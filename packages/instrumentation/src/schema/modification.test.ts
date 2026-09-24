/**
 * Tests for `./modification.ts`: the journal entry that makes this product's
 * central promise — reversible instrumentation — auditable.
 *
 * The record under test is a **three-way contract**, and that is what gives
 * this suite its shape. `../patch/patcher.ts` writes these rows,
 * `apps/local-service/src/store/modifications-repo.ts` persists them column for
 * column in the AAP §0.2.3 `modifications` table, and two user interfaces
 * render them — the VS Code `ModificationsList`/`DiffView` and the DevTools
 * `SessionSummary`, reached through `@debuggen/protocol`'s
 * `instrumentation.ready` and `cleanup.completed` payloads (AAP §0.4.2). None
 * of those three can see the other two. Asserting the **exact key set** and the
 * **chain relationship** here is what stops them drifting apart: a field added
 * to the schema without the store's table and the protocol's payload learning
 * about it is silent data loss, and it fails in this file before it can fail in
 * production.
 *
 * ## What is on trial, and what is deliberately not
 *
 * This is a **pure schema suite**. It opens no file, no database and no socket,
 * and it computes no digest: it touches the filesystem nowhere, so it can say
 * nothing about restoration. The behavioural proofs live where the real
 * machinery does —
 *
 * - `../patch/patcher.test.ts` runs the real patcher against
 *   `test/fixtures/project-a` with failure injection at every boundary of the
 *   AAP §0.5.1 write sequence, and asserts each touched file is byte-identical
 *   to the original after reconciliation;
 * - `../cleanup.test.ts` proves apply → revert → byte-identical, and
 *   edit-after-apply → `conflict` with the file left untouched.
 *
 * What this file proves is the vocabulary those suites, the store and both
 * extensions all agree on:
 *
 * 1. **The status vocabulary is exactly the AAP §0.2.3 column set**, and
 *    `OPEN_MODIFICATION_STATUSES` is exactly "everything except `reverted`" —
 *    the filter behind `ModificationJournal.listOpen()` and the set AAP §0.5.1
 *    requires service-start reconciliation to act on *regardless of the owning
 *    session's status*. A `conflict` record inside that set is not a detail: it
 *    is why a conflicting file is re-reported on every start instead of being
 *    quietly closed.
 * 2. **A digest is 64 lowercase hex characters, and a file path is
 *    project-relative**, because the restore-versus-conflict decision is a
 *    string comparison of digests and because an absolute path must never reach
 *    a panel, a prompt or a filesystem call.
 * 3. **Both hashes are required on a `pending` record.** That is the one
 *    ordering decision of AAP §0.5.1 that makes every crash point decidable, so
 *    a schema that let `instrumentedHash` arrive later would dismantle the
 *    guarantee without failing anything else.
 * 4. **A follow-up chain is readable** (AAP §0.4.2): the later record's
 *    `originalHash` *is* the earlier record's `instrumentedHash`, and
 *    `previousRecordId` names the earlier record.
 * 5. **Nothing rejected is echoed back** (AAP §0.5.2): a `diff` is a slice of
 *    the developer's source and a `backupPath` contains their home directory,
 *    and the redaction layer never sees an error raised this deep.
 * 6. **The persistence port is satisfiable.** The in-memory journal below is
 *    assigned to a `ModificationJournal`-typed binding, so `pnpm typecheck`
 *    checks the port's shape as a compile-time contract test and the suites
 *    exercise its documented semantics.
 *
 * ## Conventions
 *
 * - **No prose is asserted.** A failure is checked by its code, its field path
 *   and the presence of a hint — the parts AAP §0.5.5 makes contractual — so
 *   rewording an error does not fail a test while losing its recovery path
 *   does.
 * - **Every value is neutral and invented** (AAP §0.5.4). No demo identifier,
 *   route path or component name appears anywhere below, and every digest is a
 *   64-character lowercase hex string assembled programmatically by
 *   {@link hashFixture} from a two-character seed rather than pasted as an
 *   opaque blob — so `scripts/check-secrets.mjs` has nothing entropy-shaped to
 *   look at, and a reader can see at a glance which hash a fixture means.
 * - **No sibling import.** `../patch/**` and `../cleanup.js` depend on this
 *   module; importing either here would invert that and hide a cycle behind a
 *   test.
 */

import { describe, expect, it } from 'vitest';

import { DebuggenError, err, isSafeRelativePath, newModificationId, ok } from '@debuggen/shared';
import type { Result } from '@debuggen/shared';

import {
  DEFAULT_MODIFICATION_STATUS,
  MAX_CONFLICT_DIFF_LENGTH,
  MAX_MODIFICATION_DIFF_LENGTH,
  MODIFICATION_CONFLICT_REASONS,
  MODIFICATION_ID_PATTERN,
  MODIFICATION_STATUSES,
  OPEN_MODIFICATION_STATUSES,
  SHA256_HEX_PATTERN,
  createModificationRecord,
  isModificationStatus,
  isOpenModificationStatus,
  modificationConflictReasonSchema,
  modificationConflictSchema,
  modificationRecordSchema,
  modificationStatusSchema,
  parseModificationConflict,
  parseModificationRecord,
  sha256HexSchema,
} from './modification.js';
import type {
  CreateModificationRecordInput,
  ModificationConflict,
  ModificationJournal,
  ModificationRecord,
  ModificationStatus,
  ModificationStatusPatch,
} from './modification.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** How many hexadecimal characters a SHA-256 digest is written with. */
const SHA256_HEX_LENGTH = 64;

/** How many characters follow the `mod_` prefix of a modification id. */
const MODIFICATION_ID_SUFFIX_LENGTH = 16;

/**
 * A digest fixture: `seed` repeated to exactly {@link SHA256_HEX_LENGTH}
 * characters.
 *
 * Assembled rather than pasted for two reasons. A real digest is 64 opaque
 * high-density characters, which `scripts/check-secrets.mjs` measures for
 * entropy and which a reader cannot tell apart from the next one — so a
 * repeated two-character seed keeps every fixture below both obviously fake and
 * obviously distinct. And building it here means the builder itself is under
 * test: the first case in the digest suite asserts its output satisfies the
 * pattern the module accepts.
 *
 * @param seed Lowercase hexadecimal characters to repeat.
 * @returns A 64-character lowercase hexadecimal string.
 */
function hashFixture(seed: string): string {
  return seed.repeat(Math.ceil(SHA256_HEX_LENGTH / seed.length)).slice(0, SHA256_HEX_LENGTH);
}

/**
 * A modification id of the shape `newModificationId()` mints: `mod_` followed
 * by 16 characters of its `0-9a-z` alphabet.
 *
 * Built from a readable label so a chain assertion states which record it means
 * rather than which sixteen characters it happens to carry, and padded with
 * `'0'` — a member of that alphabet — so the result always matches
 * {@link MODIFICATION_ID_PATTERN}.
 *
 * @param label Lowercase alphanumeric label, 16 characters or fewer.
 * @returns A well-formed modification id.
 */
function modificationIdFixture(label: string): string {
  return `mod_${label.padEnd(MODIFICATION_ID_SUFFIX_LENGTH, '0').slice(0, MODIFICATION_ID_SUFFIX_LENGTH)}`;
}

/**
 * A session id, in the `ses_…` form `@debuggen/shared` mints.
 *
 * The record's schema deliberately does not pattern-match this field — a
 * session read back from an older store may legitimately be spelled otherwise —
 * but every fixture here uses the real form so nothing below depends on that
 * latitude by accident.
 *
 * @param label Lowercase alphanumeric label, 16 characters or fewer.
 * @returns A session id.
 */
function sessionIdFixture(label: string): string {
  return `ses_${label.padEnd(MODIFICATION_ID_SUFFIX_LENGTH, '0').slice(0, MODIFICATION_ID_SUFFIX_LENGTH)}`;
}

/** The session most fixtures belong to. */
const SESSION_ID = sessionIdFixture('alpha');

/** A second session, for the cross-session reach of `listOpen`. */
const OTHER_SESSION_ID = sessionIdFixture('beta');

/**
 * A stand-in for `$DEBUGGEN_HOME`.
 *
 * Absolute, and outside any project — which is the whole point of the backup
 * location (AAP §0.2.3, §0.4.2): a session's backups must never appear in the
 * developer's `git status`, and must survive a branch switch.
 */
const DEBUGGEN_HOME = '/home/example/.debuggen';

/** The digest of the pristine file, before any patch. */
const PRISTINE_HASH = hashFixture('1a');

/** The digest of the content the first plan version writes. */
const PATCHED_HASH = hashFixture('2b');

/** The digest of the content a follow-up plan version writes on top of it. */
const CHAINED_HASH = hashFixture('3c');

/** The digest of a file the developer has since edited: neither of the above. */
const DIVERGED_HASH = hashFixture('4d');

/** The file most fixtures name: project-relative POSIX, neutral, invented. */
const TARGET_FILE = 'src/lib/timing-target.ts';

/**
 * The documented backup location for one session and one original digest:
 * `$DEBUGGEN_HOME/backups/<sessionId>/<originalHash>`.
 *
 * Keyed by the original digest, which is what makes the backup write idempotent
 * and lets two records that saw identical content share one file.
 *
 * @param sessionId The owning session.
 * @param originalHash The digest of the bytes copied there.
 * @returns An absolute backup path.
 */
function backupPathFixture(sessionId: string, originalHash: string): string {
  return `${DEBUGGEN_HOME}/backups/${sessionId}/${originalHash}`;
}

