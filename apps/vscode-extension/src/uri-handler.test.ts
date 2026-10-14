/**
 * Tests for `./uri-handler.ts`: the `vscode://` source-open handler's
 * validation sequence, driven end to end against real directories.
 *
 * Every case here is about a file the developer authorised being replaced
 * before it is shown, or about the steps around that — which is why the
 * filesystem is real (`mkdtemp` sandboxes under `os.tmpdir()`, one workspace
 * directory and one directory outside it) and only the editor is substituted.
 * A swap is performed at exactly the moment the handler is most exposed to it:
 *
 * - **Before the dialog** — the canonical containment check of step 6 must
 *   refuse a link that escapes the workspace before the developer is asked.
 * - **While the dialog is open** — inside the substituted `confirm`, which
 *   runs after step 6 and before the revalidation of step 9, so a file
 *   replaced by an escaping link, renamed over, turned into a directory, or
 *   whose folder was closed must be refused with the reason step 9 reports.
 * - **After the final probe, before the editor has read** — inside the
 *   substitute's `openTextDocument`, which runs after step 10 has verified and
 *   kept its descriptor, so the editor reads whatever the path names by then.
 *   Step 11 must notice that the editor's copy is not the authorised file.
 *
 * ## The `vscode` substitute
 *
 * The editor supplies the `vscode` module at runtime and no installable
 * package provides it, so `vi.mock` registers a factory for the bare
 * specifier. The substitute carries only what the handler and
 * `./source/open-location` reach: `Uri.file`, `window.showWarningMessage`,
 * `workspace.workspaceFolders`, `workspace.openTextDocument` and
 * `workspace.decode`. Its `openTextDocument` reads the file **by path,
 * following links**, as the real editor's file service does, and caches the
 * document per path, as the real editor keeps one model per resource. `reveal`
 * is injected as a spy, so no document is ever shown and every assertion about
 * what was *not* opened is a call count.
 *
 * The refusal reason is read from the handler's own log line (`reason` field),
 * which is the one place it is observable without echoing the request. Each
 * refusal is also checked for the no-echo policy: neither the sandbox path nor
 * the requested `file` value may appear in a notification or a log field.
 *
 * Link-dependent cases are skipped only when this process cannot create a
 * symbolic link at all, detected by trying once — never by platform name.
 *
 * ## The other end of the same click
 *
 * This URI is the fallback for a click in the DevTools panel when no editor is
 * connected; when one is, the editor answers the forwarded `source.open` with
 * a `source.result` built by `sourceResultFor` in `./source/open-location`.
 * That pure builder is covered here too — this is the extension host's one
 * colocated suite, and the substitute above already carries everything that
 * module reaches — including an answer built from real `openSourceLocation`
 * failures, which must repeat none of the location or path they carried.
 */

import { lstatSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { URLSearchParams } from 'node:url';

import type * as vscode from 'vscode';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { EDITOR_OPEN_URI, parseSourceResultPayload } from '@debuggen/protocol';
import type { SourceResultPayload } from '@debuggen/protocol';
import { DEBUGGEN_ERROR_CODES, DebuggenError, err, ok } from '@debuggen/shared';
import type {
  DebuggenErrorCode,
  LogFields,
  Logger,
  Result,
  SourceLocation,
} from '@debuggen/shared';

import { openSourceLocation, sourceResultFor } from './source/open-location';
import {
  OPEN_SOURCE_URI_PATH,
  createOpenSourceUriHandler,
  type ParsedOpenRequest,
  type UriHandlerDeps,
  type UriRejectionReason,
} from './uri-handler';

/** A text document as the substitute hands it out: the members the handler reads. */
interface FakeTextDocument {
  readonly uri: { readonly fsPath: string };
  readonly isDirty: boolean;
  readonly encoding: string;
  getText(): string;
}

/**
 * The substitute editor's state, shared between the hoisted `vi.mock` factory
 * and the cases. Reset after every case.
 */
interface EditorState {
  /** Every `fsPath` `openTextDocument` was asked for, in order. */
  readonly opened: string[];

  /** The documents the editor holds, keyed by `fsPath` — one model per resource. */
  readonly documents: Map<string, FakeTextDocument>;

  /** Runs once inside the next `openTextDocument`, before it reads the file. */
  beforeRead: (() => Promise<void>) | undefined;

  /** Thrown by `openTextDocument` when set, as the editor does for a binary or oversized file. */
  openFailure: Error | undefined;

  /** Thrown by `decode` when set. */
  decodeFailure: Error | undefined;

  /** Turns the bytes read from disk into the model's text; the identity unless a case models the text buffer. */
  present: (raw: string) => string;
}

const editor = vi.hoisted((): EditorState => ({
  opened: [],
  documents: new Map(),
  beforeRead: undefined,
  openFailure: undefined,
  decodeFailure: undefined,
  present: (raw) => raw,
}));

vi.mock('vscode', async () => {
  const { readFile } = await import('node:fs/promises');

  return {
    Uri: {
      file: (fsPath: string) => ({ scheme: 'file', fsPath, path: fsPath }),
    },
    window: {
      showWarningMessage: () => Promise.resolve(undefined),
    },
    workspace: {
      workspaceFolders: undefined,
      openTextDocument: async (uri: { readonly fsPath: string }): Promise<FakeTextDocument> => {
        editor.opened.push(uri.fsPath);
        if (editor.openFailure !== undefined) {
          throw editor.openFailure;
        }

        const held = editor.documents.get(uri.fsPath);
        if (held !== undefined) {
          return held;
        }

        const hook = editor.beforeRead;
        editor.beforeRead = undefined;
        if (hook !== undefined) {
          await hook();
        }

        // By path, following links: exactly what the real file service does.
        const text = editor.present(await readFile(uri.fsPath, 'utf8'));
        const document: FakeTextDocument = {
          uri,
          isDirty: false,
          encoding: 'utf8',
          getText: () => text,
        };
        editor.documents.set(uri.fsPath, document);
        return document;
      },
      decode: (content: Uint8Array): Promise<string> =>
        editor.decodeFailure === undefined
          ? Promise.resolve(new TextDecoder('utf-8').decode(content))
          : Promise.reject(editor.decodeFailure),
    },
  };
});

/** Restores the substitute editor to an empty window with nothing open. */
function resetEditor(): void {
  editor.opened.length = 0;
  editor.documents.clear();
  editor.beforeRead = undefined;
  editor.openFailure = undefined;
  editor.decodeFailure = undefined;
  editor.present = (raw) => raw;
}

/**
 * Whether this process can create a symbolic link at all, probed once in a
 * directory of its own. A dangling link answers the question; `lstat`
 * reporting it as a link confirms the call did what it claimed.
 */
const CAN_CREATE_SYMLINKS = ((): boolean => {
  const probeRoot = mkdtempSync(join(tmpdir(), 'debuggen-uri-handler-probe-'));
  try {
    symlinkSync(join(probeRoot, 'absent'), join(probeRoot, 'link'));
    return lstatSync(join(probeRoot, 'link')).isSymbolicLink();
  } catch {
    // Any failure is the answer: the link-dependent cases are skipped.
    return false;
  } finally {
    rmSync(probeRoot, { recursive: true, force: true });
  }
})();

/** The project-relative path every request names. */
const REQUESTED_FILE = 'src/app.ts';

/** The authorised file's contents — five lines, so line 3 column 2 exists. */
const AUTHORISED_TEXT = 'export const inside = 1;\n'.repeat(5);

/** The file outside the workspace a swap tries to get shown instead. */
const OUTSIDE_TEXT = 'export const outside = 1;\n'.repeat(5);

/** The contents of a file renamed over the authorised one. */
const REPLACEMENT_TEXT = 'export const replaced = 1;\n'.repeat(5);

/** One case's directories, all canonical. */
interface Sandbox {
  /** The `mkdtemp` directory holding everything else. */
  readonly root: string;

  /** The open workspace folder. */
  readonly workspace: string;

  /** `‹workspace›/src/app.ts`, the file every request names. */
  readonly target: string;

  /** `‹workspace›/src/other.ts`, a second file inside the workspace. */
  readonly sibling: string;

  /** `‹outside›/src/app.ts`, a file no open folder contains. */
  readonly outsideTarget: string;
}

/**
 * Builds a fresh sandbox. The root is canonicalised first, so a temporary
 * directory reached through a link (`/tmp` → `/private/tmp` on macOS) cannot
 * make a canonical-path assertion compare two spellings of one file.
 */
async function createSandbox(): Promise<Sandbox> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'debuggen-uri-handler-')));
  const workspace = join(root, 'workspace');
  const outside = join(root, 'outside');
  await mkdir(join(workspace, 'src'), { recursive: true });
  await mkdir(join(outside, 'src'), { recursive: true });

  const target = join(workspace, 'src', 'app.ts');
  const sibling = join(workspace, 'src', 'other.ts');
  const outsideTarget = join(outside, 'src', 'app.ts');
  await writeFile(target, AUTHORISED_TEXT);
  await writeFile(sibling, 'export const other = 1;\n');
  await writeFile(outsideTarget, OUTSIDE_TEXT);

  return { root, workspace, target, sibling, outsideTarget };
}

