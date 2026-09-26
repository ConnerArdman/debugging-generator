/**
 * A real VS Code window for the `e2e` suite: the Extension Development Host
 * the source-open path ends in (AAP §0.2.3, §0.8.4 acceptance test 1 — "clicking
 * the SQL row opens VS Code at the `pool.query` call site").
 *
 * The recording editor connection of `./service` proves that the service
 * forwarded a `source.open`; it cannot prove that an editor acted on it. This
 * module launches the editor itself — the real VS Code (Electron) with the
 * built `apps/vscode-extension` loaded and activated — so a spec can click a
 * source chip in the DevTools panel and read back where the editor's cursor
 * landed: service → the extension's own WebSocket → `open-location.ts` →
 * `window.showTextDocument` with a selection.
 *
 * ## The two halves
 *
 * - **This module** (Playwright side) resolves the editor and the extension,
 *   prepares a throwaway profile, provides a display, spawns the window and
 *   reads what the probe reports.
 * - **`./editor-host-probe.cjs`** (inside the window) is VS Code's
 *   `--extensionTestsPath` runner: it activates `debuggen.debug-generator`,
 *   appends one JSON line per activation and selection event to a file this
 *   module names, and keeps the window open until this module creates a stop
 *   file. It observes only; everything that reaches the editor arrives through
 *   the extension's own service connection.
 *
 * ## Launch contract
 *
 * - **Editor**: `VSCODE_TEST_PATH` when set (an installed executable, checked),
 *   otherwise `@vscode/test-electron`'s `downloadAndUnzipVSCode` — resolved from
 *   `apps/vscode-extension/package.json`, whose devDependency it is — for
 *   `VSCODE_TEST_VERSION` (default `stable`) into that workspace's
 *   git-ignored, per-checkout `.vscode-test/`.
 * - **Extension**: `--extensionDevelopmentPath=<repo>/apps/vscode-extension`;
 *   its manifest's `main` (`dist/extension.js`) must exist, which `pnpm build`
 *   produces. The extension id is read from that manifest
 *   (`<publisher>.<name>`), never restated.
 * - **Profile**: a fresh `--user-data-dir` and `--extensions-dir` under one
 *   temporary directory, removed on {@link EditorHostHandle.dispose}. The
 *   `debuggen.*` settings are written to `<user-data-dir>/User/settings.json`:
 *   `debuggen.serviceUrl` is `machine`-scoped, which VS Code honours from user
 *   settings only. The window never starts a service of its own
 *   (`debuggen.autoStartService: false`) and connects to the one the suite
 *   runs.
 * - **Environment**: inherited, minus `ELECTRON_RUN_AS_NODE` (which would run
 *   Electron as plain Node), `NODE_OPTIONS`, `VSCODE_*`, `ANTHROPIC_*` and every
 *   inherited `DEBUGGEN_*`; then `DEBUGGEN_HOME` is the service's home, where
 *   the extension reads the editor credential (`auth.json`), and
 *   `DEBUGGEN_PROVIDER=deterministic`.
 * - **Display**: on Linux without `DISPLAY`, an `Xvfb` of this module's own,
 *   started with `-displayfd` so the X server picks a free display number
 *   itself — no fixed number, because many checkouts share one host — and
 *   CI's e2e job needs no `xvfb-run`.
 *
 * ## Readiness
 *
 * {@link EditorHostHandle.start} resolves once the probe reports the extension
 * activated. Activation does not wait for the service connection (the
 * extension connects in the background, AAP §0.5.5), so
 * {@link EditorHostHandle.warmUp} proves the window is connected for a live
 * session before a spec relies on it: it sends `source.open` for a harmless
 * position — line 1, column 1 of a file of the session's project — from an
 * editor-role connection and waits until the window's cursor is there,
 * resending every few seconds within a bound. It depends on no
 * acknowledgement from the service, only on the window's own behaviour.
 *
 * ## Processes
 *
 * Only processes this module spawned are ever signalled: the VS Code main
 * process (on POSIX the leader of its own process group, so the helpers
 * Electron starts are reached too) and the `Xvfb` it started. Disposal asks the
 * window to close first (the stop file lets VS Code deactivate the extension
 * and exit on its own), then `SIGTERM`, then `SIGKILL` after
 * `TERMINATION_GRACE_MS`. A worker that exits without disposing still kills
 * both, synchronously, from a process `exit` hook. No name-based kill exists
 * here.
 *
 * ## What it records
 *
 * Positions, lengths, paths and process states only — never document text, a
 * credential or an environment value.
 *
 * This file declares no `test(...)`, `describe(...)` or fixture:
 * `./fixtures.ts` exposes {@link createEditorHost} as the `editorHost` fixture.
 *
 * @module tests/e2e/helpers/editor-host
 */
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { statSync } from 'node:fs';
import { mkdir, mkdtemp, open, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';

import { DEFAULT_RESOLUTION_CONFIDENCE } from '@debuggen/shared';
import type { SourceLocation, SourceResolvedBy } from '@debuggen/shared';

import { TERMINATION_GRACE_MS, repoPath } from './repo';
import { DEFAULT_WAIT_TIMEOUT_MS } from './service';
import type { EditorClientHandle } from './service';

// ---------------------------------------------------------------------------
// Budgets and bounds
// ---------------------------------------------------------------------------

/** The budgets of the editor host, in milliseconds. */
export interface EditorHostTimeouts {
  /** Downloading and unpacking VS Code when `VSCODE_TEST_PATH` is unset (a cold CI cache). */
  readonly download: number;
  /** `Xvfb` reporting its display number. */
  readonly display: number;
  /** Spawn → the probe reporting the extension activated. */
  readonly launch: number;
  /** {@link EditorHostHandle.start} end to end: `download + display + launch`. */
  readonly startup: number;
  /** {@link EditorHostHandle.warmUp}: the window connecting to the service and opening the warm-up position. */
  readonly warmUp: number;
  /** How long one warm-up `source.open` is given before it is sent again. */
  readonly warmUpRetry: number;
  /** One {@link EditorHostHandle.waitForSelection}, the editor client's default wait. */
  readonly selection: number;
  /** The window closing on its own after the stop file appears (extension deactivation included). */
  readonly stop: number;
  /** {@link EditorHostHandle.dispose} end to end: `stop`, then SIGTERM and SIGKILL for both processes. */
  readonly teardown: number;
  /** The probe's own safety net: it resolves on its own after this long without a stop file. */
  readonly maxLifetime: number;
}

const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
const DISPLAY_TIMEOUT_MS = 15_000;
const LAUNCH_TIMEOUT_MS = 120_000;
const STOP_TIMEOUT_MS = 15_000;

/**
 * The fixed budgets (see {@link EditorHostTimeouts}). `teardown` covers the
 * graceful stop plus, for each of the two processes, a SIGTERM grace and a
 * SIGKILL grace — the worst case of {@link EditorHostHandle.dispose}.
 */
export const EDITOR_HOST_TIMEOUTS: EditorHostTimeouts = Object.freeze({
  download: DOWNLOAD_TIMEOUT_MS,
  display: DISPLAY_TIMEOUT_MS,
  launch: LAUNCH_TIMEOUT_MS,
  startup: DOWNLOAD_TIMEOUT_MS + DISPLAY_TIMEOUT_MS + LAUNCH_TIMEOUT_MS,
  warmUp: 60_000,
  warmUpRetry: 3_000,
  selection: DEFAULT_WAIT_TIMEOUT_MS,
  stop: STOP_TIMEOUT_MS,
  teardown: STOP_TIMEOUT_MS + 4 * TERMINATION_GRACE_MS,
  maxLifetime: 60 * 60_000,
});

/** How often the probe's file is read while a wait is pending: a file offers no cross-process event. */
const PROBE_POLL_INTERVAL_MS = 100;

/** How many probe records are retained; the oldest are dropped (and counted) beyond it. */
const MAX_PROBE_RECORDS = 5_000;

/** The largest slice of the probe's file read at once. */
const MAX_PROBE_READ_BYTES = 1024 * 1024;

/** How many malformed probe lines are described (the most recent). */
const MAX_PROBE_PROBLEMS = 20;

/** How many lines of the window's (and Xvfb's) stdout/stderr are kept, oldest dropped first. */
const OUTPUT_TAIL_LINES = 200;

/** The longest output line kept, in characters. */
const OUTPUT_LINE_MAX_LENGTH = 500;

/** How many selections a description or a diagnostic lists (the most recent). */
const MAX_DESCRIBED_SELECTIONS = 20;

/** How many trailing lines of each VS Code log file the diagnostics quote. */
const LOG_TAIL_LINES = 80;

/** The VS Code log files the diagnostics quote: the extension's own output channel, and the extension host's log. */
const DIAGNOSTIC_LOG_SUFFIXES = Object.freeze(['Debug Generator.log', 'exthost.log']);

/** The throwaway directory's prefix under `os.tmpdir()`. */
const TEMP_DIR_PREFIX = 'debuggen-e2e-editor-';

/** `Xvfb`'s screen: one 24-bit screen large enough for the workbench. */
const XVFB_SCREEN = '1280x1024x24';

/** The descriptor `Xvfb -displayfd` writes its display number to (the child's fd 3). */
const XVFB_DISPLAY_FD = 3;

// ---------------------------------------------------------------------------
// Fixed facts: the probe, its environment, the warm-up position
// ---------------------------------------------------------------------------

/** This module's directory, from its own location (never `process.cwd()`). */
const HELPERS_DIR = path.dirname(fileURLToPath(import.meta.url));

/** The in-window runner (see `./editor-host-probe.cjs`). */
const PROBE_FILE = path.join(HELPERS_DIR, 'editor-host-probe.cjs');

/** The environment the probe reads — the names `./editor-host-probe.cjs` documents. */
const PROBE_ENV = Object.freeze({
  output: 'DEBUGGEN_E2E_EDITOR_PROBE_OUTPUT',
  stop: 'DEBUGGEN_E2E_EDITOR_PROBE_STOP',
  extensionId: 'DEBUGGEN_E2E_EDITOR_PROBE_EXTENSION_ID',
  maxLifetimeMs: 'DEBUGGEN_E2E_EDITOR_PROBE_MAX_LIFETIME_MS',
});

/** Inherited names never handed to the window (compared upper-cased). */
const STRIPPED_ENV_NAMES: ReadonlySet<string> = new Set([
  'ELECTRON_RUN_AS_NODE',
  'ELECTRON_NO_ATTACH_CONSOLE',
  'NODE_OPTIONS',
]);

/**
 * Inherited prefixes never handed to the window: the product's own settings
 * (the window gets exactly the two it needs), provider keys, and the variables
 * a surrounding VS Code sets for its own terminals.
 */
const STRIPPED_ENV_PREFIXES: readonly string[] = Object.freeze([
  'DEBUGGEN_',
  'ANTHROPIC_',
  'VSCODE_',
]);

/**
 * Built-in extensions switched off for the window. `--disable-extensions`
 * leaves built-ins running; these two would index the whole demo (a
 * TypeScript server over its `node_modules`, a git scan of the repository) on
 * a host many checkouts share, and nothing here needs them.
 */
const DISABLED_BUILTIN_EXTENSIONS = Object.freeze([
  'vscode.typescript-language-features',
  'vscode.git',
]);

/** Where the warm-up puts the cursor: the first character of the file (1-based). */
export const EDITOR_WARM_UP_POSITION = Object.freeze({ line: 1, column: 1 });

/** The resolution route the warm-up location claims; it names a position, not a symbol. */
const WARM_UP_RESOLVED_BY: SourceResolvedBy = 'code-graph';

/** The warm-up `source.open` location for a project-relative file. */
export function editorWarmUpLocation(file: string): SourceLocation {
  return {
    file,
    line: EDITOR_WARM_UP_POSITION.line,
    column: EDITOR_WARM_UP_POSITION.column,
    resolvedBy: WARM_UP_RESOLVED_BY,
    confidence: DEFAULT_RESOLUTION_CONFIDENCE[WARM_UP_RESOLVED_BY],
  };
}

/**
 * Whether a `source.open` location is a warm-up's (line 1, column 1). A
 * recording editor connection may receive the warm-up it sent back from the
 * service; a spec waiting for a panel click's `source.open` excludes these.
 */
export function isEditorWarmUpLocation(location: SourceLocation): boolean {
  return (
    location.line === EDITOR_WARM_UP_POSITION.line &&
    location.column === EDITOR_WARM_UP_POSITION.column
  );
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Why the editor host failed:
 *
 * - `prerequisites` — something the launch needs is missing (an unbuilt
 *   extension, a wrong `VSCODE_TEST_PATH`, no `Xvfb`), with the fix;
 * - `launch` — the window or its display did not come up;
 * - `activation` — the probe could not activate the extension;
 * - `exited` — the window exited while it was relied on;
 * - `timeout` — a bounded wait ran out;
 * - `disposed` — the handle was disposed while the call ran;
 * - `teardown` — a spawned process could not be terminated, or the throwaway
 *   directory could not be removed.
 */
export type EditorHostErrorCode =
  'prerequisites' | 'launch' | 'activation' | 'exited' | 'timeout' | 'disposed' | 'teardown';

/** A failure of the editor host, with its {@link EditorHostErrorCode}. */
export class EditorHostError extends Error {
  readonly code: EditorHostErrorCode;

  constructor(code: EditorHostErrorCode, message: string, options?: { readonly cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'EditorHostError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Probe records
// ---------------------------------------------------------------------------

/** Fields every probe record carries. */
interface ProbeRecordBase {
  /** The absolute position in this handle's record list: 0 for the first, never reused. */
  readonly index: number;
  /** When the probe wrote it (epoch milliseconds, the window's clock). */
  readonly at: number;
}

/** The probe began running inside the window. */
export interface EditorStartedRecord extends ProbeRecordBase {
  readonly kind: 'started';
  readonly vscodeVersion: string;
  readonly pid: number;
}

/** The extension under development is active. */
export interface EditorActivatedRecord extends ProbeRecordBase {
  readonly kind: 'activated';
  readonly extensionId: string;
  readonly isActive: boolean;
  readonly workspaceFolders: readonly string[];
}

/** The extension could not be found or activated (`reason`, with a bounded error text). */
export interface EditorActivationFailedRecord extends ProbeRecordBase {
  readonly kind: 'activation-failed';
  readonly reason: string;
  readonly error: string | undefined;
}

/**
 * The active editor or its selection changed. `line`/`column` are the
 * cursor (the selection's `active` end), 1-based — where `open-location.ts`
 * puts a requested position.
 */
export interface EditorSelectionRecord extends ProbeRecordBase {
  readonly kind: 'selection';
  /** The document's `fsPath` as the window reported it. */
  readonly file: string;
  /** Its real path, resolved on this side; `undefined` when it could not be resolved. */
  readonly realpath: string | undefined;
  readonly line: number;
  readonly column: number;
  readonly anchorLine: number;
  readonly anchorColumn: number;
  /** The length of the cursor's line (what VS Code clamps a requested column to); `-1` when unknown. */
  readonly lineLength: number;
  /** The document's line count (what VS Code clamps a requested line to). */
  readonly lineCount: number;
}

/** The probe is ending the run (`stop-file` or `max-lifetime`). */
export interface EditorStoppingRecord extends ProbeRecordBase {
  readonly kind: 'stopping';
  readonly reason: string;
}

/** One record of the probe's output file, in the order it was written. */
export type EditorProbeRecord =
  | EditorStartedRecord
  | EditorActivatedRecord
  | EditorActivationFailedRecord
  | EditorSelectionRecord
  | EditorStoppingRecord;

/** A record as parsed, before this handle numbers it (and resolves a selection's real path). */
type ParsedProbeRecord =
  | Omit<EditorStartedRecord, 'index'>
  | Omit<EditorActivatedRecord, 'index'>
  | Omit<EditorActivationFailedRecord, 'index'>
  | Omit<EditorSelectionRecord, 'index' | 'realpath'>
  | Omit<EditorStoppingRecord, 'index'>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1;
}

function isIntegerAtLeast(value: unknown, minimum: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= minimum;
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' && value !== '' ? value : fallback;
}

/**
 * One line of the probe's file as a record, or a description of why it is not
 * one. Descriptions name the problem, never the line's content.
 */
function parseProbeLine(line: string): ParsedProbeRecord | string {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return 'a line that is not JSON';
  }
  if (!isRecord(value) || typeof value.kind !== 'string' || typeof value.at !== 'number') {
    return 'a record without a string `kind` and a numeric `at`';
  }
  const at = value.at;
  switch (value.kind) {
    case 'started':
      return {
        kind: 'started',
        at,
        vscodeVersion: stringOr(value.vscodeVersion, 'unknown'),
        pid: isPositiveInteger(value.pid) ? value.pid : -1,
      };
    case 'activated':
      return {
        kind: 'activated',
        at,
        extensionId: stringOr(value.extensionId, 'unknown'),
        isActive: value.isActive === true,
        workspaceFolders: Array.isArray(value.workspaceFolders)
          ? value.workspaceFolders.filter((folder): folder is string => typeof folder === 'string')
          : [],
      };
    case 'activation-failed':
      return {
        kind: 'activation-failed',
        at,
        reason: stringOr(value.reason, 'unknown'),
        error: typeof value.error === 'string' ? value.error : undefined,
      };
    case 'selection': {
      const { file, line: row, column, anchorLine, anchorColumn, lineLength, lineCount } = value;
      if (
        typeof file !== 'string' ||
        file === '' ||
        !isPositiveInteger(row) ||
        !isPositiveInteger(column) ||
        !isPositiveInteger(anchorLine) ||
        !isPositiveInteger(anchorColumn) ||
        !isIntegerAtLeast(lineLength, -1) ||
        !isIntegerAtLeast(lineCount, 0)
      ) {
        return 'a selection record with a missing or malformed field';
      }
      return {
        kind: 'selection',
        at,
        file,
        line: row,
        column,
        anchorLine,
        anchorColumn,
        lineLength,
        lineCount,
      };
    }
    case 'stopping':
      return { kind: 'stopping', at, reason: stringOr(value.reason, 'unknown') };
    default:
      return 'a record of an unknown kind';
  }
}

/**
 * The probe's output file, read incrementally: each {@link ProbeLog.pull}
 * reads what was appended since the last one, keeps a trailing partial line
 * for later, and numbers every whole record. Pulls are serialised.
 */
class ProbeLog {
  readonly #file: string;
  readonly #decoder = new StringDecoder('utf8');
  readonly #records: EditorProbeRecord[] = [];
  readonly #problems: string[] = [];
  #offset = 0;
  #pending = '';
  #firstRetained = 0;
  #nextIndex = 0;
  #dropped = 0;
  #malformed = 0;
  #chain: Promise<void> = Promise.resolve();

  constructor(file: string) {
    this.#file = file;
  }

  /** Read whatever the probe appended since the last pull. */
  pull(): Promise<void> {
    const next = this.#chain.then(() => this.#read());
    this.#chain = next.catch(() => undefined);
    return next;
  }

  /** The index the next record will get. */
  get nextIndex(): number {
    return this.#nextIndex;
  }

  /** Every retained record at or after `since`, oldest first. */
  since(since: number): readonly EditorProbeRecord[] {
    return this.#records.slice(Math.max(since, this.#firstRetained) - this.#firstRetained);
  }

  /** How many records were dropped on overflow. */
  get dropped(): number {
    return this.#dropped;
  }

  /** How many lines were not records, and the most recent descriptions of why. */
  problems(): { readonly count: number; readonly recent: readonly string[] } {
    return { count: this.#malformed, recent: [...this.#problems] };
  }

  async #read(): Promise<void> {
    let handle: FileHandle;
    try {
      handle = await open(this.#file, 'r');
    } catch (error) {
      if (isRecord(error) && error.code === 'ENOENT') {
        return;
      }
      throw error;
    }
    try {
      const { size } = await handle.stat();
      while (this.#offset < size) {
        const length = Math.min(size - this.#offset, MAX_PROBE_READ_BYTES);
        const buffer = Buffer.alloc(length);
        const { bytesRead } = await handle.read(buffer, 0, length, this.#offset);
        if (bytesRead === 0) {
          break;
        }
        this.#offset += bytesRead;
        this.#pending += this.#decoder.write(buffer.subarray(0, bytesRead));
      }
    } finally {
      await handle.close();
    }
    let newline = this.#pending.indexOf('\n');
    while (newline >= 0) {
      const line = this.#pending.slice(0, newline).trim();
      this.#pending = this.#pending.slice(newline + 1);
      if (line !== '') {
        await this.#accept(line);
      }
      newline = this.#pending.indexOf('\n');
    }
  }

  async #accept(line: string): Promise<void> {
    const parsed = parseProbeLine(line);
    if (typeof parsed === 'string') {
      this.#malformed += 1;
      this.#problems.push(parsed);
      if (this.#problems.length > MAX_PROBE_PROBLEMS) {
        this.#problems.shift();
      }
      return;
    }
    const index = this.#nextIndex;
    const record: EditorProbeRecord =
      parsed.kind === 'selection'
        ? { ...parsed, index, realpath: await realpath(parsed.file).catch(() => undefined) }
        : { ...parsed, index };
    this.#records.push(record);
    this.#nextIndex += 1;
    if (this.#records.length > MAX_PROBE_RECORDS) {
      this.#records.shift();
      this.#firstRetained += 1;
      this.#dropped += 1;
    }
  }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** A non-empty trimmed string, else `undefined`. */
function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === '' ? undefined : trimmed;
}

/** A bounded one-line description of a thrown value. */
function describeError(error: unknown): string {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length <= OUTPUT_LINE_MAX_LENGTH
    ? line
    : `${line.slice(0, OUTPUT_LINE_MAX_LENGTH - 1)}…`;
}

function isFile(file: string): boolean {
  try {
    return statSync(file).isFile();
  } catch {
    // Absent or unreadable: either way there is no file to use.
    return false;
  }
}

function isDirectory(directory: string): boolean {
  try {
    return statSync(directory).isDirectory();
  } catch {
    // Absent or unreadable: either way there is no folder to open.
    return false;
  }
}

/** Resolve after `ms`, or at once when `ms` is not positive; the timer is the only resource. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, ms));
  });
}

/** Settle `promise`, or reject with a `timeout` error naming `label` after `ms`; the timer never outlives the call. */
async function withDeadline<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new EditorHostError('timeout', `${label} did not finish within ${String(ms)} ms.`));
    }, ms);
  });
  // A late rejection of the loser must not surface as an unhandled rejection.
  void promise.catch(() => undefined);
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

