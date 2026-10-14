/**
 * Tests for `./modifications-repo.ts`: the journal that is the only record able
 * to restore a developer's patched files.
 *
 * What is on trial here is not a repository's CRUD. It is four promises, and
 * each block below exists because breaking one of them costs a developer their
 * source code rather than a debugging answer:
 *
 * 1. **Durability before the write.** AAP §0.5.1 puts the journal append
 *    *before* the rename that patches the file, because a journal that already
 *    knows both hashes is what makes every crash point decidable. The suite
 *    therefore proves the row is visible from a **second `DatabaseSync`
 *    connection** the moment `append` resolves — a promise that settled before
 *    its transaction committed would be indistinguishable from a correct one in
 *    every other assertion.
 * 2. **Refusal over repair.** A record with nothing to restore from, nothing to
 *    show the developer, or two identical hashes is refused; a chain that does
 *    not line up hash-for-hash is refused; a record that would fork a file's
 *    history — a second child of one parent, a child of a record that is not
 *    the file's sole open head, a second open root — is refused by the
 *    repository and, beneath it, by the database's single-child index, which
 *    a pre-existing fork migrated from version 1 does not get past either; a
 *    status transition the lifecycle
 *    forbids is refused and the row is left exactly as it was. Each refusal is
 *    checked *together with* the state of the table, because "returned an
 *    error" and "changed nothing" are two different claims.
 * 3. **Reconciliation reaches everything.** `listAllOpen` must not filter by
 *    the owning session's status: a session abandoned in `failed` still has
 *    patched files on disk. The sessions seeded below are deliberately in
 *    different statuses for that assertion alone.
 * 4. **Privacy.** A diff is a slice of the developer's source. The suite plants
 *    a sentinel inside one and asserts it appears in no log record and in no
 *    error payload, on the success path and on a refusal path — the two places
 *    a value escapes.
 *
 * The store is the real one: `openStore` against a file in an `mkdtemp`
 * sandbox — never `:memory:` — so the real DDL, the real pragmas
 * (`foreign_keys = ON` is what makes the cascade assertion meaningful, WAL is
 * what the second-connection durability check reads through) and the real
 * migration ladder are exercised. Parent sessions are written through the real
 * `sessions-repo`, because `modifications.session_id` is a foreign key and a
 * session row forged with raw SQL would test a shape the service never writes.
 * Records are built with the upstream `createModificationRecord`, so the suite
 * never hand-rolls the shape the journal is supposed to accept.
 *
 * Every fixture is neutral (`src/moduleOne.ts`, `handlerAlpha`) and every
 * digest is an obviously synthetic 64-character lowercase hex string, so
 * neither `pnpm check:no-hardcoding` nor `pnpm check:secrets` has anything to
 * find here. Nothing under `$DEBUGGEN_HOME` is touched, no environment variable
 * is read and no socket is opened, which is the contract of the
 * `local-service` Vitest project; each test owns its sandbox, store and clock,
 * so no test depends on another having run.
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  MAX_MODIFICATION_DIFF_LENGTH,
  MODIFICATION_STATUSES,
  OPEN_MODIFICATION_STATUSES,
  SHA256_HEX_PATTERN,
  createModificationRecord,
  parseModificationRecord,
} from '@debuggen/instrumentation';
import type {
  ModificationJournal,
  ModificationRecord,
  ModificationStatus,
} from '@debuggen/instrumentation';
import {
  MODIFICATIONS_PAGE_DIFF_BUDGET,
  MODIFICATION_DIFF_MAX_BYTES,
  modificationsDiffBytes,
  parseSessionRecord,
  utf8ByteLength,
} from '@debuggen/protocol';
import type { SessionRecord, SessionStatus } from '@debuggen/protocol';
import { DEBUGGEN_ERROR_CODES, isErr, newSessionId, unwrap } from '@debuggen/shared';
import type {
  DebuggenError,
  LogFields,
  LogLevel,
  Logger,
  Result,
  SessionId,
} from '@debuggen/shared';

import { loadSchemaSql, openStore } from './db.js';
import type { Store } from './db.js';
import {
  MODIFICATION_STATUS_TRANSITIONS,
  canTransitionModificationStatus,
  createModificationsRepo,
  readSessionModifications,
} from './modifications-repo.js';
import type { ModificationCorroborationReader, ModificationsRepo } from './modifications-repo.js';
import { createSessionsRepo } from './sessions-repo.js';
import type { SessionsRepo } from './sessions-repo.js';

/* -------------------------------------------------------------------------------------------------
 * Fixtures
 * ---------------------------------------------------------------------------------------------- */

/** The session most records below belong to, left mid-capture. */
const SESSION_A: SessionId = newSessionId();

/**
 * A second session, deliberately in `failed`.
 *
 * AAP §0.5.1 requires start-up reconciliation to act on an open record
 * *regardless of the owning session's status*, so the `listAllOpen` assertions
 * need sessions that a status-aware query would have excluded.
 */
const SESSION_B: SessionId = newSessionId();

/** A third session, `ended`, for the same reason. */
const SESSION_C: SessionId = newSessionId();

/** A fourth session, `generated`: finished its pipeline, files still patched. */
const SESSION_D: SessionId = newSessionId();

/** Every parent session and the status it is seeded in. */
const SESSIONS: ReadonlyArray<readonly [SessionId, SessionStatus]> = Object.freeze([
  [SESSION_A, 'capturing'],
  [SESSION_B, 'failed'],
  [SESSION_C, 'ended'],
  [SESSION_D, 'generated'],
] as const);

/** The file most records patch: neutral fixture vocabulary only. */
const FILE_ONE = 'src/moduleOne.ts';

/** A second file, for the chain rules that name "a different file". */
const FILE_TWO = 'src/moduleTwo.ts';

/** A unified diff of the shape the patcher produces. */
const DIFF = [
  `--- a/${FILE_ONE}`,
  `+++ b/${FILE_ONE}`,
  '@@ -3,3 +3,6 @@',
  ' export function handlerAlpha(input: number): number {',
  '+  const __dbg = globalThis.__dbgHelper;',
  '+  if (__dbg) return __dbg.span("handlerAlpha", {}, () => __orig(input));',
  '   return input * 2;',
  ' }',
  '',
].join('\n');

/**
 * The string the privacy assertions look for.
 *
 * Shaped like something that must never be logged and unlikely to occur by
 * accident, so a match is unambiguous.
 */
const SENTINEL = 'DIFF-SENTINEL-c7f1a4e2-never-log-me';

/** A diff carrying the sentinel: file content a log line or a refusal must never echo. */
const SENTINEL_DIFF = `${DIFF}+// ${SENTINEL}\n`;

/** The epoch-millisecond reading every test's clock starts from. */
const CLOCK_START = 1_767_225_600_000;

/** The clock the repositories and the record builder read. Advanced by tests. */
let clock = CLOCK_START;

/** The sandbox directory holding the database — and nothing else — for one test. */
let directory: string;

/** The store under the repositories. */
let store: Store;

/** Every call the store and the repositories made on the capturing logger. */
let logs: CapturedLog[];

/** The session repository that writes the parent rows the foreign key needs. */
let sessions: SessionsRepo;

/** The repository under test, with the ingest path's metadata-only read. */
let repo: ModificationsRepo & ModificationCorroborationReader;

/** The synthetic digest handed out for each label in the current test. */
let digests: Map<string, string>;

/** One call on the capturing logger. */
interface CapturedLog {
  readonly level: LogLevel;
  readonly message: string;
  readonly fields: LogFields;
}

/**
 * A {@link Logger} that records every call as `{ level, message, fields }`.
 *
 * Deliberately a hand-written object rather than the console logger with a
 * sink: the privacy assertions must see exactly what the repository handed to
 * the logging interface — message and fields, bindings merged in the order a
 * child applies them — with no formatting layer in between that could drop or
 * rewrite a value before the assertion looks at it.
 *
 * @param sink Where every call is recorded.
 * @param bindings The fields a {@link Logger.child} added, merged under each
 * call's own fields.
 * @returns The logger.
 */
function createCapturingLogger(sink: CapturedLog[], bindings: LogFields = {}): Logger {
  const at =
    (level: LogLevel) =>
    (message: string, fields?: LogFields): void => {
      sink.push({ level, message, fields: { ...bindings, ...(fields ?? {}) } });
    };

  return {
    level: 'trace',
    trace: at('trace'),
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
    fatal: at('fatal'),
    child: (childBindings: LogFields): Logger =>
      createCapturingLogger(sink, { ...bindings, ...childBindings }),
  };
}

/**
 * An obviously synthetic SHA-256-shaped digest for a label: 56 `a`s followed
 * by the label's ordinal in eight hex digits, e.g. `aaaa…aa00000003`.
 *
 * The same label answers the same digest for the whole test and distinct
 * labels answer distinct digests, which is all the journal can observe about a
 * hash. It satisfies the upstream `SHA256_HEX_PATTERN` while carrying no
 * entropy, so no secret scanner can mistake it for a credential and no reader
 * can mistake it for a real file's digest.
 *
 * @param label What the digest stands for, e.g. `original:src/moduleOne.ts`.
 * @returns The digest.
 */
function hashOf(label: string): string {
  const known = digests.get(label);

  if (known !== undefined) {
    return known;
  }

  const digest = `${'a'.repeat(56)}${(digests.size + 1).toString(16).padStart(8, '0')}`;

  digests.set(label, digest);

  return digest;
}

/** Where a backup of `hash` for `sessionId` would live: inside the sandbox. */
function backupPathOf(sessionId: string, hash: string): string {
  return join(directory, 'backups', sessionId, hash);
}

/**
 * A parent session in `status`, built through the protocol's own validator so
 * `sessions-repo` receives exactly the record shape the session manager
 * writes.
 */
function makeSession(id: SessionId, status: SessionStatus): SessionRecord {
  return unwrap(
    parseSessionRecord({
      id,
      projectRoot: '/workspace/project-one',
      projectName: 'project-one',
      devServerUrl: 'http://127.0.0.1:3100/',
      createdAt: clock,
      updatedAt: clock,
      status,
      question: 'Why is handlerAlpha slow?',
      followUps: [],
      relevantFiles: [],
      plans: [],
      modifications: [],
      captures: [],
      panelIds: [],
      analyses: [],
      cleanup: { status: 'pending', conflicts: [] },
      promptVersions: {},
      provider: { id: 'deterministic' },
    }),
  );
}

/** What {@link makeRecord} may override. */
interface RecordOverrides {
  readonly sessionId?: string;
  readonly planVersion?: number;
  readonly file?: string;
  readonly originalHash?: string;
  readonly backupPath?: string;
  readonly instrumentedHash?: string;
  readonly diff?: string;
  readonly status?: ModificationStatus;
  readonly previousRecordId?: string;
  readonly appliedAt?: number;
}

/**
 * Builds a record through the real constructor — `mod_` id, `pending` default,
 * the injected clock — so the suite never hand-rolls the shape the journal is
 * supposed to accept.
 */
function makeRecord(overrides: RecordOverrides = {}): ModificationRecord {
  const file = overrides.file ?? FILE_ONE;
  const sessionId = overrides.sessionId ?? SESSION_A;
  const appliedAt = overrides.appliedAt ?? clock;
  const originalHash = overrides.originalHash ?? hashOf(`original:${file}`);

  return unwrap(
    createModificationRecord(
      {
        sessionId,
        planVersion: overrides.planVersion ?? 1,
        file,
        originalHash,
        backupPath: overrides.backupPath ?? backupPathOf(sessionId, originalHash),
        instrumentedHash: overrides.instrumentedHash ?? hashOf(`instrumented:${file}`),
        diff: overrides.diff ?? DIFF,
        ...(overrides.status !== undefined ? { status: overrides.status } : {}),
        ...(overrides.previousRecordId !== undefined
          ? { previousRecordId: overrides.previousRecordId }
          : {}),
      },
      { now: () => appliedAt },
    ),
  );
}

/** Appends a record and fails the test if the journal refused it. */
async function appendOk(record: ModificationRecord): Promise<ModificationRecord> {
  const appended = await repo.append(record);

  if (isErr(appended)) {
    throw new Error(`append refused a record the test expected to succeed: ${appended.error.code}`);
  }

  return appended.value;
}

/** Reads one row as raw columns, for the column-for-column assertions. */
function readRow(id: string): Record<string, unknown> | undefined {
  return store.statement('SELECT * FROM modifications WHERE id = ?').get(id);
}

/** Everything the store and the repositories said, as one searchable string. */
function loggedText(): string {
  return JSON.stringify(logs);
}

/**
 * Everything a refusal can carry out of the repository — `message`, `hint`,
 * `details` and the wire payload — as one searchable string.
 */
function errorText(error: DebuggenError): string {
  return JSON.stringify({
    message: error.message,
    hint: error.hint ?? '',
    details: error.details ?? {},
    payload: error.toPayload(),
  });
}

/** The closed error vocabulary, widened once for membership checks. */
const ERROR_CODES: readonly string[] = DEBUGGEN_ERROR_CODES;

/**
 * Asserts that `result` is a refusal with `code` — a code of the closed
 * `DEBUGGEN_ERROR_CODES` tuple — and returns the error for further checks.
 *
 * Throws rather than returning `undefined` on success, so a test that expected
 * a refusal cannot continue past this line with nothing to inspect.
 */
function expectRefusal<T>(result: Result<T>, code: DebuggenError['code']): DebuggenError {
  if (!isErr(result)) {
    throw new Error(`expected a ${code} refusal, but the journal accepted the call`);
  }

  expect(ERROR_CODES).toContain(result.error.code);
  expect(result.error.code).toBe(code);

  return result.error;
}

/**
 * The lifecycle AAP §0.5.1 documents, restated independently of the module
 * under test so the matrix below is judged against the specification rather
 * than against the table it is testing. Same-status writes are not edges; they
 * are idempotent no-ops and are handled separately.
 */
const DOCUMENTED_EDGES: Readonly<Record<ModificationStatus, readonly ModificationStatus[]>> = {
  pending: ['applied', 'reverted', 'conflict', 'failed'],
  applied: ['reverted', 'conflict', 'failed'],
  conflict: ['reverted', 'failed'],
  failed: ['reverted', 'conflict'],
  reverted: [],
};

/**
 * Appends a `pending` record and moves it to `status` through the public API.
 *
 * Every status is one legal step from `pending`, so no start state is ever
 * forged with raw SQL: the matrix is proven with the calls the patcher and
 * cleanup actually make.
 */
async function seedInStatus(
  status: ModificationStatus,
  overrides: RecordOverrides = {},
): Promise<ModificationRecord> {
  const record = await appendOk(makeRecord(overrides));

  expect(record.status).toBe('pending');

  if (status === 'pending') {
    return record;
  }

  clock += 1_000;

  return unwrap(await repo.updateStatus(record.id, status));
}

beforeEach(() => {
  clock = CLOCK_START;
  digests = new Map();
  directory = mkdtempSync(join(tmpdir(), 'debuggen-modifications-'));
  logs = [];

  const logger = createCapturingLogger(logs);

  store = unwrap(openStore({ databasePath: join(directory, 'sessions.sqlite'), logger }));
  sessions = createSessionsRepo({ store, logger, now: () => clock });
  repo = createModificationsRepo({ store, logger, now: () => clock });

  for (const [id, status] of SESSIONS) {
    unwrap(sessions.insert(makeSession(id, status)));
  }
});