/** A workspace folder on the `file` scheme, the only kind containment can be proved in. */
function folder(fsPath: string): vscode.WorkspaceFolder {
  return { uri: { scheme: 'file', fsPath } as vscode.Uri, name: 'workspace', index: 0 };
}

/**
 * A `vscode://debuggen.debug-generator/open` URI as VS Code routes it: the
 * path and the already-decoded query are all the handler reads.
 *
 * The path and the parameter names are `EDITOR_OPEN_URI`'s — the table the
 * DevTools panel's `buildEditorOpenUri` writes from — so every case below also
 * proves the handler reads the names the producer writes. The substitute has no
 * `Uri.parse`, so the query is handed over already decoded once, as the real
 * editor would; the encode-and-decode round trip itself is proved against the
 * real `vscode.Uri.parse` in `test/suite/uri-handler.test.ts`.
 */
function openUri(file: string = REQUESTED_FILE): vscode.Uri {
  const query = new URLSearchParams({
    [EDITOR_OPEN_URI.fileParameter]: file,
    [EDITOR_OPEN_URI.lineParameter]: '3',
    [EDITOR_OPEN_URI.columnParameter]: '2',
  }).toString();
  return { path: EDITOR_OPEN_URI.path, query } as vscode.Uri;
}

type ConfirmFn = NonNullable<UriHandlerDeps['confirm']>;
type RevealFn = NonNullable<UriHandlerDeps['reveal']>;
type FoldersFn = NonNullable<UriHandlerDeps['workspaceFolders']>;

/** One log record the handler emitted. */
interface LogRecord {
  readonly message: string;
  readonly fields: LogFields;
}

/** A handler wired to spies, and everything it reported. */
interface Harness {
  readonly handler: vscode.UriHandler;
  readonly confirm: Mock<ConfirmFn>;
  readonly reveal: Mock<RevealFn>;
  readonly workspaceFolders: Mock<FoldersFn>;
  readonly warnings: LogRecord[];
  readonly infos: LogRecord[];
  readonly notifications: string[];
}

/** How one case drives the handler. */
interface HarnessOptions {
  /** Runs while the dialog is open, before the answer is returned. */
  readonly duringConfirm?: () => Promise<void>;

  /** The developer's answer; `true` unless stated. */
  readonly answer?: boolean;

  /** A confirmation replacing the default one entirely. */
  readonly confirm?: ConfirmFn;