/** A bounded tail of a child's output lines, each prefixed with its source. */
class OutputTail {
  readonly #lines: string[] = [];
  #dropped = 0;

  /** Follow `stream`, splitting it into lines prefixed with `label`. */
  follow(stream: Readable | null, label: string): void {
    if (stream === null) {
      return;
    }
    const decoder = new StringDecoder('utf8');
    let pending = '';
    const flush = (final: boolean): void => {
      const parts = pending.split(/\r?\n/);
      pending = final ? '' : (parts.pop() ?? '');
      for (const part of parts) {
        if (part.trim() !== '') {
          this.push(`${label}: ${part}`);
        }
      }
    };
    stream.on('data', (chunk: Buffer) => {
      pending += decoder.write(chunk);
      flush(false);
    });
    stream.on('end', () => {
      pending += decoder.end();
      flush(true);
    });
  }

  /** Append one line, truncated; evict the oldest beyond the limit. */
  push(line: string): void {
    this.#lines.push(
      line.length <= OUTPUT_LINE_MAX_LENGTH
        ? line
        : `${line.slice(0, OUTPUT_LINE_MAX_LENGTH - 1)}…`,
    );
    while (this.#lines.length > OUTPUT_TAIL_LINES) {
      this.#lines.shift();
      this.#dropped += 1;
    }
  }

  /** The last `count` lines, oldest first. */
  tail(count: number): string[] {
    return this.#lines.slice(-count);
  }

  /** How many lines were evicted. */
  get dropped(): number {
    return this.#dropped;
  }
}