afterEach(() => {
  if (!store.isClosed) {
    store.close();
  }

  rmSync(directory, { recursive: true, force: true });

  // Nothing survives a test: the next one starts from an empty sandbox.
  expect(existsSync(directory)).toBe(false);
});

/* -------------------------------------------------------------------------------------------------
 * The port
 * ---------------------------------------------------------------------------------------------- */

describe('port conformance', () => {
  it('is usable as the ModificationJournal the patcher and cleanup hold', () => {
    // The assignment is the assertion: `@debuggen/instrumentation` type-checks
    // its in-memory fakes against this same interface, so a signature that
    // drifted on either side fails to compile here.
    const journal: ModificationJournal = repo;

    // The factory too, so a change to its return type that stops satisfying
    // the port fails `pnpm typecheck` here as well as in the port's package.
    const factory: (...args: Parameters<typeof createModificationsRepo>) => ModificationJournal =
      createModificationsRepo;

    expect(factory).toBe(createModificationsRepo);
    expect(typeof journal.append).toBe('function');
    expect(typeof journal.updateStatus).toBe('function');
    expect(typeof journal.listBySession).toBe('function');
    expect(typeof journal.listOpen).toBe('function');
  });

  it('exposes every query the service needs', () => {
    const members = [
      'append',
      'updateStatus',
      'listBySession',
      'listPageBySession',
      'listOpen',
      'listAllOpen',
      'get',
      'listByFile',
      'latestRecordForFile',
      'listChain',
      'listConflicts',
      'listBackupPaths',
      'countBySession',
      'deleteBySession',
    ] as const;

    for (const member of members) {
      expect(typeof repo[member]).toBe('function');
    }
  });

  it('keeps the live CHECK list of the modifications table equal to MODIFICATION_STATUSES, in order', () => {
    // Read from the database the store actually opened — after every migration
    // step — rather than from the DDL file, so the assertion is about the table
    // a write meets, not about a file that might not be what was applied.
    const row = store
      .statement(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`)
      .get('modifications');
    const ddl = typeof row?.['sql'] === 'string' ? row['sql'] : '';
    const lists = [...ddl.matchAll(/CHECK\s*\(\s*status\s+IN\s*\(([^)]*)\)\s*\)/giu)];

    expect(ddl).toContain('CREATE TABLE');
    expect(lists).toHaveLength(1);

    const listed = (lists[0]?.[1] ?? '')
      .split(',')
      .map((value) => value.trim().replace(/^'/u, '').replace(/'$/u, ''));

    expect(
      listed,
      'The status CHECK of the modifications table must list MODIFICATION_STATUSES from ' +
        '@debuggen/instrumentation exactly and in order: edit apps/local-service/src/store/schema.sql ' +
        '(and add a migration step in ./migrations.ts) when the upstream vocabulary changes.',
    ).toEqual([...MODIFICATION_STATUSES]);
  });
});

/* -------------------------------------------------------------------------------------------------
 * append
 * ---------------------------------------------------------------------------------------------- */

describe('append', () => {
  it('persists both hashes, the backup path and the diff, and round-trips the record', async () => {
    const record = makeRecord({ planVersion: 3 });

    // The upstream constructor's own guarantees, which the journal relies on.
    expect(record.id).toMatch(/^mod_[0-9a-z]{16}$/u);
    expect(record.status).toBe('pending');
    expect(record.appliedAt).toBe(clock);
    expect(record.originalHash).toMatch(SHA256_HEX_PATTERN);
    expect(record.instrumentedHash).toMatch(SHA256_HEX_PATTERN);

    const stored = await appendOk(record);

    // The stored record is a valid record in its own right and equals the
    // input exactly: both hashes, the backup path, the diff, the plan version,
    // the timestamp and the `pending` status all survive.
    expect(parseModificationRecord(stored)).toStrictEqual({ ok: true, value: record });
    expect(stored).toStrictEqual(record);
    expect(stored.planVersion).toBe(3);
    expect(stored.status).toBe('pending');

    const row = readRow(record.id);

    expect(row).toBeDefined();
    expect(row?.['session_id']).toBe(record.sessionId);
    expect(row?.['plan_version']).toBe(record.planVersion);
    expect(row?.['file']).toBe(record.file);
    expect(row?.['original_hash']).toBe(record.originalHash);
    expect(row?.['instrumented_hash']).toBe(record.instrumentedHash);
    expect(row?.['backup_path']).toBe(record.backupPath);
    expect(row?.['diff']).toBe(record.diff);
    expect(row?.['applied_at']).toBe(record.appliedAt);
    expect(row?.['updated_at']).toBe(clock);
    expect(row?.['status']).toBe('pending');
    expect(row?.['previous_record_id']).toBeNull();

    const read = await repo.get(record.id);

    expect(read).toStrictEqual({ ok: true, value: record });
  });

  it('is durable when it resolves: a second connection sees the committed row', async () => {
    const record = await appendOk(makeRecord());

    // The patcher writes the project file only after this promise settles, so
    // "committed" has to be true here rather than eventually.
    const observer = new DatabaseSync(store.path);

    try {
      const row = observer
        .prepare(
          'SELECT id, original_hash, instrumented_hash, status FROM modifications WHERE id = ?',
        )
        .get(record.id);

      expect(row?.['id']).toBe(record.id);
      expect(row?.['original_hash']).toBe(record.originalHash);
      expect(row?.['instrumented_hash']).toBe(record.instrumentedHash);
      expect(row?.['status']).toBe('pending');
    } finally {
      observer.close();
    }
  });

  it('canonicalises a sub-millisecond timestamp and returns the stored record', async () => {
    const record = makeRecord({ appliedAt: 1_767_225_600_123.456 });
    const stored = await appendOk(record);

    expect(stored.appliedAt).toBe(1_767_225_600_123);
    expect(readRow(record.id)?.['applied_at']).toBe(1_767_225_600_123);

    // The caller's copy and the store's copy agree, which is the whole point of
    // returning the stored record rather than the offered one.
    const read = await repo.get(record.id);

    expect(read).toStrictEqual({ ok: true, value: stored });
  });

  it('refuses a record whose backup path is blank', async () => {
    // Built by spreading rather than through `createModificationRecord`, which
    // refuses a blank path itself: the assertion here is that the *journal*
    // refuses one, whichever of its two checks catches it, because a record
    // with no backup could never restore the file.
    const valid = makeRecord();
    const record: ModificationRecord = { ...valid, backupPath: '   ' };

    expectRefusal(await repo.append(record), 'INSTRUMENTATION_INSTALL_FAILED');
    expect(readRow(record.id)).toBeUndefined();
  });

  it('refuses a record whose backup path is empty', async () => {
    const valid = makeRecord();
    const record: ModificationRecord = { ...valid, backupPath: '' };

    expectRefusal(await repo.append(record), 'INSTRUMENTATION_INSTALL_FAILED');
    expect(readRow(record.id)).toBeUndefined();
  });

  it('refuses a record with no diff', async () => {
    const record = makeRecord({ diff: '' });

    expectRefusal(await repo.append(record), 'INSTRUMENTATION_INSTALL_FAILED');
    expect(readRow(record.id)).toBeUndefined();
  });

  it('refuses a no-op patch, whose two hashes are identical', async () => {
    const hash = hashOf('unchanged');
    const record = makeRecord({ originalHash: hash, instrumentedHash: hash });

    expectRefusal(await repo.append(record), 'INSTRUMENTATION_INSTALL_FAILED');
    expect(readRow(record.id)).toBeUndefined();
  });

  it.each([
    ['uppercase hex', (hash: string): string => hash.toUpperCase()],
    ['63 characters', (hash: string): string => hash.slice(1)],
    ['65 characters', (hash: string): string => `${hash}a`],
    ['a non-hex character', (hash: string): string => `${hash.slice(1)}g`],
  ])('refuses an original hash that is not 64 lowercase hex characters (%s)', async (_, mangle) => {
    const valid = makeRecord();
    const malformed: ModificationRecord = { ...valid, originalHash: mangle(valid.originalHash) };

    expect(malformed.originalHash).not.toMatch(SHA256_HEX_PATTERN);
    expectRefusal(await repo.append(malformed), 'INSTRUMENTATION_INSTALL_FAILED');
    expect(readRow(valid.id)).toBeUndefined();
  });

  it('refuses an instrumented hash that is not 64 lowercase hex characters', async () => {
    const valid = makeRecord();
    const malformed: ModificationRecord = { ...valid, instrumentedHash: 'f'.repeat(40) };

    expectRefusal(await repo.append(malformed), 'INSTRUMENTATION_INSTALL_FAILED');
    expect(readRow(valid.id)).toBeUndefined();
  });

  it.each([
    ['an absolute POSIX path', '/workspace/project-one/src/moduleOne.ts'],
    ['a leading parent segment', '../outside/moduleOne.ts'],
    ['an embedded parent segment', 'src/../../outside/moduleOne.ts'],
    ['a Windows drive path', 'C:/workspace/src/moduleOne.ts'],
  ])('refuses a file that is not project-relative (%s)', async (_, file) => {
    // Spread rather than built: the constructor normalises and refuses these
    // itself, and the assertion here is that the *journal* never stores a path
    // that could resolve outside the project it will later be restored into.
    const valid = makeRecord();
    const escaping: ModificationRecord = { ...valid, file };

    expectRefusal(await repo.append(escaping), 'INSTRUMENTATION_INSTALL_FAILED');
    expect(readRow(valid.id)).toBeUndefined();
    expect(await repo.countBySession(SESSION_A)).toStrictEqual({ ok: true, value: 0 });
  });

  it('refuses a duplicate record id', async () => {
    const record = await appendOk(makeRecord());
    const error = expectRefusal(await repo.append(record), 'STORE_ERROR');

    expect(error.details?.['reason']).toBe('duplicate-record-id');

    const listed = await repo.listBySession(SESSION_A);

    expect(listed.ok && listed.value).toHaveLength(1);
  });

  it('refuses a record naming a session the store does not hold, writing nothing', async () => {
    const orphanSession = newSessionId();
    const record = makeRecord({ sessionId: orphanSession });
    const error = expectRefusal(await repo.append(record), 'STORE_ERROR');

    expect(error.details?.['reason']).toBe('unknown-session');
    expect(readRow(record.id)).toBeUndefined();
    expect(await repo.countBySession(orphanSession)).toStrictEqual({ ok: true, value: 0 });
  });

  it('answers every refusal as a settled Err, never as a thrown exception', async () => {
    const valid = makeRecord();
    const refusals: ReadonlyArray<() => Promise<Result<ModificationRecord>>> = [
      () => repo.append({ ...valid, backupPath: '' }),
      () => repo.append({ ...valid, diff: '' }),
      () => repo.append({ ...valid, instrumentedHash: valid.originalHash }),
      () => repo.append({ ...valid, file: '/abs/moduleOne.ts' }),
      () => repo.append({ ...valid, sessionId: newSessionId() }),
      () => repo.updateStatus('mod_0000000000000000', 'applied'),
    ];

    for (const refuse of refusals) {
      // `resolves` fails the test if the promise rejects, so a throw anywhere
      // on these paths is a failure rather than a pass.
      await expect(refuse()).resolves.toMatchObject({ ok: false });
    }

    expect(await repo.countBySession(SESSION_A)).toStrictEqual({ ok: true, value: 0 });
  });

  it('keeps append order for records that share a millisecond', async () => {
    const first = await appendOk(makeRecord({ file: 'src/moduleA.ts' }));
    const second = await appendOk(makeRecord({ file: 'src/moduleB.ts' }));
    const third = await appendOk(makeRecord({ file: 'src/moduleC.ts' }));

    expect(first.appliedAt).toBe(second.appliedAt);
    expect(second.appliedAt).toBe(third.appliedAt);

    const listed = await repo.listBySession(SESSION_A);

    expect(listed.ok && listed.value.map((entry) => entry.file)).toEqual([
      'src/moduleA.ts',
      'src/moduleB.ts',
      'src/moduleC.ts',
    ]);
  });
});

/* -------------------------------------------------------------------------------------------------
 * Chains
 * ---------------------------------------------------------------------------------------------- */

describe('follow-up chains', () => {
  /** Appends the first record for a file and returns it. */
  async function appendRoot(file = FILE_ONE): Promise<ModificationRecord> {
    return appendOk(makeRecord({ file }));
  }

  it('accepts a delta whose original hash is the parent’s instrumented hash', async () => {
    const root = await appendRoot();
    const delta = makeRecord({
      planVersion: 2,
      originalHash: root.instrumentedHash,
      instrumentedHash: hashOf('instrumented:plan-2'),
      previousRecordId: root.id,
    });

    const stored = await appendOk(delta);

    expect(stored.previousRecordId).toBe(root.id);
    expect(readRow(delta.id)?.['previous_record_id']).toBe(root.id);
  });

  /**
   * Asserts a chain refusal tells the caller what to do and carries nothing of
   * the file: no diff line, no digest, no backup path.
   */
  function expectActionableHint(error: DebuggenError, refused: ModificationRecord): string {
    const hint = error.hint ?? '';

    expect(hint.trim().length).toBeGreaterThan(20);
    expect(hint).not.toContain(SENTINEL);
    expect(hint).not.toContain('handlerAlpha');
    expect(hint).not.toContain(refused.originalHash);
    expect(hint).not.toContain(refused.instrumentedHash);
    expect(hint).not.toContain(refused.backupPath);
    expect(errorText(error)).not.toContain(SENTINEL);

    return hint;
  }

  it('refuses a delta that does not continue from the parent’s written bytes', async () => {
    const root = await appendRoot();
    const delta = makeRecord({
      planVersion: 2,
      originalHash: hashOf('somebody else edited the file'),
      instrumentedHash: hashOf('instrumented:plan-2'),
      previousRecordId: root.id,
      diff: SENTINEL_DIFF,
    });

    const error = expectRefusal(await repo.append(delta), 'MODIFICATION_CONFLICT');
    const hint = expectActionableHint(error, delta);

    // The remedy is named: revert the earlier patch and instrument again.
    expect(hint).toContain('between plan versions');
    expect(hint).toMatch(/Revert the earlier modification/u);
    expect(readRow(delta.id)).toBeUndefined();
    expect(readRow(root.id)?.['status']).toBe('pending');
  });

  it('refuses a delta that repeats the parent’s original hash', async () => {
    const root = await appendRoot();
    const delta = makeRecord({
      planVersion: 2,
      originalHash: root.originalHash,
      instrumentedHash: hashOf('instrumented:plan-2'),
      previousRecordId: root.id,
      diff: SENTINEL_DIFF,
    });

    const error = expectRefusal(await repo.append(delta), 'INSTRUMENTATION_INSTALL_FAILED');

    expect(expectActionableHint(error, delta)).toContain('instrumentedHash');
    expect(readRow(delta.id)).toBeUndefined();
  });

  it('refuses a delta whose parent belongs to another session', async () => {
    const root = await appendRoot();
    const delta = makeRecord({
      sessionId: SESSION_B,
      planVersion: 2,
      originalHash: root.instrumentedHash,
      instrumentedHash: hashOf('instrumented:plan-2'),
      previousRecordId: root.id,
      diff: SENTINEL_DIFF,
    });

    const error = expectRefusal(await repo.append(delta), 'INSTRUMENTATION_INSTALL_FAILED');

    expect(expectActionableHint(error, delta)).toContain('one session');
    expect(error.details?.['previousRecordId']).toBe(root.id);
    expect(readRow(delta.id)).toBeUndefined();
    expect(await repo.countBySession(SESSION_B)).toStrictEqual({ ok: true, value: 0 });
  });

  it('refuses a delta whose parent describes a different file', async () => {
    const root = await appendRoot(FILE_ONE);
    const delta = makeRecord({
      file: FILE_TWO,
      planVersion: 2,
      originalHash: root.instrumentedHash,
      instrumentedHash: hashOf('instrumented:plan-2'),
      previousRecordId: root.id,
      diff: SENTINEL_DIFF,
    });

    const error = expectRefusal(await repo.append(delta), 'INSTRUMENTATION_INSTALL_FAILED');

    expect(expectActionableHint(error, delta)).toContain('one file');
    // The project-relative path is an identifier and may be named; the content may not.
    expect(error.details?.['file']).toBe(FILE_TWO);
    expect(readRow(delta.id)).toBeUndefined();
  });

  it('refuses a delta whose parent is not journalled', async () => {
    const delta = makeRecord({
      planVersion: 2,
      previousRecordId: 'mod_0000000000000000',
      originalHash: hashOf('instrumented:plan-1'),
      diff: SENTINEL_DIFF,
    });

    const error = expectRefusal(await repo.append(delta), 'INSTRUMENTATION_INSTALL_FAILED');

    expect(expectActionableHint(error, delta)).toContain('without a previous record');
    expect(readRow(delta.id)).toBeUndefined();
  });

  it('walks a chain oldest → newest, so a restore can reverse it', async () => {
    const root = await appendRoot();
    const second = await appendOk(
      makeRecord({
        planVersion: 2,
        originalHash: root.instrumentedHash,
        instrumentedHash: hashOf('instrumented:plan-2'),
        previousRecordId: root.id,
      }),
    );
    const third = await appendOk(
      makeRecord({
        planVersion: 3,
        originalHash: second.instrumentedHash,
        instrumentedHash: hashOf('instrumented:plan-3'),
        previousRecordId: second.id,
      }),
    );

    const chain = await repo.listChain(third.id);

    expect(chain.ok && chain.value.map((entry) => entry.id)).toEqual([
      root.id,
      second.id,
      third.id,
    ]);

    // Every link of the walk lines up hash by hash, oldest first: exactly the
    // property a newest-first restore verifies at each step.
    const links = chain.ok ? chain.value : [];

    for (let index = 1; index < links.length; index += 1) {
      expect(links[index]?.originalHash).toBe(links[index - 1]?.instrumentedHash);
      expect(links[index]?.previousRecordId).toBe(links[index - 1]?.id);
    }

    // Walked from a middle member or from the root, the answer is still oldest
    // → newest: the chain that member descends from, ending at that member.
    expect(unwrap(await repo.listChain(second.id)).map((entry) => entry.id)).toEqual([
      root.id,
      second.id,
    ]);
    expect(unwrap(await repo.listChain(root.id)).map((entry) => entry.id)).toEqual([root.id]);

    // The head is what a restore starts from, and it is the record nothing else
    // is layered on.
    const head = await repo.latestRecordForFile(SESSION_A, root.file);

    expect(head.ok && head.value?.id).toBe(third.id);

    const byFile = await repo.listByFile(SESSION_A, root.file);

    expect(byFile.ok && byFile.value.map((entry) => entry.id)).toEqual([
      root.id,
      second.id,
      third.id,
    ]);
    expect(byFile.ok && byFile.value.map((entry) => entry.planVersion)).toEqual([1, 2, 3]);

    // Another session's records for the same path are not part of this chain.
    expect(await repo.listByFile(SESSION_B, root.file)).toStrictEqual({ ok: true, value: [] });
  });

  it('orders a chain by its links even when every link shares one millisecond', async () => {
    // No clock advance between appends: `applied_at` cannot order these, so the
    // head and the walk must come from the links and the append order.
    const root = await appendRoot();
    const second = await appendOk(
      makeRecord({
        planVersion: 2,
        originalHash: root.instrumentedHash,
        instrumentedHash: hashOf('instrumented:plan-2'),
        previousRecordId: root.id,
      }),
    );

    expect(second.appliedAt).toBe(root.appliedAt);
    expect(unwrap(await repo.latestRecordForFile(SESSION_A, FILE_ONE))?.id).toBe(second.id);
    expect(unwrap(await repo.listByFile(SESSION_A, FILE_ONE)).map((entry) => entry.id)).toEqual([
      root.id,
      second.id,
    ]);
  });

  it('answers a single-record chain with that record alone', async () => {
    const root = await appendRoot();
    const chain = await repo.listChain(root.id);

    expect(chain.ok && chain.value.map((entry) => entry.id)).toEqual([root.id]);
  });

  it('refuses to walk a cycle', async () => {
    const root = await appendRoot();
    const second = await appendOk(
      makeRecord({
        planVersion: 2,
        originalHash: root.instrumentedHash,
        instrumentedHash: hashOf('instrumented:plan-2'),
        previousRecordId: root.id,
      }),
    );

    const third = await appendOk(
      makeRecord({
        planVersion: 3,
        originalHash: second.instrumentedHash,
        instrumentedHash: hashOf('instrumented:plan-3'),
        previousRecordId: second.id,
      }),
    );

    // Only reachable by corrupting the table directly — the one place raw SQL
    // is justified here: `append` refuses a forward link, and the record schema
    // refuses a self-link. Pointing the root at the head closes the loop.
    store
      .statement('UPDATE modifications SET previous_record_id = ? WHERE id = ?')
      .run(third.id, root.id);

    // From every member the walk terminates with a refusal instead of looping,
    // which is what keeps start-up reconciliation from hanging on it.
    for (const member of [root, second, third]) {
      const error = expectRefusal(await repo.listChain(member.id), 'STORE_ERROR');

      expect(error.details?.['reason']).toBe('chain-cycle');
      expect(error.hint).toContain('Report the record ids');
    }
  });

  it('refuses to walk a chain whose link is missing', async () => {
    const root = await appendRoot();
    const second = await appendOk(
      makeRecord({
        planVersion: 2,
        originalHash: root.instrumentedHash,
        instrumentedHash: hashOf('instrumented:plan-2'),
        previousRecordId: root.id,
      }),
    );

    // The foreign key would clear the link, so the dangling state has to be
    // forged with the constraint suspended for one statement.
    store.db.exec('PRAGMA foreign_keys = OFF');
    store.statement('DELETE FROM modifications WHERE id = ?').run(root.id);
    store.db.exec('PRAGMA foreign_keys = ON');

    const chain = await repo.listChain(second.id);

    expect(isErr(chain)).toBe(true);
    expect(isErr(chain) ? chain.error.details?.['reason'] : undefined).toBe('chain-link-missing');
  });

  it('refuses a chain walk from an unknown record', async () => {
    const chain = await repo.listChain('mod_0000000000000000');

    expect(isErr(chain)).toBe(true);
    expect(isErr(chain) ? chain.error.details?.['reason'] : undefined).toBe('record-not-found');
  });
});

/* -------------------------------------------------------------------------------------------------
 * One chain per file: the single-child and sole-head invariant
 * ---------------------------------------------------------------------------------------------- */

describe('one chain per file', () => {
  /** A delta layered on `parent`, continuing from the bytes it wrote. */
  function deltaOf(parent: ModificationRecord, planVersion: number): ModificationRecord {
    return makeRecord({
      file: parent.file,
      sessionId: parent.sessionId,
      planVersion,
      originalHash: parent.instrumentedHash,
      instrumentedHash: hashOf(`instrumented:${parent.file}:plan-${String(planVersion)}`),
      previousRecordId: parent.id,
    });
  }

  /** The ids the journal holds for one session, in append order. */
  async function idsOf(sessionId: string): Promise<string[]> {
    const listed = await repo.listBySession(sessionId);

    if (isErr(listed)) {
      throw new Error(`listBySession refused: ${listed.error.code}`);
    }

    return listed.value.map((entry) => entry.id);
  }

  /** Moves a record through `applied` to `reverted`, as a verified restore would. */
  async function revert(record: ModificationRecord): Promise<void> {
    clock += 1_000;
    unwrap(await repo.updateStatus(record.id, 'applied'));
    clock += 1_000;
    unwrap(await repo.updateStatus(record.id, 'reverted'));
  }

  it('refuses a second child of one parent and leaves the row set unchanged', async () => {
    const root = await appendOk(makeRecord());
    const first = await appendOk(deltaOf(root, 2));
    const before = await idsOf(SESSION_A);
    const sibling = deltaOf(root, 3);

    const appended = await repo.append(sibling);

    expect(isErr(appended)).toBe(true);

    if (!isErr(appended)) {
      return;
    }

    expect(appended.error.code).toBe('MODIFICATION_CONFLICT');
    expect(appended.error.details?.['reason']).toBe('chain-parent-has-child');
    expect(appended.error.details?.['detectedBy']).toBe('journal-check');
    expect(appended.error.details?.['existingChildRecordId']).toBe(first.id);
    expect(appended.error.details?.['previousRecordId']).toBe(root.id);
    expect(appended.error.hint).toContain('latestRecordForFile');

    // Refused *and* unchanged: the same rows, in the same order, and no trace
    // of the sibling.
    expect(await idsOf(SESSION_A)).toEqual(before);
    expect(readRow(sibling.id)).toBeUndefined();
    expect(readRow(root.id)?.['status']).toBe('pending');
    expect(readRow(first.id)?.['previous_record_id']).toBe(root.id);

    // Identifiers only: no digest, backup path or diff in anything returned.
    const serialised = JSON.stringify({
      payload: appended.error.toPayload(),
      details: appended.error.details ?? {},
      message: appended.error.message,
      hint: appended.error.hint ?? '',
    });

    expect(serialised).not.toContain(sibling.originalHash);
    expect(serialised).not.toContain(sibling.instrumentedHash);
    expect(serialised).not.toContain(sibling.backupPath);
    expect(serialised).not.toContain(sibling.diff);
  });

  it('re-layers a parent whose follow-up delta was rolled back (AAP 0.4.2)', async () => {
    // The installer's delta rollback: plan version 2 patched the file on top of
    // the applied root, a later step of that install failed, and the delta was
    // restored — the file holds the root's instrumented bytes again and the
    // session stays at plan version 1. The next follow-up must be able to layer
    // plan version 3 on the same root.
    const root = await appendOk(makeRecord({ status: 'applied' }));
    const rolledBack = await appendOk(deltaOf(root, 2));

    await revert(rolledBack);

    // The head a new layer must name is the parent the file holds again, not
    // the reverted delta.
    const headBefore = await repo.latestRecordForFile(SESSION_A, root.file);

    expect(headBefore.ok && headBefore.value?.id).toBe(root.id);

    const retry = await appendOk(deltaOf(root, 3));

    expect(retry.previousRecordId).toBe(root.id);
    expect(await idsOf(SESSION_A)).toEqual([root.id, rolledBack.id, retry.id]);

    const headAfter = await repo.latestRecordForFile(SESSION_A, root.file);

    expect(headAfter.ok && headAfter.value?.id).toBe(retry.id);

    const chain = await repo.listChain(retry.id);

    expect(chain.ok && chain.value.map((entry) => entry.id)).toEqual([root.id, retry.id]);

    // One live layer is still the limit: a second one beside the retry is a fork.
    const sibling = await repo.append(deltaOf(root, 4));

    expect(isErr(sibling) ? sibling.error.details?.['reason'] : undefined).toBe(
      'chain-parent-has-child',
    );
    expect(isErr(sibling) ? sibling.error.details?.['existingChildRecordId'] : undefined).toBe(
      retry.id,
    );
  });

  it('keeps a fully reverted file at its newest record as the head', async () => {
    const root = await appendOk(makeRecord({ status: 'applied' }));
    const delta = await appendOk(deltaOf(root, 2));

    await revert(delta);
    clock += 1_000;
    unwrap(await repo.updateStatus(root.id, 'reverted'));

    const head = await repo.latestRecordForFile(SESSION_A, root.file);

    expect(head.ok && head.value?.id).toBe(delta.id);
  });

  it('lets the database index ignore a reverted layer but not a second live one', async () => {
    const root = await appendOk(makeRecord({ status: 'applied' }));
    const rolledBack = await appendOk(deltaOf(root, 2));

    await revert(rolledBack);

    const bypass = new DatabaseSync(store.path);
    let caught: unknown;

    try {
      bypass.exec('PRAGMA foreign_keys = ON');
      // Beside a reverted sibling, one live layer is legal to the index too.
      insertRawRecord(bypass, deltaOf(root, 3));

      try {
        insertRawRecord(bypass, deltaOf(root, 4));
      } catch (error) {
        caught = error;
      }
    } finally {
      bypass.close();
    }

    expect(errcodeOf(caught)).toBe(2067);
    expect(await repo.countBySession(SESSION_A)).toStrictEqual({ ok: true, value: 3 });
  });

  it('refuses a child of a reverted record, which is no longer the file’s current head', async () => {
    const root = await appendOk(makeRecord());

    await revert(root);

    const delta = deltaOf(root, 2);
    const appended = await repo.append(delta);

    expect(isErr(appended)).toBe(true);
    expect(isErr(appended) ? appended.error.code : undefined).toBe('MODIFICATION_CONFLICT');
    expect(isErr(appended) ? appended.error.details?.['reason'] : undefined).toBe(
      'chain-parent-not-head',
    );
    expect(isErr(appended) ? appended.error.details?.['parentStatus'] : undefined).toBe('reverted');
    expect(readRow(delta.id)).toBeUndefined();
  });

  it('refuses a child of a record that is not the sole open head of its file', async () => {
    const root = await appendOk(makeRecord());
    // A second open root, planted the way a writer that bypassed the repository
    // would have left it — a root has no parent, so no index can refuse it.
    const stray = makeRecord({ instrumentedHash: hashOf('instrumented:stray-root') });

    insertRawRecord(store.db, stray);

    const before = await idsOf(SESSION_A);
    const delta = deltaOf(root, 2);
    const appended = await repo.append(delta);

    expect(isErr(appended)).toBe(true);
    expect(isErr(appended) ? appended.error.details?.['reason'] : undefined).toBe(
      'chain-parent-not-head',
    );
    expect(isErr(appended) ? appended.error.details?.['openRecordIds'] : undefined).toEqual([
      stray.id,
    ]);
    expect(await idsOf(SESSION_A)).toEqual(before);
  });

  it('accepts a child of the head of a chain whose ancestors are all on its line', async () => {
    const root = await appendOk(makeRecord({ status: 'applied' }));
    const second = await appendOk(deltaOf(root, 2));
    const third = await appendOk(deltaOf(second, 3));

    expect(third.previousRecordId).toBe(second.id);

    const head = await repo.latestRecordForFile(SESSION_A, root.file);

    expect(head.ok && head.value?.id).toBe(third.id);
  });

  it('refuses a second open root for one file', async () => {
    const root = await appendOk(makeRecord());
    const second = makeRecord({ instrumentedHash: hashOf('instrumented:second-root') });

    const appended = await repo.append(second);

    expect(isErr(appended)).toBe(true);

    if (!isErr(appended)) {
      return;
    }

    expect(appended.error.code).toBe('MODIFICATION_CONFLICT');
    expect(appended.error.details?.['reason']).toBe('chain-root-while-open');
    expect(appended.error.details?.['openRecordIds']).toEqual([root.id]);
    expect(readRow(second.id)).toBeUndefined();
    expect(await idsOf(SESSION_A)).toEqual([root.id]);
  });

  it('accepts a new root once every earlier record of the file is reverted', async () => {
    const root = await appendOk(makeRecord({ status: 'applied' }));
    const delta = await appendOk(deltaOf(root, 2));

    // Still open: a new root is a second chain.
    const early = await repo.append(makeRecord({ planVersion: 3 }));

    expect(isErr(early) ? early.error.details?.['reason'] : undefined).toBe(
      'chain-root-while-open',
    );

    // Unwound strictly last-first, as cleanup does.
    await revert(delta);
    clock += 1_000;
    unwrap(await repo.updateStatus(root.id, 'reverted'));

    const fresh = await appendOk(makeRecord({ planVersion: 3 }));

    expect(fresh.previousRecordId).toBeUndefined();

    // And the new chain grows from its own head, the reverted chain being
    // finished business off its line.
    const next = await appendOk(deltaOf(fresh, 4));

    expect(next.previousRecordId).toBe(fresh.id);
    expect(await idsOf(SESSION_A)).toEqual([root.id, delta.id, fresh.id, next.id]);
  });

  it('judges each session’s chain on its own', async () => {
    await appendOk(makeRecord({ sessionId: SESSION_A }));

    // Another session's open record for the same path is not this session's
    // history: a chain describes one file within one session.
    const other = await appendOk(makeRecord({ sessionId: SESSION_B }));

    expect(other.sessionId).toBe(SESSION_B);
  });

  it('reports a duplicate id as a duplicate, not as a second chain', async () => {
    const record = await appendOk(makeRecord());
    const again = await repo.append(record);

    expect(isErr(again) ? again.error.code : undefined).toBe('STORE_ERROR');
    expect(isErr(again) ? again.error.details?.['reason'] : undefined).toBe('duplicate-record-id');
  });

  it('enforces the single-child rule in the database for a writer that bypasses the repository', async () => {
    const root = await appendOk(makeRecord());

    await appendOk(deltaOf(root, 2));

    const bypass = new DatabaseSync(store.path);
    let caught: unknown;

    try {
      insertRawRecord(bypass, deltaOf(root, 3));
    } catch (error) {
      caught = error;
    } finally {
      bypass.close();
    }

    // SQLITE_CONSTRAINT_UNIQUE from the partial unique index of schema v2; a
    // duplicate primary key would have been SQLITE_CONSTRAINT_PRIMARYKEY (1555).
    expect(errcodeOf(caught)).toBe(2067);
    expect(await repo.countBySession(SESSION_A)).toStrictEqual({ ok: true, value: 2 });
  });

  it('reports a second child the index refused as the same typed chain-fork conflict', async () => {
    const root = await appendOk(makeRecord());
    const racer = deltaOf(root, 2);
    const loser = deltaOf(root, 3);
    const racing = createModificationsRepo({
      store: storeThatInsertsFirst(store, racer),
      now: () => clock,
    });

    // The racer lands between this append's checks and its insert — the one
    // interval the checks cannot see — so only the index can refuse the loser.
    const appended = await racing.append(loser);

    expect(isErr(appended)).toBe(true);
    expect(isErr(appended) ? appended.error.code : undefined).toBe('MODIFICATION_CONFLICT');
    expect(isErr(appended) ? appended.error.details?.['reason'] : undefined).toBe(
      'chain-parent-has-child',
    );
    expect(isErr(appended) ? appended.error.details?.['detectedBy'] : undefined).toBe(
      'unique-index',
    );
    expect(isErr(appended) ? appended.error.details?.['previousRecordId'] : undefined).toBe(
      root.id,
    );

    // The refusal rolled the append's transaction back, the racer included.
    expect(readRow(loser.id)).toBeUndefined();
    expect(await idsOf(SESSION_A)).toEqual([root.id]);
  });

  it('migrates a version-1 store holding a pre-existing fork, keeps every row and refuses to extend the fork', async () => {
    const legacyDirectory = mkdtempSync(join(directory, 'legacy-v1-'));
    const legacyPath = join(legacyDirectory, 'sessions.sqlite');
    const parent = makeRecord({ status: 'applied' });
    const left = deltaOf(parent, 2);
    const right = makeRecord({
      planVersion: 2,
      originalHash: parent.instrumentedHash,
      instrumentedHash: hashOf('instrumented:right-branch'),
      previousRecordId: parent.id,
    });

    // A store written before schema version 2: the version-1 DDL, stamped 1,
    // holding a parent with two children — what two racing writers could leave.
    const legacy = new DatabaseSync(legacyPath);

    try {
      legacy.exec(unwrap(loadSchemaSql()));
      legacy.exec('PRAGMA user_version = 1');
      insertRawSession(legacy, SESSION_A);

      for (const record of [parent, left, right]) {
        insertRawRecord(legacy, record);
      }
    } finally {
      legacy.close();
    }

    const migrated = unwrap(
      openStore({
        databasePath: legacyPath,
        logger: createCapturingLogger(logs),
      }),
    );

    try {
      // The fresh store of `beforeEach` is at the current version, which is
      // the version the ladder must bring a legacy file to.
      expect(migrated.schemaVersion).toBe(store.schemaVersion);
      expect(store.schemaVersion).toBeGreaterThanOrEqual(2);

      // No row lost, none rewritten beyond the flag: every sibling of the fork
      // is marked, the parent is not.
      const rows = migrated
        .statement(
          `SELECT id, original_hash, instrumented_hash, backup_path, status, diff, previous_record_id, chain_fork
           FROM modifications ORDER BY rowid ASC`,
        )
        .all();

      // Spread because `node:sqlite` hands rows back with a null prototype.
      expect(rows.map((row) => ({ ...row }))).toStrictEqual(
        [parent, left, right].map((record) => ({
          id: record.id,
          original_hash: record.originalHash,
          instrumented_hash: record.instrumentedHash,
          backup_path: record.backupPath,
          status: record.status,
          diff: record.diff,
          previous_record_id: record.previousRecordId ?? null,
          chain_fork: record.id === parent.id ? 0 : 1,
        })),
      );
      expect(
        migrated
          .statement(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?`)
          .get('idx_modifications_previous_record_id_unique'),
      ).toBeDefined();
      expect(
        logs.some((entry) => entry.level === 'warn' && entry.fields['forkedRecords'] === 2),
      ).toBe(true);

      const journal = createModificationsRepo({ store: migrated, now: () => clock });

      // The migrated rows still read as records: the new column never reaches
      // a ModificationRecord.
      const chain = await journal.listChain(left.id);

      expect(chain.ok && chain.value).toStrictEqual([parent, left]);

      // A third child of the forked parent: refused, although the index exempts
      // the flagged siblings — the journal's check counts every child.
      const third = await journal.append(deltaOf(parent, 3));

      expect(isErr(third) ? third.error.details?.['reason'] : undefined).toBe(
        'chain-parent-has-child',
      );

      // Extending either branch: refused, because the other branch is an open
      // record off its line.
      const onLeft = await journal.append(deltaOf(left, 3));

      expect(isErr(onLeft) ? onLeft.error.details?.['reason'] : undefined).toBe(
        'chain-parent-not-head',
      );
      expect(isErr(onLeft) ? onLeft.error.details?.['openRecordIds'] : undefined).toEqual([
        right.id,
      ]);

      // And a fresh root over the forked file: refused while it is open.
      const root = await journal.append(makeRecord({ planVersion: 3 }));

      expect(isErr(root) ? root.error.details?.['reason'] : undefined).toBe(
        'chain-root-while-open',
      );
      expect(await journal.countBySession(SESSION_A)).toStrictEqual({ ok: true, value: 3 });
    } finally {
      migrated.close();
      rmSync(legacyDirectory, { recursive: true, force: true });
    }
  });

  it('migrates a version-1 rollback-then-retry chain without flagging it as a fork', async () => {
    const legacyDirectory = mkdtempSync(join(directory, 'legacy-v1-retry-'));
    const legacyPath = join(legacyDirectory, 'sessions.sqlite');
    const parent = makeRecord({ status: 'applied' });
    const rolledBack = makeRecord({
      planVersion: 2,
      status: 'reverted',
      originalHash: parent.instrumentedHash,
      instrumentedHash: hashOf('instrumented:rolled-back-delta'),
      previousRecordId: parent.id,
    });
    const retry = makeRecord({
      planVersion: 3,
      status: 'applied',
      originalHash: parent.instrumentedHash,
      instrumentedHash: hashOf('instrumented:retried-delta'),
      previousRecordId: parent.id,
    });

    // One reverted layer and one live layer on the same parent: the shape the
    // installer's delta rollback followed by a successful follow-up leaves, and
    // not a fork — the file can only hold the live layer's bytes.
    const legacy = new DatabaseSync(legacyPath);

    try {
      legacy.exec(unwrap(loadSchemaSql()));
      legacy.exec('PRAGMA user_version = 1');
      insertRawSession(legacy, SESSION_A);

      for (const record of [parent, rolledBack, retry]) {
        insertRawRecord(legacy, record);
      }
    } finally {
      legacy.close();
    }

    const migrated = unwrap(
      openStore({
        databasePath: legacyPath,
        logger: createCapturingLogger(logs),
      }),
    );

    try {
      expect(migrated.schemaVersion).toBe(store.schemaVersion);

      const flags = migrated
        .statement('SELECT id, chain_fork FROM modifications ORDER BY rowid ASC')
        .all()
        .map((row) => ({ ...row }));

      expect(flags).toStrictEqual([
        { id: parent.id, chain_fork: 0 },
        { id: rolledBack.id, chain_fork: 0 },
        { id: retry.id, chain_fork: 0 },
      ]);
      expect(logs.some((entry) => entry.fields['forkedRecords'] !== undefined)).toBe(false);

      const journal = createModificationsRepo({ store: migrated, now: () => clock });
      const head = await journal.latestRecordForFile(SESSION_A, parent.file);

      expect(head.ok && head.value?.id).toBe(retry.id);

      const next = await journal.append(deltaOf(retry, 4));

      expect(next.ok && next.value.previousRecordId).toBe(retry.id);
    } finally {
      migrated.close();
      rmSync(legacyDirectory, { recursive: true, force: true });
    }
  });
});