  /** The open folders on the n-th read (1-based); the sandbox workspace unless stated. */
  readonly folders?: (read: number) => readonly vscode.WorkspaceFolder[] | undefined;
}

/** A logger that records every warning and info line, and discards the rest. */
function recordingLogger(warnings: LogRecord[], infos: LogRecord[]): Logger {
  const discard = (): void => undefined;
  const logger: Logger = {
    level: 'debug',
    trace: discard,
    debug: discard,
    info: (message, fields) => {
      infos.push({ message, fields: fields ?? {} });
    },
    warn: (message, fields) => {
      warnings.push({ message, fields: fields ?? {} });
    },
    error: discard,
    fatal: discard,
    child: () => logger,
  };
  return logger;
}

/** The value a successful reveal answers with; the spy never shows anything. */
const REVEALED = ok({
  editor: {} as vscode.TextEditor,
  selection: {} as vscode.Selection,
  clamped: false,
});

/**
 * Builds a handler whose every collaborator is a spy: the confirmation runs
 * `options.duringConfirm` while "the dialog is open", the folders are the
 * sandbox workspace unless `options.folders` says otherwise, and `reveal`
 * records its arguments and shows nothing.
 */
function buildHandler(sandbox: Sandbox, options: HarnessOptions = {}): Harness {
  const warnings: LogRecord[] = [];
  const infos: LogRecord[] = [];
  const notifications: string[] = [];

  const confirm = vi.fn<ConfirmFn>(
    options.confirm ??
      (async () => {
        if (options.duringConfirm !== undefined) {
          await options.duringConfirm();
        }
        return options.answer ?? true;
      }),
  );
  const reveal = vi.fn<RevealFn>(() => Promise.resolve(REVEALED));

  let reads = 0;
  const workspaceFolders = vi.fn<FoldersFn>(() => {
    reads += 1;
    return options.folders === undefined ? [folder(sandbox.workspace)] : options.folders(reads);
  });

  const handler = createOpenSourceUriHandler({
    logger: recordingLogger(warnings, infos),
    confirm,
    reveal,
    showWarning: (message) => {
      notifications.push(message);
    },
    workspaceFolders,
  });

  return { handler, confirm, reveal, workspaceFolders, warnings, infos, notifications };
}

/** The refusal reasons the handler logged, in order. */
function refusalReasons(harness: Harness): unknown[] {
  return harness.warnings.map((record) => record.fields.reason);
}

/**
 * Asserts one refusal for `reason`, nothing revealed, and none of the request
 * or the sandbox echoed into a notification or a log field.
 */
function expectRefused(harness: Harness, sandbox: Sandbox, reason: UriRejectionReason): void {
  expect(refusalReasons(harness)).toEqual([reason]);
  expect(harness.reveal).not.toHaveBeenCalled();
  expect(harness.infos).toEqual([]);

  const surfaced = [
    ...harness.notifications,
    ...harness.warnings.map((record) => `${record.message} ${JSON.stringify(record.fields)}`),
  ];
  for (const text of surfaced) {
    expect(text).not.toContain(sandbox.root);
    expect(text).not.toContain(REQUESTED_FILE);
  }
}

/** Replaces the authorised file with a symbolic link to `destination`. */
async function swapForLink(sandbox: Sandbox, destination: string): Promise<void> {
  await rm(sandbox.target);
  await symlink(destination, sandbox.target);
}

/** Replaces the authorised file by renaming a new one over it: same name, new inode. */
async function renameOver(sandbox: Sandbox): Promise<void> {
  const staged = `${sandbox.target}.staged`;
  await writeFile(staged, REPLACEMENT_TEXT);
  await rename(staged, sandbox.target);
}

let sandbox: Sandbox;

beforeEach(async () => {
  sandbox = await createSandbox();
});

afterEach(async () => {
  resetEditor();
  await rm(sandbox.root, { recursive: true, force: true });
});