// ---------------------------------------------------------------------------
// Spawned processes: tracking and termination
// ---------------------------------------------------------------------------

/** On POSIX the window leads its own process group, so its Electron helpers are signalled with it. */
const USE_PROCESS_GROUPS = process.platform !== 'win32';

/** Processes this module spawned that have not exited yet. */
const liveChildren = new Set<ChildProcess>();
let exitHookInstalled = false;

/** The spawned processes that lead their own process group (spawned `detached` on POSIX). */
const groupLeaders = new WeakSet<ChildProcess>();

/**
 * Track a spawned process until it exits. The first call installs one `exit`
 * hook that SIGKILLs every live one (a worker ending mid-test must not leave a
 * window or an X server behind). Installed lazily: importing this module has
 * no side effect.
 */
function trackChild(child: ChildProcess): void {
  liveChildren.add(child);
  child.once('exit', () => {
    liveChildren.delete(child);
  });
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.on('exit', () => {
      for (const live of liveChildren) {
        signalChild(live, 'SIGKILL', true);
      }
      liveChildren.clear();
    });
  }
}

function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

/**
 * Send `signal` to a spawned process, or to the process group it leads when
 * `group` is set and it was spawned detached (POSIX). `ESRCH` (nothing left to
 * signal) is success.
 *
 * @returns `undefined` when delivered or moot, otherwise why it could not be sent.
 */
