/**
 * The original a chained modification names — `originalBackupPathOf` in
 * `./ModificationsList` and every webview surface that says "Original saved at".
 *
 * A follow-up that patches a file an earlier plan version already patched
 * journals a record whose `previousRecordId` links the earlier one and whose own
 * backup therefore holds that earlier version's **instrumented** output, still
 * wrapped by Debug Generator. Only the first record of the chain — its root —
 * backed up the pristine file. Restoring the layered record's own backup by
 * hand would put the instrumentation back, so every surface names the root's.
 *
 * Pinned here:
 *
 *   - **The helper**: an unchained record's original is its own backup; a
 *     chained record's is its root's, however deep the chain; the walk stays in
 *     one session and one (normalised) file, skips `reverted` records, stops at
 *     a missing parent, survives a cycle, and takes the first of two records
 *     sharing an id.
 *   - **`ModificationsList`**: a chained conflict's callout and its "Copy path"
 *     name the root's backup, never the record's own — from the conflict
 *     entry's `originalBackupPath` when the service sent one, from the listed
 *     records otherwise — and a chained failed record's callout does the same;
 *     an unchained record keeps its own backup.
 *   - **`App`'s session cleanup outcome**: a conflict carrying
 *     `originalBackupPath` lists that path under "Files left untouched"; a
 *     report without it, from a service that predates the field, lists its
 *     chained record's root backup when the record is listed and its own
 *     backup when it is not; and a partial cleanup lists a chained record's
 *     root backup under "Files not restored".
 *
 * The fixture paths, hashes and diffs are generic vocabulary written for this
 * suite; no inspected project's names appear in it (AAP 0.5.4).
 */

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createEnvelope, parseMessage } from '@debuggen/protocol';
import type { ModificationConflict, ModificationRecord, SessionRecord } from '@debuggen/protocol';

import type {
  HostToWebviewMessage,
  WebviewState,
  WebviewToHostMessage,
} from '../../webview-messages';
import { App } from '../App';

import { ModificationsList, originalBackupPathOf } from './ModificationsList';

// ---------------------------------------------------------------------------
// The scripted host channel, for the cases that mount the whole view
// ---------------------------------------------------------------------------

const channel = vi.hoisted(() => ({
  /** App's subscription, once its effect has run. */
  handler: undefined as ((message: HostToWebviewMessage) => void) | undefined,
  /** Every message App posted, in order. */
  posted: [] as WebviewToHostMessage[],
}));

vi.mock('../vscode-api', () => ({
  isVsCodeApiAvailable: (): boolean => true,
  postToHost: (message: WebviewToHostMessage): boolean => {
    channel.posted.push(message);
    return true;
  },
  subscribeToHost: (handler: (message: HostToWebviewMessage) => void): (() => void) => {
    channel.handler = handler;
    return () => {
      if (channel.handler === handler) {
        channel.handler = undefined;
      }
    };
  },
}));