describe('createOpenSourceUriHandler — an unchanged, confirmed request', () => {
  it('reveals the canonical file once, at the requested line and column', async () => {
    const harness = buildHandler(sandbox);

    await harness.handler.handleUri(openUri());

    const expected: ParsedOpenRequest = { file: REQUESTED_FILE, line: 3, column: 2 };
    expect(harness.confirm).toHaveBeenCalledTimes(1);
    expect(harness.confirm).toHaveBeenCalledWith(expected);
    expect(harness.workspaceFolders).toHaveBeenCalledTimes(2);
    expect(harness.reveal).toHaveBeenCalledTimes(1);
    expect(harness.reveal).toHaveBeenCalledWith(
      expect.objectContaining({ scheme: 'file', fsPath: sandbox.target }),
      3,
      2,
      expect.objectContaining({ logger: expect.anything() as unknown }),
    );
    // Step 11 loaded exactly the authorised path before anything was shown.
    expect(editor.opened).toEqual([sandbox.target]);
    expect(harness.warnings).toEqual([]);
    expect(harness.notifications).toEqual([]);
    expect(harness.infos.map((record) => record.fields)).toEqual([
      { line: 3, column: 2, clamped: false },
    ]);
  });

  it('opens nothing and shows nothing when the developer declines', async () => {
    const harness = buildHandler(sandbox, { answer: false });

    await harness.handler.handleUri(openUri());

    expectRefused(harness, sandbox, 'declined');
    expect(harness.notifications).toEqual([]);
    expect(harness.workspaceFolders).toHaveBeenCalledTimes(1);
    expect(editor.opened).toEqual([]);
  });

  it("accepts an editor model whose line breaks and byte-order mark are the text buffer's own", async () => {
    await writeFile(sandbox.target, `\uFEFF${AUTHORISED_TEXT.replaceAll('\n', '\r\n')}`);
    // The model drops the mark and normalises every line break.
    editor.present = (raw) => raw.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
    const harness = buildHandler(sandbox);

    await harness.handler.handleUri(openUri());

    expect(harness.warnings).toEqual([]);
    expect(harness.reveal).toHaveBeenCalledTimes(1);
  });
});

describe('createOpenSourceUriHandler — before the dialog', () => {
  it.skipIf(!CAN_CREATE_SYMLINKS)(
    'refuses a link that escapes the workspace without asking the developer',
    async () => {
      await swapForLink(sandbox, sandbox.outsideTarget);
      const harness = buildHandler(sandbox);

      await harness.handler.handleUri(openUri());

      expectRefused(harness, sandbox, 'outside-workspace');
      expect(harness.confirm).not.toHaveBeenCalled();
      expect(editor.opened).toEqual([]);
    },
  );
});