function signalChild(
  child: ChildProcess,
  signal: NodeJS.Signals,
  group: boolean,
): string | undefined {
  const pid = child.pid;
  if (pid === undefined) {
    return undefined;
  }
  if (group && USE_PROCESS_GROUPS && groupLeaders.has(child)) {
    try {
      process.kill(-pid, signal);
      return undefined;
    } catch (error) {
      if (!(isRecord(error) && error.code === 'ESRCH')) {
        return describeError(error);
      }
      // The group is gone; the leader itself may still be exiting — fall through.
    }
  }
  if (hasExited(child)) {
    return undefined;
  }
  try {
    child.kill(signal);
    return undefined;
  } catch (error) {
    return isRecord(error) && error.code === 'ESRCH' ? undefined : describeError(error);
  }
}

/** Resolve `true` once `child` has exited, or `false` after `ms`. */
function waitForExit(child: ChildProcess, ms: number): Promise<boolean> {
  if (hasExited(child)) {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    const onExit = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      child.removeListener('exit', onExit);
      resolve(hasExited(child));
    }, ms);
    child.once('exit', onExit);
  });
}

/**
 * Whether any process of the group `child` led is still alive after the
 * leader exited (an Electron helper it left behind).
 */
function groupSurvives(child: ChildProcess): boolean {
  const pid = child.pid;
  if (pid === undefined || !USE_PROCESS_GROUPS || !groupLeaders.has(child)) {
    return false;
  }
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    // ESRCH: no process is left in the group (EPERM cannot arise for our own children).
    return false;
  }
}

/**
 * Stop a spawned process: SIGTERM to it, then SIGKILL to it (and, for a group
 * leader, its group) after `TERMINATION_GRACE_MS`. A leader that exited on its
 * own has any helper still in its group reaped the same way.
 *
 * @returns `undefined` once nothing is left, otherwise why something survived.
 */
async function terminate(child: ChildProcess, label: string): Promise<string | undefined> {
  if (!hasExited(child)) {
    const problem = signalChild(child, 'SIGTERM', false);
    if (problem !== undefined) {
      return `${label}: SIGTERM could not be sent (${problem})`;
    }
    if (!(await waitForExit(child, TERMINATION_GRACE_MS))) {
      const killProblem = signalChild(child, 'SIGKILL', true);
      if (killProblem !== undefined) {
        return `${label}: SIGKILL could not be sent (${killProblem})`;
      }
      if (!(await waitForExit(child, TERMINATION_GRACE_MS))) {
        return `${label} (pid ${String(child.pid)}) is still running after SIGTERM and SIGKILL`;
      }
    }
  }
  if (groupSurvives(child)) {
    const reapProblem = signalChild(child, 'SIGKILL', true);
    if (reapProblem !== undefined) {
      return `${label}: its remaining helper processes could not be killed (${reapProblem})`;
    }
  }
  return undefined;
}

/** A process's exit, as a short phrase. */
function describeExit(child: ChildProcess): string {
  if (child.exitCode !== null) {
    return `exited with code ${String(child.exitCode)}`;
  }
  if (child.signalCode !== null) {
    return `was ended by ${child.signalCode}`;
  }
  return 'is running';
}

// ---------------------------------------------------------------------------
// Resolution: the extension, the editor, the display
// ---------------------------------------------------------------------------

/** The extension under development, from its manifest. */
interface ExtensionUnderTest {
  /** `<publisher>.<name>`. */
  readonly id: string;
  /** `apps/vscode-extension`. */
  readonly developmentPath: string;
}

/**
 * Read `apps/vscode-extension/package.json` for the extension id and require
 * its built entry point.
 *
 * @throws {EditorHostError} `prerequisites` when the manifest is unreadable or the build is missing.
 */
async function resolveExtensionUnderTest(): Promise<ExtensionUnderTest> {
  const developmentPath = repoPath('apps', 'vscode-extension');
  const manifestFile = path.join(developmentPath, 'package.json');
  let manifest: unknown;
  try {
    manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
  } catch (error) {
    throw new EditorHostError(
      'prerequisites',
      `The VS Code extension manifest apps/vscode-extension/package.json could not be read (${describeError(error)}).`,
      { cause: error },
    );
  }
  if (
    !isRecord(manifest) ||
    typeof manifest.publisher !== 'string' ||
    typeof manifest.name !== 'string' ||
    typeof manifest.main !== 'string'
  ) {
    throw new EditorHostError(
      'prerequisites',
      'apps/vscode-extension/package.json declares no string `publisher`, `name` and `main`.',
    );
  }
  const main = path.resolve(developmentPath, manifest.main);
  if (!isFile(main)) {
    throw new EditorHostError(
      'prerequisites',
      `The VS Code extension is not built: ${path.relative(repoPath(), main)} is missing. Run \`pnpm build\` (or \`pnpm --filter debug-generator build\`) before \`pnpm test:e2e\`.`,
    );
  }
  return { id: `${manifest.publisher}.${manifest.name}`, developmentPath };
}

/** `@vscode/test-electron`'s download entry point, as far as this module calls it. */
type DownloadAndUnzip = (options: {
  readonly version: string;
  readonly cachePath: string;
}) => Promise<unknown>;