beforeEach(() => {
  channel.handler = undefined;
  channel.posted = [];
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  Reflect.deleteProperty(window.navigator, 'clipboard');
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SESSION_ID = 'ses_chainroot0000';
const OTHER_SESSION_ID = 'ses_chainroot9999';
const FILE = 'src/lib/chain/worker.ts';
const OTHER_FILE = 'src/lib/solo/task.ts';
const BACKUP_ROOT = `/home/dev/.debuggen/backups/${SESSION_ID}`;
const DETECTED_AT = Date.UTC(2026, 0, 15, 9, 45, 0);

/** A SHA-256-shaped digest built from one repeated hexadecimal digit. */
function digest(digit: string): string {
  return digit.repeat(64);
}

/** A small, well-formed unified diff for `file`. */
function diffFor(file: string, removed: string, added: string): string {
  return [
    `--- a/${file}`,
    `+++ b/${file}`,
    '@@ -1,3 +1,3 @@',
    ' export function run() {',
    `-  ${removed}`,
    `+  ${added}`,
    ' }',
    '',
  ].join('\n');
}

/**
 * One record of a chain on {@link FILE}: plan version `version`, backing up the
 * bytes hashed `from` and writing the bytes hashed `to`. Its backup is named by
 * `from`, as the content-addressed store names it, so a layered record's own
 * backup is visibly the previous version's instrumented output.
 */
function chainRecord(
  version: number,
  from: string,
  to: string,
  overrides?: Partial<ModificationRecord>,
): ModificationRecord {
  return {
    id: `mod_chain${String(version).padStart(11, '0')}`,
    sessionId: SESSION_ID,
    planVersion: version,
    file: FILE,
    originalHash: digest(from),
    backupPath: `${BACKUP_ROOT}/${digest(from)}`,
    instrumentedHash: digest(to),
    appliedAt: Date.UTC(2026, 0, 15, 9, 30, version),
    status: 'conflict',
    diff: diffFor(FILE, `const v${String(version - 1)} = 0;`, `const v${String(version)} = 0;`),
    ...overrides,
  };
}

/** The chain root: plan v1 backed up the pristine file (hash `a…`). */
const ROOT = chainRecord(1, 'a', 'b');

/** Plan v2, layered on the root: its own backup holds the root's instrumented output. */
const LAYERED = chainRecord(2, 'b', 'c', { previousRecordId: ROOT.id });

/** Plan v3, layered on v2: its own backup holds v2's instrumented output. */
const TOP = chainRecord(3, 'c', 'd', { previousRecordId: LAYERED.id });

/** An unchained record of another file in the same session. */
const SOLO: ModificationRecord = {
  id: 'mod_solo000000000000',
  sessionId: SESSION_ID,
  planVersion: 1,
  file: OTHER_FILE,
  originalHash: digest('e'),
  backupPath: `${BACKUP_ROOT}/${digest('e')}`,
  instrumentedHash: digest('f'),
  appliedAt: Date.UTC(2026, 0, 15, 9, 31, 0),
  status: 'conflict',
  diff: diffFor(OTHER_FILE, 'return 0;', 'return 1;'),
};

/** The service's conflict entry for `record`, edited while instrumented. */
function conflictFor(
  record: ModificationRecord,
  overrides?: Partial<ModificationConflict>,
): ModificationConflict {
  return {
    recordId: record.id,
    sessionId: record.sessionId,
    file: record.file,
    reason: 'content-changed',
    expectedHash: record.instrumentedHash,
    actualHash: digest('9'),
    backupPath: record.backupPath,
    detectedAt: DETECTED_AT,
    message: `'${record.file}' was changed after it was instrumented, so nothing was written to it.`,
    diffs: { instrumentedToCurrent: diffFor(record.file, 'const v = 0;', 'const edited = 1;') },
    ...overrides,
  };
}

/** The layered record's conflict as the service reports it: its own backup and the root's. */
const LAYERED_CONFLICT = conflictFor(LAYERED, { originalBackupPath: ROOT.backupPath });

/** The AAP 0.5.5 sentence for `file` and `path`. */
function editedSentence(file: string, path: string): string {
  return `${file} was edited while instrumented. Debug Generator will not overwrite it. Original saved at ${path}.`;
}

/** The list's item at `index`, failing the test when it is absent. */
function itemAt(container: HTMLElement, index: number): HTMLElement {
  const item = container.querySelectorAll<HTMLElement>('.dgv-modifications__item')[index];
  if (item === undefined) {
    throw new Error(`expected an item at index ${String(index)}`);
  }
  return item;
}

/** The callout text of the item at `index`. */
function calloutOf(container: HTMLElement, index: number): string {
  return itemAt(container, index).querySelector('.dgv-modifications__note')?.textContent ?? '';
}

/** Replaces the clipboard with one whose `writeText` is `writeText`. */
function stubClipboard(writeText: (text: string) => Promise<void>): void {
  Object.defineProperty(window.navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  });
}

/** Settles the clipboard write a click started, a few microtasks deep. */
async function settleCopy(): Promise<void> {
  await act(async () => {
    for (let hop = 0; hop < 5; hop += 1) {
      await Promise.resolve();
    }
  });
}

describe('chain-root fixtures', () => {
  it('are records and conflicts the protocol itself accepts', () => {
    // A shape the service could never send would make every case below test
    // something that does not occur, so the fixtures go through the real schema.
    expect(
      parseMessage(
        createEnvelope('instrumentation.ready', {
          sessionId: SESSION_ID,
          applied: [ROOT, LAYERED, TOP, SOLO],
          runtimeHooks: [],
          unavailable: [],
        }),
      ).ok,
    ).toBe(true);
    expect(
      parseMessage(
        createEnvelope('cleanup.completed', {
          sessionId: SESSION_ID,
          status: 'conflict',
          conflicts: [LAYERED_CONFLICT, conflictFor(SOLO)],
        }),
      ).ok,
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// originalBackupPathOf
// ---------------------------------------------------------------------------

describe('originalBackupPathOf', () => {
  it('answers an unchained record’s own backup', () => {
    expect(originalBackupPathOf(ROOT, [ROOT, LAYERED])).toBe(ROOT.backupPath);
    expect(originalBackupPathOf(SOLO, [SOLO, ROOT, LAYERED])).toBe(SOLO.backupPath);
  });

  it('answers the chain root’s backup for a chained record, however deep the chain', () => {
    expect(originalBackupPathOf(LAYERED, [ROOT, LAYERED])).toBe(ROOT.backupPath);
    expect(originalBackupPathOf(TOP, [TOP, LAYERED, ROOT])).toBe(ROOT.backupPath);
    expect(originalBackupPathOf(TOP, [ROOT, LAYERED, TOP])).not.toBe(LAYERED.backupPath);
  });

  it('falls back to the record’s own backup when its parent is not listed', () => {
    expect(originalBackupPathOf(LAYERED, [LAYERED])).toBe(LAYERED.backupPath);
    expect(originalBackupPathOf(LAYERED, [])).toBe(LAYERED.backupPath);
  });

  it('stops at the deepest ancestor listed when the chain is only partly loaded', () => {
    expect(originalBackupPathOf(TOP, [LAYERED, TOP])).toBe(LAYERED.backupPath);
  });

  it('never follows a link across sessions or files', () => {
    const foreignSession = { ...ROOT, sessionId: OTHER_SESSION_ID };
    expect(originalBackupPathOf(LAYERED, [foreignSession, LAYERED])).toBe(LAYERED.backupPath);

    const foreignFile = { ...ROOT, file: OTHER_FILE };
    expect(originalBackupPathOf(LAYERED, [foreignFile, LAYERED])).toBe(LAYERED.backupPath);
  });

  it('compares files in their normalised spelling', () => {
    const respelled = { ...ROOT, file: `./${FILE.replace('/chain/', '//chain/')}` };
    expect(originalBackupPathOf(LAYERED, [respelled, LAYERED])).toBe(ROOT.backupPath);
  });

  it('skips a reverted ancestor, whose backup was deleted once its restore verified', () => {
    const reverted = { ...ROOT, status: 'reverted' as const };
    expect(originalBackupPathOf(LAYERED, [reverted, LAYERED])).toBe(LAYERED.backupPath);
  });

  it('ends a cycle at the last record before it repeats, never answering with the record itself', () => {
    const first = chainRecord(1, 'a', 'b', { previousRecordId: LAYERED.id });
    const second = chainRecord(2, 'b', 'c', { previousRecordId: first.id });
    expect(originalBackupPathOf(second, [first, second])).toBe(first.backupPath);
    expect(originalBackupPathOf(first, [first, second])).toBe(second.backupPath);

    const selfLinked = chainRecord(4, 'd', 'e');
    const looped = { ...selfLinked, previousRecordId: selfLinked.id };
    expect(originalBackupPathOf(looped, [looped])).toBe(looped.backupPath);
  });

  it('uses the first of two listed records that share an id', () => {
    const shadow = { ...ROOT, backupPath: `${BACKUP_ROOT}/${digest('0')}` };
    expect(originalBackupPathOf(LAYERED, [ROOT, shadow, LAYERED])).toBe(ROOT.backupPath);
    expect(originalBackupPathOf(LAYERED, [shadow, ROOT, LAYERED])).toBe(shadow.backupPath);
  });
});

// ---------------------------------------------------------------------------
// ModificationsList
// ---------------------------------------------------------------------------

describe('ModificationsList — a chained record names its pristine original', () => {
  it('states the chain root’s backup in a chained conflict’s callout, not the record’s own', () => {
    const { container } = render(<ModificationsList modifications={[ROOT, LAYERED]} />);

    const message = itemAt(container, 1).querySelector('.dgv-modifications__message');
    expect(message?.textContent).toBe(editedSentence(FILE, ROOT.backupPath));
    expect(calloutOf(container, 1)).not.toContain(LAYERED.backupPath);
    // The root's own item names the same pristine file.
    expect(calloutOf(container, 0)).toContain(`Original saved at ${ROOT.backupPath}.`);
  });

  it('prefers the conflict entry’s originalBackupPath, which holds while the root is not listed', () => {
    const { container } = render(
      <ModificationsList modifications={[LAYERED]} conflicts={[LAYERED_CONFLICT]} total={2} />,
    );

    const message = itemAt(container, 0).querySelector('.dgv-modifications__message');
    expect(message?.textContent).toBe(editedSentence(FILE, ROOT.backupPath));
    expect(calloutOf(container, 0)).not.toContain(LAYERED.backupPath);
  });

  it('names the root’s backup beside the service’s own message for another reason', () => {
    // A deleted file has no bytes to hash or diff, so the report carries neither.
    const missing: ModificationConflict = {
      recordId: LAYERED.id,
      sessionId: SESSION_ID,
      file: FILE,
      reason: 'file-missing',
      expectedHash: LAYERED.instrumentedHash,
      backupPath: LAYERED.backupPath,
      originalBackupPath: ROOT.backupPath,
      detectedAt: DETECTED_AT,
      message: `'${FILE}' no longer exists, so nothing was written to it.`,
    };
    const { container } = render(
      <ModificationsList modifications={[ROOT, LAYERED]} conflicts={[missing]} />,
    );

    const callout = calloutOf(container, 1);
    expect(callout).toContain(`'${FILE}' no longer exists, so nothing was written to it.`);
    expect(callout).toContain(`Original saved at ${ROOT.backupPath}.`);
    expect(callout).not.toContain(LAYERED.backupPath);
  });

  it('copies the chain root’s backup from a chained conflict’s "Copy path"', async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>(() => Promise.resolve());
    stubClipboard(writeText);
    const { container } = render(<ModificationsList modifications={[ROOT, LAYERED]} />);

    // The file repeats in the list, so the control's name ends with its row.
    fireEvent.click(
      within(itemAt(container, 1)).getByRole('button', {
        name: `Copy path of the saved original of ${FILE}, change 2 of 2, plan v2`,
      }),
    );
    await settleCopy();

    expect(writeText.mock.calls).toEqual([[ROOT.backupPath]]);
  });

  it('gives a chained failed record the root’s backup as its saved original', () => {
    const failed = { ...LAYERED, status: 'failed' as const };
    const { container } = render(
      <ModificationsList modifications={[{ ...ROOT, status: 'applied' }, failed]} />,
    );

    const callout = calloutOf(container, 1);
    expect(callout).toContain(`Original saved at ${ROOT.backupPath}.`);
    expect(callout).not.toContain(LAYERED.backupPath);
  });

  it('keeps an unchained record’s own backup', () => {
    const { container } = render(
      <ModificationsList modifications={[SOLO]} conflicts={[conflictFor(SOLO)]} />,
    );

    const message = itemAt(container, 0).querySelector('.dgv-modifications__message');
    expect(message?.textContent).toBe(editedSentence(OTHER_FILE, SOLO.backupPath));
  });
});

// ---------------------------------------------------------------------------
// App — the session cleanup outcome
// ---------------------------------------------------------------------------

/** Delivers one host frame to the mounted view. */
function push(message: HostToWebviewMessage): void {
  const handler = channel.handler;
  if (handler === undefined) {
    throw new Error('App has not subscribed to the host channel');
  }
  act(() => {
    handler(message);
  });
}

/** An ended session record with `cleanupState` and `modifications`. */
function endedSession(
  cleanupState: WebviewState['cleanup'],
  modifications: readonly ModificationRecord[],
): SessionRecord {
  return {
    id: SESSION_ID,
    projectRoot: '/home/dev/workspace/site',
    projectName: 'site',
    devServerUrl: 'http://localhost:3000',
    createdAt: Date.UTC(2026, 0, 15, 9, 0, 0),
    updatedAt: Date.UTC(2026, 0, 15, 9, 50, 0),
    status: 'ended',
    question: 'Why does this action take so long?',
    followUps: [],
    relevantFiles: [],
    plans: [],
    modifications: [...modifications],
    captures: [],
    panelIds: [],
    analyses: [],
    cleanup: cleanupState,
    promptVersions: {},
    provider: { id: 'deterministic' },
  };
}

/** Mounts the view as `main.tsx` does and delivers an ended session's snapshot. */
function mountEnded(
  cleanupState: WebviewState['cleanup'],
  modifications: readonly ModificationRecord[],
): void {
  render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
  push({
    type: 'state',
    state: {
      connection: {
        status: 'open',
        serviceUrl: 'http://127.0.0.1:43117',
        serviceReachable: true,
        provider: 'deterministic',
      },
      session: endedSession(cleanupState, modifications),
      progress: [],
      relevantFiles: [],
      modifications: [...modifications],
      modificationsTotal: modifications.length,
      capture: { active: false, eventCount: 0 },
      cleanup: cleanupState,
    },
  });
}

describe('App — the cleanup outcome names a chained file’s pristine original', () => {
  const COMPLETED_AT = Date.UTC(2026, 0, 15, 9, 50, 0);

  it('lists a conflict’s originalBackupPath under "Files left untouched"', () => {
    mountEnded({ status: 'conflict', completedAt: COMPLETED_AT, conflicts: [LAYERED_CONFLICT] }, [
      ROOT,
      LAYERED,
    ]);

    const list = screen.getByRole('list', { name: 'Files left untouched' });
    const codes = Array.from(list.querySelectorAll('code')).map((code) => code.textContent);
    expect(codes).toEqual([FILE, ROOT.backupPath]);
    expect(list.textContent ?? '').toContain('Original saved at');
    // Nowhere in the view is the intermediate, still-instrumented backup offered as the original.
    expect(document.body.textContent ?? '').not.toContain(LAYERED.backupPath);
  });

  it('walks a listed chained record’s chain when its report carries no originalBackupPath', () => {
    // A report from a service that predates the field names only the record's own backup.
    const withoutRoot = conflictFor(LAYERED);
    expect(withoutRoot.originalBackupPath).toBeUndefined();
    mountEnded({ status: 'conflict', completedAt: COMPLETED_AT, conflicts: [withoutRoot] }, [
      { ...ROOT, status: 'applied' },
      LAYERED,
    ]);

    const list = screen.getByRole('list', { name: 'Files left untouched' });
    const codes = Array.from(list.querySelectorAll('code')).map((code) => code.textContent);
    expect(codes).toEqual([FILE, ROOT.backupPath]);
    // The modifications list names the same pristine file for the same record.
    expect(document.body.textContent ?? '').not.toContain(LAYERED.backupPath);
  });

  it('keeps a report’s own backup when its chained record is not listed', () => {
    mountEnded(
      { status: 'conflict', completedAt: COMPLETED_AT, conflicts: [conflictFor(LAYERED)] },
      [SOLO],
    );

    const list = screen.getByRole('list', { name: 'Files left untouched' });
    const codes = Array.from(list.querySelectorAll('code')).map((code) => code.textContent);
    expect(codes).toEqual([FILE, LAYERED.backupPath]);
  });

  it('keeps an unchained conflict’s own backup', () => {
    mountEnded({ status: 'conflict', completedAt: COMPLETED_AT, conflicts: [conflictFor(SOLO)] }, [
      SOLO,
    ]);

    const list = screen.getByRole('list', { name: 'Files left untouched' });
    const codes = Array.from(list.querySelectorAll('code')).map((code) => code.textContent);
    expect(codes).toEqual([OTHER_FILE, SOLO.backupPath]);
  });

  it('lists the chain root’s backup for a chained record a partial cleanup did not restore', () => {
    const root = { ...ROOT, status: 'applied' as const };
    const layered = { ...LAYERED, status: 'applied' as const };
    mountEnded({ status: 'partial', completedAt: COMPLETED_AT, conflicts: [] }, [root, layered]);

    const list = screen.getByRole('list', { name: 'Files not restored' });
    const entries = within(list).getAllByRole('listitem');
    expect(entries).toHaveLength(2);
    for (const entry of entries) {
      expect(entry.textContent ?? '').toContain(ROOT.backupPath);
      expect(entry.textContent ?? '').not.toContain(LAYERED.backupPath);
    }
  });
});
