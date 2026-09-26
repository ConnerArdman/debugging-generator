/**
 * The in-editor half of `tests/e2e/helpers/editor-host.ts`: the module VS Code
 * loads as its `--extensionTestsPath` inside the Extension Development Host that
 * helper launches.
 *
 * VS Code's test runner contract is a CommonJS module exporting `run()`, called
 * once the extension host is up; the window stays open while the returned
 * promise is pending and VS Code exits when it settles (exit code 0 when it
 * resolves, 1 when it rejects). This probe uses that window, and only observes:
 *
 * 1. it activates the extension under development
 *    (`vscode.extensions.getExtension(id).activate()`), which is what connects
 *    the real editor to the local service, exactly as a developer's window does;
 * 2. it appends one JSON line per event to the output file the host names:
 *    `{ kind: 'started' }`, then `{ kind: 'activated' }` (or
 *    `{ kind: 'activation-failed' }`), then one `{ kind: 'selection' }` per
 *    active-editor or selection change — the document's `fsPath`, the cursor's
 *    1-based `line` and `column` (the `active` end of the selection, which is
 *    where `open-location.ts` puts the requested position), the anchor, the
 *    active line's length and the document's line count;
 * 3. it waits until the host creates the stop file, or until its maximum
 *    lifetime passes, records `{ kind: 'stopping', reason }` and resolves, so
 *    VS Code deactivates the extension and exits on its own.
 *
 * It never sends a command, edits a document or talks to the service: whatever
 * reaches the editor comes through the extension's own connection. It records
 * positions and lengths, never document text.
 *
 * Configuration arrives through the environment the host sets (every name is
 * required; a missing one rejects `run()` so VS Code exits at once with code 1):
 *
 * | Variable                                      | Meaning                                                |
 * | --------------------------------------------- | ------------------------------------------------------ |
 * | `DEBUGGEN_E2E_EDITOR_PROBE_OUTPUT`            | the JSON-lines file records are appended to            |
 * | `DEBUGGEN_E2E_EDITOR_PROBE_STOP`              | the file whose appearance ends the run                 |
 * | `DEBUGGEN_E2E_EDITOR_PROBE_EXTENSION_ID`      | `<publisher>.<name>` of the extension                  |
 * | `DEBUGGEN_E2E_EDITOR_PROBE_MAX_LIFETIME_MS`   | maximum probe lifetime, in ms, if no stop file appears |
 *
 * Plain CommonJS with no dependency beyond `vscode` and Node built-ins: VS Code
 * `require`s it directly, so it is never compiled, bundled or type-checked, and
 * it is linted under the repository's `.cjs` rules.
 */
'use strict';

const fs = require('node:fs');

const vscode = require('vscode');

/** The environment variables the host sets, by role (see the table above). */
const ENV = Object.freeze({
  output: 'DEBUGGEN_E2E_EDITOR_PROBE_OUTPUT',
  stop: 'DEBUGGEN_E2E_EDITOR_PROBE_STOP',
  extensionId: 'DEBUGGEN_E2E_EDITOR_PROBE_EXTENSION_ID',
  maxLifetimeMs: 'DEBUGGEN_E2E_EDITOR_PROBE_MAX_LIFETIME_MS',
});

/**
 * How often the stop file is looked for. It only bounds how long the window
 * outlives the host's request to stop; the host allows several seconds for the
 * whole exit, extension deactivation included.
 */
const STOP_POLL_INTERVAL_MS = 250;

/** The longest error text recorded for a failed activation. */
const MAX_ERROR_TEXT_LENGTH = 500;

/**
 * A required, non-empty environment value.
 *
 * @param {string} name
 * @returns {string}
 */
function requiredEnv(name) {
  const value = process.env[name];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(
      `editor-host-probe: ${name} is not set; tests/e2e/helpers/editor-host.ts sets it.`,
    );
  }
  return value.trim();
}

/**
 * The maximum lifetime, a positive whole number of milliseconds.
 *
 * @returns {number}
 */
function maxLifetimeMs() {
  const raw = requiredEnv(ENV.maxLifetimeMs);
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(
      `editor-host-probe: ${ENV.maxLifetimeMs}=${raw} is not a positive whole number of milliseconds.`,
    );
  }
  return value;
}

/**
 * A recorder appending one JSON line per record, stamped with the epoch
 * millisecond it was written at. Each line is written with one `appendFileSync`
 * call, so a reader sees whole lines or a trailing partial line it keeps for
 * later, never interleaved records. A write failure is reported on stderr (the
 * host keeps the window's output tail) and never throws into VS Code's event
 * loop.
 *
 * @param {string} outputFile
 * @returns {(record: Record<string, unknown>) => void}
 */