describe('createOpenSourceUriHandler — a swap while the dialog is open', () => {
  it.skipIf(!CAN_CREATE_SYMLINKS)(
    'refuses a file replaced by a link to a file outside the workspace, and never reads it',
    async () => {
      const harness = buildHandler(sandbox, {
        duringConfirm: () => swapForLink(sandbox, sandbox.outsideTarget),
      });

      await harness.handler.handleUri(openUri());

      expectRefused(harness, sandbox, 'outside-workspace');
      // The outside file never reached the editor, let alone `reveal`.
      expect(editor.opened).toEqual([]);
    },
  );

  it.skipIf(!CAN_CREATE_SYMLINKS)(
    'refuses a file replaced by a link to another file inside the workspace',
    async () => {
      const harness = buildHandler(sandbox, {
        duringConfirm: () => swapForLink(sandbox, sandbox.sibling),
      });

      await harness.handler.handleUri(openUri());

      // Contained, and a regular file — but not the canonical path or the
      // inode the developer was asked about.
      expectRefused(harness, sandbox, 'changed');
      expect(editor.opened).toEqual([]);
    },
  );

  it('refuses a file renamed over while the dialog was open (same name, new inode)', async () => {
    const harness = buildHandler(sandbox, { duringConfirm: () => renameOver(sandbox) });

    await harness.handler.handleUri(openUri());

    expectRefused(harness, sandbox, 'changed');
    expect(harness.notifications).toHaveLength(1);
    expect(editor.opened).toEqual([]);
  });

  it('refuses a file replaced by a directory', async () => {
    const harness = buildHandler(sandbox, {
      duringConfirm: async () => {
        await rm(sandbox.target);
        await mkdir(sandbox.target);
      },
    });

    await harness.handler.handleUri(openUri());

    expectRefused(harness, sandbox, 'not-a-file');
    expect(editor.opened).toEqual([]);
  });

  const closedFolderStates: readonly (readonly [
    string,
    readonly vscode.WorkspaceFolder[] | undefined,
  ])[] = [
    ['no folders at all', undefined],
    ['an empty folder list', []],
  ];

  it.each(closedFolderStates)(
    'refuses when the folder was closed and the window reports %s',
    async (_label, after) => {
      const harness = buildHandler(sandbox, {
        folders: (read) => (read === 1 ? [folder(sandbox.workspace)] : after),
      });

      await harness.handler.handleUri(openUri());

      expectRefused(harness, sandbox, 'no-workspace');
      expect(harness.workspaceFolders).toHaveBeenCalledTimes(2);
      expect(editor.opened).toEqual([]);
    },
  );
});

describe("createOpenSourceUriHandler — a swap after the final probe, before the editor's read", () => {
  it.skipIf(!CAN_CREATE_SYMLINKS)(
    'refuses when the editor reads a link swapped in after the probe, and shows nothing',
    async () => {
      editor.beforeRead = () => swapForLink(sandbox, sandbox.outsideTarget);
      const harness = buildHandler(sandbox);

      await harness.handler.handleUri(openUri());

      // The editor did read the swapped path — that is the residual this step
      // exists for — and the handler refused before anything was shown.
      expect(editor.opened).toEqual([sandbox.target]);
      expectRefused(harness, sandbox, 'changed');
    },
  );

  it('refuses when the editor reads a file renamed over after the probe', async () => {
    editor.beforeRead = () => renameOver(sandbox);
    const harness = buildHandler(sandbox);

    await harness.handler.handleUri(openUri());

    expect(editor.opened).toEqual([sandbox.target]);
    expectRefused(harness, sandbox, 'changed');
  });
});

describe("createOpenSourceUriHandler — the editor's copy", () => {
  it('accepts an already-open document with unsaved edits as the developer’s own buffer', async () => {
    editor.documents.set(sandbox.target, {
      uri: { fsPath: sandbox.target },
      isDirty: true,
      encoding: 'utf8',
      getText: () => 'unsaved edits the developer is making\n',
    });
    const harness = buildHandler(sandbox);

    await harness.handler.handleUri(openUri());

    expect(harness.warnings).toEqual([]);
    expect(harness.reveal).toHaveBeenCalledTimes(1);
  });

  it('refuses an already-open clean document whose text is not the authorised file', async () => {
    editor.documents.set(sandbox.target, {
      uri: { fsPath: sandbox.target },
      isDirty: false,
      encoding: 'utf8',
      getText: () => OUTSIDE_TEXT,
    });
    const harness = buildHandler(sandbox);

    await harness.handler.handleUri(openUri());

    expectRefused(harness, sandbox, 'changed');
  });

  it('reports reveal-failed when the editor cannot load the document', async () => {
    editor.openFailure = new Error('the file is binary');
    const harness = buildHandler(sandbox);

    await harness.handler.handleUri(openUri());

    expectRefused(harness, sandbox, 'reveal-failed');
    expect(harness.notifications).toHaveLength(1);
  });

  it('reports reveal-failed when the authorised bytes cannot be decoded', async () => {
    editor.decodeFailure = new Error('the content is binary');
    const harness = buildHandler(sandbox);

    await harness.handler.handleUri(openUri());

    expectRefused(harness, sandbox, 'reveal-failed');
  });
});