/* -------------------------------------------------------------------------------------------------
 * updateStatus and the transition matrix
 * ---------------------------------------------------------------------------------------------- */

describe('the transition matrix', () => {
  it('declares the lifecycle of AAP 0.5.1', () => {
    // A second, independent copy of the table: a change to the module has to be
    // made here too, which is where a reviewer sees it.
    expect(MODIFICATION_STATUS_TRANSITIONS).toStrictEqual({
      pending: ['applied', 'reverted', 'conflict', 'failed'],
      applied: ['reverted', 'conflict', 'failed'],
      conflict: ['reverted', 'failed'],
      failed: ['reverted', 'conflict'],
      reverted: [],
    });
  });

  it('covers every status, so no state is left without rules', () => {
    expect(Object.keys(MODIFICATION_STATUS_TRANSITIONS).sort()).toEqual(
      [...MODIFICATION_STATUSES].sort(),
    );
  });

  it('treats a same-status write as legal for every status', () => {
    for (const status of MODIFICATION_STATUSES) {
      expect(canTransitionModificationStatus(status, status)).toBe(true);
    }
  });

  it('leaves reverted terminal', () => {
    for (const status of MODIFICATION_STATUSES) {
      if (status !== 'reverted') {
        expect(canTransitionModificationStatus('reverted', status)).toBe(false);
      }
    }
  });
});