/**
 * The VS Code executable: `VSCODE_TEST_PATH` when set, otherwise a download of
 * `VSCODE_TEST_VERSION` (default `stable`) through `@vscode/test-electron`,
 * resolved from `apps/vscode-extension` because it is that workspace's
 * devDependency, cached in that workspace's git-ignored `.vscode-test/`.
 *
 * @throws {EditorHostError} `prerequisites` for a wrong path or an unavailable
 *   downloader; `timeout` when the download outlasts its budget.
 */
async function resolveEditorExecutable(): Promise<string> {
  const configured = nonEmpty(process.env.VSCODE_TEST_PATH);
  if (configured !== undefined) {
    const executable = path.resolve(configured);
    if (!isFile(executable)) {
      throw new EditorHostError(
        'prerequisites',
        `VSCODE_TEST_PATH=${configured} is not an existing VS Code executable. Point it at the editor binary (for example …/vscode-linux-x64-<version>/code), or unset it to download one.`,
      );
    }
    return executable;
  }
  const workspace = repoPath('apps', 'vscode-extension');
  let loaded: unknown;
  try {
    loaded = createRequire(path.join(workspace, 'package.json'))('@vscode/test-electron');
  } catch (error) {
    throw new EditorHostError(
      'prerequisites',
      `@vscode/test-electron could not be loaded from apps/vscode-extension (${describeError(error)}). Run \`pnpm install\`, or set VSCODE_TEST_PATH to an installed VS Code executable.`,
      { cause: error },
    );
  }
  if (!isRecord(loaded) || typeof loaded.downloadAndUnzipVSCode !== 'function') {
    throw new EditorHostError(
      'prerequisites',
      '@vscode/test-electron exports no downloadAndUnzipVSCode; check the version apps/vscode-extension pins.',
    );
  }
  const download = loaded.downloadAndUnzipVSCode as DownloadAndUnzip;
  const version = nonEmpty(process.env.VSCODE_TEST_VERSION) ?? 'stable';
  const executable = await withDeadline(
    download({ version, cachePath: path.join(workspace, '.vscode-test') }),
    DOWNLOAD_TIMEOUT_MS,
    `Downloading VS Code ${version}`,
  );
  if (typeof executable !== 'string' || !isFile(executable)) {
    throw new EditorHostError(
      'prerequisites',
      `@vscode/test-electron did not produce a VS Code executable for ${version}.`,
    );
  }
  return executable;
}

/** The display the window uses, and the X server started for it, if any. */
interface DisplayLease {
  readonly display: string | undefined;
  readonly server: ChildProcess | undefined;
}

/**
 * The display for the window: the inherited `DISPLAY`, nothing off Linux, or
 * an `Xvfb` of this module's own. `-displayfd` makes the server choose a free
 * display number and write it to the descriptor once it accepts connections,
 * so concurrent checkouts never collide on a fixed number.
 *
 * @throws {EditorHostError} `prerequisites` when `Xvfb` is not installed;
 *   `launch` when it exits or stays silent.
 */
async function acquireDisplay(output: OutputTail): Promise<DisplayLease> {
  if (process.platform !== 'linux') {
    return { display: undefined, server: undefined };
  }
  const inherited = nonEmpty(process.env.DISPLAY);
  if (inherited !== undefined) {
    return { display: inherited, server: undefined };
  }
  const server = spawn(
    'Xvfb',
    ['-displayfd', String(XVFB_DISPLAY_FD), '-screen', '0', XVFB_SCREEN, '-nolisten', 'tcp'],
    { stdio: ['ignore', 'pipe', 'pipe', 'pipe'], windowsHide: true },
  );
  output.follow(server.stdout, 'xvfb');
  output.follow(server.stderr, 'xvfb');
  const displayStream = server.stdio[XVFB_DISPLAY_FD] as Readable | null | undefined;
  const reported = new Promise<string>((resolve, reject) => {
    const decoder = new StringDecoder('utf8');
    let text = '';
    server.once('error', (error) => {
      reject(
        isRecord(error) && error.code === 'ENOENT'
          ? new EditorHostError(
              'prerequisites',
              'Xvfb is not installed, and DISPLAY is unset. Install it (`apt-get install xvfb`), or point DISPLAY at a running X server.',
              { cause: error },
            )
          : new EditorHostError('launch', `Xvfb could not be started (${describeError(error)}).`, {
              cause: error,
            }),
      );
    });
    server.once('exit', () => {
      reject(
        new EditorHostError(
          'launch',
          `Xvfb ${describeExit(server)} before reporting a display; its output: ${output.tail(10).join(' | ') || '(none)'}`,
        ),
      );
    });
    if (displayStream === null || displayStream === undefined) {
      reject(new EditorHostError('launch', 'Xvfb was started without its display descriptor.'));
      return;
    }
    displayStream.on('data', (chunk: Buffer) => {
      text += decoder.write(chunk);
      const match = /^\s*(\d+)\s*\n/.exec(text);
      if (match?.[1] !== undefined) {
        resolve(`:${match[1]}`);
      }
    });
  });
  trackChild(server);
  try {
    const display = await withDeadline(reported, DISPLAY_TIMEOUT_MS, 'Xvfb reporting its display');
    return { display, server };
  } catch (error) {
    await terminate(server, 'Xvfb');
    throw error;
  }
}

/**
 * The window's user settings. `debuggen.serviceUrl` is `machine`-scoped, so it
 * must be a user setting; the rest keep the window from starting a service of
 * its own, from reaching the network and from opening anything unasked.
 */
function userSettings(serviceUrl: string): Record<string, unknown> {
  return {
    'debuggen.serviceUrl': serviceUrl,
    'debuggen.autoStartService': false,
    'debuggen.provider': 'deterministic',
    'telemetry.telemetryLevel': 'off',
    'update.mode': 'none',
    'extensions.autoCheckUpdates': false,
    'extensions.autoUpdate': false,
    'extensions.ignoreRecommendations': true,
    'workbench.startupEditor': 'none',
    'workbench.tips.enabled': false,
    'workbench.enableExperiments': false,
    'security.workspace.trust.enabled': false,
    'window.restoreWindows': 'none',
    'git.enabled': false,
    'files.watcherExclude': { '**/.next/**': true, '**/node_modules/**': true },
  };
}

/** The window's environment (see the module documentation). */
function editorEnvironment(values: Readonly<Record<string, string>>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined) {
      continue;
    }
    const upper = name.toUpperCase();
    if (
      STRIPPED_ENV_NAMES.has(upper) ||
      STRIPPED_ENV_PREFIXES.some((prefix) => upper.startsWith(prefix))
    ) {
      continue;
    }
    env[name] = value;
  }
  return { ...env, ...values };
}

/** Every file under `directory` whose name ends with one of `suffixes`, newest-path last. */
async function findLogs(directory: string, suffixes: readonly string[]): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(directory, { recursive: true });
  } catch {
    // No logs directory yet (the window never started): nothing to quote.
    return [];
  }
  return entries
    .filter((entry) => suffixes.some((suffix) => entry.endsWith(suffix)))
    .sort()
    .map((entry) => path.join(directory, entry));
}

// ---------------------------------------------------------------------------
// The handle
// ---------------------------------------------------------------------------

/** Options of {@link createEditorHost}. */
export interface EditorHostOptions {
  /** The service origin the window's extension connects to (`debuggen.serviceUrl`). */
  readonly serviceUrl: string;
  /** The service's `$DEBUGGEN_HOME`, where the extension reads the editor credential. */
  readonly debuggenHome: string;
  /** The folder the window opens: the project whose sessions it serves. */
  readonly workspaceFolder: string;
  /** The probe's safety-net lifetime; defaults to `EDITOR_HOST_TIMEOUTS.maxLifetime`. */
  readonly maxLifetimeMs?: number | undefined;
}