describe('createOpenSourceUriHandler — the editor-open URI of @debuggen/protocol', () => {
  it('answers to exactly the path buildEditorOpenUri writes', () => {
    expect(OPEN_SOURCE_URI_PATH).toBe(EDITOR_OPEN_URI.path);
  });

  it('reads the column only under EDITOR_OPEN_URI.columnParameter, never another spelling', async () => {
    // `column` is the spelling a hand-written link reaches for; the contract's
    // is `col`, and a handler accepting both would make it a suggestion.
    expect(EDITOR_OPEN_URI.columnParameter).not.toBe('column');
    const query = new URLSearchParams({
      [EDITOR_OPEN_URI.fileParameter]: REQUESTED_FILE,
      [EDITOR_OPEN_URI.lineParameter]: '3',
      column: '2',
    }).toString();
    const harness = buildHandler(sandbox);

    await harness.handler.handleUri({ path: EDITOR_OPEN_URI.path, query } as vscode.Uri);

    expectRefused(harness, sandbox, 'missing-parameter');
    expect(harness.confirm).not.toHaveBeenCalled();
  });
});

describe('createOpenSourceUriHandler — one dialog at a time', () => {
  it('refuses a second request as busy while a confirmation is open, and releases afterwards', async () => {
    let answer: (confirmed: boolean) => void = () => undefined;
    const answered = new Promise<boolean>((resolve) => {
      answer = resolve;
    });
    const harness = buildHandler(sandbox, { confirm: () => answered });

    const first = harness.handler.handleUri(openUri());
    await vi.waitFor(() => {
      expect(harness.confirm).toHaveBeenCalledTimes(1);
    });

    await harness.handler.handleUri(openUri());
    expect(refusalReasons(harness)).toEqual(['busy']);
    expect(harness.notifications).toEqual([]);
    expect(harness.reveal).not.toHaveBeenCalled();

    answer(true);
    await first;
    expect(harness.reveal).toHaveBeenCalledTimes(1);

    await harness.handler.handleUri(openUri());
    expect(harness.confirm).toHaveBeenCalledTimes(2);
    expect(harness.reveal).toHaveBeenCalledTimes(2);
    expect(refusalReasons(harness)).toEqual(['busy']);
  });
});

/** The `source.open` frame every answer below responds to. */
const ANSWERED = Object.freeze({ sessionId: 'sess_answered', ref: 'msg_forwarded' });

/** The `failed` member of the `source.result` payload union. */
type FailedSourceResult = Extract<SourceResultPayload, { status: 'failed' }>;

/** The failed answer inside `result`, or a test failure naming what came back instead. */
function expectFailedAnswer(
  result: Result<SourceResultPayload, DebuggenError>,
): FailedSourceResult {
  if (!result.ok || result.value.status !== 'failed') {
    throw new Error(`expected a failed source.result, got ${JSON.stringify(result)}`);
  }
  return result.value;
}

/** A location inside the sandbox workspace, as a forwarded `source.open` carries it. */
function forwardedLocation(): SourceLocation {
  return { file: REQUESTED_FILE, line: 3, column: 2, resolvedBy: 'patch', confidence: 1 };
}