describe('updateStatus', () => {
  it('agrees with the documented lifecycle on every ordered pair', () => {
    let legalEdges = 0;

    for (const from of MODIFICATION_STATUSES) {
      for (const to of MODIFICATION_STATUSES) {
        const documented = from === to || DOCUMENTED_EDGES[from].includes(to);

        expect(canTransitionModificationStatus(from, to), `${from} → ${to}`).toBe(documented);

        if (from !== to && documented) {
          legalEdges += 1;
        }
      }
    }

    // 4 + 3 + 2 + 2 + 0: the edge count of AAP §0.5.1's lifecycle.
    expect(legalEdges).toBe(11);
  });

  for (const from of MODIFICATION_STATUSES) {
    for (const to of MODIFICATION_STATUSES) {
      const same = from === to;
      const legal = same || DOCUMENTED_EDGES[from].includes(to);
      const verb = same ? 'accepts as a no-op' : legal ? 'applies' : 'refuses';

      it(`${verb} ${from} → ${to}`, async () => {
        // Seeded through legal steps from `pending`, never with raw SQL, so the
        // matrix is proven with the calls the patcher and cleanup make.
        const seeded = await seedInStatus(from, { file: `src/${from}To${to}.ts` });
        const before = readRow(seeded.id);

        expect(before?.['status']).toBe(from);

        clock += 1_000;

        const updated = await repo.updateStatus(seeded.id, to);
        const reread = unwrap(await repo.get(seeded.id));

        if (same) {
          // An idempotent retry: accepted, and nothing is written.
          expect(updated).toStrictEqual({ ok: true, value: seeded });
          expect(reread).toStrictEqual(seeded);
          expect(readRow(seeded.id)?.['updated_at']).toBe(before?.['updated_at']);

          return;
        }

        if (legal) {
          // The returned record is what the store now holds, so a caller can
          // broadcast it without a second read.
          expect(updated.ok && updated.value.status).toBe(to);
          expect(updated.ok ? updated.value : undefined).toStrictEqual(reread);
          expect(readRow(seeded.id)?.['status']).toBe(to);
          expect(readRow(seeded.id)?.['updated_at']).toBe(clock);
          expect(readRow(seeded.id)?.['applied_at']).toBe(seeded.appliedAt);

          return;
        }

        const error = expectRefusal(updated, 'SESSION_INVALID_STATE');

        expect(error.details?.['reason']).toBe('illegal-status-transition');
        expect(error.details?.['from']).toBe(from);
        expect(error.details?.['to']).toBe(to);
        expect(error.hint).toContain('Re-read the record');

        // The refusal changed nothing: re-read, the row still describes the
        // file exactly as it did, which is what keeps a caller that lost track
        // from overwriting a developer's edit.
        expect(reread).toStrictEqual(seeded);
        expect(readRow(seeded.id)).toStrictEqual(before);
      });
    }
  }

  it('refuses a transition decided on a stale read, leaving the newer status in place', async () => {
    const record = await appendOk(makeRecord());

    // Caller one reads the record and decides, from `pending`, to mark it
    // applied once its rename lands…
    const stale = unwrap(await repo.get(record.id));

    expect(stale?.status).toBe('pending');

    // …while reconciliation, seeing the file still hold the original bytes,
    // closes the record first.
    clock += 1_000;
    unwrap(await repo.updateStatus(record.id, 'reverted'));

    clock += 1_000;

    const error = expectRefusal(
      await repo.updateStatus(record.id, 'applied'),
      'SESSION_INVALID_STATE',
    );

    // The refusal names the status the record really holds, and says what to
    // do: re-read before deciding again.
    expect(error.details?.['from']).toBe('reverted');
    expect(error.hint).toContain('Re-read the record');
    expect(unwrap(await repo.get(record.id))?.status).toBe('reverted');
    expect(readRow(record.id)?.['updated_at']).toBe(CLOCK_START + 1_000);
  });

  it('advances updated_at on every accepted transition and never moves applied_at', async () => {
    const record = await appendOk(makeRecord());

    expect(readRow(record.id)?.['updated_at']).toBe(CLOCK_START);

    const path: readonly ModificationStatus[] = ['applied', 'conflict', 'failed', 'reverted'];
    const stamps: number[] = [];

    for (const status of path) {
      clock += 1_500;

      const moved = unwrap(await repo.updateStatus(record.id, status));
      const row = readRow(record.id);

      expect(moved.status).toBe(status);
      expect(moved.appliedAt).toBe(record.appliedAt);
      expect(row?.['status']).toBe(status);
      expect(row?.['updated_at']).toBe(clock);
      expect(row?.['applied_at']).toBe(record.appliedAt);

      stamps.push(clock);
    }

    // Strictly increasing: each transition can be audited after the fact.
    expect(stamps).toStrictEqual([...stamps].sort((left, right) => left - right));
    expect(new Set(stamps).size).toBe(path.length);
  });

  it('returns the stored record without a second read', async () => {
    const record = await appendOk(makeRecord());

    clock += 2_500;

    const updated = await repo.updateStatus(record.id, 'applied', { appliedAt: clock });
    const read = await repo.get(record.id);

    expect(updated.ok && updated.value.appliedAt).toBe(clock);
    expect(read.ok && read.value).toStrictEqual(updated.ok ? updated.value : undefined);
  });

  it('writes only the columns the patch names', async () => {
    const record = await appendOk(makeRecord());
    const before = readRow(record.id);

    clock += 4_000;

    const revisedHash = hashOf('revised instrumented content');
    const updated = await repo.updateStatus(record.id, 'pending', {
      instrumentedHash: revisedHash,
      diff: `${DIFF}\n+// revised`,
    });

    expect(updated.ok).toBe(true);

    const after = readRow(record.id);

    expect(after?.['instrumented_hash']).toBe(revisedHash);
    expect(after?.['diff']).toBe(`${DIFF}\n+// revised`);
    // Untouched by this patch, even though the write happened later.
    expect(after?.['applied_at']).toBe(before?.['applied_at']);
    expect(after?.['original_hash']).toBe(before?.['original_hash']);
    expect(after?.['backup_path']).toBe(before?.['backup_path']);
    // Always refreshed, so a transition can be audited after the fact.
    expect(after?.['updated_at']).toBe(clock);
  });

  it('relocates a backup path for a conflicting record', async () => {
    const record = await appendOk(makeRecord({ status: 'applied' }));
    const relocated = join(directory, 'backups', 'quarantine', record.originalHash);
    const updated = await repo.updateStatus(record.id, 'conflict', { backupPath: relocated });

    expect(updated.ok && updated.value.backupPath).toBe(relocated);
    expect(readRow(record.id)?.['backup_path']).toBe(relocated);
  });

  it('accepts an idempotent retry without writing', async () => {
    const record = await appendOk(makeRecord({ status: 'conflict' }));
    const before = readRow(record.id);

    clock += 9_000;

    const updated = await repo.updateStatus(record.id, 'conflict');

    expect(updated.ok && updated.value).toStrictEqual(record);
    expect(readRow(record.id)?.['updated_at']).toBe(before?.['updated_at']);
  });

  it('refuses a patch that would store a record a later read could not parse', async () => {
    const record = await appendOk(makeRecord());
    const updated = await repo.updateStatus(record.id, 'applied', {
      instrumentedHash: 'not-a-hash',
    });

    expect(isErr(updated)).toBe(true);
    expect(isErr(updated) ? updated.error.code : undefined).toBe('INSTRUMENTATION_INSTALL_FAILED');

    const row = readRow(record.id);

    expect(row?.['status']).toBe('pending');
    expect(row?.['instrumented_hash']).toBe(record.instrumentedHash);
  });

  it('refuses a patch that would make the two hashes identical', async () => {
    const record = await appendOk(makeRecord());
    const updated = await repo.updateStatus(record.id, 'applied', {
      instrumentedHash: record.originalHash,
    });

    expect(isErr(updated)).toBe(true);
    expect(readRow(record.id)?.['status']).toBe('pending');
  });

  it('refuses a patch that would empty the diff', async () => {
    const record = await appendOk(makeRecord());
    const updated = await repo.updateStatus(record.id, 'applied', { diff: '   ' });

    expect(isErr(updated)).toBe(true);
    expect(readRow(record.id)?.['diff']).toBe(record.diff);
  });

  it('refuses an unknown record id', async () => {
    const updated = await repo.updateStatus('mod_0000000000000000', 'applied');

    expect(isErr(updated)).toBe(true);
    expect(isErr(updated) ? updated.error.code : undefined).toBe('STORE_ERROR');
    expect(isErr(updated) ? updated.error.details?.['reason'] : undefined).toBe('record-not-found');
  });

  it('refuses the write when the record moved underneath it', async () => {
    const record = await appendOk(makeRecord());

    // A store that lets another writer move the row between the read and the
    // guarded write, which is the race the optimistic guard exists for.
    const racing = createModificationsRepo({
      store: storeThatMovesTheRow(store, record.id, 'failed'),
      now: () => clock,
    });

    clock += 1_000;

    // The repository reads `pending` and binds it as the expected status of
    // its guarded `UPDATE … WHERE id = ? AND status = ?`; the other writer's
    // move to `failed` lands in between, so the expectation is stale by the
    // time the write runs.
    const error = expectRefusal(await racing.updateStatus(record.id, 'applied'), 'STORE_ERROR');

    expect(error.details?.['reason']).toBe('status-moved');
    expect(error.details?.['expected']).toBe('pending');
    expect(error.hint).toContain('re-read');

    // The other writer's value stands; this call wrote nothing.
    expect(readRow(record.id)?.['status']).toBe('failed');
    expect(unwrap(await repo.get(record.id))?.status).toBe('failed');
    expect(readRow(record.id)?.['updated_at']).toBe(CLOCK_START);
  });
});