function createRecorder(outputFile) {
  return (record) => {
    const line = `${JSON.stringify({ ...record, at: Date.now() })}\n`;
    try {
      fs.appendFileSync(outputFile, line, { encoding: 'utf8', mode: 0o600 });
    } catch (error) {
      process.stderr.write(
        `editor-host-probe: could not append a ${String(record.kind)} record: ${describeError(error)}\n`,
      );
    }
  };
}

/**
 * A bounded one-line description of a thrown value.
 *
 * @param {unknown} error
 * @returns {string}
 */
function describeError(error) {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length <= MAX_ERROR_TEXT_LENGTH
    ? line
    : `${line.slice(0, MAX_ERROR_TEXT_LENGTH - 1)}…`;
}

/**
 * The `selection` record of one editor and one of its selections, or
 * `undefined` for a document that is not a file on disk (an output channel, an
 * untitled buffer, a settings editor).
 *
 * `line`/`column` are the selection's `active` position — the cursor — made
 * 1-based; `anchorLine`/`anchorColumn` its other end. `lineLength` is the
 * length of the active line, which is what VS Code clamps a requested column
 * to; `lineCount` bounds a requested line the same way.
 *
 * @param {import('vscode').TextEditor} editor
 * @param {import('vscode').Selection} selection
 * @returns {Record<string, unknown> | undefined}
 */
function selectionRecord(editor, selection) {
  const document = editor.document;
  if (document.uri.scheme !== 'file') {
    return undefined;
  }
  const active = selection.active;
  const anchor = selection.anchor;
  let lineLength = -1;
  try {
    lineLength = document.lineAt(active.line).text.length;
  } catch {
    // The document changed under the event; -1 tells the host the length is unknown.
  }
  return {
    kind: 'selection',
    file: document.uri.fsPath,
    line: active.line + 1,
    column: active.character + 1,
    anchorLine: anchor.line + 1,
    anchorColumn: anchor.character + 1,
    lineLength,
    lineCount: document.lineCount,
  };
}

/**
 * Resolves with why the run ends: the stop file appeared, or the lifetime ran out.
 *
 * @param {string} stopFile
 * @param {number} lifetimeMs
 * @returns {Promise<'stop-file' | 'max-lifetime'>}
 */
function untilStopped(stopFile, lifetimeMs) {
  const deadline = Date.now() + lifetimeMs;
  return new Promise((resolve) => {
    const check = () => {
      if (fs.existsSync(stopFile)) {
        resolve('stop-file');
        return;
      }
      if (Date.now() >= deadline) {
        resolve('max-lifetime');
        return;
      }
      setTimeout(check, Math.min(STOP_POLL_INTERVAL_MS, Math.max(0, deadline - Date.now())));
    };
    check();
  });
}

/**
 * VS Code's test-runner entry point (see the module documentation).
 *
 * @returns {Promise<void>}
 */
async function run() {
  const record = createRecorder(requiredEnv(ENV.output));
  const stopFile = requiredEnv(ENV.stop);
  const extensionId = requiredEnv(ENV.extensionId);
  const lifetimeMs = maxLifetimeMs();

  record({ kind: 'started', vscodeVersion: vscode.version, pid: process.pid });

  const extension = vscode.extensions.getExtension(extensionId);
  if (extension === undefined) {
    record({ kind: 'activation-failed', reason: 'extension-not-found', extensionId });
    throw new Error(
      `editor-host-probe: the extension ${extensionId} is not loaded; check --extensionDevelopmentPath.`,
    );
  }
  try {
    await extension.activate();
  } catch (error) {
    record({ kind: 'activation-failed', reason: 'activate-threw', error: describeError(error) });
    throw error;
  }

  const disposables = [
    vscode.window.onDidChangeTextEditorSelection((event) => {
      const selection = event.selections[0];
      const entry =
        selection === undefined ? undefined : selectionRecord(event.textEditor, selection);
      if (entry !== undefined) {
        record(entry);
      }
    }),
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      const entry = editor === undefined ? undefined : selectionRecord(editor, editor.selection);
      if (entry !== undefined) {
        record(entry);
      }
    }),
  ];

  record({
    kind: 'activated',
    extensionId,
    isActive: extension.isActive,
    workspaceFolders: (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath),
  });

  const current = vscode.window.activeTextEditor;
  const initial = current === undefined ? undefined : selectionRecord(current, current.selection);
  if (initial !== undefined) {
    record(initial);
  }

  try {
    const reason = await untilStopped(stopFile, lifetimeMs);
    record({ kind: 'stopping', reason });
  } finally {
    for (const disposable of disposables) {
      disposable.dispose();
    }
  }
}

module.exports = { run };