/** A short, realistic unified diff. Its content is never asserted on. */
const DIFF_TEXT = [
  `--- a/${TARGET_FILE}`,
  `+++ b/${TARGET_FILE}`,
  '@@ -1,3 +1,4 @@',
  ' export function run(): void {',
  '+  // instrumented',
  '   perform();',
  ' }',
].join('\n');

/**
 * Overrides for {@link makeRecord}, typed loosely on purpose.
 *
 * The rejection tables below have to put a `string` where a `number` belongs
 * and an unknown key where no key belongs, which is exactly what the schema is
 * for. Constraining this to `Partial<ModificationRecord>` would make the
 * compiler reject the very inputs the suite needs to prove are rejected.
 */
type RecordOverrides = Readonly<Record<string, unknown>>;

/**
 * A valid modification record as a plain object, with `overrides` applied.
 *
 * The one fixture factory for this shape, so a test names only the field it is
 * about. It returns an untyped object rather than a `ModificationRecord`
 * because roughly half its uses are deliberately invalid; {@link validRecord}
 * is the typed path, and it gets its type from the schema itself.
 *
 * `previousRecordId` is absent by default: an unchained record must not carry
 * the key at all (see the record suite), so the default fixture is the
 * unchained one.
 *
 * @param overrides Fields to replace or add.
 * @returns A plain object shaped like a record.
 */
function makeRecord(overrides: RecordOverrides = {}): Record<string, unknown> {
  return {
    id: modificationIdFixture('first'),
    sessionId: SESSION_ID,
    planVersion: 1,
    file: TARGET_FILE,
    originalHash: PRISTINE_HASH,
    backupPath: backupPathFixture(SESSION_ID, PRISTINE_HASH),
    instrumentedHash: PATCHED_HASH,
    appliedAt: 1_700_000_000_000,
    status: 'pending',
    diff: DIFF_TEXT,
    ...overrides,
  };
}

/**
 * A copy of the default record fixture with one key removed.
 *
 * Rebuilt by filtering entries rather than by `delete`, so the returned object
 * is a fresh one and the default fixture cannot be mutated by a table row.
 *
 * @param key The field to omit.
 * @returns A record fixture missing that field.
 */
function recordWithout(key: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(makeRecord()).filter(([name]) => name !== key));
}

/**
 * The value of a successful `Result`, or a failure naming the error that
 * arrived instead.
 *
 * @param result The outcome to unwrap.
 * @param what What was being attempted, for the failure message.
 * @returns The value.
 */
function okValue<T>(result: Result<T, DebuggenError>, what: string): T {
  if (!result.ok) {
    throw new Error(
      `${what} was expected to succeed, but failed with ${result.error.code}: ${result.error.message}`,
    );
  }

  return result.value;
}

/**
 * The error of a failed `Result`, or a failure saying the call succeeded.
 *
 * @param result The outcome to unwrap.
 * @param what What was being attempted, for the failure message.
 * @returns The error.
 */
function errValue<T>(result: Result<T, DebuggenError>, what: string): DebuggenError {
  if (result.ok) {
    throw new Error(`${what} was expected to fail, but succeeded.`);
  }

  return result.error;
}

/** A validated record fixture, typed by the schema that accepted it. */
function validRecord(overrides: RecordOverrides = {}): ModificationRecord {
  return okValue(parseModificationRecord(makeRecord(overrides)), 'a record fixture');
}

/**
 * Whether a value is the `{ path, message }` issue list the module attaches to
 * `details.issues`.
 *
 * A guard rather than an assertion, so nothing below reads a field off a value
 * the compiler has not agreed carries it.
 *
 * @param value Any value, normally `error.details.issues`.
 * @returns `true` when every entry has a string `path` and a string `message`.
 */
function isIssueList(value: unknown): value is readonly { path: string; message: string }[] {
  return (
    Array.isArray(value) &&
    value.every(
      (entry: unknown) =>
        entry !== null &&
        typeof entry === 'object' &&
        'path' in entry &&
        typeof entry.path === 'string' &&
        'message' in entry &&
        typeof entry.message === 'string',
    )
  );
}

/**
 * The field paths a failed parse reported, in order.
 *
 * Field paths are the contractual half of a rejection — they tell a producer
 * which value to fix — so they are what the tables below assert on, never the
 * message beside them.
 *
 * @param error The error from a failed parse or construction.
 * @returns One dotted field path per issue.
 */
function issuePaths(error: DebuggenError): string[] {
  const issues: unknown = error.details?.['issues'];

  if (!isIssueList(issues)) {
    throw new Error(`The error carried no issue list: ${error.code}.`);
  }

  return issues.map((issue) => issue.path);
}

/**
 * Everything the record constructor needs, with `overrides` applied.
 *
 * Frozen, and frozen deliberately: the AAP §0.5.1 write sequence calls the
 * constructor mid-flight with values the caller still holds, so mutating the
 * input would be a defect the compiler cannot see. A frozen object turns that
 * into a thrown `TypeError` under the strict mode every module here compiles
 * to — and `createModificationRecord` is documented never to throw, so the
 * freeze is an assertion in its own right.
 *
 * @param overrides Fields to replace.
 * @returns A frozen constructor input.
 */
function makeCreateInput(
  overrides: Partial<CreateModificationRecordInput> = {},
): CreateModificationRecordInput {
  return Object.freeze({
    sessionId: SESSION_ID,
    planVersion: 1,
    file: TARGET_FILE,
    originalHash: PRISTINE_HASH,
    backupPath: backupPathFixture(SESSION_ID, PRISTINE_HASH),
    instrumentedHash: PATCHED_HASH,
    diff: DIFF_TEXT,
    ...overrides,
  });
}

/**
 * The outcome of a constructor call, with a thrown exception turned into a
 * distinct value.
 *
 * `createModificationRecord` documents that it never throws, and that matters
 * more here than anywhere else in the package: it is called after the backup
 * has been written and `fsync`ed but before anything in the project has
 * changed, so an exception would unwind past a durable backup with no journal
 * entry to explain it. "Threw" and "returned a failure" both read as a red
 * test, and only one of them is that defect.
 *
 * @param input The constructor input.
 * @param options Injectable id and clock generators.
 * @returns The `Result`, or the literal `'threw'`.
 */
function createOutcome(
  input: CreateModificationRecordInput,
  options?: { readonly newId?: () => string; readonly now?: () => number },
): Result<ModificationRecord, DebuggenError> | 'threw' {
  try {
    return createModificationRecord(input, options ?? {});
  } catch {
    return 'threw';
  }
}

/**
 * The `Result` an outcome carries, or a failure reporting that the call threw.
 *
 * @param outcome The outcome from {@link createOutcome}.
 * @param what What was being attempted, for the failure message.
 * @returns The `Result`.
 */
function notThrown<T>(
  outcome: Result<T, DebuggenError> | 'threw',
  what: string,
): Result<T, DebuggenError> {
  if (outcome === 'threw') {
    throw new Error(`${what} threw instead of returning a failure value.`);
  }

  return outcome;
}

/** A conflict report as a plain object, with `overrides` applied. */
function makeConflict(overrides: RecordOverrides = {}): Record<string, unknown> {
  return {
    recordId: modificationIdFixture('first'),
    sessionId: SESSION_ID,
    file: TARGET_FILE,
    reason: 'content-changed',
    expectedHash: PATCHED_HASH,
    actualHash: DIVERGED_HASH,
    backupPath: backupPathFixture(SESSION_ID, PRISTINE_HASH),
    detectedAt: 1_700_000_000_500,
    message: `${TARGET_FILE} was edited while instrumented. The original is saved outside the project.`,
    diffs: {
      originalToInstrumented: DIFF_TEXT,
      instrumentedToCurrent: DIFF_TEXT,
      originalToCurrent: DIFF_TEXT,
    },
    ...overrides,
  };
}

/** A copy of the default conflict fixture with one key removed. */
function conflictWithout(key: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(makeConflict()).filter(([name]) => name !== key));
}

/** A validated conflict fixture, typed by the schema that accepted it. */
function validConflict(overrides: RecordOverrides = {}): ModificationConflict {
  return okValue(parseModificationConflict(makeConflict(overrides)), 'a conflict fixture');
}

// ---------------------------------------------------------------------------
// Status vocabularies — the sets the store's CHECK constraint and the
// service-start reconciliation of AAP §0.5.1 are both written against.
// ---------------------------------------------------------------------------

describe('MODIFICATION_STATUSES', () => {
  it('declares the five statuses in the order AAP §0.2.3 lists the column', () => {
    // Order is asserted, not just membership: the store DDL, the reconciliation
    // table in `../cleanup.ts` and this tuple are read side by side, and a
    // sorted or reordered vocabulary would make that three-way reading a
    // guessing game.
    expect(MODIFICATION_STATUSES).toEqual(['pending', 'applied', 'reverted', 'conflict', 'failed']);
  });

  it('carries no duplicate', () => {
    expect(new Set(MODIFICATION_STATUSES).size).toBe(MODIFICATION_STATUSES.length);
  });

  it('names "pending" as the status a record is created in', () => {
    // The journal-before-write state of AAP §0.5.1: the entry that exists
    // precisely so a crash between the journal append and the rename is
    // decidable.
    expect(DEFAULT_MODIFICATION_STATUS).toBe('pending');
    expect(MODIFICATION_STATUSES).toContain(DEFAULT_MODIFICATION_STATUS);
  });

  it.each(MODIFICATION_STATUSES)('recognises %s as a status', (status) => {
    expect(isModificationStatus(status)).toBe(true);
    expect(modificationStatusSchema.safeParse(status).success).toBe(true);
  });

  it.each([
    ['an unknown status', 'partially-applied'],
    ['a status in the wrong case', 'Applied'],
    ['an empty string', ''],
    ['a number', 1],
    ['null', null],
    ['undefined', undefined],
    ['an object', { status: 'applied' }],
  ] as readonly (readonly [string, unknown])[])('rejects %s', (_label, value) => {
    expect(isModificationStatus(value)).toBe(false);
    expect(modificationStatusSchema.safeParse(value).success).toBe(false);
  });
});