/* -------------------------------------------------------------------------------------------------
 * Queries
 * ---------------------------------------------------------------------------------------------- */

describe('queries', () => {
  /**
   * Records across four sessions in four different session statuses —
   * `capturing` (A), `failed` (B), `ended` (C) and `generated` (D) — every one
   * brought to its status through legal steps, plus a three-link chain in D.
   */
  interface Seeded {
    readonly pendingA: ModificationRecord;
    readonly appliedA: ModificationRecord;
    readonly revertedA: ModificationRecord;
    readonly conflictA: ModificationRecord;
    readonly failedB: ModificationRecord;
    readonly revertedB: ModificationRecord;
    readonly conflictC: ModificationRecord;
    readonly chainD: readonly [ModificationRecord, ModificationRecord, ModificationRecord];
  }

  /** The file the seeded chain in session D patches three times. */
  const CHAIN_FILE = 'src/moduleChain.ts';

  let seeded: Seeded;

  /** Every seeded record, in the order it was appended. */
  function allSeeded(): readonly ModificationRecord[] {
    return [
      seeded.pendingA,
      seeded.appliedA,
      seeded.revertedA,
      seeded.conflictA,
      seeded.failedB,
      seeded.revertedB,
      seeded.conflictC,
      ...seeded.chainD,
    ];
  }

  /** The ids of `records` whose status is one of the upstream open statuses. */
  function openIdsOf(records: readonly ModificationRecord[]): string[] {
    const open: readonly ModificationStatus[] = OPEN_MODIFICATION_STATUSES;

    return records.filter((record) => open.includes(record.status)).map((record) => record.id);
  }

  /** Whether each session's records form one contiguous run in `records`. */
  function sessionsAreContiguous(records: readonly ModificationRecord[]): boolean {
    const finished = new Set<string>();
    let current: string | undefined;

    for (const record of records) {
      if (record.sessionId !== current) {
        if (finished.has(record.sessionId)) {
          return false;
        }

        if (current !== undefined) {
          finished.add(current);
        }

        current = record.sessionId;
      }
    }

    return true;
  }

  beforeEach(async () => {
    const pendingA = await seedInStatus('pending', { file: 'src/moduleA1.ts' });
    const appliedA = await seedInStatus('applied', { file: 'src/moduleA2.ts' });
    const revertedA = await seedInStatus('reverted', { file: 'src/moduleA3.ts' });
    const conflictA = await seedInStatus('conflict', { file: 'src/moduleA4.ts' });
    const failedB = await seedInStatus('failed', { sessionId: SESSION_B, file: 'src/moduleB1.ts' });
    const revertedB = await seedInStatus('reverted', {
      sessionId: SESSION_B,
      file: 'src/moduleB2.ts',
    });
    const conflictC = await seedInStatus('conflict', {
      sessionId: SESSION_C,
      file: 'src/moduleC1.ts',
    });

    // A follow-up chain in the `generated` session: plan version 1 applied,
    // plan version 2 layered on it and applied, plan version 3 journalled but
    // not yet written.
    const rootD = await seedInStatus('applied', { sessionId: SESSION_D, file: CHAIN_FILE });
    const middleD = await appendOk(
      makeRecord({
        sessionId: SESSION_D,
        file: CHAIN_FILE,
        planVersion: 2,
        originalHash: rootD.instrumentedHash,
        instrumentedHash: hashOf('instrumented:chain:plan-2'),
        previousRecordId: rootD.id,
      }),
    );

    clock += 1_000;

    const appliedMiddleD = unwrap(await repo.updateStatus(middleD.id, 'applied'));
    const headD = await appendOk(
      makeRecord({
        sessionId: SESSION_D,
        file: CHAIN_FILE,
        planVersion: 3,
        originalHash: appliedMiddleD.instrumentedHash,
        instrumentedHash: hashOf('instrumented:chain:plan-3'),
        previousRecordId: appliedMiddleD.id,
      }),
    );

    seeded = {
      pendingA,
      appliedA,
      revertedA,
      conflictA,
      failedB,
      revertedB,
      conflictC,
      chainD: [rootD, appliedMiddleD, headD],
    };
  });

  it('lists one session and nobody else, in append order', async () => {
    const listed = unwrap(await repo.listBySession(SESSION_A));

    expect(listed.map((entry) => entry.id)).toEqual([
      seeded.pendingA.id,
      seeded.appliedA.id,
      seeded.revertedA.id,
      seeded.conflictA.id,
    ]);
    expect(listed.every((entry) => entry.sessionId === SESSION_A)).toBe(true);
  });

  it('orders a session by applied_at, breaking ties by append order, and filters by status', async () => {
    // Appended out of timestamp order, with a tie, so the order the listing
    // gives can only come from `applied_at` first and insertion second.
    const later = await appendOk(
      makeRecord({ sessionId: SESSION_B, file: 'src/moduleB3.ts', appliedAt: clock + 50_000 }),
    );
    const earlier = await appendOk(
      makeRecord({ sessionId: SESSION_B, file: 'src/moduleB4.ts', appliedAt: clock + 10_000 }),
    );
    const tie = await appendOk(
      makeRecord({ sessionId: SESSION_B, file: 'src/moduleB5.ts', appliedAt: clock + 10_000 }),
    );
    const expected = [seeded.failedB.id, seeded.revertedB.id, earlier.id, tie.id, later.id];

    // Read twice: the order is a property of the data, not of a read.
    for (let read = 0; read < 2; read += 1) {
      const listed = unwrap(await repo.listBySession(SESSION_B));

      expect(listed.map((entry) => entry.id)).toEqual(expected);
    }

    const pending = unwrap(await repo.listBySession(SESSION_B, { statuses: ['pending'] }));

    expect(pending.map((entry) => entry.id)).toEqual([earlier.id, tie.id, later.id]);

    const failed = unwrap(await repo.listBySession(SESSION_B, { statuses: ['failed'] }));

    expect(failed.map((entry) => entry.id)).toEqual([seeded.failedB.id]);

    // A repeated status in the filter changes nothing.
    const repeated = unwrap(
      await repo.listBySession(SESSION_B, { statuses: ['failed', 'failed', 'reverted'] }),
    );

    expect(repeated.map((entry) => entry.id)).toEqual([seeded.failedB.id, seeded.revertedB.id]);
  });

  it('answers listOpen(session) with exactly the records in OPEN_MODIFICATION_STATUSES', async () => {
    // One record of every status in a single session, each reached legally.
    const perStatus: ModificationRecord[] = [];

    for (const status of MODIFICATION_STATUSES) {
      perStatus.push(
        await seedInStatus(status, { sessionId: SESSION_C, file: `src/moduleOf${status}.ts` }),
      );
    }

    const open = unwrap(await repo.listOpen(SESSION_C));
    const everyC = [seeded.conflictC, ...perStatus];

    // Derived from the imported constant, never from a list spelled here.
    expect(open.map((entry) => entry.id).sort()).toEqual(openIdsOf(everyC).sort());
    const listedPerStatus = perStatus.filter((entry) =>
      open.some((listed) => listed.id === entry.id),
    );

    expect(new Set(listedPerStatus.map((entry) => entry.status))).toEqual(
      new Set(OPEN_MODIFICATION_STATUSES),
    );
    expect(open.some((entry) => entry.status === 'reverted')).toBe(false);
    expect(open.every((entry) => entry.sessionId === SESSION_C)).toBe(true);
  });

  it('narrows a session listing by status', async () => {
    const reverted = await repo.listBySession(SESSION_A, { statuses: ['reverted'] });

    expect(reverted.ok && reverted.value.map((entry) => entry.id)).toEqual([seeded.revertedA.id]);

    const both = await repo.listBySession(SESSION_A, { statuses: ['pending', 'applied'] });

    expect(both.ok && both.value).toHaveLength(2);
  });

  it('answers an empty status filter with nothing rather than everything', async () => {
    const listed = await repo.listBySession(SESSION_A, { statuses: [] });

    expect(listed).toStrictEqual({ ok: true, value: [] });
  });

  it('reconciles every session, whatever status the session is in', async () => {
    const open = unwrap(await repo.listAllOpen());
    const ids = open.map((entry) => entry.id);

    // The parent sessions really are in four different statuses.
    expect(SESSIONS.map(([id]) => unwrap(sessions.get(id))?.status)).toEqual([
      'capturing',
      'failed',
      'ended',
      'generated',
    ]);

    // B is `failed`, C is `ended` and D is `generated`; their open records are
    // still on the list, because the files they describe are still patched.
    expect([...ids].sort()).toEqual(openIdsOf(allSeeded()).sort());
    expect(ids).toContain(seeded.failedB.id);
    expect(ids).toContain(seeded.conflictC.id);

    for (const link of seeded.chainD) {
      expect(ids).toContain(link.id);
    }

    // `reverted` is the one status with nothing left to do.
    expect(ids).not.toContain(seeded.revertedA.id);
    expect(ids).not.toContain(seeded.revertedB.id);
    expect(ids).toHaveLength(8);

    for (const record of open) {
      expect(OPEN_MODIFICATION_STATUSES).toContain(record.status);
    }
  });

  it('orders the reconciliation set by session, with a chain in application order', async () => {
    const open = unwrap(await repo.listAllOpen());

    // Each session's records are one contiguous run…
    expect(sessionsAreContiguous(open)).toBe(true);

    // …and within session D the chain comes root → middle → head, the order it
    // was applied in and the order a newest-first restore reverses.
    const chainIds = seeded.chainD.map((link) => link.id);

    expect(open.filter((entry) => chainIds.includes(entry.id)).map((entry) => entry.id)).toEqual(
      chainIds,
    );

    const inD = open.filter((entry) => entry.sessionId === SESSION_D);

    expect(inD.map((entry) => entry.planVersion)).toEqual([1, 2, 3]);
  });

  it('never consults sessions.status: moving every session leaves the set unchanged', async () => {
    const before = unwrap(await repo.listAllOpen());

    // Every session driven to a terminal status — the states a status-aware
    // query would be most tempted to skip.
    for (const [id] of SESSIONS) {
      clock += 1_000;
      unwrap(sessions.setStatus(id, id === SESSION_B ? 'ended' : 'failed'));
    }

    expect(unwrap(await repo.listAllOpen())).toStrictEqual(before);
    expect(unwrap(await repo.listOpen())).toStrictEqual(before);
  });

  it('answers listOpen() exactly as listAllOpen(), and listOpen(session) for one session', async () => {
    const all = await repo.listOpen();
    const viaAll = await repo.listAllOpen();

    expect(all.ok && all.value).toStrictEqual(viaAll.ok ? viaAll.value : undefined);

    const one = await repo.listOpen(SESSION_A);

    expect(one.ok && one.value.map((entry) => entry.id).sort()).toEqual(
      [seeded.pendingA.id, seeded.appliedA.id, seeded.conflictA.id].sort(),
    );
  });

  it('lists conflicts for reporting and for the retention exemption', async () => {
    const all = await repo.listConflicts();

    expect(all.ok && all.value.map((entry) => entry.id).sort()).toEqual(
      [seeded.conflictA.id, seeded.conflictC.id].sort(),
    );

    const one = await repo.listConflicts(SESSION_A);

    expect(one.ok && one.value.map((entry) => entry.id)).toEqual([seeded.conflictA.id]);
  });

  it('names exactly the conflict-backed paths retention must never delete', async () => {
    // The exemption rule of the retention sweep reads both queries; they must
    // agree with each other and with the conflicting records themselves.
    const conflicts = unwrap(await repo.listConflicts());
    const exempt = unwrap(await repo.listBackupPaths({ statuses: ['conflict'] }));

    expect(conflicts.every((entry) => entry.status === 'conflict')).toBe(true);
    expect(exempt).toEqual([...new Set(conflicts.map((entry) => entry.backupPath))].sort());
    expect(exempt).toEqual([seeded.conflictA.backupPath, seeded.conflictC.backupPath].sort());

    // Resolving one conflict (a verified restore) takes its path off the list.
    clock += 1_000;
    unwrap(await repo.updateStatus(seeded.conflictA.id, 'reverted'));

    expect(unwrap(await repo.listBackupPaths({ statuses: ['conflict'] }))).toEqual([
      seeded.conflictC.backupPath,
    ]);
    expect(unwrap(await repo.listConflicts()).map((entry) => entry.id)).toEqual([
      seeded.conflictC.id,
    ]);
  });

  it('lists the distinct backup paths retention needs', async () => {
    const all = await repo.listBackupPaths();

    expect(all.ok && all.value).toHaveLength(allSeeded().length);
    expect(all.ok && all.value).toStrictEqual([...(all.ok ? all.value : [])].sort());

    const conflicts = await repo.listBackupPaths({ statuses: ['conflict'] });

    expect(conflicts.ok && conflicts.value.sort()).toEqual(
      [seeded.conflictA.backupPath, seeded.conflictC.backupPath].sort(),
    );

    const session = await repo.listBackupPaths({ sessionId: SESSION_B });

    expect(session.ok && session.value.sort()).toEqual(
      [seeded.failedB.backupPath, seeded.revertedB.backupPath].sort(),
    );

    const both = await repo.listBackupPaths({ sessionId: SESSION_A, statuses: ['conflict'] });

    expect(both.ok && both.value).toEqual([seeded.conflictA.backupPath]);

    const none = await repo.listBackupPaths({ statuses: [] });

    expect(none).toStrictEqual({ ok: true, value: [] });
  });

  it('deduplicates a backup path two records share', async () => {
    const shared = backupPathOf(SESSION_A, hashOf('shared original'));

    await appendOk(makeRecord({ file: 'src/share-1.ts', backupPath: shared }));
    await appendOk(makeRecord({ file: 'src/share-2.ts', backupPath: shared }));

    const paths = await repo.listBackupPaths({ sessionId: SESSION_A });

    expect(paths.ok && paths.value.filter((path) => path === shared)).toHaveLength(1);
  });

  it('counts and purges one session only', async () => {
    const before = await repo.countBySession(SESSION_A);

    expect(before).toStrictEqual({ ok: true, value: 4 });

    const deleted = await repo.deleteBySession(SESSION_A);

    expect(deleted).toStrictEqual({ ok: true, value: 4 });

    const after = await repo.countBySession(SESSION_A);

    expect(after).toStrictEqual({ ok: true, value: 0 });

    const other = await repo.countBySession(SESSION_B);

    expect(other).toStrictEqual({ ok: true, value: 2 });
  });

  it('goes with the session it belongs to', async () => {
    /** Counts rows straight from the table, bypassing the repository. */
    const rowsOf = (sessionId: SessionId): unknown =>
      store
        .statement('SELECT COUNT(*) AS total FROM modifications WHERE session_id = ?')
        .get(sessionId)?.['total'];

    // Accurate beforehand, and in agreement with the table itself.
    expect(await repo.countBySession(SESSION_A)).toStrictEqual({ ok: true, value: 4 });
    expect(rowsOf(SESSION_A)).toBe(4);
    expect(await repo.countBySession(SESSION_D)).toStrictEqual({ ok: true, value: 3 });

    // The session repository's delete: the `ON DELETE CASCADE` edge takes the
    // journal rows with it, which is why retention must check first.
    expect(sessions.delete(SESSION_A)).toStrictEqual({ ok: true, value: 1 });

    expect(rowsOf(SESSION_A)).toBe(0);
    expect(await repo.countBySession(SESSION_A)).toStrictEqual({ ok: true, value: 0 });
    expect(await repo.listBySession(SESSION_A)).toStrictEqual({ ok: true, value: [] });

    // Nobody else's records moved.
    expect(rowsOf(SESSION_B)).toBe(2);
    expect(await repo.countBySession(SESSION_B)).toStrictEqual({ ok: true, value: 2 });
    expect(unwrap(await repo.listAllOpen()).some((entry) => entry.sessionId === SESSION_A)).toBe(
      false,
    );
  });

  it('reports absence rather than failure for a record and a file it does not hold', async () => {
    const record = await repo.get('mod_0000000000000000');

    expect(record).toStrictEqual({ ok: true, value: undefined });

    const head = await repo.latestRecordForFile(SESSION_A, 'src/never-touched.ts');

    expect(head).toStrictEqual({ ok: true, value: undefined });

    const byFile = await repo.listByFile(SESSION_A, 'src/never-touched.ts');

    expect(byFile).toStrictEqual({ ok: true, value: [] });
  });

  it('refuses a status filter naming something outside the vocabulary', async () => {
    // Reachable only from JavaScript, which is why the cast is the test: a
    // silently dropped filter would answer with rows the caller excluded.
    const listed = await repo.listBySession(SESSION_A, {
      statuses: ['applied', 'not-a-status'] as unknown as readonly ModificationStatus[],
    });

    expect(isErr(listed)).toBe(true);
    expect(isErr(listed) ? listed.error.details?.['reason'] : undefined).toBe('unknown-status');
  });

  it('fails a read whose row is no longer a record, naming the id only', async () => {
    insertCorruptRow('mod_corruptrow00000', 'src/corrupt.ts', `${DIFF}\n+// ${SENTINEL}`);

    const listed = await repo.listBySession(SESSION_A);

    expect(isErr(listed)).toBe(true);
    expect(isErr(listed) ? listed.error.code : undefined).toBe('STORE_ERROR');
    expect(isErr(listed) ? listed.error.details?.['recordId'] : undefined).toBe(
      'mod_corruptrow00000',
    );
    expect(JSON.stringify(isErr(listed) ? listed.error.toPayload() : {})).not.toContain(SENTINEL);
  });
});

