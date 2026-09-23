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
 *    not line up hash-for-hash is refused; a status transition the lifecycle
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
 * The store is the real one: `openStore` against an `mkdtemp` sandbox, so the
 * real DDL, the real pragmas (`foreign_keys = ON` is what makes the cascade
 * assertion meaningful) and the real migration ladder are exercised. Nothing
 * under `$DEBUGGEN_HOME` is touched and no socket is opened, which is the
 * contract of the `local-service` Vitest project.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  MODIFICATION_STATUSES,
  OPEN_MODIFICATION_STATUSES,
  createModificationRecord,
} from '@debuggen/instrumentation';
import type {
  ModificationJournal,
  ModificationRecord,
  ModificationStatus,
} from '@debuggen/instrumentation';
import { createConsoleLogger, isErr, newSessionId, unwrap } from '@debuggen/shared';
import type { LogRecord } from '@debuggen/shared';
import { sha256Hex } from '@debuggen/shared/node';

import { openStore } from './db.js';
import type { Store } from './db.js';
import {
  MODIFICATION_STATUS_TRANSITIONS,
  canTransitionModificationStatus,
  createModificationsRepo,
} from './modifications-repo.js';
import type { ModificationsRepo } from './modifications-repo.js';

/* -------------------------------------------------------------------------------------------------
 * Fixtures
 * ---------------------------------------------------------------------------------------------- */

/** The session most records below belong to. Left in a mid-pipeline status. */
const SESSION_A = newSessionId();

/**
 * A second session, deliberately in `failed`.
 *
 * AAP §0.5.1 requires start-up reconciliation to act on an open record
 * *regardless of the owning session's status*, so the `listAllOpen` assertions
 * need a session that a status-aware query would have excluded.
 */
const SESSION_B = newSessionId();

/** A third session, `ended`, for the same reason. */
const SESSION_C = newSessionId();

/** Where backups live: outside every checkout, as AAP §0.2.3 requires. */
const BACKUPS = '/tmp/debuggen-home/backups';

/** A unified diff of the shape the patcher produces. */
const DIFF = [
  '--- a/src/server/report.ts',
  '+++ b/src/server/report.ts',
  '@@ -12,7 +12,11 @@',
  '-export async function buildReport(input: Input): Promise<Report> {',
  '+export async function buildReport(input: Input): Promise<Report> {',
  '+  const __dbg = (globalThis as { __DEBUGGEN__?: __DebuggenSpanHelper }).__DEBUGGEN__;',
  '',
].join('\n');

/**
 * The string the privacy assertions look for.
 *
 * Shaped like something that must never be logged and unlikely to occur by
 * accident, so a match is unambiguous.
 */
const SENTINEL = 'DIFF-SENTINEL-c7f1a4e2-never-log-me';

/** The clock the repository and the record builder read. Advanced by tests. */
let clock = 1_767_225_600_000;

/** The sandbox directory holding the database for one test. */
let directory: string;

/** The store under the repository. */
let store: Store;

/** Every log record either the store or the repository emitted. */
let logs: LogRecord[];

/** The repository under test. */
let repo: ModificationsRepo;

/** A digest of the shape `sha256Hex` produces: 64 lowercase hex characters. */
function hashOf(content: string): string {
  return sha256Hex(content);
}