/** What {@link EditorHostHandle.start} established. */
export interface EditorHostReady {
  /** The VS Code executable that was launched. */
  readonly executable: string;
  /** The version the window reported. */
  readonly vscodeVersion: string;
  /** The display it runs on (`undefined` off Linux). */
  readonly display: string | undefined;
  /** Whether that display is an `Xvfb` this handle started. */
  readonly ownDisplay: boolean;
  /** The activated extension's id. */
  readonly extensionId: string;
  /** Milliseconds from `start()` to the probe reporting activation. */
  readonly startupMs: number;
}

/** The lifecycle of a handle. */
export type EditorHostState = 'idle' | 'starting' | 'ready' | 'failed' | 'disposed';

/** Options of {@link EditorHostHandle.waitForSelection}. */
export interface WaitForSelectionOptions {
  /** The document, project-relative to the workspace folder; compared by real path. */
  readonly file: string;
  /** What the selection must satisfy besides its document; any selection in it when omitted. */
  readonly matches?: ((selection: EditorSelectionRecord) => boolean) | undefined;
  /** What the timeout message calls the awaited selection, e.g. `at 12:5`. */
  readonly description?: string | undefined;
  /** Only records at or after this index (from {@link EditorHostHandle.snapshotIndex}); 0 by default. */
  readonly sinceIndex?: number | undefined;
  /** The wait's budget; defaults to `EDITOR_HOST_TIMEOUTS.selection`. */
  readonly timeoutMs?: number | undefined;
}

/** Options of {@link EditorHostHandle.warmUp}. */
export interface EditorWarmUpOptions {
  /** An editor-role connection whose announced workspace covers the session's project. */
  readonly sender: Pick<EditorClientHandle, 'sendSourceOpen'>;
  /** The live session the window must serve. */
  readonly sessionId: string;
  /** A file of the session's project, project-relative, to put the cursor at line 1, column 1 of. */
  readonly file: string;
  /** The whole warm-up's budget; defaults to `EDITOR_HOST_TIMEOUTS.warmUp`. */
  readonly timeoutMs?: number | undefined;
  /** How long each `source.open` is given before it is sent again; defaults to `EDITOR_HOST_TIMEOUTS.warmUpRetry`. */
  readonly retryIntervalMs?: number | undefined;
}

/** What {@link EditorHostHandle.warmUp} observed. */
export interface EditorWarmUpResult {
  /** How many warm-up `source.open` frames were sent. */
  readonly attempts: number;
  /** Milliseconds until the window's cursor reached the warm-up position. */
  readonly elapsedMs: number;
  /** The selection that proved it. */
  readonly selection: EditorSelectionRecord;
}

/** What {@link EditorHostHandle.dispose} did. */
export interface EditorHostDisposeReport {
  /** Whether the window closed on its own after the stop file (rather than being signalled). */
  readonly graceful: boolean;
  /** Whether a window had been spawned at all. */
  readonly launched: boolean;
}

/** A real VS Code window serving the suite's service (see the module documentation). */
export interface EditorHostHandle {
  /** The folder the window opens. */
  readonly workspaceFolder: string;
  /** The handle's lifecycle state. */
  state(): EditorHostState;
  /**
   * Launch the window and wait for the probe to report the extension active.
   * Idempotent: every call answers the same launch. Creating the handle does no
   * I/O; this is where the work starts.
   *
   * @throws {EditorHostError} See {@link EditorHostErrorCode}.
   */
  start(): Promise<EditorHostReady>;
  /** The index the next probe record will get; pass it as `sinceIndex` to scope a wait. */
  snapshotIndex(): number;
  /** Every retained probe record (from `sinceIndex`), oldest first, as last read. */
  records(sinceIndex?: number): readonly EditorProbeRecord[];
  /** Every retained selection record (from `sinceIndex`), oldest first, after reading the probe's file. */
  selections(sinceIndex?: number): Promise<readonly EditorSelectionRecord[]>;
  /**
   * Resolve with the first selection in `file` (by real path) at or after
   * `sinceIndex` that `matches`. Rejects with a `timeout` error listing the
   * selections recorded, or at once with `exited` when the window is gone.
   */
  waitForSelection(options: WaitForSelectionOptions): Promise<EditorSelectionRecord>;
  /**
   * Prove the window is connected to the service for `sessionId`: send
   * `source.open` for line 1, column 1 of `file` from `sender` until the
   * window's cursor is there, resending every `retryIntervalMs`. Starts the
   * window first if needed.
   *
   * @throws {EditorHostError} `timeout` naming the attempts and what the window recorded.
   */
  warmUp(options: EditorWarmUpOptions): Promise<EditorWarmUpResult>;
  /** `file:line:column` of a selection, with the file relative to the workspace folder — no text. */
  describeSelection(selection: EditorSelectionRecord): string;
  /**
   * Bounded, text-free diagnostics for a failure report: state, processes,
   * probe records, selections, the window's output tail and the tails of the
   * extension's output-channel log and the extension-host log.
   */
  collectDiagnostics(): Promise<readonly string[]>;
  /**
   * Close the window (stop file, then SIGTERM, then SIGKILL), stop the `Xvfb`
   * this handle started and remove the throwaway profile. Idempotent.
   *
   * @throws {EditorHostError} `teardown` when a process survived or the directory could not be removed.
   */
  dispose(): Promise<EditorHostDisposeReport>;
}

/**
 * Create an {@link EditorHostHandle}. Nothing is resolved, spawned or written
 * until {@link EditorHostHandle.start}.
 */