describe('OPEN_MODIFICATION_STATUSES', () => {
  it('is exactly the four statuses that still require reconciliation', () => {
    // This is the set AAP §0.5.1 requires service-start reconciliation to act
    // on REGARDLESS of the owning session's status — a session left in
    // `capturing`, `generated` or `failed` still has patched files on disk — and
    // it is the filter behind `ModificationJournal.listOpen()`.
    expect(OPEN_MODIFICATION_STATUSES).toEqual(['pending', 'applied', 'failed', 'conflict']);
  });

  it('carries no duplicate and is a subset of the full vocabulary', () => {
    expect(new Set(OPEN_MODIFICATION_STATUSES).size).toBe(OPEN_MODIFICATION_STATUSES.length);

    for (const status of OPEN_MODIFICATION_STATUSES) {
      expect(MODIFICATION_STATUSES).toContain(status);
    }
  });

  it('excludes "reverted", and nothing else', () => {
    // `reverted` is the only status with nothing left to do: the backup was
    // restored, the restored content was verified against `originalHash` and the
    // backup was deleted. Everything else — including `conflict`, whose backup
    // is retained and which is re-reported on every start until the developer
    // resolves it — stays open.
    expect(OPEN_MODIFICATION_STATUSES).not.toContain('reverted');
    expect(OPEN_MODIFICATION_STATUSES).toContain('conflict');
    expect([...OPEN_MODIFICATION_STATUSES].sort()).toEqual(
      MODIFICATION_STATUSES.filter((status) => status !== 'reverted').sort(),
    );
  });

  it.each(MODIFICATION_STATUSES)('agrees with the guard for %s', (status) => {
    expect(isOpenModificationStatus(status)).toBe(status !== 'reverted');
  });

  it.each([
    ['an unknown status', 'half-applied'],
    ['a number', 0],
    ['null', null],
    ['undefined', undefined],
  ] as readonly (readonly [string, unknown])[])('does not treat %s as open', (_label, value) => {
    expect(isOpenModificationStatus(value)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Digests — the values the restore-versus-conflict decision compares as
// strings, which is why one spelling of them is enforced.
// ---------------------------------------------------------------------------

describe('SHA256_HEX_PATTERN', () => {
  it('accepts a 64-character lowercase hexadecimal digest', () => {
    // Also the assertion on this suite's own fixture builder: every hash below
    // is assembled by `hashFixture`, so if that produced something the module
    // would refuse, every table in this file would be testing the wrong thing.
    for (const hash of [PRISTINE_HASH, PATCHED_HASH, CHAINED_HASH, DIVERGED_HASH]) {
      expect(hash).toHaveLength(SHA256_HEX_LENGTH);
      expect(SHA256_HEX_PATTERN.test(hash)).toBe(true);
      expect(sha256HexSchema.safeParse(hash).success).toBe(true);
    }

    expect(SHA256_HEX_PATTERN.test(hashFixture('0123456789abcdef'))).toBe(true);
  });

  it.each([
    ['one character short', PATCHED_HASH.slice(0, SHA256_HEX_LENGTH - 1)],
    ['one character long', `${PATCHED_HASH}0`],
    ['uppercase hexadecimal', PATCHED_HASH.toUpperCase()],
    ['mixed case', `${PATCHED_HASH.slice(0, -1)}B`],
    ['a non-hexadecimal character', `${PATCHED_HASH.slice(0, -1)}z`],
    ['an empty string', ''],
    ['a 0x prefix', `0x${PATCHED_HASH.slice(2)}`],
    ['surrounding whitespace', ` ${PATCHED_HASH} `],
    ['an embedded newline', `${PATCHED_HASH.slice(0, -1)}\n`],
  ] as readonly (readonly [string, string])[])('rejects %s', (_label, value) => {
    expect(SHA256_HEX_PATTERN.test(value)).toBe(false);
    expect(sha256HexSchema.safeParse(value).success).toBe(false);
  });

  it('carries no flags, so repeated tests of one value agree', () => {
    // A global regular expression keeps a mutable `lastIndex`, so successive
    // `.test()` calls against one shared instance alternate between true and
    // false. This pattern is module-level and consulted on every validation,
    // which is exactly the situation that hides that bug until it decides
    // whether a developer's file may be overwritten.
    expect(SHA256_HEX_PATTERN.flags).toBe('');
    expect(SHA256_HEX_PATTERN.global).toBe(false);
    expect(SHA256_HEX_PATTERN.sticky).toBe(false);
    expect(SHA256_HEX_PATTERN.lastIndex).toBe(0);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(SHA256_HEX_PATTERN.test(PATCHED_HASH)).toBe(true);
    }
  });

  it('is anchored at both ends', () => {
    expect(SHA256_HEX_PATTERN.test(`prefix${PATCHED_HASH}`)).toBe(false);
    expect(SHA256_HEX_PATTERN.test(`${PATCHED_HASH}suffix`)).toBe(false);
  });
});

describe('MODIFICATION_ID_PATTERN', () => {
  it('matches what newModificationId() mints', () => {
    // The pattern exists so the patcher, the store and these suites can
    // recognise an id without importing the generator. Asserting it against the
    // real generator is what keeps the copy honest.
    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect(MODIFICATION_ID_PATTERN.test(newModificationId())).toBe(true);
    }

    expect(MODIFICATION_ID_PATTERN.test(modificationIdFixture('first'))).toBe(true);
  });

  it('carries no flags', () => {
    expect(MODIFICATION_ID_PATTERN.flags).toBe('');
    expect(MODIFICATION_ID_PATTERN.lastIndex).toBe(0);
  });

  it.each([
    ['another kind of id', SESSION_ID],
    ['no prefix', 'first00000000000'],
    ['an uppercase prefix', 'MOD_first00000000'],
    ['a short suffix', 'mod_first'],
    ['a long suffix', `mod_${'a'.repeat(MODIFICATION_ID_SUFFIX_LENGTH + 1)}`],
    ['an uppercase suffix', 'mod_FIRST00000000'],
    ['a suffix with a separator', 'mod_first-00000000'],
    ['an empty string', ''],
  ] as readonly (readonly [string, string])[])('rejects %s', (_label, value) => {
    expect(MODIFICATION_ID_PATTERN.test(value)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Paths — `file` is contained inside the project; `backupPath` deliberately is
// not.
// ---------------------------------------------------------------------------

describe('the file field', () => {
  it.each([
    ['a nested project-relative path', 'src/lib/nested/deep/module.ts'],
    ['a file at the project root', 'module.ts'],
    ['a TSX file', 'src/ui/widget.tsx'],
    ['a non-ASCII file name', 'src/lib/caf\u00e9.ts'],
    ['a name with spaces', 'src/lib/two words.ts'],
    ['an interior ".." that resolves back inside', 'src/lib/../module.ts'],
  ] as readonly (readonly [string, string])[])('accepts %s', (_label, file) => {
    expect(modificationRecordSchema.safeParse(makeRecord({ file })).success).toBe(true);
    // The schema delegates to `isSafeRelativePath` from `@debuggen/shared` —
    // the same containment predicate the patcher applies before it resolves a
    // path, the service's `source/open.ts` applies before it forwards a click,
    // and the VS Code URI handler applies independently of both. Asserting the
    // predicate alongside the schema is what proves they cannot disagree.
    expect(isSafeRelativePath(file)).toBe(true);
  });

  it.each([
    ['a POSIX-absolute path', '/home/example/project/src/lib/module.ts'],
    ['a Windows drive path', 'C:\\project\\src\\module.ts'],
    ['a Windows drive path with forward slashes', 'C:/project/src/module.ts'],
    ['a UNC path', '\\\\host\\share\\module.ts'],
    ['a leading ".." escape', '../outside/module.ts'],
    ['a mid-path ".." escape', 'src/../../outside/module.ts'],
    ['a bare ".."', '..'],
    ['a backslash separator', 'src\\lib\\module.ts'],
    ['an empty path', ''],
    ['a blank path', '   '],
    ['a path carrying NUL', 'src/lib/mod\u0000ule.ts'],
    ['a path carrying a newline', 'src/lib/mod\nule.ts'],
  ] as readonly (readonly [string, string])[])('rejects %s', (label, file) => {
    const error = errValue(parseModificationRecord(makeRecord({ file })), `the path ${label}`);

    expect(issuePaths(error)).toContain('file');
    expect(isSafeRelativePath(file)).toBe(false);
  });

  it('rejects a path past the length bound', () => {
    const tooLong = `src/${'a'.repeat(1024)}.ts`;

    expect(modificationRecordSchema.safeParse(makeRecord({ file: tooLong })).success).toBe(false);
  });
});

describe('the backupPath field', () => {
  it('accepts an absolute path outside every project', () => {
    // Backups live under `$DEBUGGEN_HOME/backups/<sessionId>/<originalHash>`,
    // outside any checkout, so a debugging session never pollutes the
    // developer's `git status` and a backup survives a branch switch
    // (AAP §0.2.3, §0.4.2). Applying the project-relative rule to this field
    // would reject every legitimate value, so the acceptance is asserted
    // explicitly rather than left to be inferred from its absence.
    const backupPath = backupPathFixture(SESSION_ID, PRISTINE_HASH);

    expect(backupPath.startsWith('/')).toBe(true);
    expect(isSafeRelativePath(backupPath)).toBe(false);
    expect(modificationRecordSchema.safeParse(makeRecord({ backupPath })).success).toBe(true);
    expect(validRecord({ backupPath }).backupPath).toBe(backupPath);
  });

  it('accepts a path whose directory segments are the session and the digest', () => {
    const record = validRecord();

    expect(record.backupPath).toBe(`${DEBUGGEN_HOME}/backups/${SESSION_ID}/${PRISTINE_HASH}`);
    expect(record.backupPath.endsWith(record.originalHash)).toBe(true);
  });

  it.each([
    ['an empty string', ''],
    ['a blank string', '  '],
    ['a value carrying NUL', `${DEBUGGEN_HOME}/backups/ses\u0000/abc`],
    ['a value carrying a newline', `${DEBUGGEN_HOME}/backups/ses\n/abc`],
  ] as readonly (readonly [string, string])[])('rejects %s', (label, backupPath) => {
    const error = errValue(
      parseModificationRecord(makeRecord({ backupPath })),
      `the backup path ${label}`,
    );

    expect(issuePaths(error)).toContain('backupPath');
  });
});

// ---------------------------------------------------------------------------
// ModificationRecord — the AAP §0.2.3 row, column for column.
// ---------------------------------------------------------------------------

/**
 * The required columns of the store's `modifications` table, in the order AAP
 * §0.2.3 lists them.
 *
 * Written out here rather than derived from the schema, because deriving it
 * would make the guard below tautological: the point is that this file, the
 * store's DDL and the protocol's `instrumentation.ready` payload independently
 * state the same list.
 */
const RECORD_COLUMNS = [
  'id',
  'sessionId',
  'planVersion',
  'file',
  'originalHash',
  'backupPath',
  'instrumentedHash',
  'appliedAt',
  'status',
  'diff',
] as const;

/** The full column list, including the optional follow-up chain link. */
const RECORD_COLUMNS_WITH_CHAIN = [...RECORD_COLUMNS, 'previousRecordId'];

describe('modificationRecordSchema', () => {
  it('accepts a full record and returns it unchanged', () => {
    const candidate = makeRecord();
    const parsed = modificationRecordSchema.safeParse(candidate);

    expect(parsed.success).toBe(true);
    // Deep equality with the input is the assertion that no `.transform()`,
    // `.default()` or coercion crept in. Normalisation belongs to
    // `createModificationRecord`; a schema that rewrote a value would let a row
    // read back out of SQLite differ from the row that was written, and the
    // hashes on it would then describe bytes nobody can find.
    expect(parsed.success ? parsed.data : undefined).toEqual(candidate);
  });

  it('carries exactly the AAP §0.2.3 columns, and nothing else', () => {
    // The mechanical guard this file exists for. A field added to the schema
    // without the store's `modifications` table and the protocol's
    // `instrumentation.ready` payload learning about it is silent data loss:
    // the patcher would record something the journal cannot persist and neither
    // user interface can render. The declared shape is asserted as well as a
    // parsed instance, so an added OPTIONAL field — absent from any fixture and
    // therefore invisible to a key check on parsed output — is caught too.
    expect(Object.keys(modificationRecordSchema.shape)).toEqual(RECORD_COLUMNS_WITH_CHAIN);
    expect(Object.keys(validRecord())).toEqual([...RECORD_COLUMNS]);
    expect(Object.keys(validRecord({ previousRecordId: modificationIdFixture('older') }))).toEqual(
      RECORD_COLUMNS_WITH_CHAIN,
    );
  });

  it('leaves previousRecordId absent rather than present and undefined', () => {
    const record = validRecord();

    // Absent, not `null` and not `undefined`: the record is stored and
    // transported as JSON, and an absent key is the one representation SQLite,
    // the WebSocket and both user interfaces agree on.
    expect('previousRecordId' in record).toBe(false);
    expect(record.previousRecordId).toBeUndefined();
    expect(JSON.stringify(record)).not.toContain('previousRecordId');
  });

  it('accepts a record that names the record it is layered on', () => {
    const previousRecordId = modificationIdFixture('older');
    const record = validRecord({ previousRecordId });

    expect(record.previousRecordId).toBe(previousRecordId);
  });

  it.each(MODIFICATION_STATUSES)('accepts a record in status %s', (status) => {
    expect(validRecord({ status }).status).toBe(status);
  });

  it('requires both hashes, so a pending record already knows its expected bytes', () => {
    // The single ordering decision of AAP §0.5.1: because the journal records
    // the post-write hash BEFORE the rename, reconciliation can tell "nothing
    // was written" (the file hashes to `originalHash`) from "our patch landed
    // but was never marked" (`instrumentedHash`) from "the developer changed it"
    // (neither). A schema that let `instrumentedHash` arrive after the write
    // would dismantle that without failing anything else.
    const pending = validRecord({ status: 'pending' });

    expect(pending.originalHash).toBe(PRISTINE_HASH);
    expect(pending.instrumentedHash).toBe(PATCHED_HASH);
    expect(modificationRecordSchema.safeParse(recordWithout('instrumentedHash')).success).toBe(
      false,
    );
  });

  it.each([...RECORD_COLUMNS])('rejects a record missing %s', (column) => {
    const error = errValue(
      parseModificationRecord(recordWithout(column)),
      `a record missing ${column}`,
    );

    expect(issuePaths(error)).toContain(column);
  });

  it.each([
    ['an id of another kind', makeRecord({ id: SESSION_ID }), 'id'],
    ['an unprefixed id', makeRecord({ id: 'first00000000000' }), 'id'],
    ['an uppercase id suffix', makeRecord({ id: 'mod_FIRST00000000' }), 'id'],
    ['an empty session id', makeRecord({ sessionId: '' }), 'sessionId'],
    ['a blank session id', makeRecord({ sessionId: '   ' }), 'sessionId'],
    ['a session id carrying NUL', makeRecord({ sessionId: 'ses_a\u0000b' }), 'sessionId'],
    ['a plan version of zero', makeRecord({ planVersion: 0 }), 'planVersion'],
    ['a negative plan version', makeRecord({ planVersion: -1 }), 'planVersion'],
    ['a fractional plan version', makeRecord({ planVersion: 1.5 }), 'planVersion'],
    ['a plan version written as a string', makeRecord({ planVersion: '1' }), 'planVersion'],
    ['a NaN plan version', makeRecord({ planVersion: Number.NaN }), 'planVersion'],
    [
      'an infinite plan version',
      makeRecord({ planVersion: Number.POSITIVE_INFINITY }),
      'planVersion',
    ],
    [
      'an uppercase original hash',
      makeRecord({ originalHash: PRISTINE_HASH.toUpperCase() }),
      'originalHash',
    ],
    [
      'a truncated original hash',
      makeRecord({ originalHash: PRISTINE_HASH.slice(1) }),
      'originalHash',
    ],
    [
      'an instrumented hash with a non-hexadecimal character',
      makeRecord({ instrumentedHash: `${PATCHED_HASH.slice(0, -1)}g` }),
      'instrumentedHash',
    ],
    [
      'an instrumented hash written as a number',
      makeRecord({ instrumentedHash: 1_234 }),
      'instrumentedHash',
    ],
    ['a zero timestamp', makeRecord({ appliedAt: 0 }), 'appliedAt'],
    ['a negative timestamp', makeRecord({ appliedAt: -1 }), 'appliedAt'],
    ['a NaN timestamp', makeRecord({ appliedAt: Number.NaN }), 'appliedAt'],
    ['an infinite timestamp', makeRecord({ appliedAt: Number.POSITIVE_INFINITY }), 'appliedAt'],
    ['a timestamp written as a string', makeRecord({ appliedAt: '1700000000000' }), 'appliedAt'],
    ['an ISO-8601 timestamp', makeRecord({ appliedAt: '2026-09-19T00:00:00.000Z' }), 'appliedAt'],
    ['an unknown status', makeRecord({ status: 'half-applied' }), 'status'],
    ['a status in the wrong case', makeRecord({ status: 'Applied' }), 'status'],
    ['a diff written as a number', makeRecord({ diff: 42 }), 'diff'],
    ['a diff written as an array of lines', makeRecord({ diff: ['-a', '+b'] }), 'diff'],
    [
      'a chain link of another kind',
      makeRecord({ previousRecordId: SESSION_ID }),
      'previousRecordId',
    ],
  ] as readonly (readonly [string, unknown, string])[])(
    'rejects %s and names the field',
    (label, candidate, field) => {
      expect(modificationRecordSchema.safeParse(candidate).success).toBe(false);

      const error = errValue(parseModificationRecord(candidate), label);

      expect(error.code).toBe('PROTOCOL_INVALID_MESSAGE');
      expect(issuePaths(error)).toContain(field);
      // AAP §0.5.5 makes the recovery path contractual, so a rejection must
      // always carry one. Its wording is not asserted anywhere in this file.
      expect(error.hint).toBeDefined();
    },
  );

  it('rejects an unknown key rather than stripping it', () => {
    // `z.strictObject`, not `z.object`. This shape is a journal the product's
    // central promise depends on, not a lenient process boundary: a producer
    // sending a field this version does not understand is a version mismatch
    // that must surface loudly instead of losing data quietly.
    const parsed = modificationRecordSchema.safeParse(makeRecord({ revertedAt: 1 }));

    expect(parsed.success).toBe(false);
    expect(parseModificationRecord(makeRecord({ revertedAt: 1 })).ok).toBe(false);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'mod_first00000000'],
    ['a number', 1],
    ['a boolean', true],
    ['an array of records', [makeRecord()]],
    ['an empty object', {}],
  ] as readonly (readonly [string, unknown])[])('rejects %s as a record', (label, candidate) => {
    expect(modificationRecordSchema.safeParse(candidate).success).toBe(false);
    expect(errValue(parseModificationRecord(candidate), label).code).toBe(
      'PROTOCOL_INVALID_MESSAGE',
    );
  });

  it('accepts a sub-millisecond timestamp but not a non-positive one', () => {
    // Epoch milliseconds are the product's canonical time base, so a record's
    // timestamp is directly comparable with a telemetry event's `startTime`.
    // The field is not constrained to an integer: a finer reading is a more
    // precise answer to the same question, and rejecting it would be rejecting
    // better data.
    expect(validRecord({ appliedAt: 1_700_000_000_000.25 }).appliedAt).toBe(1_700_000_000_000.25);
    expect(modificationRecordSchema.safeParse(makeRecord({ appliedAt: 0 })).success).toBe(false);
  });

  it('accepts an empty diff but not one past the cap', () => {
    // An empty diff is not this schema's error to report — the patcher refuses
    // to journal a transform that changed nothing — while the cap keeps a
    // pathological rewrite out of a SQLite row and an `instrumentation.ready`
    // frame.
    expect(validRecord({ diff: '' }).diff).toBe('');
    expect(
      modificationRecordSchema.safeParse(
        makeRecord({ diff: '-'.repeat(MAX_MODIFICATION_DIFF_LENGTH) }),
      ).success,
    ).toBe(true);
    expect(
      modificationRecordSchema.safeParse(
        makeRecord({ diff: '-'.repeat(MAX_MODIFICATION_DIFF_LENGTH + 1) }),
      ).success,
    ).toBe(false);
  });

  it('survives a JSON round trip unchanged', () => {
    // Records are persisted in a SQLite JSON column and delivered over a
    // WebSocket, so nothing in one may be a value JSON cannot carry: no `Date`,
    // no `Buffer`, no `Map`, no class instance.
    const record = validRecord({ previousRecordId: modificationIdFixture('older') });
    const roundTripped: unknown = JSON.parse(JSON.stringify(record));

    expect(roundTripped).toEqual(record);
    expect(okValue(parseModificationRecord(roundTripped), 'a round-tripped record')).toEqual(
      record,
    );
  });
});

// ---------------------------------------------------------------------------
// Follow-up chains (AAP §0.4.2) — the relationship cleanup unwinds.
// ---------------------------------------------------------------------------

describe('a follow-up chain over one file', () => {
  it("takes the earlier record's instrumented hash as its own original hash", () => {
    // A follow-up question produces plan version n + 1 whose delta touches a
    // file plan version n already patched. The bytes the later record replaces
    // ARE the earlier patch's output, so its `originalHash` is the earlier
    // record's `instrumentedHash` and its backup holds the
    // already-instrumented content — which is correct, and is exactly what lets
    // cleanup unwind the chain in STRICT REVERSE ORDER, verifying at each step
    // that the file currently hashes to *that* record's `instrumentedHash`
    // before writing *that* record's backup. Restoring the pair in the other
    // order would write the pristine bytes first and then overwrite them with
    // the intermediate patch.
    const first = validRecord({
      id: modificationIdFixture('first'),
      planVersion: 1,
      originalHash: PRISTINE_HASH,
      instrumentedHash: PATCHED_HASH,
      backupPath: backupPathFixture(SESSION_ID, PRISTINE_HASH),
      status: 'applied',
    });
    const second = validRecord({
      id: modificationIdFixture('second'),
      planVersion: 2,
      originalHash: first.instrumentedHash,
      instrumentedHash: CHAINED_HASH,
      backupPath: backupPathFixture(SESSION_ID, first.instrumentedHash),
      previousRecordId: first.id,
      status: 'applied',
    });

    expect(second.originalHash).toBe(first.instrumentedHash);
    expect(second.previousRecordId).toBe(first.id);
    expect(second.planVersion).toBe(first.planVersion + 1);
    expect(second.file).toBe(first.file);
    // The backup is keyed by the digest of the bytes it holds, so the chain is
    // readable from the paths alone: each link's backup is named after the
    // previous link's output.
    expect(second.backupPath.endsWith(first.instrumentedHash)).toBe(true);
    expect(first.backupPath.endsWith(PRISTINE_HASH)).toBe(true);
  });

  it('rejects a record that names itself as the record it is layered on', () => {
    // The implementation FORBIDS self-reference: `modificationRecordSchema`
    // carries a refinement whose issue path is `previousRecordId`, and this
    // test pins that choice. A record pointing at itself is unambiguously wrong
    // and cheap to catch at the field boundary, and cleanup walking it would
    // never terminate.
    const id = modificationIdFixture('first');
    const error = errValue(
      parseModificationRecord(makeRecord({ id, previousRecordId: id })),
      'a self-referencing record',
    );

    expect(issuePaths(error)).toContain('previousRecordId');
    expect(error.code).toBe('PROTOCOL_INVALID_MESSAGE');
  });

  it('permits a longer cycle, whose detection belongs to cleanup', () => {
    // A → B → A spans two records the schema never sees together, so it cannot
    // be a field constraint. `../cleanup.ts` holds the whole chain while it
    // walks it in reverse order and is the only place that can answer the
    // question; this assertion records that the latitude is deliberate rather
    // than an oversight, so a future reader does not "fix" it here and leave
    // the real check unwritten.
    const firstId = modificationIdFixture('first');
    const secondId = modificationIdFixture('second');

    expect(validRecord({ id: firstId, previousRecordId: secondId }).previousRecordId).toBe(
      secondId,
    );
    expect(validRecord({ id: secondId, previousRecordId: firstId }).previousRecordId).toBe(firstId);
  });
});

// ---------------------------------------------------------------------------
// Failure reporting — AAP §0.5.2 applies to errors, not only to telemetry.
// ---------------------------------------------------------------------------

describe('rejection privacy', () => {
  /**
   * A distinctive token, assembled at run time.
   *
   * Assembled so the literal never appears in this file's source: a
   * secret-shaped constant would be exactly what `scripts/check-secrets.mjs`
   * exists to find, and a reader of the source cannot match what is not there.
   */
  const token = (): string => ['qz', '7', 'vk', '3'].join('');

  it('never echoes a rejected value back through a record failure', () => {
    // A `diff` is a slice of the developer's source and a `backupPath` carries
    // their home directory, and this error is logged, persisted with a session
    // and rendered in a user interface — while the redaction layer never sees a
    // failure raised this deep in the call stack. What may travel is the SHAPE
    // of the failure: which field, and what the schema expected.
    const secret = token();
    const error = errValue(
      parseModificationRecord(
        makeRecord({ file: `src/${secret}/module.ts`, originalHash: secret, diff: secret }),
      ),
      'a record carrying a distinctive value',
    );

    expect(error.message).not.toContain(secret);
    expect(JSON.stringify(error.toPayload())).not.toContain(secret);
    expect(JSON.stringify(error.details)).not.toContain(secret);
    expect(error.hint).toBeDefined();
    expect(error.hint).not.toContain(secret);
    // The field paths still arrive, so a producer knows what to fix.
    expect(issuePaths(error)).toContain('originalHash');
  });

  it('never echoes a rejected value back through a conflict failure', () => {
    const secret = token();
    const error = errValue(
      parseModificationConflict(makeConflict({ expectedHash: secret, message: secret })),
      'a conflict carrying a distinctive value',
    );

    expect(error.message).not.toContain(secret);
    expect(JSON.stringify(error.toPayload())).not.toContain(secret);
    expect(JSON.stringify(error.details)).not.toContain(secret);
  });

  it('never echoes a rejected value back through a construction failure', () => {
    const secret = token();
    const error = errValue(
      notThrown(
        createOutcome(makeCreateInput({ originalHash: secret, diff: secret })),
        'a construction with a distinctive hash',
      ),
      'a construction with a distinctive hash',
    );

    expect(error.message).not.toContain(secret);
    expect(JSON.stringify(error.toPayload())).not.toContain(secret);
    expect(JSON.stringify(error.details)).not.toContain(secret);
  });

  it('reports a construction failure as the operation it blocks', () => {
    // `INSTRUMENTATION_INSTALL_FAILED`, not a protocol code: the caller is
    // about to patch a file and now must not. Nothing has been written, so the
    // hint says the patch can be abandoned safely (AAP §0.5.5).
    const error = errValue(
      notThrown(
        createOutcome(makeCreateInput({ planVersion: 0 })),
        'a construction with a zero plan version',
      ),
      'a construction with a zero plan version',
    );

    expect(error.code).toBe('INSTRUMENTATION_INSTALL_FAILED');
    expect(error.hint).toBeDefined();
    expect(DebuggenError.is(error)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// createModificationRecord — the one constructor, called at step 4 of the
// AAP §0.5.1 sequence: after the backup is durable, before the project changes.
// ---------------------------------------------------------------------------

describe('createModificationRecord', () => {
  it('mints an id of the shape the store keys records by', () => {
    const first = okValue(createModificationRecord(makeCreateInput()), 'a minted record');
    const second = okValue(createModificationRecord(makeCreateInput()), 'a second minted record');

    expect(MODIFICATION_ID_PATTERN.test(first.id)).toBe(true);
    expect(MODIFICATION_ID_PATTERN.test(newModificationId())).toBe(true);
    // Every later step of the sequence refers to the record by this id — the
    // `updateStatus` that marks it applied, a follow-up record's
    // `previousRecordId`, a conflict's `recordId` — so two records must never
    // share one.
    expect(second.id).not.toBe(first.id);
  });

  it('uses the injected id and clock exactly', () => {
    const id = modificationIdFixture('injected');
    const record = okValue(
      createModificationRecord(makeCreateInput(), {
        newId: () => id,
        now: () => 1_700_000_012_345,
      }),
      'a record with injected generators',
    );

    expect(record.id).toBe(id);
    expect(record.appliedAt).toBe(1_700_000_012_345);
  });

  it('defaults the status to the journal-before-write state', () => {
    // The default is the point: AAP §0.5.1 requires the entry to exist as
    // `pending` before any byte is written, so the ordinary caller — the
    // patcher, mid-sequence — passes no status at all.
    expect(okValue(createModificationRecord(makeCreateInput()), 'a defaulted record').status).toBe(
      DEFAULT_MODIFICATION_STATUS,
    );
  });

  it.each(MODIFICATION_STATUSES)('honours an explicit status of %s', (status) => {
    const record = okValue(
      createModificationRecord(makeCreateInput({ status })),
      `a record created as ${status}`,
    );

    expect(record.status).toBe(status);
  });

  it.each([
    ['a cosmetic leading "./"', `./${TARGET_FILE}`, TARGET_FILE],
    ['redundant "./" segments', './src/./lib/timing-target.ts', TARGET_FILE],
    ['Windows-flavoured separators', 'src\\lib\\timing-target.ts', TARGET_FILE],
    ['a doubled separator', 'src//lib//timing-target.ts', TARGET_FILE],
    [
      'an interior ".." that resolves back inside',
      'src/lib/nested/../timing-target.ts',
      TARGET_FILE,
    ],
  ] as readonly (readonly [string, string, string])[])(
    'normalises %s into the one spelling the schema accepts',
    (label, file, expected) => {
      // A caller may hold a path from a Windows-flavoured API or a ts-morph
      // relative path; both are the same file. Normalising here — and only here
      // — keeps "what is valid" and "how a value is built" in separate places,
      // so a row read back from SQLite is never quietly rewritten on the way
      // out.
      expect(okValue(createModificationRecord(makeCreateInput({ file })), label).file).toBe(
        expected,
      );
    },
  );

  it.each([
    ['an invalid original hash', makeCreateInput({ originalHash: 'not-a-digest' }), 'originalHash'],
    [
      'an uppercase instrumented hash',
      makeCreateInput({ instrumentedHash: PATCHED_HASH.toUpperCase() }),
      'instrumentedHash',
    ],
    ['an absolute file path', makeCreateInput({ file: '/home/example/project/a.ts' }), 'file'],
    ['a file path escaping the project', makeCreateInput({ file: '../outside/a.ts' }), 'file'],
    ['a zero plan version', makeCreateInput({ planVersion: 0 }), 'planVersion'],
    ['a negative plan version', makeCreateInput({ planVersion: -2 }), 'planVersion'],
    ['a fractional plan version', makeCreateInput({ planVersion: 2.5 }), 'planVersion'],
    ['an empty session id', makeCreateInput({ sessionId: '' }), 'sessionId'],
    ['an empty backup path', makeCreateInput({ backupPath: '' }), 'backupPath'],
    [
      'a self-referencing chain link',
      makeCreateInput({ previousRecordId: modificationIdFixture('self') }),
      'previousRecordId',
    ],
  ] as readonly (readonly [string, CreateModificationRecordInput, string])[])(
    'returns a failure for %s instead of throwing',
    (label, input, field) => {
      const options =
        field === 'previousRecordId' ? { newId: () => modificationIdFixture('self') } : undefined;
      const error = errValue(notThrown(createOutcome(input, options), label), label);

      expect(error.code).toBe('INSTRUMENTATION_INSTALL_FAILED');
      expect(issuePaths(error)).toContain(field);
    },
  );

  it('absorbs a throwing generator rather than unwinding past a written backup', () => {
    // This call sits between a durable backup and the only write, so even an
    // unexpected failure has to come back as a value the patcher can abandon
    // the patch on.
    const outcome = createOutcome(makeCreateInput(), {
      newId: () => {
        throw new Error('the injected generator failed');
      },
    });

    expect(
      errValue(notThrown(outcome, 'a throwing id generator'), 'a throwing id generator').code,
    ).toBe('INTERNAL');
  });

  it('produces a record the schema accepts, with the chain key only when asked', () => {
    const plain = okValue(createModificationRecord(makeCreateInput()), 'a plain record');
    const chained = okValue(
      createModificationRecord(
        makeCreateInput({ previousRecordId: modificationIdFixture('older') }),
      ),
      'a chained record',
    );

    expect(modificationRecordSchema.safeParse(plain).success).toBe(true);
    expect(modificationRecordSchema.safeParse(chained).success).toBe(true);
    expect(Object.keys(plain)).toEqual([...RECORD_COLUMNS]);
    expect(Object.keys(chained)).toEqual(RECORD_COLUMNS_WITH_CHAIN);
  });

  it('is pure and deterministic under injected generators', () => {
    const input = makeCreateInput();
    const snapshot: unknown = JSON.parse(JSON.stringify(input));
    const generators = {
      newId: () => modificationIdFixture('fixed'),
      now: () => 1_700_000_000_007,
    };

    const first = okValue(createModificationRecord(input, generators), 'the first construction');
    const second = okValue(createModificationRecord(input, generators), 'the second construction');

    expect(second).toEqual(first);
    // The input is frozen, so a mutation would have thrown; the comparison
    // states the intent for a reader who changes the fixture later.
    expect(input).toEqual(snapshot);
    expect(JSON.parse(JSON.stringify(first))).toEqual(first);
  });
});

// ---------------------------------------------------------------------------
// ModificationConflict — the report that makes "Debug Generator will not
// overwrite it" a true statement (AAP §0.5.1, §0.5.5).
// ---------------------------------------------------------------------------

/** The fields of a conflict report, in the order the schema declares them. */
const CONFLICT_FIELDS = [
  'recordId',
  'sessionId',
  'file',
  'reason',
  'expectedHash',
  'actualHash',
  'backupPath',
  'detectedAt',
  'message',
  'diffs',
];

describe('MODIFICATION_CONFLICT_REASONS', () => {
  it('declares one reason per branch of the AAP §0.5.1 reconciliation table', () => {
    // The mapping each member stands for, which is why the set is closed:
    //   'content-changed'             the file hashes to neither hash on the
    //                                 record — the developer edited a file
    //                                 while it was instrumented, the headline
    //                                 case of AAP §0.5.5;
    //   'file-missing'                the target file is gone (deleted, renamed
    //                                 or moved after the patch was applied), so
    //                                 there are no bytes to hash;
    //   'backup-missing'              the backup is gone or fails its own
    //                                 verification, so restoration is
    //                                 impossible and the record is surfaced
    //                                 rather than closed;
    //   'restore-verification-failed' the write completed but the restored
    //                                 content did not hash to `originalHash`,
    //                                 so the backup is kept;
    //   'record-chain-fork'           the file's open records do not form one
    //                                 chain (two live layers on one parent, or
    //                                 two open chains), so no reverse order
    //                                 exists and nothing is written.
    // Every one of them means the same thing operationally: no write is
    // authorised, the backup is retained, and the record stays open so the next
    // service start reports it again.
    expect(MODIFICATION_CONFLICT_REASONS).toEqual([
      'content-changed',
      'file-missing',
      'backup-missing',
      'restore-verification-failed',
      'record-chain-fork',
    ]);
  });

  it('carries no duplicate', () => {
    expect(new Set(MODIFICATION_CONFLICT_REASONS).size).toBe(MODIFICATION_CONFLICT_REASONS.length);
  });

  it.each(MODIFICATION_CONFLICT_REASONS)('accepts %s as a reason', (reason) => {
    expect(modificationConflictReasonSchema.safeParse(reason).success).toBe(true);
    expect(validConflict({ reason }).reason).toBe(reason);
  });

  it.each([
    ['an unknown reason', 'developer-edited'],
    ['a reason in the wrong case', 'Content-Changed'],
    ['an empty string', ''],
    ['a number', 3],
    ['null', null],
  ] as readonly (readonly [string, unknown])[])('rejects %s', (_label, reason) => {
    expect(modificationConflictReasonSchema.safeParse(reason).success).toBe(false);
    expect(modificationConflictSchema.safeParse(makeConflict({ reason })).success).toBe(false);
  });
});

describe('modificationConflictSchema', () => {
  it('accepts a report carrying all three diffs and returns it unchanged', () => {
    const candidate = makeConflict();
    const parsed = modificationConflictSchema.safeParse(candidate);

    expect(parsed.success).toBe(true);
    expect(parsed.success ? parsed.data : undefined).toEqual(candidate);
    expect(Object.keys(modificationConflictSchema.shape)).toEqual(CONFLICT_FIELDS);
  });

  it('accepts a report with no diffs at all', () => {
    // A conflict may leave nothing to diff: `file-missing` has no current text
    // and `backup-missing` has no original text. The object and every member of
    // it are optional for that reason, and an absent member reads as "nothing
    // to show here" — which is also why a patch past the cap is omitted rather
    // than clipped, since the shape carries no truncation flag.
    const bare = okValue(
      parseModificationConflict(conflictWithout('diffs')),
      'a conflict with no diffs',
    );

    expect('diffs' in bare).toBe(false);
    expect(modificationConflictSchema.safeParse(makeConflict({ diffs: {} })).success).toBe(true);
  });

  it.each([
    ['only the change the tool made', { originalToInstrumented: DIFF_TEXT }],
    ['only the developer’s change on top', { instrumentedToCurrent: DIFF_TEXT }],
    ['only the net divergence', { originalToCurrent: DIFF_TEXT }],
  ] as readonly (readonly [string, Record<string, string>])[])(
    'accepts a report carrying %s',
    (_label, diffs) => {
      expect(modificationConflictSchema.safeParse(makeConflict({ diffs })).success).toBe(true);
    },
  );

  it('rejects an unknown member inside diffs', () => {
    expect(
      modificationConflictSchema.safeParse(makeConflict({ diffs: { threeWay: DIFF_TEXT } }))
        .success,
    ).toBe(false);
  });

  it('bounds each diff independently of the record diff', () => {
    // Lower than the record's cap, because a conflict carries up to three
    // patches at once inside a `cleanup.completed` message that both user
    // interfaces render immediately.
    expect(MAX_CONFLICT_DIFF_LENGTH).toBeLessThan(MAX_MODIFICATION_DIFF_LENGTH);
    expect(
      modificationConflictSchema.safeParse(
        makeConflict({ diffs: { originalToCurrent: '-'.repeat(MAX_CONFLICT_DIFF_LENGTH) } }),
      ).success,
    ).toBe(true);
    expect(
      modificationConflictSchema.safeParse(
        makeConflict({ diffs: { originalToCurrent: '-'.repeat(MAX_CONFLICT_DIFF_LENGTH + 1) } }),
      ).success,
    ).toBe(false);
  });

  it('allows actualHash to be absent, because a missing file has no bytes to hash', () => {
    const missing = okValue(
      parseModificationConflict({ ...conflictWithout('actualHash'), reason: 'file-missing' }),
      'a conflict for a missing file',
    );

    expect('actualHash' in missing).toBe(false);
    // Optional rather than an empty string: a blank digest would be a value
    // that looks like an answer.
    expect(missing.actualHash).toBeUndefined();
    expect(missing.expectedHash).toBe(PATCHED_HASH);
  });

  it('requires actualHash to be a digest when it is present', () => {
    const conflict = validConflict();

    expect(conflict.actualHash).toBe(DIVERGED_HASH);
    // Both sides of the comparison that refused the write travel to interfaces
    // that do not hold the journal, so both must be readable as digests.
    expect(conflict.actualHash).not.toBe(conflict.expectedHash);

    for (const actualHash of ['', DIVERGED_HASH.toUpperCase(), DIVERGED_HASH.slice(1), 42]) {
      expect(modificationConflictSchema.safeParse(makeConflict({ actualHash })).success).toBe(
        false,
      );
    }
  });

  it('keeps the backup path, because the conflict path retains the backup', () => {
    // AAP §0.5.5 quotes this path to the developer ("Original saved at ‹backup
    // path›") so they can recover the pristine file by hand, and it is present
    // even for `backup-missing`, where it records the path that was expected and
    // is the only useful thing left to say.
    const conflict = validConflict({ reason: 'backup-missing' });

    expect(conflict.backupPath).toBe(backupPathFixture(SESSION_ID, PRISTINE_HASH));
    expect(modificationConflictSchema.safeParse(conflictWithout('backupPath')).success).toBe(false);
  });

  it.each([...CONFLICT_FIELDS.filter((field) => field !== 'actualHash' && field !== 'diffs')])(
    'rejects a report missing %s',
    (field) => {
      const error = errValue(
        parseModificationConflict(conflictWithout(field)),
        `a conflict missing ${field}`,
      );

      expect(error.code).toBe('PROTOCOL_INVALID_MESSAGE');
      expect(issuePaths(error)).toContain(field);
    },
  );

  it.each([
    ['a record id of another kind', makeConflict({ recordId: SESSION_ID }), 'recordId'],
    ['an empty session id', makeConflict({ sessionId: '' }), 'sessionId'],
    ['an absolute file path', makeConflict({ file: '/home/example/project/a.ts' }), 'file'],
    ['a file path escaping the project', makeConflict({ file: '../outside/a.ts' }), 'file'],
    ['an invalid expected hash', makeConflict({ expectedHash: 'nope' }), 'expectedHash'],
    ['a zero detection time', makeConflict({ detectedAt: 0 }), 'detectedAt'],
    ['a negative detection time', makeConflict({ detectedAt: -1 }), 'detectedAt'],
    ['a NaN detection time', makeConflict({ detectedAt: Number.NaN }), 'detectedAt'],
    [
      'an infinite detection time',
      makeConflict({ detectedAt: Number.POSITIVE_INFINITY }),
      'detectedAt',
    ],
    [
      'a detection time written as a string',
      makeConflict({ detectedAt: '1700000000500' }),
      'detectedAt',
    ],
    ['an empty message', makeConflict({ message: '' }), 'message'],
    ['a message written as an error object', makeConflict({ message: { text: 'x' } }), 'message'],
    ['an over-long message', makeConflict({ message: 'm'.repeat(2049) }), 'message'],
    ['an unknown key', makeConflict({ resolvedAt: 1 }), ''],
  ] as readonly (readonly [string, unknown, string])[])(
    'rejects %s and names the field',
    (label, candidate, field) => {
      const error = errValue(parseModificationConflict(candidate), label);

      expect(error.code).toBe('PROTOCOL_INVALID_MESSAGE');
      expect(issuePaths(error)).toContain(field);
      expect(error.hint).toBeDefined();
    },
  );

  it('accepts a sub-millisecond detection time, exactly as a record timestamp does', () => {
    // `detectedAt` and `appliedAt` share one validator, so a conflict's
    // timestamp is comparable with the record's and with a telemetry event's
    // `startTime` without a conversion nobody remembers to apply.
    expect(validConflict({ detectedAt: 1_700_000_000_500.5 }).detectedAt).toBe(1_700_000_000_500.5);
    expect(validRecord({ appliedAt: 1_700_000_000_500.5 }).appliedAt).toBe(1_700_000_000_500.5);
  });

  it('requires a non-empty message but says nothing about its wording', () => {
    // The developer-facing wording is authored by the service and the adapters
    // (AAP §0.5.5), which know the context and the recovery action to offer —
    // never by this schema and never by a model. All the schema insists on is
    // that a conflict can never reach a user interface as a blank row.
    expect(validConflict({ message: 'x' }).message).toBe('x');
    expect(validConflict({ message: 'm'.repeat(2048) }).message).toHaveLength(2048);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'content-changed'],
    ['an array', [makeConflict()]],
    ['an empty object', {}],
  ] as readonly (readonly [string, unknown])[])('rejects %s as a conflict', (label, candidate) => {
    expect(modificationConflictSchema.safeParse(candidate).success).toBe(false);
    expect(errValue(parseModificationConflict(candidate), label).code).toBe(
      'PROTOCOL_INVALID_MESSAGE',
    );
  });

  it('survives a JSON round trip unchanged', () => {
    // The report is carried by `cleanup.completed { sessionId, status,
    // conflicts }` (AAP §0.4.2) and rendered by the VS Code `DiffView` and the
    // DevTools `SessionSummary`, so every field has to be a JSON primitive and
    // no `Error` instance may appear anywhere in it.
    const conflict = validConflict();
    const roundTripped: unknown = JSON.parse(JSON.stringify(conflict));

    expect(roundTripped).toEqual(conflict);
    expect(okValue(parseModificationConflict(roundTripped), 'a round-tripped conflict')).toEqual(
      conflict,
    );
  });
});

// ---------------------------------------------------------------------------
// The ModificationJournal port — a compile-time contract test plus its
// documented semantics.
// ---------------------------------------------------------------------------

/**
 * An in-memory {@link ModificationJournal}.
 *
 * `@debuggen/instrumentation` never opens a database: it writes the journal
 * through this port, and two independent implementations satisfy it — the
 * service's `apps/local-service/src/store/modifications-repo.ts` over
 * synchronous `node:sqlite`, and the in-memory journals `../installer.test.ts`
 * and `../cleanup.test.ts` use to drive the real patcher with no
 * filesystem-backed store. This fake mirrors both, which is why it is written
 * to the port's documented semantics rather than to whatever these tests happen
 * to need:
 *
 * - `append` preserves insertion order, because that order is the order cleanup
 *   must reverse;
 * - `listBySession` returns one session's records in append order and no other
 *   session's;
 * - `listOpen` reaches across **all** sessions, filtered by
 *   {@link OPEN_MODIFICATION_STATUSES};
 * - `updateStatus` applies the patch and returns the updated record;
 * - an expected failure comes back as `err`, never as an exception, because
 *   these calls sit inside the crash-safe sequence;
 * - nothing is handed out by reference, so a caller cannot observe a status
 *   that was never journaled.
 *
 * The methods are deliberately not `async`: the port is asynchronous so that a
 * future out-of-process store does not force every caller to change, while a
 * synchronous implementation — which the `node:sqlite` one also is — settles
 * its promise immediately.
 */
class InMemoryJournal implements ModificationJournal {
  /** Append-ordered storage. A record is copied in and copied out. */
  private readonly records: ModificationRecord[] = [];

  /** @inheritdoc */
  append(record: ModificationRecord): Promise<Result<ModificationRecord>> {
    const stored: ModificationRecord = { ...record };
    this.records.push(stored);

    return Promise.resolve(ok({ ...stored }));
  }

  /** @inheritdoc */
  updateStatus(
    id: string,
    status: ModificationStatus,
    patch?: ModificationStatusPatch,
  ): Promise<Result<ModificationRecord>> {
    const index = this.records.findIndex((candidate) => candidate.id === id);
    const existing = index === -1 ? undefined : this.records[index];

    if (existing === undefined) {
      return Promise.resolve(
        err(
          new DebuggenError('STORE_ERROR', 'No modification record has that id.', {
            hint: 'Append the record before moving its status.',
          }),
        ),
      );
    }

    const updated: ModificationRecord = {
      ...existing,
      status,
      instrumentedHash: patch?.instrumentedHash ?? existing.instrumentedHash,
      diff: patch?.diff ?? existing.diff,
      appliedAt: patch?.appliedAt ?? existing.appliedAt,
      backupPath: patch?.backupPath ?? existing.backupPath,
    };

    this.records[index] = updated;

    return Promise.resolve(ok({ ...updated }));
  }

  /** @inheritdoc */
  listBySession(sessionId: string): Promise<Result<ModificationRecord[]>> {
    return Promise.resolve(
      ok(
        this.records
          .filter((record) => record.sessionId === sessionId)
          .map((record) => ({ ...record })),
      ),
    );
  }

  /** @inheritdoc */
  listOpen(): Promise<Result<ModificationRecord[]>> {
    return Promise.resolve(
      ok(
        this.records
          .filter((record) => isOpenModificationStatus(record.status))
          .map((record) => ({ ...record })),
      ),
    );
  }
}

/**
 * The port, satisfied by the fake above.
 *
 * This return type — together with the `implements` clause on the class and the
 * `ModificationJournal`-typed binding every test below receives from `seeded`
 * — is the contract test. `pnpm typecheck` compiles all three with `strict`,
 * `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` in force, so a
 * method signature that drifted from {@link ModificationJournal} — a dropped
 * optional patch argument, a `Result` that stopped being one, a promise that
 * stopped being returned — fails the blocking gate rather than this suite. No
 * cast appears anywhere in the implementation, which is the point: a cast would
 * prove only that TypeScript can be told to stop asking.
 *
 * @returns A fresh journal, so no test observes another's records.
 */
function newJournal(): ModificationJournal {
  return new InMemoryJournal();
}

/**
 * Settles a journal call, turning a thrown exception or a rejected promise into
 * a distinct value.
 *
 * The port documents that an expected failure — an unknown id, a closed store,
 * a constraint violation — is an `err`, never an exception, because these calls
 * sit between a durable backup and the only write.
 *
 * @param operation The call to settle.
 * @returns The `Result`, or the literal `'threw'`.
 */
async function settled<T>(
  operation: () => Promise<Result<T, DebuggenError>>,
): Promise<Result<T, DebuggenError> | 'threw'> {
  try {
    return await operation();
  } catch {
    return 'threw';
  }
}

describe('ModificationJournal', () => {
  /** Three records for one session, plus one for another, in append order. */
  async function seeded(): Promise<{
    readonly journal: ModificationJournal;
    readonly appended: readonly ModificationRecord[];
  }> {
    const journal = newJournal();
    const appended = [
      validRecord({ id: modificationIdFixture('one'), status: 'applied' }),
      validRecord({
        id: modificationIdFixture('two'),
        file: 'src/lib/second-target.ts',
        status: 'reverted',
      }),
      validRecord({
        id: modificationIdFixture('three'),
        file: 'src/lib/third-target.ts',
        status: 'conflict',
      }),
      validRecord({
        id: modificationIdFixture('four'),
        sessionId: OTHER_SESSION_ID,
        backupPath: backupPathFixture(OTHER_SESSION_ID, PRISTINE_HASH),
        status: 'pending',
      }),
    ];

    for (const record of appended) {
      okValue(await journal.append(record), `appending ${record.id}`);
    }

    return { journal, appended };
  }

  it('preserves insertion order, which is the order cleanup reverses', async () => {
    const { journal, appended } = await seeded();
    const listed = okValue(await journal.listBySession(SESSION_ID), 'listing one session');

    expect(listed.map((record) => record.id)).toEqual([
      modificationIdFixture('one'),
      modificationIdFixture('two'),
      modificationIdFixture('three'),
    ]);
    expect(listed[0]).toEqual(appended[0]);
  });

  it('lists only the named session, and answers an unknown one with an empty list', async () => {
    const { journal } = await seeded();

    expect(
      okValue(await journal.listBySession(OTHER_SESSION_ID), 'listing the other session').map(
        (record) => record.id,
      ),
    ).toEqual([modificationIdFixture('four')]);
    // An empty array is a success, not a failure: a session may legitimately
    // have installed nothing at all.
    expect(okValue(await journal.listBySession(sessionIdFixture('gamma')), 'listing none')).toEqual(
      [],
    );
  });

  it('lists open records across every session and excludes only the reverted one', async () => {
    // The whole point of `listOpen`: AAP §0.5.1 requires service-start
    // reconciliation to act on an open record REGARDLESS of the owning
    // session's status, so a filter by session here would leave a patched file
    // on disk whenever a session ended in `failed` or was abandoned
    // mid-capture. `conflict` is included — its backup is retained and it is
    // re-reported until the developer resolves it — and `reverted` is the one
    // status with nothing left to do.
    const { journal } = await seeded();
    const open = okValue(await journal.listOpen(), 'listing open records');

    expect(open.map((record) => record.id)).toEqual([
      modificationIdFixture('one'),
      modificationIdFixture('three'),
      modificationIdFixture('four'),
    ]);
    expect(open.map((record) => record.status)).toEqual(['applied', 'conflict', 'pending']);
    expect(new Set(open.map((record) => record.sessionId))).toEqual(
      new Set([SESSION_ID, OTHER_SESSION_ID]),
    );

    for (const record of open) {
      expect(OPEN_MODIFICATION_STATUSES).toContain(record.status);
      expect(record.status).not.toBe('reverted');
    }
  });

  it('applies a status patch and returns the record the caller now holds', async () => {
    const { journal } = await seeded();
    const patch: ModificationStatusPatch = {
      instrumentedHash: CHAINED_HASH,
      diff: `${DIFF_TEXT}\n`,
      appliedAt: 1_700_000_100_000,
      backupPath: backupPathFixture(SESSION_ID, DIVERGED_HASH),
    };

    const updated = okValue(
      await journal.updateStatus(modificationIdFixture('one'), 'reverted', patch),
      'reverting a record',
    );

    expect(updated.status).toBe('reverted');
    expect(updated.instrumentedHash).toBe(CHAINED_HASH);
    expect(updated.appliedAt).toBe(1_700_000_100_000);
    expect(updated.backupPath).toBe(patch.backupPath);
    // The returned record is what the caller holds, so it must not need a
    // re-read to be trusted — and it must still satisfy the schema.
    expect(modificationRecordSchema.safeParse(updated).success).toBe(true);

    const reread = okValue(await journal.listBySession(SESSION_ID), 'rereading the session');

    expect(reread[0]).toEqual(updated);
    // `reverted` is out of the open set, so reconciliation stops reporting it.
    expect(
      okValue(await journal.listOpen(), 'listing open records after the revert').map(
        (record) => record.id,
      ),
    ).not.toContain(modificationIdFixture('one'));
  });

  it('moves a status without a patch, leaving every other field alone', async () => {
    const { journal, appended } = await seeded();
    const before = appended[0];

    if (before === undefined) {
      throw new Error('The seeded journal produced no records.');
    }

    const updated = okValue(
      await journal.updateStatus(before.id, 'conflict'),
      'marking a record as conflicting',
    );

    expect(updated).toEqual({ ...before, status: 'conflict' });
  });

  it('answers an unknown id with a failure rather than an exception', async () => {
    const { journal } = await seeded();
    const outcome = await settled(() =>
      journal.updateStatus(modificationIdFixture('absent'), 'applied'),
    );
    const error = errValue(notThrown(outcome, 'updating an unknown id'), 'updating an unknown id');

    expect(error.code).toBe('STORE_ERROR');
    expect(error.hint).toBeDefined();
  });

  it('hands out copies, so a caller cannot observe an unjournaled status', async () => {
    // A returned record is safe to keep. An implementation that handed out a
    // reference it later edited — or that let a caller edit the row it holds —
    // would let a status the journal never recorded be read back as though it
    // had been, which is precisely the lie reconciliation cannot detect.
    const { journal } = await seeded();
    const handedOut = okValue(await journal.listBySession(SESSION_ID), 'listing one session');
    const appendedCopy = okValue(
      await journal.append(validRecord({ id: modificationIdFixture('five'), status: 'pending' })),
      'appending a fifth record',
    );

    const first = handedOut[0];

    if (first === undefined) {
      throw new Error('The seeded journal produced no records.');
    }

    first.status = 'reverted';
    first.diff = '';
    appendedCopy.status = 'conflict';

    const reread = okValue(await journal.listBySession(SESSION_ID), 'rereading the session');

    expect(reread[0]?.status).toBe('applied');
    expect(reread[0]?.diff).toBe(DIFF_TEXT);
    expect(reread[3]?.status).toBe('pending');
  });
});