/* -------------------------------------------------------------------------------------------------
 * The ingest path's metadata-only read
 * ---------------------------------------------------------------------------------------------- */

describe('listCorroborationsBySession', () => {
  /** The corroboration facts a full record implies. */
  function factsOf(records: readonly ModificationRecord[]): object[] {
    return records.map((record) => ({
      file: record.file,
      status: record.status,
      appliedAt: record.appliedAt,
    }));
  }

  it('answers file, status and applied time only, in the append order listBySession keeps', async () => {
    const applied = await seedInStatus('applied', { file: FILE_ONE });
    clock += 1_000;
    // Two appends inside one millisecond: only insertion order tells them apart.
    const pendingTwo = await appendOk(makeRecord({ file: FILE_TWO }));
    const pendingThree = await appendOk(makeRecord({ file: 'src/moduleThree.ts' }));
    await appendOk(makeRecord({ sessionId: SESSION_B, file: FILE_ONE }));

    const listed = unwrap(await repo.listCorroborationsBySession(SESSION_A));

    expect(listed).toStrictEqual(factsOf([applied, pendingTwo, pendingThree]));
    expect(listed).toStrictEqual(factsOf(unwrap(await repo.listBySession(SESSION_A))));
    for (const fact of listed) {
      expect(Object.keys(fact).sort()).toEqual(['appliedAt', 'file', 'status']);
    }
  });

  it('keeps other sessions out and answers an empty list for a session with no records', async () => {
    await appendOk(makeRecord({ sessionId: SESSION_B, file: FILE_ONE }));

    expect(unwrap(await repo.listCorroborationsBySession(SESSION_A))).toEqual([]);
    expect(unwrap(await repo.listCorroborationsBySession(SESSION_C))).toEqual([]);
    expect(unwrap(await repo.listCorroborationsBySession(SESSION_B))).toHaveLength(1);
  });

  it('selects none of the columns only a restore or a display needs', async () => {
    await appendOk(makeRecord({ diff: `${DIFF}\n+// ${SENTINEL}` }));
    const statements: string[] = [];
    const reader = createModificationsRepo({ store: recordingStore(store, statements) });

    const listed = unwrap(await reader.listCorroborationsBySession(SESSION_A));

    expect(listed).toHaveLength(1);
    expect(statements).toHaveLength(1);
    for (const sql of statements) {
      for (const column of ['diff', 'backup_path', 'original_hash', 'instrumented_hash']) {
        expect(sql).not.toContain(column);
      }
    }
    expect(JSON.stringify(listed)).not.toContain(SENTINEL);
  });

  it('fails the read on a corrupt column, naming the column and never the value', async () => {
    insertCorruptRow('mod_corruptfile0000', '', `${DIFF}\n+// ${SENTINEL}`);

    const blankFile = await repo.listCorroborationsBySession(SESSION_A);

    const fileError = expectRefusal(blankFile, 'STORE_ERROR');
    expect(fileError.details).toMatchObject({
      operation: 'listCorroborationsBySession',
      column: 'file',
    });
    expect(errorText(fileError)).not.toContain(SENTINEL);

    store.statement('DELETE FROM modifications WHERE id = ?').run('mod_corruptfile0000');
    const record = await appendOk(makeRecord({ sessionId: SESSION_D }));
    // Only a writer that switched the CHECK constraint off can store this status.
    store.db.exec('PRAGMA ignore_check_constraints = ON');
    store
      .statement('UPDATE modifications SET status = ? WHERE id = ?')
      .run('status-from-elsewhere', record.id);
    store.db.exec('PRAGMA ignore_check_constraints = OFF');

    const statusError = expectRefusal(
      await repo.listCorroborationsBySession(SESSION_D),
      'STORE_ERROR',
    );
    expect(statusError.details).toMatchObject({
      operation: 'listCorroborationsBySession',
      column: 'status',
    });
    expect(errorText(statusError)).not.toContain('status-from-elsewhere');
  });
});

/* -------------------------------------------------------------------------------------------------
 * The source resolver's per-file patch evidence
 * ---------------------------------------------------------------------------------------------- */

describe('listPatchEvidenceBySessionFile', () => {
  /** The patch evidence a full record implies. */
  function evidenceOf(records: readonly ModificationRecord[]): object[] {
    return records.map((record) => ({
      file: record.file,
      status: record.status,
      appliedAt: record.appliedAt,
      diff: record.diff,
    }));
  }

  it('answers file, status, applied time and diff of one file only, in append order', async () => {
    const applied = await seedInStatus('applied', { file: FILE_ONE, diff: `${DIFF}\n+// one` });
    await appendOk(makeRecord({ file: FILE_TWO }));
    // A delta of the same file, chained to the record it builds on.
    const delta = await appendOk(
      makeRecord({
        file: FILE_ONE,
        planVersion: 2,
        originalHash: applied.instrumentedHash,
        instrumentedHash: hashOf('instrumented:plan-2'),
        previousRecordId: applied.id,
        diff: `${DIFF}\n+// two`,
      }),
    );
    await appendOk(makeRecord({ sessionId: SESSION_B, file: FILE_ONE }));

    const listed = unwrap(await repo.listPatchEvidenceBySessionFile(SESSION_A, FILE_ONE));

    expect(listed).toStrictEqual(evidenceOf([applied, delta]));
    for (const fact of listed) {
      expect(Object.keys(fact).sort()).toEqual(['appliedAt', 'diff', 'file', 'status']);
    }
  });

  it('matches the stored file exactly and keeps other sessions out', async () => {
    await appendOk(makeRecord({ file: FILE_ONE }));
    await appendOk(makeRecord({ sessionId: SESSION_B, file: FILE_TWO }));

    expect(unwrap(await repo.listPatchEvidenceBySessionFile(SESSION_A, `./${FILE_ONE}`))).toEqual(
      [],
    );
    expect(
      unwrap(await repo.listPatchEvidenceBySessionFile(SESSION_A, FILE_ONE.toUpperCase())),
    ).toEqual([]);
    expect(unwrap(await repo.listPatchEvidenceBySessionFile(SESSION_A, FILE_TWO))).toEqual([]);
    expect(unwrap(await repo.listPatchEvidenceBySessionFile(SESSION_C, FILE_ONE))).toEqual([]);
    expect(unwrap(await repo.listPatchEvidenceBySessionFile(SESSION_B, FILE_TWO))).toHaveLength(1);
  });

  it('reads with one statement that names no restore-only column', async () => {
    await appendOk(makeRecord({ file: FILE_ONE }));
    const statements: string[] = [];
    const reader = createModificationsRepo({ store: recordingStore(store, statements) });

    expect(unwrap(await reader.listPatchEvidenceBySessionFile(SESSION_A, FILE_ONE))).toHaveLength(
      1,
    );
    expect(statements).toHaveLength(1);
    for (const sql of statements) {
      for (const column of ['backup_path', 'original_hash', 'instrumented_hash']) {
        expect(sql).not.toContain(column);
      }
    }
  });

  it('fails the read on a corrupt column, naming the column and never the value', async () => {
    insertCorruptRow('mod_corruptfile0000', '', `${DIFF}\n+// ${SENTINEL}`);

    const refused = expectRefusal(
      await repo.listPatchEvidenceBySessionFile(SESSION_A, ''),
      'STORE_ERROR',
    );
    expect(refused.details).toMatchObject({
      operation: 'listPatchEvidenceBySessionFile',
      column: 'file',
    });
    expect(errorText(refused)).not.toContain(SENTINEL);
  });
});