describe("sourceResultFor — the editor's answer to a forwarded source.open", () => {
  it('answers an opened location with the session and the ref, and nothing else', () => {
    expect(sourceResultFor(ANSWERED, { kind: 'opened' })).toEqual(
      ok({ sessionId: ANSWERED.sessionId, ref: ANSWERED.ref, status: 'opened' }),
    );
  });

  it('answers a session this window does not know as SESSION_NOT_FOUND', () => {
    const answer = expectFailedAnswer(sourceResultFor(ANSWERED, { kind: 'unknown-session' }));

    expect(answer).toMatchObject({ sessionId: ANSWERED.sessionId, ref: ANSWERED.ref });
    expect(answer.error.code).toBe('SESSION_NOT_FOUND');
    expect(answer.error.hint).toEqual(expect.any(String));
  });

  it('answers an attempt that threw as INTERNAL', () => {
    const answer = expectFailedAnswer(sourceResultFor(ANSWERED, { kind: 'unexpected' }));

    expect(answer.error.code).toBe('INTERNAL');
    expect(answer.error.hint).toEqual(expect.any(String));
  });

  it('keeps the code of any failure and answers it with a payload the service accepts', () => {
    for (const code of DEBUGGEN_ERROR_CODES) {
      const answer = expectFailedAnswer(sourceResultFor(ANSWERED, { kind: 'not-opened', code }));

      expect(answer.error.code).toBe(code);
      expect(parseSourceResultPayload(answer)).toEqual(ok(answer));
    }
  });

  it('gives each refusal openSourceLocation reports a sentence of its own', () => {
    const codes: readonly DebuggenErrorCode[] = [
      'PROTOCOL_INVALID_MESSAGE',
      'PATH_OUTSIDE_PROJECT',
      'PROJECT_NOT_FOUND',
      'INTERNAL',
    ];
    const messages = codes.map(
      (code) =>
        expectFailedAnswer(sourceResultFor(ANSWERED, { kind: 'not-opened', code })).error.message,
    );

    expect(new Set(messages).size).toBe(codes.length);
  });

  it('repeats nothing a failed open carried: not the location, the path or the local message', async () => {
    const notices: string[] = [];
    const showWarning = (message: string): void => {
      notices.push(message);
    };
    const unrevealable = new DebuggenError(
      'PROJECT_NOT_FOUND',
      `The editor could not open ${sandbox.target}`,
    );
    const failures = [
      // Refused before any editor call: the session has no usable project root.
      await openSourceLocation(forwardedLocation(), { projectRoot: ' ' }, { showWarning }),
      // Contained, and the editor could not load it; its error quotes the path.
      await openSourceLocation(
        forwardedLocation(),
        { projectRoot: sandbox.workspace },
        { showWarning, reveal: () => Promise.resolve(err(unrevealable)) },
      ),
    ];

    expect(failures.map((failure) => (failure.ok ? 'ok' : failure.error.code))).toEqual([
      'PATH_OUTSIDE_PROJECT',
      'PROJECT_NOT_FOUND',
    ]);
    // The developer was told in this window, once per failure.
    expect(notices).toHaveLength(failures.length);
    for (const failure of failures) {
      if (failure.ok) {
        continue;
      }
      const answer = expectFailedAnswer(
        sourceResultFor(ANSWERED, { kind: 'not-opened', code: failure.error.code }),
      );
      const wire = JSON.stringify(answer);

      expect(answer.error.code).toBe(failure.error.code);
      expect(wire).not.toContain(sandbox.root);
      expect(wire).not.toContain(REQUESTED_FILE);
      expect(wire).not.toContain(failure.error.message);
    }
  });

  it('answers a location openSourceLocation revealed as opened', async () => {
    const opened = await openSourceLocation(
      forwardedLocation(),
      { projectRoot: sandbox.workspace },
      { showWarning: () => undefined, reveal: () => Promise.resolve(REVEALED) },
    );

    expect(opened.ok).toBe(true);
    expect(sourceResultFor(ANSWERED, { kind: 'opened' })).toMatchObject({
      ok: true,
      value: { status: 'opened' },
    });
  });

  it('refuses, without throwing, a ref the service would refuse', () => {
    for (const ref of ['', 'r'.repeat(65)]) {
      const answer = sourceResultFor({ ...ANSWERED, ref }, { kind: 'opened' });

      expect(answer.ok).toBe(false);
      expect(answer.ok ? undefined : answer.error.code).toBe('PROTOCOL_INVALID_MESSAGE');
    }
  });
});