/** Inserts the `sessions` row a modification's foreign key requires. */
function insertSession(sessionId: string, status: string): void {
  store
    .statement(
      `INSERT INTO sessions (
         id, project_root, project_name, status, question, dev_server_url, created_at, updated_at, record
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      sessionId,
      '/home/dev/projects/storefront',
      'storefront',
      status,
      'Why is this button slow?',
      'http://127.0.0.1:20531',
      clock,
      clock,
      '{}',
    );
}

/** What {@link buildRecord} may override. */
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
 * Builds a record through the real constructor, so the suite never hand-rolls
 * the shape the journal is supposed to accept.
 */
function buildRecord(overrides: RecordOverrides = {}): ModificationRecord {
  const file = overrides.file ?? 'src/server/report.ts';
  const sessionId = overrides.sessionId ?? SESSION_A;
  const appliedAt = overrides.appliedAt ?? clock;

  return unwrap(
    createModificationRecord(
      {
        sessionId,
        planVersion: overrides.planVersion ?? 1,
        file,
        originalHash: overrides.originalHash ?? hashOf(`original:${file}`),
        backupPath: overrides.backupPath ?? `${BACKUPS}/${sessionId}/${hashOf(`original:${file}`)}`,
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

/** Everything the store and the repository said, as one searchable string. */
function loggedText(): string {
  return JSON.stringify(logs);
}

beforeEach(() => {
  clock = 1_767_225_600_000;
  directory = mkdtempSync(join(tmpdir(), 'debuggen-modifications-'));
  logs = [];

  const logger = createConsoleLogger({
    level: 'trace',
    sink: (record) => {
      logs.push(record);
    },
  });

  store = unwrap(openStore({ databasePath: join(directory, 'sessions.sqlite'), logger }));
  repo = createModificationsRepo({ store, logger, now: () => clock });

  insertSession(SESSION_A, 'instrumenting');
  insertSession(SESSION_B, 'failed');
  insertSession(SESSION_C, 'ended');
});

afterEach(() => {
  store.close();
  rmSync(directory, { recursive: true, force: true });
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

  it('keeps the SQL status vocabulary equal to MODIFICATION_STATUSES, in order', () => {
    const ddl = readFileSync(fileURLToPath(new URL('./schema.sql', import.meta.url)), 'utf8');
    const match = /CHECK\s*\(status IN \(([^)]*)\)\)/.exec(ddl);

    expect(match).not.toBeNull();

    const listed = (match?.[1] ?? '')
      .split(',')
      .map((value) => value.trim().replace(/^'/, '').replace(/'$/, ''));

    expect(listed).toEqual([...MODIFICATION_STATUSES]);
  });
});

/* -------------------------------------------------------------------------------------------------
 * append
 * ---------------------------------------------------------------------------------------------- */

describe('append', () => {
  it('persists both hashes, the backup path and the diff, and round-trips the record', async () => {
    const record = buildRecord();
    const stored = await appendOk(record);

    expect(stored).toEqual(record);

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
    const record = await appendOk(buildRecord());

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
    const record = buildRecord({ appliedAt: 1_767_225_600_123.456 });
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
    const valid = buildRecord();
    const record: ModificationRecord = { ...valid, backupPath: '   ' };
    const appended = await repo.append(record);

    expect(isErr(appended)).toBe(true);
    expect(isErr(appended) ? appended.error.code : undefined).toBe(
      'INSTRUMENTATION_INSTALL_FAILED',
    );
    expect(readRow(record.id)).toBeUndefined();
  });

  it('refuses a record with no diff', async () => {
    const record = buildRecord({ diff: '' });
    const appended = await repo.append(record);

    expect(isErr(appended)).toBe(true);
    expect(isErr(appended) ? appended.error.code : undefined).toBe(
      'INSTRUMENTATION_INSTALL_FAILED',
    );
    expect(readRow(record.id)).toBeUndefined();
  });

  it('refuses a no-op patch, whose two hashes are identical', async () => {
    const hash = hashOf('unchanged');
    const record = buildRecord({ originalHash: hash, instrumentedHash: hash });
    const appended = await repo.append(record);

    expect(isErr(appended)).toBe(true);
    expect(isErr(appended) ? appended.error.code : undefined).toBe(
      'INSTRUMENTATION_INSTALL_FAILED',
    );
    expect(readRow(record.id)).toBeUndefined();
  });

  it('refuses a record that does not satisfy the record schema', async () => {
    const valid = buildRecord();
    const malformed: ModificationRecord = {
      ...valid,
      originalHash: valid.originalHash.toUpperCase(),
    };
    const appended = await repo.append(malformed);

    expect(isErr(appended)).toBe(true);
    expect(isErr(appended) ? appended.error.code : undefined).toBe(
      'INSTRUMENTATION_INSTALL_FAILED',
    );
    expect(readRow(valid.id)).toBeUndefined();
  });

  it('refuses a duplicate record id', async () => {
    const record = await appendOk(buildRecord());
    const again = await repo.append(record);

    expect(isErr(again)).toBe(true);
    expect(isErr(again) ? again.error.code : undefined).toBe('STORE_ERROR');
    expect(isErr(again) ? again.error.details?.['reason'] : undefined).toBe('duplicate-record-id');

    const listed = await repo.listBySession(SESSION_A);

    expect(listed.ok && listed.value).toHaveLength(1);
  });

  it('refuses a record naming a session the store does not hold', async () => {
    const record = buildRecord({ sessionId: newSessionId() });
    const appended = await repo.append(record);

    expect(isErr(appended)).toBe(true);
    expect(isErr(appended) ? appended.error.code : undefined).toBe('STORE_ERROR');
    expect(isErr(appended) ? appended.error.details?.['reason'] : undefined).toBe(
      'unknown-session',
    );
  });

  it('keeps append order for records that share a millisecond', async () => {
    const first = await appendOk(buildRecord({ file: 'src/a.ts' }));
    const second = await appendOk(buildRecord({ file: 'src/b.ts' }));
    const third = await appendOk(buildRecord({ file: 'src/c.ts' }));

    expect(first.appliedAt).toBe(second.appliedAt);
    expect(second.appliedAt).toBe(third.appliedAt);

    const listed = await repo.listBySession(SESSION_A);

    expect(listed.ok && listed.value.map((entry) => entry.file)).toEqual([
      'src/a.ts',
      'src/b.ts',
      'src/c.ts',
    ]);
  });
});

/* -------------------------------------------------------------------------------------------------
 * Chains
 * ---------------------------------------------------------------------------------------------- */

describe('follow-up chains', () => {
  /** Appends the first record for a file and returns it. */
  async function appendRoot(file = 'src/server/report.ts'): Promise<ModificationRecord> {
    return appendOk(buildRecord({ file }));
  }

  it('accepts a delta whose original hash is the parent’s instrumented hash', async () => {
    const root = await appendRoot();
    const delta = buildRecord({
      planVersion: 2,
      originalHash: root.instrumentedHash,
      instrumentedHash: hashOf('instrumented:plan-2'),
      previousRecordId: root.id,
    });

    const stored = await appendOk(delta);

    expect(stored.previousRecordId).toBe(root.id);
    expect(readRow(delta.id)?.['previous_record_id']).toBe(root.id);
  });

  it('refuses a delta that does not continue from the parent’s written bytes', async () => {
    const root = await appendRoot();
    const delta = buildRecord({
      planVersion: 2,
      originalHash: hashOf('somebody else edited the file'),
      instrumentedHash: hashOf('instrumented:plan-2'),
      previousRecordId: root.id,
    });

    const appended = await repo.append(delta);

    expect(isErr(appended)).toBe(true);
    expect(isErr(appended) ? appended.error.code : undefined).toBe('MODIFICATION_CONFLICT');
    expect(isErr(appended) ? appended.error.hint : undefined).toContain('between plan versions');
    expect(readRow(delta.id)).toBeUndefined();
  });

  it('refuses a delta that repeats the parent’s original hash', async () => {
    const root = await appendRoot();
    const delta = buildRecord({
      planVersion: 2,
      originalHash: root.originalHash,
      instrumentedHash: hashOf('instrumented:plan-2'),
      previousRecordId: root.id,
    });

    const appended = await repo.append(delta);

    expect(isErr(appended)).toBe(true);
    expect(isErr(appended) ? appended.error.code : undefined).toBe(
      'INSTRUMENTATION_INSTALL_FAILED',
    );
    expect(readRow(delta.id)).toBeUndefined();
  });

  it('refuses a delta whose parent belongs to another session', async () => {
    const root = await appendRoot();
    const delta = buildRecord({
      sessionId: SESSION_B,
      planVersion: 2,
      originalHash: root.instrumentedHash,
      instrumentedHash: hashOf('instrumented:plan-2'),
      previousRecordId: root.id,
    });

    const appended = await repo.append(delta);

    expect(isErr(appended)).toBe(true);
    expect(isErr(appended) ? appended.error.code : undefined).toBe(
      'INSTRUMENTATION_INSTALL_FAILED',
    );
    expect(readRow(delta.id)).toBeUndefined();
  });

  it('refuses a delta whose parent describes a different file', async () => {
    const root = await appendRoot('src/server/report.ts');
    const delta = buildRecord({
      file: 'src/server/other.ts',
      planVersion: 2,
      originalHash: root.instrumentedHash,
      instrumentedHash: hashOf('instrumented:plan-2'),
      previousRecordId: root.id,
    });

    const appended = await repo.append(delta);

    expect(isErr(appended)).toBe(true);
    expect(isErr(appended) ? appended.error.code : undefined).toBe(
      'INSTRUMENTATION_INSTALL_FAILED',
    );
    expect(readRow(delta.id)).toBeUndefined();
  });

  it('refuses a delta whose parent is not journalled', async () => {
    const delta = buildRecord({
      planVersion: 2,
      previousRecordId: 'mod_0000000000000000',
      originalHash: hashOf('instrumented:plan-1'),
    });

    const appended = await repo.append(delta);

    expect(isErr(appended)).toBe(true);
    expect(isErr(appended) ? appended.error.code : undefined).toBe(
      'INSTRUMENTATION_INSTALL_FAILED',
    );
    expect(readRow(delta.id)).toBeUndefined();
  });

  it('walks a chain oldest → newest, so a restore can reverse it', async () => {
    const root = await appendRoot();
    const second = await appendOk(
      buildRecord({
        planVersion: 2,
        originalHash: root.instrumentedHash,
        instrumentedHash: hashOf('instrumented:plan-2'),
        previousRecordId: root.id,
      }),
    );
    const third = await appendOk(
      buildRecord({
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

    // The head is what a restore starts from, and it is the record nothing else
    // is layered on.
    const head = await repo.latestRecordForFile(SESSION_A, root.file);

    expect(head.ok && head.value?.id).toBe(third.id);

    const byFile = await repo.listByFile(SESSION_A, root.file);

    expect(byFile.ok && byFile.value.map((entry) => entry.planVersion)).toEqual([1, 2, 3]);
  });

  it('answers a single-record chain with that record alone', async () => {
    const root = await appendRoot();
    const chain = await repo.listChain(root.id);

    expect(chain.ok && chain.value.map((entry) => entry.id)).toEqual([root.id]);
  });

  it('refuses to walk a cycle', async () => {
    const root = await appendRoot();
    const second = await appendOk(
      buildRecord({
        planVersion: 2,
        originalHash: root.instrumentedHash,
        instrumentedHash: hashOf('instrumented:plan-2'),
        previousRecordId: root.id,
      }),
    );

    // Only reachable by corrupting the table directly: `append` refuses a
    // forward link, and the record schema refuses a self-link.
    store
      .statement('UPDATE modifications SET previous_record_id = ? WHERE id = ?')
      .run(second.id, root.id);

    const chain = await repo.listChain(second.id);

    expect(isErr(chain)).toBe(true);
    expect(isErr(chain) ? chain.error.code : undefined).toBe('STORE_ERROR');
    expect(isErr(chain) ? chain.error.details?.['reason'] : undefined).toBe('chain-cycle');
  });

  it('refuses to walk a chain whose link is missing', async () => {
    const root = await appendRoot();
    const second = await appendOk(
      buildRecord({
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
  for (const from of MODIFICATION_STATUSES) {
    for (const to of MODIFICATION_STATUSES) {
      const legal = canTransitionModificationStatus(from, to);

      it(`${legal ? 'applies' : 'refuses'} ${from} → ${to}`, async () => {
        const record = await appendOk(buildRecord({ status: from, file: `src/${from}-${to}.ts` }));

        clock += 1_000;

        const updated = await repo.updateStatus(record.id, to);

        if (legal) {
          expect(updated.ok && updated.value.status).toBe(to);
          expect(readRow(record.id)?.['status']).toBe(to);

          return;
        }

        expect(isErr(updated)).toBe(true);
        expect(isErr(updated) ? updated.error.code : undefined).toBe('SESSION_INVALID_STATE');
        expect(isErr(updated) ? updated.error.details?.['reason'] : undefined).toBe(
          'illegal-status-transition',
        );

        // The refusal changed nothing: the row still describes the file exactly
        // as it did, which is what keeps a caller that lost track from
        // overwriting a developer's edit.
        const row = readRow(record.id);

        expect(row?.['status']).toBe(from);
        expect(row?.['updated_at']).toBe(record.appliedAt);
      });
    }
  }

  it('returns the stored record without a second read', async () => {
    const record = await appendOk(buildRecord());

    clock += 2_500;

    const updated = await repo.updateStatus(record.id, 'applied', { appliedAt: clock });
    const read = await repo.get(record.id);

    expect(updated.ok && updated.value.appliedAt).toBe(clock);
    expect(read.ok && read.value).toStrictEqual(updated.ok ? updated.value : undefined);
  });

  it('writes only the columns the patch names', async () => {
    const record = await appendOk(buildRecord());
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
    const record = await appendOk(buildRecord({ status: 'applied' }));
    const relocated = `${BACKUPS}/quarantine/${record.originalHash}`;
    const updated = await repo.updateStatus(record.id, 'conflict', { backupPath: relocated });

    expect(updated.ok && updated.value.backupPath).toBe(relocated);
    expect(readRow(record.id)?.['backup_path']).toBe(relocated);
  });

  it('accepts an idempotent retry without writing', async () => {
    const record = await appendOk(buildRecord({ status: 'conflict' }));
    const before = readRow(record.id);

    clock += 9_000;

    const updated = await repo.updateStatus(record.id, 'conflict');

    expect(updated.ok && updated.value).toStrictEqual(record);
    expect(readRow(record.id)?.['updated_at']).toBe(before?.['updated_at']);
  });

  it('refuses a patch that would store a record a later read could not parse', async () => {
    const record = await appendOk(buildRecord());
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
    const record = await appendOk(buildRecord());
    const updated = await repo.updateStatus(record.id, 'applied', {
      instrumentedHash: record.originalHash,
    });

    expect(isErr(updated)).toBe(true);
    expect(readRow(record.id)?.['status']).toBe('pending');
  });

  it('refuses a patch that would empty the diff', async () => {
    const record = await appendOk(buildRecord());
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
    const record = await appendOk(buildRecord());

    // A store that lets another writer move the row between the read and the
    // guarded write, which is the race the optimistic guard exists for.
    const racing = createModificationsRepo({
      store: storeThatMovesTheRow(store, record.id, 'failed'),
      now: () => clock,
    });

    const updated = await racing.updateStatus(record.id, 'applied');

    expect(isErr(updated)).toBe(true);
    expect(isErr(updated) ? updated.error.code : undefined).toBe('STORE_ERROR');
    expect(isErr(updated) ? updated.error.details?.['reason'] : undefined).toBe('status-moved');
    expect(isErr(updated) ? updated.error.hint : undefined).toContain('re-read');

    // The other writer's value stands; this call wrote nothing.
    expect(readRow(record.id)?.['status']).toBe('failed');
  });
});

/* -------------------------------------------------------------------------------------------------
 * Queries
 * ---------------------------------------------------------------------------------------------- */

describe('queries', () => {
  /** One record per status across three sessions in three different statuses. */
  interface Seeded {
    readonly pendingA: ModificationRecord;
    readonly appliedA: ModificationRecord;
    readonly revertedA: ModificationRecord;
    readonly conflictA: ModificationRecord;
    readonly failedB: ModificationRecord;
    readonly revertedB: ModificationRecord;
    readonly conflictC: ModificationRecord;
  }

  let seeded: Seeded;

  beforeEach(async () => {
    seeded = {
      pendingA: await appendOk(buildRecord({ status: 'pending', file: 'src/a-pending.ts' })),
      appliedA: await appendOk(buildRecord({ status: 'applied', file: 'src/a-applied.ts' })),
      revertedA: await appendOk(buildRecord({ status: 'reverted', file: 'src/a-reverted.ts' })),
      conflictA: await appendOk(buildRecord({ status: 'conflict', file: 'src/a-conflict.ts' })),
      failedB: await appendOk(
        buildRecord({ sessionId: SESSION_B, status: 'failed', file: 'src/b-failed.ts' }),
      ),
      revertedB: await appendOk(
        buildRecord({ sessionId: SESSION_B, status: 'reverted', file: 'src/b-reverted.ts' }),
      ),
      conflictC: await appendOk(
        buildRecord({ sessionId: SESSION_C, status: 'conflict', file: 'src/c-conflict.ts' }),
      ),
    };
  });

  it('lists one session and nobody else', async () => {
    const listed = await repo.listBySession(SESSION_A);

    expect(listed.ok && listed.value.map((entry) => entry.id).sort()).toEqual(
      [seeded.pendingA.id, seeded.appliedA.id, seeded.revertedA.id, seeded.conflictA.id].sort(),
    );
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
    const open = await repo.listAllOpen();
    const ids = open.ok ? open.value.map((entry) => entry.id) : [];

    // SESSION_B is `failed` and SESSION_C is `ended`; their open records are
    // still on the list, because the files they describe are still patched.
    expect(ids).toContain(seeded.failedB.id);
    expect(ids).toContain(seeded.conflictC.id);
    expect(ids).toContain(seeded.pendingA.id);
    expect(ids).toContain(seeded.appliedA.id);
    expect(ids).toContain(seeded.conflictA.id);

    // `reverted` is the one status with nothing left to do.
    expect(ids).not.toContain(seeded.revertedA.id);
    expect(ids).not.toContain(seeded.revertedB.id);
    expect(ids).toHaveLength(5);

    for (const record of open.ok ? open.value : []) {
      expect(OPEN_MODIFICATION_STATUSES).toContain(record.status);
    }
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

  it('lists the distinct backup paths retention needs', async () => {
    const all = await repo.listBackupPaths();

    expect(all.ok && all.value).toHaveLength(7);
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
    const shared = `${BACKUPS}/${SESSION_A}/${hashOf('shared original')}`;

    await appendOk(buildRecord({ file: 'src/share-1.ts', backupPath: shared }));
    await appendOk(buildRecord({ file: 'src/share-2.ts', backupPath: shared }));

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
    store.statement('DELETE FROM sessions WHERE id = ?').run(SESSION_A);

    const remaining = await repo.countBySession(SESSION_A);

    expect(remaining).toStrictEqual({ ok: true, value: 0 });

    const elsewhere = await repo.countBySession(SESSION_B);

    expect(elsewhere).toStrictEqual({ ok: true, value: 2 });
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
 * Privacy
 * ---------------------------------------------------------------------------------------------- */

describe('privacy', () => {
  it('journals a diff without ever logging it', async () => {
    const diff = `${DIFF}\n+// ${SENTINEL}`;
    const record = await appendOk(buildRecord({ diff }));

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
    const diff = `${DIFF}\n+// ${SENTINEL}`;
    const hash = hashOf('unchanged content');
    const refused = await repo.append(
      buildRecord({ diff, originalHash: hash, instrumentedHash: hash }),
    );

    expect(isErr(refused)).toBe(true);

    if (isErr(refused)) {
      const error = refused.error;
      const serialised = JSON.stringify({
        payload: error.toPayload(),
        details: error.details ?? {},
        message: error.message,
        hint: error.hint ?? '',
      });

      expect(serialised).not.toContain(SENTINEL);
      expect(serialised).not.toContain(hash);
    }

    expect(loggedText()).not.toContain(SENTINEL);
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
      `${BACKUPS}/${SESSION_A}/original`,
      'ALSO-NOT-A-SHA256-DIGEST',
      clock,
      clock,
      'pending',
      diff,
    );
}