/* -------------------------------------------------------------------------------------------------
 * Privacy
 * ---------------------------------------------------------------------------------------------- */

describe('privacy', () => {
  it('journals a diff without ever logging it', async () => {
    const diff = `${DIFF}\n+// ${SENTINEL}`;
    const record = await appendOk(makeRecord({ diff }));

    clock += 1_000;
    await repo.updateStatus(record.id, 'applied', { appliedAt: clock });
    clock += 1_000;
    await repo.updateStatus(record.id, 'reverted', { appliedAt: clock });

    // Stored verbatim: the developer is shown this diff rather than the file.
    expect(readRow(record.id)?.['diff']).toBe(diff);

    const text = loggedText();

    expect(text).not.toContain(SENTINEL);
    expect(text).not.toContain(record.originalHash);
    expect(text).not.toContain(record.instrumentedHash);
    expect(text).not.toContain(record.backupPath);

    // What a log record does carry, so the omissions above are not simply the
    // absence of logging.
    expect(text).toContain(record.id);
    expect(text).toContain(record.file);
    expect(logs.some((entry) => entry.message === 'a modification was journalled')).toBe(true);
  });

  it('keeps a refused record out of the error it answers with', async () => {
    const hash = hashOf('unchanged content');
    const error = expectRefusal(
      await repo.append(
        makeRecord({ diff: SENTINEL_DIFF, originalHash: hash, instrumentedHash: hash }),
      ),
      'INSTRUMENTATION_INSTALL_FAILED',
    );

    expect(errorText(error)).not.toContain(SENTINEL);
    expect(errorText(error)).not.toContain(hash);
    expect(loggedText()).not.toContain(SENTINEL);
  });

  it('carries no diff content in any log line or refusal, on every path', async () => {
    // The success path first: a sentinel-bearing record journalled, moved and
    // read back through every query.
    const kept = await appendOk(makeRecord({ diff: SENTINEL_DIFF }));

    clock += 1_000;
    unwrap(await repo.updateStatus(kept.id, 'applied', { appliedAt: clock }));

    unwrap(await repo.listBySession(SESSION_A));
    unwrap(await repo.listOpen(SESSION_A));
    unwrap(await repo.listAllOpen());
    unwrap(await repo.listByFile(SESSION_A, FILE_ONE));
    unwrap(await repo.latestRecordForFile(SESSION_A, FILE_ONE));
    unwrap(await repo.listChain(kept.id));
    unwrap(await repo.listConflicts());
    unwrap(await repo.listBackupPaths());

    // Then every refusal path, each offered the same sentinel-bearing diff.
    const fresh = (overrides: RecordOverrides = {}): ModificationRecord =>
      makeRecord({ file: FILE_TWO, diff: SENTINEL_DIFF, ...overrides });
    const template = fresh();
    const racing = createModificationsRepo({
      store: storeThatMovesTheRow(store, kept.id, 'conflict'),
      logger: createCapturingLogger(logs),
      now: () => clock,
    });

    const refusals: ReadonlyArray<readonly [DebuggenError['code'], Result<unknown>]> = [
      ['INSTRUMENTATION_INSTALL_FAILED', await repo.append({ ...template, backupPath: ' ' })],
      [
        'INSTRUMENTATION_INSTALL_FAILED',
        await repo.append({ ...template, instrumentedHash: template.originalHash }),
      ],
      [
        'INSTRUMENTATION_INSTALL_FAILED',
        await repo.append({ ...template, originalHash: 'e'.repeat(63) }),
      ],
      [
        'INSTRUMENTATION_INSTALL_FAILED',
        await repo.append({ ...template, file: '../outside/moduleTwo.ts' }),
      ],
      ['STORE_ERROR', await repo.append({ ...template, sessionId: newSessionId() })],
      ['STORE_ERROR', await repo.append(kept)],
      [
        'MODIFICATION_CONFLICT',
        await repo.append(
          fresh({
            file: FILE_ONE,
            planVersion: 2,
            originalHash: hashOf('drifted content'),
            previousRecordId: kept.id,
          }),
        ),
      ],
      [
        'INSTRUMENTATION_INSTALL_FAILED',
        await repo.append(
          fresh({
            sessionId: SESSION_B,
            file: FILE_ONE,
            planVersion: 2,
            originalHash: kept.instrumentedHash,
            instrumentedHash: hashOf('instrumented:other-session'),
            previousRecordId: kept.id,
          }),
        ),
      ],
      ['MODIFICATION_CONFLICT', await repo.append(fresh({ file: FILE_ONE, planVersion: 2 }))],
      [
        'INSTRUMENTATION_INSTALL_FAILED',
        await repo.updateStatus(kept.id, 'applied', { instrumentedHash: 'not-a-digest' }),
      ],
      ['SESSION_INVALID_STATE', await repo.updateStatus(kept.id, 'pending')],
      ['STORE_ERROR', await racing.updateStatus(kept.id, 'reverted')],
      ['STORE_ERROR', await repo.listChain('mod_0000000000000000')],
    ];

    for (const [code, result] of refusals) {
      const error = expectRefusal(result, code);

      expect(errorText(error)).not.toContain(SENTINEL);
      expect(errorText(error)).not.toContain(kept.backupPath);
    }

    // Nothing the store, the sessions repository or the journal logged — on
    // any of the paths above — carries the diff, a digest or a backup path.
    const text = loggedText();

    expect(logs.length).toBeGreaterThan(refusals.length);
    expect(text).not.toContain(SENTINEL);
    expect(text).not.toContain(kept.originalHash);
    expect(text).not.toContain(kept.instrumentedHash);
    expect(text).not.toContain(kept.backupPath);

    for (const entry of logs) {
      expect(`${entry.message} ${JSON.stringify(entry.fields)}`).not.toContain(SENTINEL);
    }
  });
});

/* -------------------------------------------------------------------------------------------------
 * Test doubles
 * ---------------------------------------------------------------------------------------------- */

/**
 * A {@link Store} that moves one record's status the moment the repository
 * prepares its guarded `UPDATE`.
 *
 * Everything in this stack is synchronous, so a concurrent writer cannot be
 * simulated with a second task: the only seam between the repository's read and
 * its write is the `statement` call it makes for the generated `UPDATE`. The
 * sneaky write goes through the wrapped store rather than through this wrapper,
 * so it cannot recurse, and it happens inside the repository's own transaction
 * on the same connection — exactly the visibility a real racing writer would
 * have after committing.
 */
function storeThatMovesTheRow(target: Store, recordId: string, moveTo: ModificationStatus): Store {
  let moved = false;

  return {
    get path(): string {
      return target.path;
    },
    get db(): DatabaseSync {
      return target.db;
    },
    get schemaVersion(): number {
      return target.schemaVersion;
    },
    get isClosed(): boolean {
      return target.isClosed;
    },
    statement(sql: string) {
      if (!moved && sql.startsWith('UPDATE modifications SET status')) {
        moved = true;
        target.statement('UPDATE modifications SET status = ? WHERE id = ?').run(moveTo, recordId);
      }

      return target.statement(sql);
    },
    transaction<T>(fn: () => T): T {
      return target.transaction(fn);
    },
    checkpoint(): void {
      target.checkpoint();
    },
    close(): void {
      target.close();
    },
  };
}

/**
 * A {@link Store} on which another writer inserts `racer` immediately before
 * the repository's own `INSERT` runs — after every check `append` makes.
 *
 * The same seam as {@link storeThatMovesTheRow}: everything here is
 * synchronous, so the only interval between a check and its insert is the
 * `statement` call that prepares the insert. The racer is written through the
 * underlying connection rather than through this wrapper, so it cannot recurse,
 * and inside the repository's transaction, so a rollback takes it too.
 */
function storeThatInsertsFirst(target: Store, racer: ModificationRecord): Store {
  let raced = false;

  return {
    get path(): string {
      return target.path;
    },
    get db(): DatabaseSync {
      return target.db;
    },
    get schemaVersion(): number {
      return target.schemaVersion;
    },
    get isClosed(): boolean {
      return target.isClosed;
    },
    statement(sql: string) {
      if (!raced && sql.startsWith('INSERT INTO modifications')) {
        raced = true;
        insertRawRecord(target.db, racer);
      }

      return target.statement(sql);
    },
    transaction<T>(fn: () => T): T {
      return target.transaction(fn);
    },
    checkpoint(): void {
      target.checkpoint();
    },
    close(): void {
      target.close();
    },
  };
}

/**
 * Writes a record's row with raw SQL, the way a writer that bypasses the
 * repository — another process, an older build, a hand edit — would.
 *
 * Names the version-1 columns only, so `chain_fork` takes its default and the
 * same helper serves a version-1 file and a migrated one.
 */