export function createEditorHost(options: EditorHostOptions): EditorHostHandle {
  const workspaceFolder = path.resolve(options.workspaceFolder);
  const maxLifetimeMs = options.maxLifetimeMs ?? EDITOR_HOST_TIMEOUTS.maxLifetime;
  if (!Number.isSafeInteger(maxLifetimeMs) || maxLifetimeMs <= 0) {
    throw new EditorHostError('prerequisites', 'maxLifetimeMs must be a positive whole number.');
  }

  const output = new OutputTail();
  // Mutated from the launch, the child's callbacks and `dispose()`, so held in
  // an object that flow analysis does not narrow.
  const live: {
    state: EditorHostState;
    root: string | undefined;
    log: ProbeLog | undefined;
    stopFile: string | undefined;
    editor: ChildProcess | undefined;
    display: DisplayLease | undefined;
    spawnError: string | undefined;
    startFailure: string | undefined;
    /** The launch itself, settled without the state bookkeeping `starting` adds. */
    launching: Promise<unknown> | undefined;
    starting: Promise<EditorHostReady> | undefined;
    disposing: Promise<EditorHostDisposeReport> | undefined;
  } = {
    state: 'idle',
    root: undefined,
    log: undefined,
    stopFile: undefined,
    editor: undefined,
    display: undefined,
    spawnError: undefined,
    startFailure: undefined,
    launching: undefined,
    starting: undefined,
    disposing: undefined,
  };

  /** Relative to the workspace folder when inside it; the base name otherwise. */
  const describeFile = (file: string): string => {
    const relative = path.relative(workspaceFolder, file);
    return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
      ? relative.split(path.sep).join('/')
      : `(outside the workspace) ${path.basename(file)}`;
  };

  const describeSelection = (selection: EditorSelectionRecord): string =>
    `${describeFile(selection.file)}:${String(selection.line)}:${String(selection.column)}`;

  const abortIfDisposed = (): void => {
    if (live.state === 'disposed') {
      throw new EditorHostError('disposed', 'The editor host was disposed while it was starting.');
    }
  };

  /** Why nothing more can be observed from the window, or `undefined` while it runs. */
  const fatalReason = (): string | undefined => {
    if (live.state === 'disposed') {
      return 'the editor host was disposed';
    }
    if (live.spawnError !== undefined) {
      return `VS Code could not be started (${live.spawnError})`;
    }
    const editor = live.editor;
    if (editor !== undefined && hasExited(editor)) {
      return `the VS Code window ${describeExit(editor)}`;
    }
    return undefined;
  };

  const recordsSince = (since: number): readonly EditorProbeRecord[] =>
    live.log?.since(since) ?? [];

  const selectionsSince = (since: number): EditorSelectionRecord[] =>
    recordsSince(since).filter(
      (record): record is EditorSelectionRecord => record.kind === 'selection',
    );

  /** The recorded selections from `since`, described, the most recent {@link MAX_DESCRIBED_SELECTIONS}. */
  const describeSelectionsSince = (since: number): string => {
    const selections = selectionsSince(since);
    const shown = selections.slice(-MAX_DESCRIBED_SELECTIONS).map(describeSelection);
    const earlier = selections.length - shown.length;
    return shown.length === 0
      ? 'no selection'
      : `${earlier > 0 ? `(+${String(earlier)} earlier) ` : ''}${shown.join(', ')}`;
  };

  /**
   * Poll the probe's file until `find` answers, the window is gone, or `ms`
   * passes; `describe` is the timeout's account of what was seen.
   */
  const pollFor = async <T>(
    find: () => T | undefined,
    ms: number,
    label: string,
    describe: () => string,
  ): Promise<T> => {
    const deadline = Date.now() + ms;
    for (;;) {
      await live.log?.pull();
      const found = find();
      if (found !== undefined) {
        return found;
      }
      const fatal = fatalReason();
      if (fatal !== undefined) {
        // One last read: the window may have written its last record just before exiting.
        await live.log?.pull();
        const last = find();
        if (last !== undefined) {
          return last;
        }
        throw new EditorHostError('exited', `${label}: ${fatal}; ${describe()}.`);
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new EditorHostError(
          'timeout',
          `${label}: nothing within ${String(ms)} ms; ${describe()}.`,
        );
      }
      await delay(Math.min(PROBE_POLL_INTERVAL_MS, remaining));
    }
  };

  const launch = async (): Promise<EditorHostReady> => {
    const startedAt = Date.now();
    if (!isDirectory(workspaceFolder)) {
      throw new EditorHostError(
        'prerequisites',
        `The editor host's workspace folder ${workspaceFolder} is not a directory.`,
      );
    }
    if (!isFile(PROBE_FILE)) {
      throw new EditorHostError(
        'prerequisites',
        `The editor probe ${path.relative(repoPath(), PROBE_FILE)} is missing.`,
      );
    }
    const extension = await resolveExtensionUnderTest();
    const executable = await resolveEditorExecutable();
    abortIfDisposed();

    const root = await mkdtemp(path.join(os.tmpdir(), TEMP_DIR_PREFIX));
    live.root = root;
    abortIfDisposed();
    const userData = path.join(root, 'user-data');
    const extensionsDir = path.join(root, 'extensions');
    await mkdir(path.join(userData, 'User'), { recursive: true, mode: 0o700 });
    await mkdir(extensionsDir, { recursive: true, mode: 0o700 });
    await writeFile(
      path.join(userData, 'User', 'settings.json'),
      `${JSON.stringify(userSettings(options.serviceUrl), null, 2)}\n`,
      { mode: 0o600 },
    );
    const outputFile = path.join(root, 'probe.jsonl');
    const stopFile = path.join(root, 'probe.stop');
    live.log = new ProbeLog(outputFile);
    live.stopFile = stopFile;

    const display = await acquireDisplay(output);
    live.display = display;
    abortIfDisposed();

    const args = [
      workspaceFolder,
      `--extensionDevelopmentPath=${extension.developmentPath}`,
      `--extensionTestsPath=${PROBE_FILE}`,
      `--user-data-dir=${userData}`,
      `--extensions-dir=${extensionsDir}`,
      '--disable-extensions',
      ...DISABLED_BUILTIN_EXTENSIONS.flatMap((id) => ['--disable-extension', id]),
      '--disable-workspace-trust',
      '--skip-welcome',
      '--skip-release-notes',
      '--disable-telemetry',
      '--disable-updates',
      '--no-cached-data',
      // Headless hosts have no GPU; Chromium refuses to run as root without
      // `--no-sandbox`; containers' 64 MB `/dev/shm` kills renderers mid-run.
      '--disable-gpu',
      '--disable-gpu-sandbox',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      // No OS keyring prompt on a headless Linux desktop.
      '--password-store=basic',
    ];
    const env = editorEnvironment({
      DEBUGGEN_HOME: options.debuggenHome,
      DEBUGGEN_PROVIDER: 'deterministic',
      [PROBE_ENV.output]: outputFile,
      [PROBE_ENV.stop]: stopFile,
      [PROBE_ENV.extensionId]: extension.id,
      [PROBE_ENV.maxLifetimeMs]: String(maxLifetimeMs),
      ...(display.display === undefined ? {} : { DISPLAY: display.display }),
    });
    const editor = spawn(executable, args, {
      cwd: workspaceFolder,
      env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: USE_PROCESS_GROUPS,
      windowsHide: true,
    });
    if (USE_PROCESS_GROUPS) {
      groupLeaders.add(editor);
    }
    live.editor = editor;
    editor.once('error', (error) => {
      live.spawnError = describeError(error);
    });
    output.follow(editor.stdout, 'vscode');
    output.follow(editor.stderr, 'vscode');
    trackChild(editor);

    const log = live.log;
    const outcome = await pollFor(
      () =>
        log
          .since(0)
          .find(
            (record): record is EditorActivatedRecord | EditorActivationFailedRecord =>
              record.kind === 'activated' || record.kind === 'activation-failed',
          ),
      LAUNCH_TIMEOUT_MS,
      'Waiting for the VS Code window to activate the extension',
      () =>
        `probe records: ${
          log
            .since(0)
            .map((record) => record.kind)
            .join(', ') || '(none)'
        }; window output: ${output.tail(10).join(' | ') || '(none)'}`,
    );
    if (outcome.kind === 'activation-failed') {
      throw new EditorHostError(
        'activation',
        `The VS Code window could not activate ${extension.id} (${outcome.reason}${outcome.error === undefined ? '' : `: ${outcome.error}`}).`,
      );
    }
    const started = log.since(0).find((record) => record.kind === 'started');
    return {
      executable,
      vscodeVersion: started?.kind === 'started' ? started.vscodeVersion : 'unknown',
      display: display.display,
      ownDisplay: display.server !== undefined,
      extensionId: outcome.extensionId,
      startupMs: Date.now() - startedAt,
    };
  };

  /**
   * Release everything the launch created so far: the window (stop file, then
   * signals), the `Xvfb`, the throwaway directory. Safe to run more than once.
   */
  const release = async (): Promise<EditorHostDisposeReport> => {
    const problems: string[] = [];
    const editor = live.editor;
    let graceful = false;
    if (editor !== undefined) {
      if (!hasExited(editor) && live.stopFile !== undefined) {
        try {
          await writeFile(live.stopFile, '', { mode: 0o600 });
          graceful = await waitForExit(editor, STOP_TIMEOUT_MS);
        } catch (error) {
          problems.push(`the stop file could not be written (${describeError(error)})`);
        }
      } else {
        graceful = hasExited(editor) && editor.exitCode === 0;
      }
      const survived = await terminate(editor, 'the VS Code window');
      if (survived !== undefined) {
        problems.push(survived);
      }
    }
    const server = live.display?.server;
    if (server !== undefined) {
      const survived = await terminate(server, 'Xvfb');
      if (survived !== undefined) {
        problems.push(survived);
      }
    }
    if (live.root !== undefined) {
      try {
        await rm(live.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      } catch (error) {
        problems.push(
          `the throwaway directory ${live.root} could not be removed (${describeError(error)})`,
        );
      }
    }
    if (problems.length > 0) {
      throw new EditorHostError(
        'teardown',
        `The editor host did not stop cleanly: ${problems.join('; ')}.`,
      );
    }
    return { graceful, launched: editor !== undefined };
  };

  const handle: EditorHostHandle = {
    workspaceFolder,

    state: () => live.state,

    start(): Promise<EditorHostReady> {
      if (live.state === 'disposed') {
        return Promise.reject(new EditorHostError('disposed', 'The editor host was disposed.'));
      }
      if (live.starting === undefined) {
        live.state = 'starting';
        const launching = launch();
        live.launching = launching;
        live.starting = launching.then(
          (ready) => {
            if (live.state === 'starting') {
              live.state = 'ready';
            }
            return ready;
          },
          (error: unknown) => {
            if (live.state === 'starting') {
              live.state = 'failed';
            }
            live.startFailure = describeError(error);
            throw error;
          },
        );
      }
      return live.starting;
    },

    snapshotIndex: () => live.log?.nextIndex ?? 0,

    records: (sinceIndex = 0) => recordsSince(sinceIndex),

    async selections(sinceIndex = 0) {
      await live.log?.pull();
      return selectionsSince(sinceIndex);
    },

    async waitForSelection(waitOptions) {
      const since = waitOptions.sinceIndex ?? 0;
      const matches = waitOptions.matches ?? ((): boolean => true);
      const target = path.join(workspaceFolder, ...waitOptions.file.split('/'));
      const expected = await realpath(target).catch(() => target);
      const label = `Waiting for the VS Code window's cursor in ${waitOptions.file}${waitOptions.description === undefined ? '' : ` ${waitOptions.description}`}`;
      if (live.log === undefined) {
        throw new EditorHostError('exited', `${label}: the editor host was never started.`);
      }
      return pollFor(
        () =>
          selectionsSince(since).find(
            (selection) => selection.realpath === expected && matches(selection),
          ),
        waitOptions.timeoutMs ?? EDITOR_HOST_TIMEOUTS.selection,
        label,
        () => `the window recorded ${describeSelectionsSince(since)} since index ${String(since)}`,
      );
    },

    async warmUp(warmOptions) {
      await handle.start();
      const timeoutMs = warmOptions.timeoutMs ?? EDITOR_HOST_TIMEOUTS.warmUp;
      const retryMs = warmOptions.retryIntervalMs ?? EDITOR_HOST_TIMEOUTS.warmUpRetry;
      const location = editorWarmUpLocation(warmOptions.file);
      const began = handle.snapshotIndex();
      const startedAt = Date.now();
      const deadline = startedAt + timeoutMs;
      let attempts = 0;
      let lastSendProblem: string | undefined;
      for (;;) {
        attempts += 1;
        try {
          warmOptions.sender.sendSourceOpen(warmOptions.sessionId, location);
          lastSendProblem = undefined;
        } catch (error) {
          lastSendProblem = describeError(error);
        }
        try {
          // Scoped to the whole warm-up, not the attempt: once the cursor sits
          // at 1:1, a later identical request changes no selection.
          const selection = await handle.waitForSelection({
            file: warmOptions.file,
            sinceIndex: began,
            description: `at ${String(location.line)}:${String(location.column)} (warm-up)`,
            matches: (candidate) =>
              candidate.line === location.line && candidate.column === location.column,
            timeoutMs: Math.max(1, Math.min(retryMs, deadline - Date.now())),
          });
          return { attempts, elapsedMs: Date.now() - startedAt, selection };
        } catch (error) {
          if (!(error instanceof EditorHostError) || error.code !== 'timeout') {
            throw error;
          }
          if (Date.now() >= deadline) {
            throw new EditorHostError(
              'timeout',
              [
                `The VS Code window did not open ${warmOptions.file} at 1:1 for session ${warmOptions.sessionId} within ${String(timeoutMs)} ms (${String(attempts)} source.open attempt(s)).`,
                `It recorded ${describeSelectionsSince(began)}.`,
                lastSendProblem === undefined
                  ? ''
                  : `The last source.open could not be sent: ${lastSendProblem}.`,
                `The extension connects to ${options.serviceUrl} with the editor credential in ${options.debuggenHome}; its output-channel log is in the failure diagnostics.`,
              ]
                .filter((part) => part !== '')
                .join(' '),
              { cause: error },
            );
          }
        }
      }
    },

    describeSelection,

    async collectDiagnostics() {
      await live.log?.pull().catch(() => undefined);
      const editor = live.editor;
      const server = live.display?.server;
      const records = recordsSince(0);
      const kinds = new Map<string, number>();
      for (const record of records) {
        kinds.set(record.kind, (kinds.get(record.kind) ?? 0) + 1);
      }
      const problems = live.log?.problems() ?? { count: 0, recent: [] };
      const lines: string[] = [
        `state: ${live.state}${live.startFailure === undefined ? '' : ` (start failed: ${live.startFailure})`}`,
        `workspace folder: ${workspaceFolder}`,
        `service: ${options.serviceUrl}`,
        `window: ${editor === undefined ? 'not spawned' : `pid ${String(editor.pid)}, ${describeExit(editor)}`}${live.spawnError === undefined ? '' : `, spawn error ${live.spawnError}`}`,
        `display: ${live.display?.display ?? '(none)'}${server === undefined ? '' : ` (own Xvfb pid ${String(server.pid)}, ${describeExit(server)})`}`,
        `probe records: ${[...kinds].map(([kind, count]) => `${kind}×${String(count)}`).join(', ') || '(none)'}; dropped ${String(live.log?.dropped ?? 0)}; malformed ${String(problems.count)}${problems.recent.length > 0 ? ` (${problems.recent.slice(-3).join(' | ')})` : ''}`,
        `selections: ${describeSelectionsSince(0)}`,
        '',
        `window output (last ${String(OUTPUT_TAIL_LINES)} lines, ${String(output.dropped)} older dropped):`,
        ...output.tail(OUTPUT_TAIL_LINES),
      ];
      if (live.root !== undefined) {
        for (const file of await findLogs(
          path.join(live.root, 'user-data', 'logs'),
          DIAGNOSTIC_LOG_SUFFIXES,
        )) {
          let text: string;
          try {
            text = await readFile(file, 'utf8');
          } catch (error) {
            lines.push('', `${path.basename(file)}: could not be read (${describeError(error)})`);
            continue;
          }
          const logLines = text.split(/\r?\n/).filter((line) => line.trim() !== '');
          lines.push(
            '',
            `${path.relative(live.root, file)} (last ${String(LOG_TAIL_LINES)} of ${String(logLines.length)} lines):`,
            ...logLines
              .slice(-LOG_TAIL_LINES)
              .map((line) =>
                line.length <= OUTPUT_LINE_MAX_LENGTH
                  ? line
                  : `${line.slice(0, OUTPUT_LINE_MAX_LENGTH - 1)}…`,
              ),
          );
        }
      }
      return lines;
    },

    dispose(): Promise<EditorHostDisposeReport> {
      if (live.disposing === undefined) {
        live.state = 'disposed';
        const launching = live.launching;
        live.disposing = (async () => {
          if (launching === undefined) {
            return release();
          }
          // A launch waiting on the window notices the disposal within one poll;
          // one still resolving the editor (a download) cannot be cancelled and
          // notices it at its next step. It gets the stop budget to settle, so
          // what it created is known to the release below.
          const settled = launching.then(
            () => true,
            () => true,
          );
          const inTime = await withDeadline(
            settled,
            STOP_TIMEOUT_MS,
            'The editor host start',
          ).catch(() => false);
          if (!inTime) {
            // Whatever it creates before it stops is released once it settles.
            void settled.then(() => release()).catch(() => undefined);
          }
          return release();
        })();
      }
      return live.disposing;
    },
  };
  return handle;
}