function insertRawRecord(db: DatabaseSync, record: ModificationRecord): void {
  db.prepare(
    `INSERT INTO modifications (
       id, session_id, plan_version, file, original_hash, backup_path,
       instrumented_hash, applied_at, updated_at, status, diff, previous_record_id
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    record.id,
    record.sessionId,
    record.planVersion,
    record.file,
    record.originalHash,
    record.backupPath,
    record.instrumentedHash,
    record.appliedAt,
    record.appliedAt,
    record.status,
    record.diff,
    record.previousRecordId ?? null,
  );
}

/** Writes the `sessions` row a record's foreign key needs, on a raw connection. */
function insertRawSession(db: DatabaseSync, sessionId: string): void {
  db.prepare(
    `INSERT INTO sessions (
       id, project_root, project_name, status, question, dev_server_url, created_at, updated_at, record
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    sessionId,
    '/workspace/project-one',
    'project-one',
    'capturing',
    'Why is handlerAlpha slow?',
    'http://127.0.0.1:3100/',
    clock,
    clock,
    '{}',
  );
}

/** The extended SQLite result code a `node:sqlite` error carries, if any. */
function errcodeOf(value: unknown): unknown {
  return typeof value === 'object' && value !== null && 'errcode' in value
    ? value.errcode
    : undefined;
}

/**
 * Inserts a row that is in the table but is not a record.
 *
 * Written with raw SQL on purpose: `append` refuses this shape, so the only way
 * to reach the corrupt-row path is to plant one the way a different build of
 * the product or a hand-edited database would.
 */
function insertCorruptRow(id: string, file: string, diff: string): void {
  store
    .statement(
      `INSERT INTO modifications (
         id, session_id, plan_version, file, original_hash, backup_path,
         instrumented_hash, applied_at, updated_at, status, diff, previous_record_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    )
    .run(
      id,
      SESSION_A,
      1,
      file,
      'NOT-A-SHA256-DIGEST',
      backupPathOf(SESSION_A, 'original'),
      'ALSO-NOT-A-SHA256-DIGEST',
      clock,
      clock,
      'pending',
      diff,
    );
}

/**
 * A {@link Store} that records the text of every statement the repository
 * prepares and otherwise behaves exactly as `target`: the seam that shows
 * which columns a read asks SQLite for.
 */
function recordingStore(target: Store, sink: string[]): Store {
  return {
    get path(): string {
      return target.path;
    },
    get db(): DatabaseSync {
      return target.db;
    },
    get schemaVersion(): number {
      return target.schemaVersion;
    },
    get isClosed(): boolean {
      return target.isClosed;
    },
    statement(sql: string) {
      sink.push(sql);
      return target.statement(sql);
    },
    transaction<T>(fn: () => T): T {
      return target.transaction(fn);
    },
    checkpoint(): void {
      target.checkpoint();
    },
    close(): void {
      target.close();
    },
  };
}

/* -------------------------------------------------------------------------------------------------
 * listPageBySession — one diff-budgeted page of the journal
 * ---------------------------------------------------------------------------------------------- */

/**
 * A diff of exactly `length` UTF-16 code units: the fixture diff, padded with
 * `filler`, so the journal accepts it as the patcher's output.
 *
 * @param length The diff's `string.length`; at least the fixture diff's.
 * @param filler One code unit of padding — `'+'` is one UTF-8 byte, `'€'` three.
 * @returns The diff.
 */
function diffOfLength(length: number, filler = '+'): string {
  return length <= DIFF.length ? DIFF : `${DIFF}${filler.repeat(length - DIFF.length)}`;
}

/** One statement call the page read made, as {@link recordStatementCalls} saw it. */
interface StatementCall {
  readonly sql: string;
  readonly method: string;
  readonly args: readonly unknown[];
}

/**
 * Records every statement the store prepares for the rest of the test, and
 * every `get`, `all` and `iterate` call made on it with its bound values — so
 * a test can say which rows a read asked SQLite for, not only what it returned.
 *
 * @returns The calls, in order; filled as the test runs.
 */
function recordStatementCalls(): StatementCall[] {
  const calls: StatementCall[] = [];
  const statement = store.statement.bind(store);

  vi.spyOn(store, 'statement').mockImplementation((sql: string) => {
    const prepared = statement(sql);

    return new Proxy(prepared, {
      get(target, property, receiver): unknown {
        const value: unknown = Reflect.get(target, property, receiver);

        if (
          typeof value === 'function' &&
          (property === 'get' || property === 'all' || property === 'iterate')
        ) {
          return (...args: unknown[]): unknown => {
            calls.push({ sql, method: property, args });
            return Reflect.apply(value, target, args);
          };
        }

        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  });

  return calls;
}

/** How many files {@link appendJournal} has patched, so every call names fresh ones. */
let pagedFiles = 0;

/**
 * Appends `count` records of one session, each patching a file no earlier
 * record patched so no chain rule applies, each carrying `diff` itself when
 * it is a string, or the fixture diff padded to `diff` code units
 * ({@link diffOfLength}) when it is a number.
 *
 * @param count How many records to append.
 * @param diff Every record's diff, or its length in code units.
 * @param sessionId The owning session.
 * @returns The records as journalled, in append order.
 */
async function appendJournal(
  count: number,
  diff: number | string = DIFF.length,
  sessionId: SessionId = SESSION_A,
): Promise<ModificationRecord[]> {
  const appended: ModificationRecord[] = [];

  for (let index = 0; index < count; index += 1) {
    pagedFiles += 1;
    appended.push(
      await appendOk(
        makeRecord({
          sessionId,
          file: `src/paged${String(pagedFiles)}.ts`,
          diff: typeof diff === 'number' ? diffOfLength(diff) : diff,
        }),
      ),
    );
  }

  return appended;
}

describe('listPageBySession', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('pages the journal in the application order listBySession uses, with its total', async () => {
    // Two appends share a millisecond: the rowid tie-breaker keeps append order.
    const first = await appendJournal(2);
    clock += 1;
    const rest = await appendJournal(3);
    await appendJournal(2, DIFF.length, SESSION_B);

    const pages = [
      unwrap(await repo.listPageBySession(SESSION_A, { limit: 2, offset: 0 })),
      unwrap(await repo.listPageBySession(SESSION_A, { limit: 2, offset: 2 })),
      unwrap(await repo.listPageBySession(SESSION_A, { limit: 2, offset: 4 })),
    ];
    const whole = unwrap(await repo.listBySession(SESSION_A));

    expect(pages.map((page) => page.total)).toEqual([5, 5, 5]);
    expect(pages.map((page) => page.records.length)).toEqual([2, 2, 1]);
    expect(pages.flatMap((page) => page.records)).toEqual(whole);
    expect(whole.map((record) => record.id)).toEqual(
      [...first, ...rest].map((record) => record.id),
    );
    expect(pages.flatMap((page) => page.records).every((r) => r.sessionId === SESSION_A)).toBe(
      true,
    );
  });

  it('ends a page early rather than let its diffs exceed the default budget in UTF-8 bytes', async () => {
    // A million code units of '€' each: three bytes a unit, so two diffs fit
    // the 6 MiB budget and a third does not — although all three together hold
    // fewer code units than the budget, which a code-unit measure would admit.
    const records = await appendJournal(3, diffOfLength(1_000_000, '€'));
    expect(records.reduce((units, record) => units + record.diff.length, 0)).toBeLessThan(
      MODIFICATIONS_PAGE_DIFF_BUDGET,
    );

    const head = unwrap(await repo.listPageBySession(SESSION_A, { limit: 256, offset: 0 }));
    const tail = unwrap(await repo.listPageBySession(SESSION_A, { limit: 256, offset: 2 }));

    expect(head.total).toBe(3);
    expect(head.records.map((record) => record.id)).toEqual(
      records.slice(0, 2).map((record) => record.id),
    );
    expect(modificationsDiffBytes(head.records)).toBeLessThanOrEqual(
      MODIFICATIONS_PAGE_DIFF_BUDGET,
    );
    expect(modificationsDiffBytes([...head.records, ...tail.records])).toBeGreaterThan(
      MODIFICATIONS_PAGE_DIFF_BUDGET,
    );
    expect(tail.records.map((record) => record.id)).toEqual([records[2]?.id]);
  });

  it('always carries at least one record, even when one diff fills the whole budget', async () => {
    // The largest diff the journal accepts, in bytes: every code unit '€'.
    const records = await appendJournal(3, '€'.repeat(MAX_MODIFICATION_DIFF_LENGTH));
    expect(MODIFICATIONS_PAGE_DIFF_BUDGET).toBe(MODIFICATION_DIFF_MAX_BYTES);

    for (const [offset, record] of records.entries()) {
      const page = unwrap(await repo.listPageBySession(SESSION_A, { limit: 256, offset }));

      expect(page.records.map((kept) => kept.id)).toEqual([record.id]);
      expect(modificationsDiffBytes(page.records)).toBe(MODIFICATION_DIFF_MAX_BYTES);
    }
  });

  it('measures the record that ends a page and never reads it: no diff past the page is loaded', async () => {
    await appendJournal(2, diffOfLength(1_000_000, '€'));
    // The row past the budget is corrupt: reading it as a record would fail the page.
    insertCorruptRow('mod_corruptpast0budget', 'src/pastBudget.ts', diffOfLength(1_000_000));
    const calls = recordStatementCalls();

    const head = unwrap(await repo.listPageBySession(SESSION_A, { limit: 256, offset: 0 }));

    expect(head.records).toHaveLength(2);
    expect(head.total).toBe(3);

    // Three statements: the count, the measure, and a full read of exactly the
    // two records the measure kept — the third row's diff was never asked for.
    expect(calls.map((call) => call.method)).toEqual(['get', 'iterate', 'all']);
    const [, measure, read] = calls;
    expect(measure?.sql).toMatch(
      /^SELECT id, octet_length\(diff\) AS diff_bytes FROM modifications/,
    );
    expect(measure?.args).toEqual([SESSION_A, 256, 0]);
    expect(read?.sql).toMatch(/\bdiff\b/);
    expect(read?.args).toEqual([SESSION_A, 2, 0]);

    // The next page reads it as a record, and refuses it as corrupt.
    const next = await repo.listPageBySession(SESSION_A, { limit: 256, offset: 2 });
    const error = expectRefusal(next, 'STORE_ERROR');
    expect(error.details?.['recordId']).toBe('mod_corruptpast0budget');
  });

  it('answers each diff length from the row header, without loading the diff', async () => {
    await appendJournal(1);
    const calls = recordStatementCalls();

    unwrap(await repo.listPageBySession(SESSION_A, { limit: 1, offset: 0 }));

    const measure = calls.find((call) => call.sql.includes('octet_length'));
    expect(measure).toBeDefined();
    // `EXPLAIN` exposes the opcode that reads `diff`: its P5 carries
    // OPFLAG_BYTELENARG (0xc0), SQLite's instruction to compute the byte length
    // from the record header rather than load the value.
    const program = store.db
      .prepare(`EXPLAIN ${measure?.sql ?? ''}`)
      .all(SESSION_A, 1, 0)
      .map((row) => ({ opcode: row['opcode'], p5: row['p5'] }));
    expect(program).toContainEqual({ opcode: 'Column', p5: 0xc0 });
  });

  it('measures diffs in UTF-8 bytes, exactly as protocol counts them', async () => {
    const samples = [
      'plain ASCII text',
      'two-byte é ü ß',
      'three-byte € 中文',
      'four-byte 𝄞 𐍈',
      'emoji 😀 👩‍💻 🇪🇺',
      'lone surrogate \ud800 stored as U+FFFD',
    ];

    for (const sample of samples) {
      const measured = store.db.prepare('SELECT octet_length(?) AS bytes').get(sample)?.['bytes'];
      expect(measured, sample).toBe(utf8ByteLength(sample));
    }

    // And for journalled diffs, as the page measures them.
    const records = await appendJournal(1, `${DIFF}+// ${samples.join(' ')}\n`);
    const stored = store.db
      .prepare('SELECT octet_length(diff) AS bytes FROM modifications WHERE id = ?')
      .get(records[0]?.id ?? '')?.['bytes'];
    expect(stored).toBe(modificationsDiffBytes(records));
    expect(stored).toBeGreaterThan(records[0]?.diff.length ?? 0);
  });

  it('refuses a first record whose diff alone exceeds the budget as a corrupt row', async () => {
    // Only a row written past the journal's validation can measure this much.
    insertCorruptRow(
      'mod_oversizeddiff0',
      'src/oversized.ts',
      '€'.repeat(MAX_MODIFICATION_DIFF_LENGTH + 1),
    );

    const error = expectRefusal(
      await repo.listPageBySession(SESSION_A, { limit: 10, offset: 0 }),
      'STORE_ERROR',
    );

    expect(error.details?.['recordId']).toBe('mod_oversizeddiff0');
    expect(error.cause).toMatchObject({
      details: {
        reason: 'diff-over-cap',
        diffBytes: 3 * (MAX_MODIFICATION_DIFF_LENGTH + 1),
        budgetBytes: MODIFICATIONS_PAGE_DIFF_BUDGET,
      },
    });
    expect(JSON.stringify(error)).not.toContain('€');
  });

  it('counts without reading a record for limit 0, and answers an empty page past the end', async () => {
    await appendJournal(3);
    const prepared: string[] = [];
    const statement = store.statement.bind(store);
    vi.spyOn(store, 'statement').mockImplementation((sql: string) => {
      prepared.push(sql);
      return statement(sql);
    });

    expect(unwrap(await repo.listPageBySession(SESSION_A, { limit: 0, offset: 0 }))).toEqual({
      records: [],
      total: 3,
    });
    expect(unwrap(await repo.listPageBySession(SESSION_A, { limit: 10, offset: 3 }))).toEqual({
      records: [],
      total: 3,
    });
    expect(unwrap(await repo.listPageBySession(SESSION_A, { limit: 10, offset: 99 }))).toEqual({
      records: [],
      total: 3,
    });
    expect(prepared).toHaveLength(3);
    expect(prepared.every((sql) => sql.startsWith('SELECT COUNT(*)'))).toBe(true);
    expect(unwrap(await repo.listPageBySession(SESSION_C, { limit: 10, offset: 0 }))).toEqual({
      records: [],
      total: 0,
    });
  });

  it('refuses a window outside its domain without reading anything', async () => {
    await appendJournal(1);

    for (const window of [
      { limit: -1, offset: 0 },
      { limit: 1.5, offset: 0 },
      { limit: 10, offset: -1 },
      { limit: 10, offset: Number.MAX_SAFE_INTEGER + 1 },
      { limit: 10, offset: 0, maxDiffBytes: MODIFICATION_DIFF_MAX_BYTES - 1 },
      // The code-unit cap is no longer enough: a page of it could not hold one
      // diff of three-byte characters.
      { limit: 10, offset: 0, maxDiffBytes: MAX_MODIFICATION_DIFF_LENGTH },
    ]) {
      const error = expectRefusal(await repo.listPageBySession(SESSION_A, window), 'STORE_ERROR');
      expect(error.details?.['reason']).toBe('invalid-argument');
    }
  });

  it('never logs a diff it pages', async () => {
    await appendOk(makeRecord({ file: 'src/sentinel.ts', diff: SENTINEL_DIFF }));

    const page = unwrap(await repo.listPageBySession(SESSION_A, { limit: 10, offset: 0 }));

    expect(page.records[0]?.diff).toContain(SENTINEL);
    expect(loggedText()).not.toContain(SENTINEL);
  });
});

/* -------------------------------------------------------------------------------------------------
 * readSessionModifications — the session record's synchronous journal read
 * ---------------------------------------------------------------------------------------------- */

describe('readSessionModifications', () => {
  it('answers what listBySession answers, in the same order, without a promise', async () => {
    const first = await seedInStatus('applied');
    const second = await seedInStatus('applied', { file: FILE_TWO });
    await seedInStatus('applied', { sessionId: SESSION_B });

    const read = readSessionModifications(store, SESSION_A);

    expect(read).not.toBeInstanceOf(Promise);
    expect(unwrap(read)).toEqual(unwrap(await repo.listBySession(SESSION_A)));
    expect(unwrap(read).map((record) => record.id)).toEqual([first.id, second.id]);
    expect(unwrap(read).every((record) => record.sessionId === SESSION_A)).toBe(true);
  });

  it('reflects every status transition the moment the journal takes it', async () => {
    const restored = await seedInStatus('applied');
    const edited = await seedInStatus('applied', { file: FILE_TWO });

    unwrap(await repo.updateStatus(restored.id, 'reverted'));
    unwrap(await repo.updateStatus(edited.id, 'conflict'));

    const statuses = unwrap(readSessionModifications(store, SESSION_A)).map((record) => [
      record.id,
      record.status,
    ]);

    expect(statuses).toEqual([
      [restored.id, 'reverted'],
      [edited.id, 'conflict'],
    ]);
  });

  it('returns records the upstream schema accepts, every field as the row holds it', async () => {
    const parent = await seedInStatus('applied');
    const child = await appendOk(
      makeRecord({
        planVersion: 2,
        originalHash: parent.instrumentedHash,
        instrumentedHash: hashOf('instrumented:followup'),
        previousRecordId: parent.id,
      }),
    );

    const read = unwrap(readSessionModifications(store, SESSION_A));

    for (const record of read) {
      expect(parseModificationRecord(record)).toEqual({ ok: true, value: record });
    }
    expect(read.find((record) => record.id === child.id)).toEqual(child);
    expect(read.find((record) => record.id === parent.id)).not.toHaveProperty('previousRecordId');
  });

  it('answers an empty list for a session with no record and for an id the store does not hold', () => {
    expect(unwrap(readSessionModifications(store, SESSION_C))).toEqual([]);
    expect(unwrap(readSessionModifications(store, newSessionId()))).toEqual([]);
  });

  it('refuses a blank or non-string session id before any statement is prepared', () => {
    const prepared: string[] = [];
    const recording = recordingStore(store, prepared);

    for (const sessionId of ['', undefined, 42]) {
      const error = expectRefusal(
        readSessionModifications(recording, sessionId as unknown as SessionId),
        'STORE_ERROR',
      );
      expect(error.details?.['reason']).toBe('invalid-argument');
      expect(error.details?.['field']).toBe('sessionId');
    }
    expect(prepared).toEqual([]);
  });

  it('fails the whole read on a row that is no longer a record, naming the id only', async () => {
    await seedInStatus('applied');
    insertCorruptRow('mod_corruptmirror000', 'src/corrupt.ts', `${DIFF}\n+// ${SENTINEL}`);

    const error = expectRefusal(readSessionModifications(store, SESSION_A), 'STORE_ERROR');

    expect(error.details?.['recordId']).toBe('mod_corruptmirror000');
    expect(errorText(error)).not.toContain(SENTINEL);
  });

  it('reports a store it cannot read as store-failed instead of throwing', () => {
    store.close();

    const error = expectRefusal(readSessionModifications(store, SESSION_A), 'STORE_ERROR');

    expect(error.details?.['reason']).toBe('store-failed');
    expect(error.details?.['operation']).toBe('readSessionModifications');
  });

  it('reads through the session index and never logs a diff it returns', async () => {
    await appendOk(makeRecord({ file: 'src/sentinel.ts', diff: SENTINEL_DIFF }));
    const prepared: string[] = [];

    const read = unwrap(readSessionModifications(recordingStore(store, prepared), SESSION_A));

    expect(read[0]?.diff).toContain(SENTINEL);
    expect(loggedText()).not.toContain(SENTINEL);
    expect(prepared).toHaveLength(1);

    const plan = store.db
      .prepare(`EXPLAIN QUERY PLAN ${prepared[0] ?? ''}`)
      .all(SESSION_A)
      .map((row) => String(row['detail']))
      .join(' | ');

    expect(plan).toMatch(/USING (COVERING )?INDEX idx_modifications_session_id/);
  });
});
