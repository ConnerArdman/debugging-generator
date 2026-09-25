/**
 * The editor end of click-to-source: the terminal hop of
 *
 * ```text
 * SourceLink → PanelActions.openSource → the DevTools panel's actions.ts
 *   → the Chrome service worker → WebSocket `source.open`
 *   → apps/local-service/src/source/open.ts → src/source/open-location.ts
 * ```
 *
 * (AAP 0.4.2), run inside a real VS Code under `pnpm test:vscode`. This is
 * where a `SourceLocation` — project-relative POSIX `file`, **1-based** `line`
 * and `column` (AAP 0.2.3) — becomes a document, a 0-based selection, a
 * revealed range and a 1.5 s line highlight; AAP 0.8.4 acceptance test 1 is
 * lost here if the cursor lands one line or one character off.
 *
 * The module under test has two entry points with deliberately different
 * policies, and both are exercised:
 *
 * - `openSourceLocation` is session-scoped: it re-validates the location
 *   against the session's `projectRoot` before any editor call. Every case
 *   injects a `mkdtemp` scratch directory as that root, which is what keeps the
 *   suite hermetic — the containment gate is judged against a throwaway tree,
 *   never the developer's workspace, and no workspace folder is ever added
 *   (`updateWorkspaceFolders` in a single-folder window restarts the extension
 *   host and would end the run).
 * - `revealLocationInEditor` is the policy-free primitive the URI handler
 *   builds on. It is exercised against the read-only fixture workspace and a
 *   scratch file outside it, and no containment error is ever expected from
 *   it: its only contract is the numeric one.
 *
 * Positions are never hardcoded. Every expected line and column is computed by
 * scanning the file's text for an anchor token that occurs exactly once, so a
 * fixture edit moves the expectation with it, and an off-by-one in either axis
 * of the 1-based → 0-based conversion fails with the numbers side by side.
 *
 * "Opens nothing" is asserted, not inferred from an error value: every refusal
 * snapshots the visible editors, the active editor and every tab before and
 * after the call, checks that no document under either scratch root was
 * loaded, and checks that the reveal primitive was never reached.
 *
 * This bundle carries its own module instance of `open-location` (esbuild
 * inlines it into `dist/test/suite/open-location.test.js`, separately from
 * `dist/extension.js`), so `disposeSourceRevealResources()` in `afterEach` and
 * `after` tears down exactly the decoration type, timers and listeners these
 * cases created.
 *
 * Mocha's `bdd` interface is supplied as globals by the `@vscode/test-cli`
 * runner and this workspace declares no `@types/mocha` (see the
 * `compilerOptions.types` notes in `tsconfig.json`), so the globals this suite
 * calls are declared below, in module scope, with the slice of Mocha's context
 * they use — the same convention as `packaged-vsix.test.ts`.
 *
 * @module apps/vscode-extension/test/suite/open-location
 */

import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';

import {
  DEBUGGEN_ERROR_CODES,
  DebuggenError,
  createConsoleLogger,
  isErr,
  isOk,
  parseSourceLocation,
} from '@debuggen/shared';
import type {
  DebuggenErrorCode,
  LogRecord,
  Logger,
  Result,
  SourceLocation,
} from '@debuggen/shared';
import * as vscode from 'vscode';

import {
  HIGHLIGHT_DURATION_MS,
  disposeSourceRevealResources,
  hasActiveHighlight,
  openSourceLocation,
  revealLocationInEditor,
} from '../../src/source/open-location';
import type { OpenSourceDeps, RevealOutcome } from '../../src/source/open-location';
import {
  cleanupScratch,
  closeAllEditors,
  createScratchDir,
  fixtureFile,
  fixtureWorkspaceRoot,
  makeSourceLocation,
  stopTrackedProcesses,
  waitFor,
  writeFixtureFile,
} from '../helpers';

// ---------------------------------------------------------------------------
// Mocha's bdd globals, as provided by the @vscode/test-cli runner
// ---------------------------------------------------------------------------

/** The part of Mocha's test and hook context (`this`) this suite uses. */
interface MochaRunnableContext {
  timeout(ms: number): unknown;
  slow(ms: number): unknown;
}

/** A test or hook body: synchronous, or a promise mocha awaits. */
type MochaRunnable = (this: MochaRunnableContext) => void | Promise<void>;

declare function describe(title: string, body: (this: MochaRunnableContext) => void): void;
declare function it(title: string, body: MochaRunnable): void;
declare function before(body: MochaRunnable): void;
declare function after(body: MochaRunnable): void;
declare function beforeEach(body: MochaRunnable): void;
declare function afterEach(body: MochaRunnable): void;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * The transient highlight AAP 0.7.1 Group 3 specifies: "a 1.5 s line
 * highlight". Restated here on purpose — the first test compares the product
 * constant against it, so a silent change to either is visible in review.
 */
const SPECIFIED_HIGHLIGHT_MS = 1500;

/**
 * How far past {@link HIGHLIGHT_DURATION_MS} the highlight may take to clear
 * before the expiry test fails: generous, because the extension host shares
 * its CPUs with every other build on the machine, and a late timer is not the
 * defect this case exists to catch.
 */
const HIGHLIGHT_EXPIRY_MARGIN_MS = 5_000;

/**
 * How much earlier than {@link HIGHLIGHT_DURATION_MS} a Node timer may fire
 * and still count as "on time". Node rounds timer deadlines to whole
 * milliseconds, so a timer can land a millisecond early; anything beyond this
 * tolerance means the highlight was cleared by something other than its timer.
 */
const TIMER_TOLERANCE_MS = 50;

/** Poll interval while waiting for a highlight to clear. */
const HIGHLIGHT_POLL_INTERVAL_MS = 25;

/**
 * A highlight duration no test run can outlive: a highlight created with it
 * that disappears during the test was ended by an editor event, not its timer.
 */
const EFFECTIVELY_PERMANENT_HIGHLIGHT_MS = 10 * 60_000;

/** A duration short enough to watch expire within one test. */
const SHORT_HIGHLIGHT_MS = 150;

/** The error codes this suite asserts, resolved against the product's vocabulary. */
const PATH_OUTSIDE_PROJECT = errorCode('PATH_OUTSIDE_PROJECT');
const PROTOCOL_INVALID_MESSAGE = errorCode('PROTOCOL_INVALID_MESSAGE');
const PROJECT_NOT_FOUND = errorCode('PROJECT_NOT_FOUND');

/** The fixture workspace's two revealable modules, project-relative POSIX. */
const SAMPLE_MODULE = 'src/sample-module.ts';
const DEEP_MODULE = 'src/nested/deep-module.ts';

/** Each fixture module's anchor tokens; each occurs once in its own file only. */
const SAMPLE_ANCHORS = Object.freeze([
  'SAMPLE_ANCHOR_PRIMARY',
  'sampleAnchorMarker',
  'sample-anchor-inner',
] as const);
const DEEP_ANCHORS = Object.freeze([
  'DEEP_ANCHOR_PRIMARY',
  'deepAnchorMarker',
  'deep-anchor-inner',
] as const);

/**
 * The scratch module the session-scoped cases open, as project-relative POSIX
 * below the injected project root. Multi-segment, so the join onto the root is
 * exercised rather than a bare file name.
 */
const SCRATCH_TARGET = 'src/features/reveal-target.ts';

/**
 * The anchor inside {@link SCRATCH_TARGET_SOURCE}. It sits on an indented line
 * well below the first, at a column far from the line number, so an error in
 * either axis — or the two axes swapped — lands visibly off it.
 */
const SCRATCH_ANCHOR = 'revealTargetAnchor';

/** Ordinary, import-free TypeScript carrying {@link SCRATCH_ANCHOR} once. */
const SCRATCH_TARGET_SOURCE = [
  '/** Scratch module written, then opened, by the open-location suite. */',
  '',
  'export interface Reading {',
  '  readonly label: string;',
  '  readonly value: number;',
  '}',
  '',
  'export function totalOf(readings: readonly Reading[]): number {',
  '  let total = 0;',
  '  for (const reading of readings) {',
  '    total += reading.value; // the revealTargetAnchor statement',
  '  }',
  '  return total;',
  '}',
  '',
  'export function describeReadings(readings: readonly Reading[]): string {',
  "  return readings.map((reading) => reading.label).join(', ');",
  '}',
  '',
].join('\n');

/** Line count of the long scratch file the scrolling case reveals deep inside. */
const LONG_FILE_LINES = 2_000;

/** The 1-based line of the long file's anchor: far outside any first viewport. */
const LONG_FILE_ANCHOR_LINE = 1_800;

/** The anchor token of the long scratch file. */
const LONG_FILE_ANCHOR = 'farDownAnchor';

// ---------------------------------------------------------------------------
// Suite support
// ---------------------------------------------------------------------------

/**
 * A code from `@debuggen/shared`'s `DEBUGGEN_ERROR_CODES`, or a thrown `Error`.
 *
 * The parameter type makes a misspelt code a compile error, and the lookup
 * makes a code that left the runtime tuple a load-time failure, so every
 * assertion below compares against the product's own vocabulary.
 */
function errorCode(name: DebuggenErrorCode): DebuggenErrorCode {
  const code = DEBUGGEN_ERROR_CODES.find((candidate) => candidate === name);
  if (code === undefined) {
    throw new Error(`${name} is not one of @debuggen/shared's DEBUGGEN_ERROR_CODES.`);
  }
  return code;
}

/** Where an anchor token sits in a file, in the product's 1-based convention. */
interface Anchor {
  readonly token: string;
  readonly line: number;
  readonly column: number;
}

/**
 * Finds `token` in `text` and returns its 1-based line and column.
 *
 * Throws unless the token occurs exactly once: an ambiguous anchor would let
 * a reveal that landed on the wrong occurrence pass. The column counts UTF-16
 * code units from the start of the line, which is what both JavaScript string
 * indices and `vscode.Position.character` count.
 */
function locateAnchor(text: string, token: string, source: string): Anchor {
  const index = text.indexOf(token);
  if (index === -1) {
    throw new Error(`Anchor ${JSON.stringify(token)} does not occur in ${source}.`);
  }
  if (text.includes(token, index + token.length)) {
    throw new Error(`Anchor ${JSON.stringify(token)} occurs more than once in ${source}.`);
  }
  const preceding = text.slice(0, index);
  const line = preceding.split('\n').length;
  const lineStart = preceding.lastIndexOf('\n') + 1;
  return { token, line, column: index - lineStart + 1 };
}

/** The anchor's position as VS Code's 0-based `Position`: the value under test. */
function expectedPosition(anchor: Anchor): vscode.Position {
  return new vscode.Position(anchor.line - 1, anchor.column - 1);
}

/** The text of a fixture-workspace module, read only. */
async function readFixture(relativePath: string): Promise<{ file: string; text: string }> {
  const file = fixtureFile(relativePath);
  return { file, text: await fsp.readFile(file, 'utf8') };
}

/** Every document this suite revealed, so teardown can prove no highlight outlived it. */
const touchedDocuments = new Map<string, vscode.Uri>();

/** Records the document a successful reveal produced. */
function touched(outcome: RevealOutcome): RevealOutcome {
  const uri = outcome.editor.document.uri;
  touchedDocuments.set(uri.toString(), uri);
  return outcome;
}

/**
 * The outcome of a reveal that must have succeeded, or a failure naming the
 * error code, message and hint the product returned instead.
 */
function expectOk(result: Result<RevealOutcome, DebuggenError>, what: string): RevealOutcome {
  if (isOk(result)) {
    return touched(result.value);
  }
  const { code, message, hint } = result.error;
  return assert.fail(
    `${what} failed with ${code}: ${message}${hint === undefined ? '' : ` (hint: ${hint})`}`,
  );
}

/** The `DebuggenError` of a reveal that must have failed with `code`. */
function expectErr(
  result: Result<RevealOutcome, DebuggenError>,
  code: DebuggenErrorCode,
  what: string,
): DebuggenError {
  if (!isErr(result)) {
    touched(result.value);
    return assert.fail(
      `${what} succeeded and revealed ${result.value.editor.document.uri.toString()}; expected ${code}.`,
    );
  }
  const error = result.error;
  assert.ok(DebuggenError.is(error), `${what} failed with something other than a DebuggenError.`);
  assert.equal(error.code, code, `${what}: expected ${code}, got ${error.code}: ${error.message}`);
  return error;
}

/** A logger that keeps every record, rendered as JSON at the moment it was emitted. */
interface CapturedLog {
  readonly logger: Logger;
  readonly records: LogRecord[];
  readonly rendered: string[];
}

function captureLog(): CapturedLog {
  const records: LogRecord[] = [];
  const rendered: string[] = [];
  const logger = createConsoleLogger({
    level: 'trace',
    name: 'open-location-suite',
    sink: (record) => {
      records.push(record);
      rendered.push(JSON.stringify({ message: record.message, fields: record.fields }));
    },
  });
  return { logger, records, rendered };
}

/**
 * Asserts that no captured log line and no warning discloses any of the given
 * absolute paths: the module logs and displays the project-relative
 * `file:line:column` only (AAP 0.5.2).
 */
function assertDisclosesNoPath(
  output: readonly string[],
  forbidden: readonly string[],
  what: string,
): void {
  for (const text of output) {
    for (const secret of forbidden) {
      assert.ok(
        !text.includes(secret),
        `${what} disclosed ${JSON.stringify(secret)} in ${JSON.stringify(text)}.`,
      );
    }
  }
}

/** One call the reveal spy saw, with the arguments exactly as they arrived. */
interface RevealCall {
  readonly uri: string;
  readonly line: number;
  readonly column: number;
  readonly endLine: number | undefined;
  readonly symbol: string | undefined;
}

/**
 * A reveal implementation that records its arguments and then delegates to the
 * real primitive, so a refusal that reached it would still open an editor and
 * fail the snapshot comparison as well as the call count.
 */
function spyOnReveal(): {
  readonly reveal: NonNullable<OpenSourceDeps['reveal']>;
  readonly calls: RevealCall[];
} {
  const calls: RevealCall[] = [];
  const reveal: NonNullable<OpenSourceDeps['reveal']> = (uri, line, column, options) => {
    calls.push({
      uri: uri.toString(),
      line,
      column,
      endLine: options?.endLine,
      symbol: options?.symbol,
    });
    return revealLocationInEditor(uri, line, column, options);
  };
  return { reveal, calls };
}

/** The editor state a refused location must leave exactly as it found it. */
interface EditorSnapshot {
  readonly visible: readonly string[];
  readonly active: string | undefined;
  readonly tabs: readonly string[];
}

function tabIdentity(tab: vscode.Tab): string {
  return tab.input instanceof vscode.TabInputText
    ? `text:${tab.input.uri.toString()}`
    : `other:${tab.label}`;
}

function snapshotEditors(): EditorSnapshot {
  return {
    visible: vscode.window.visibleTextEditors
      .map((editor) => editor.document.uri.toString())
      .sort(),
    active: vscode.window.activeTextEditor?.document.uri.toString(),
    tabs: vscode.window.tabGroups.all.flatMap((group) => group.tabs.map(tabIdentity)).sort(),
  };
}

/** Whether `candidate` is `root` or lies beneath it. */
function isInside(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/** File-scheme documents currently loaded in the editor from beneath any of `roots`. */
function documentsUnder(roots: readonly string[]): string[] {
  return vscode.workspace.textDocuments
    .filter((document) => document.uri.scheme === 'file')
    .map((document) => document.uri.fsPath)
    .filter((fsPath) => roots.some((root) => isInside(fsPath, root)));
}

/** Opens `file` in a non-preview editor and waits until it is the active one. */
async function openBaselineEditor(file: string): Promise<vscode.TextEditor> {
  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
  await vscode.window.showTextDocument(document, { preview: false });
  const expected = document.uri.toString();
  return waitFor(
    () =>
      vscode.window.activeTextEditor?.document.uri.toString() === expected
        ? vscode.window.activeTextEditor
        : undefined,
    { message: `the baseline editor ${path.basename(file)} to become active` },
  );
}

/** Waits until the active editor shows `file` (compared by real path) and returns it. */
async function activeEditorFor(file: string): Promise<vscode.TextEditor> {
  const expected = await fsp.realpath(file);
  const editor = await waitFor(() => vscode.window.activeTextEditor, {
    message: `an active text editor after revealing ${path.basename(file)}`,
  });
  const actual = await fsp.realpath(editor.document.uri.fsPath);
  assert.equal(actual, expected, 'the active editor shows a different file than the one revealed');
  return editor;
}

/** Waits until `line` (0-based) lies inside one of the editor's visible ranges. */
async function waitUntilLineVisible(editor: vscode.TextEditor, line: number): Promise<void> {
  await waitFor(
    () => editor.visibleRanges.some((range) => range.start.line <= line && line <= range.end.line),
    {
      message: `0-based line ${line} to scroll into the visible ranges of ${path.basename(editor.document.uri.fsPath)}`,
    },
  );
}

/**
 * Asserts the reveal put an empty selection exactly on the anchor: the active
 * position is the anchor's `line - 1` / `column - 1`, the selection starts
 * where it is active, the outcome reports the selection the editor holds, and
 * the text under the cursor is the anchor token itself.
 */
function assertCursorOnAnchor(
  outcome: RevealOutcome,
  editor: vscode.TextEditor,
  anchor: Anchor,
): void {
  const at = `${anchor.token} (1-based ${anchor.line}:${anchor.column})`;
  const { active } = editor.selection;
  assert.equal(active.line, anchor.line - 1, `cursor line for ${at}`);
  assert.equal(active.character, anchor.column - 1, `cursor character for ${at}`);
  assert.ok(editor.selection.isEmpty, `the selection for ${at} must be empty`);
  assert.ok(
    editor.selection.start.isEqual(active),
    `the selection for ${at} must start at the cursor`,
  );
  assert.ok(outcome.selection.isEqual(editor.selection), `RevealOutcome.selection for ${at}`);
  assert.equal(outcome.clamped, false, `a position inside the file (${at}) is not clamped`);
  const start = expectedPosition(anchor);
  const underCursor = editor.document.getText(
    new vscode.Range(start, start.translate(0, anchor.token.length)),
  );
  assert.equal(underCursor, anchor.token, `the text under the cursor for ${at}`);
}

/** A warning sink standing in for `vscode.window.showWarningMessage`: no toast, every message kept. */
function collectWarnings(): {
  readonly showWarning: (message: string) => void;
  readonly warnings: string[];
} {
  const warnings: string[] = [];
  return { showWarning: (message) => warnings.push(message), warnings };
}

/** `fields` of the first captured record at `level` with `message`, or a failure listing what was logged. */
function loggedFields(
  log: CapturedLog,
  level: LogRecord['level'],
  message: string,
): Readonly<Record<string, unknown>> {
  const record = log.records.find(
    (candidate) => candidate.level === level && candidate.message === message,
  );
  if (record === undefined) {
    return assert.fail(
      `expected a ${level} record ${JSON.stringify(message)}; logged: ${JSON.stringify(log.rendered)}`,
    );
  }
  return record.fields ?? {};
}

/** The scratch module the long-file case reveals deep inside, as project-relative POSIX. */
const LONG_FILE = 'src/generated/long-module.ts';

/** A module in the second scratch directory that hostile locations aim at. */
const FOREIGN_TARGET = 'src/foreign-module.ts';

/** A real file in the fixture workspace kept open while refusals run, so "unchanged" compares non-empty state. */
const BASELINE_MODULE = SAMPLE_MODULE;

/** Ordinary TypeScript, {@link LONG_FILE_LINES} lines, with {@link LONG_FILE_ANCHOR} once on {@link LONG_FILE_ANCHOR_LINE}. */
function longFileSource(): string {
  const lines: string[] = [];
  for (let line = 1; line <= LONG_FILE_LINES; line += 1) {
    lines.push(
      line === LONG_FILE_ANCHOR_LINE
        ? `    export const ${LONG_FILE_ANCHOR} = ${line};`
        : `export const filler${line} = ${line};`,
    );
  }
  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------------------
// The suite
// ---------------------------------------------------------------------------

describe('open-location: the editor end of click-to-source', function () {
  this.timeout(60_000);
  this.slow(5_000);

  /** The injected project root of every session-scoped case: a fresh `mkdtemp` directory. */
  let projectRoot = '';
  /** A second scratch directory, sibling of the first, that hostile locations try to reach. */
  let foreignRoot = '';
  let targetFile = '';
  let targetAnchor: Anchor;
  let longFile = '';
  let longAnchor: Anchor;
  let foreignFile = '';

  /** Session-scoped reveal of the scratch target, with warnings collected rather than shown. */
  function targetLocation(overrides: Partial<SourceLocation> = {}): SourceLocation {
    return makeSourceLocation({
      file: SCRATCH_TARGET,
      line: targetAnchor.line,
      column: targetAnchor.column,
      ...overrides,
    });
  }

  before(async function () {
    await closeAllEditors();

    projectRoot = createScratchDir();
    foreignRoot = createScratchDir();
    assert.notEqual(projectRoot, foreignRoot, 'the two scratch roots must be distinct directories');
    assert.equal(
      path.dirname(projectRoot),
      path.dirname(foreignRoot),
      'the scratch roots must be siblings, so a ../ path from one names the other',
    );
    for (const root of [projectRoot, foreignRoot]) {
      assert.ok(path.isAbsolute(root), `scratch root ${root} must be absolute`);
      assert.equal(
        await fsp.realpath(root),
        root,
        `scratch root ${root} must already be a real path`,
      );
      assert.ok(
        !isInside(root, fixtureWorkspaceRoot()),
        'scratch roots live outside the fixture workspace',
      );
    }

    targetFile = writeFixtureFile(projectRoot, SCRATCH_TARGET, SCRATCH_TARGET_SOURCE);
    targetAnchor = locateAnchor(SCRATCH_TARGET_SOURCE, SCRATCH_ANCHOR, SCRATCH_TARGET);
    assert.equal(targetFile, path.join(projectRoot, ...SCRATCH_TARGET.split('/')));

    const longSource = longFileSource();
    longFile = writeFixtureFile(projectRoot, LONG_FILE, longSource);
    longAnchor = locateAnchor(longSource, LONG_FILE_ANCHOR, LONG_FILE);
    // The scanner is checked against a file whose anchor position is known by
    // construction, so every other expectation it computes can be trusted.
    assert.equal(
      longAnchor.line,
      LONG_FILE_ANCHOR_LINE,
      'anchor scan: line of the constructed long file',
    );
    assert.equal(
      longAnchor.column,
      '    export const '.length + 1,
      'anchor scan: column of the constructed long file',
    );

    foreignFile = writeFixtureFile(foreignRoot, FOREIGN_TARGET, 'export const foreignValue = 1;\n');
  });

  afterEach(async function () {
    disposeSourceRevealResources();
    await closeAllEditors();
    for (const [key, uri] of touchedDocuments) {
      assert.equal(hasActiveHighlight(uri), false, `a highlight outlived teardown in ${key}`);
    }
  });

  after(async function () {
    disposeSourceRevealResources();
    await closeAllEditors();
    await cleanupScratch();
    await stopTrackedProcesses();
    for (const root of [projectRoot, foreignRoot]) {
      await assert.rejects(
        fsp.access(root),
        `scratch root ${root} must be removed by cleanupScratch()`,
      );
    }
    touchedDocuments.clear();
  });

  it('keeps the transient highlight at the specified 1.5 s', function () {
    assert.equal(HIGHLIGHT_DURATION_MS, SPECIFIED_HIGHLIGHT_MS);
  });

  describe('openSourceLocation, inside the injected project root', function () {
    it('opens a project-relative location with the cursor at line - 1 / column - 1 and highlights it', async function () {
      const log = captureLog();
      const spy = spyOnReveal();
      const { showWarning, warnings } = collectWarnings();
      const location = targetLocation({ symbol: 'totalOf' });

      const result = await openSourceLocation(
        location,
        { projectRoot },
        { logger: log.logger, reveal: spy.reveal, showWarning },
      );

      const outcome = expectOk(result, 'openSourceLocation of the scratch target');
      const editor = await activeEditorFor(targetFile);
      assert.equal(outcome.editor.document.uri.toString(), editor.document.uri.toString());
      assertCursorOnAnchor(outcome, editor, targetAnchor);
      assert.equal(
        hasActiveHighlight(editor.document),
        true,
        'the location is highlighted immediately',
      );
      assert.equal(
        hasActiveHighlight(editor.document.uri),
        true,
        'hasActiveHighlight accepts the uri too',
      );

      // The primitive received the 1-based position unchanged and the file
      // joined onto the injected root; the conversion happens only inside it.
      assert.deepEqual(spy.calls, [
        {
          uri: vscode.Uri.file(targetFile).toString(),
          line: targetAnchor.line,
          column: targetAnchor.column,
          endLine: undefined,
          symbol: 'totalOf',
        },
      ]);

      assert.deepEqual(warnings, [], 'a successful open raises no warning');
      const fields = loggedFields(log, 'info', 'Opened a source location');
      assert.equal(fields['file'], SCRATCH_TARGET);
      assert.equal(fields['line'], targetAnchor.line);
      assert.equal(fields['column'], targetAnchor.column);
      assert.equal(fields['resolvedBy'], location.resolvedBy);
      assert.equal(fields['clamped'], false);
      assertDisclosesNoPath(log.rendered, [projectRoot, foreignRoot], 'the success log');
    });

    it('clears the session highlight once HIGHLIGHT_DURATION_MS has elapsed, and not before', async function () {
      this.timeout(HIGHLIGHT_DURATION_MS + HIGHLIGHT_EXPIRY_MARGIN_MS + 30_000);
      this.slow(HIGHLIGHT_DURATION_MS + 2_000);
      const { showWarning, warnings } = collectWarnings();

      const result = await openSourceLocation(targetLocation(), { projectRoot }, { showWarning });
      // Measured from the moment the reveal returned, not from before the call:
      // the highlight's timer is armed inside the call, just before it returns,
      // so the time from here to the highlight clearing can never exceed the
      // timer's real delay. A slow `showTextDocument` therefore cannot make an
      // early-firing timer look punctual.
      const revealedAt = performance.now();
      const outcome = expectOk(result, 'openSourceLocation before the highlight expiry');
      const uri = outcome.editor.document.uri;
      assert.equal(hasActiveHighlight(uri), true, 'the highlight is active right after the reveal');

      await waitFor(() => !hasActiveHighlight(uri), {
        timeoutMs: HIGHLIGHT_DURATION_MS + HIGHLIGHT_EXPIRY_MARGIN_MS,
        intervalMs: HIGHLIGHT_POLL_INTERVAL_MS,
        message: `the highlight to clear within ${HIGHLIGHT_DURATION_MS} ms + ${HIGHLIGHT_EXPIRY_MARGIN_MS} ms`,
      });
      const elapsed = performance.now() - revealedAt;
      assert.ok(
        elapsed >= HIGHLIGHT_DURATION_MS - TIMER_TOLERANCE_MS,
        `the highlight cleared ${elapsed.toFixed(0)} ms after the reveal, before its ${HIGHLIGHT_DURATION_MS} ms duration`,
      );

      // Only the highlight went: the editor and its cursor stayed.
      const editor = await activeEditorFor(targetFile);
      assertCursorOnAnchor(outcome, editor, targetAnchor);
      assert.deepEqual(warnings, []);
    });

    it('selects from the location through the end of endLine, keeping the cursor on the location', async function () {
      const { showWarning } = collectWarnings();
      const endLine = targetAnchor.line + 2;

      const outcome = expectOk(
        await openSourceLocation(targetLocation({ endLine }), { projectRoot }, { showWarning }),
        'openSourceLocation with an endLine',
      );
      const editor = await activeEditorFor(targetFile);
      const expectedEnd = editor.document.lineAt(endLine - 1).range.end;

      assert.ok(
        editor.selection.active.isEqual(expectedPosition(targetAnchor)),
        'the cursor stays on the location',
      );
      assert.ok(
        editor.selection.anchor.isEqual(expectedEnd),
        `the selection is anchored at the end of line ${endLine}`,
      );
      assert.ok(!editor.selection.isEmpty, 'the symbol range is selected');
      assert.ok(outcome.selection.isEqual(editor.selection));
      assert.equal(outcome.clamped, false);
      assert.equal(hasActiveHighlight(editor.document), true);

      const single = expectOk(
        await openSourceLocation(
          targetLocation({ endLine: targetAnchor.line }),
          { projectRoot },
          { showWarning },
        ),
        'openSourceLocation with endLine equal to line',
      );
      assertCursorOnAnchor(single, await activeEditorFor(targetFile), targetAnchor);
    });

    it('scrolls a location far below the first viewport into view', async function () {
      const { showWarning } = collectWarnings();
      const outcome = expectOk(
        await openSourceLocation(
          makeSourceLocation({ file: LONG_FILE, line: longAnchor.line, column: longAnchor.column }),
          { projectRoot },
          { showWarning },
        ),
        'openSourceLocation deep inside the long file',
      );
      const editor = await activeEditorFor(longFile);
      assertCursorOnAnchor(outcome, editor, longAnchor);
      await waitUntilLineVisible(editor, longAnchor.line - 1);
      assert.ok(
        !editor.visibleRanges.some((range) => range.start.line === 0),
        `line 1 is still in view after revealing line ${longAnchor.line}: the editor did not scroll`,
      );
    });
  });

  describe('revealLocationInEditor, the policy-free primitive', function () {
    it('reveals every anchor of the fixture workspace sample module', async function () {
      const sample = await readFixture(SAMPLE_MODULE);
      const deep = await readFixture(DEEP_MODULE);
      assert.ok(
        isInside(sample.file, fixtureWorkspaceRoot()),
        'the sample module is a workspace file',
      );

      for (const token of SAMPLE_ANCHORS) {
        assert.ok(!deep.text.includes(token), `${token} must not occur in ${DEEP_MODULE}`);
        const anchor = locateAnchor(sample.text, token, SAMPLE_MODULE);
        const outcome = expectOk(
          await revealLocationInEditor(vscode.Uri.file(sample.file), anchor.line, anchor.column),
          `revealLocationInEditor at ${token}`,
        );
        const editor = await activeEditorFor(sample.file);
        assertCursorOnAnchor(outcome, editor, anchor);
        assert.equal(hasActiveHighlight(editor.document), true, `${token} is highlighted`);
        await waitUntilLineVisible(editor, anchor.line - 1);
      }
    });

    it('reveals every anchor of the deep, multi-segment module and scrolls to each', async function () {
      const deep = await readFixture(DEEP_MODULE);
      const sample = await readFixture(SAMPLE_MODULE);
      assert.ok(isInside(deep.file, fixtureWorkspaceRoot()), 'the deep module is a workspace file');
      assert.ok(DEEP_MODULE.split('/').length > 2, 'the deep module path has several segments');

      // Last anchor first, so the reveals move up and down the file rather
      // than only ever further down it.
      for (const token of [...DEEP_ANCHORS].reverse()) {
        assert.ok(!sample.text.includes(token), `${token} must not occur in ${SAMPLE_MODULE}`);
        const anchor = locateAnchor(deep.text, token, DEEP_MODULE);
        const outcome = expectOk(
          await revealLocationInEditor(vscode.Uri.file(deep.file), anchor.line, anchor.column),
          `revealLocationInEditor at ${token}`,
        );
        const editor = await activeEditorFor(deep.file);
        assertCursorOnAnchor(outcome, editor, anchor);
        await waitUntilLineVisible(editor, anchor.line - 1);
      }
    });

    it('applies no containment policy of its own: it opens a file outside every workspace folder', async function () {
      const text = await fsp.readFile(foreignFile, 'utf8');
      const anchor = locateAnchor(text, 'foreignValue', FOREIGN_TARGET);
      assert.ok(!isInside(foreignFile, fixtureWorkspaceRoot()));
      assert.ok(!isInside(foreignFile, projectRoot));

      const outcome = expectOk(
        await revealLocationInEditor(vscode.Uri.file(foreignFile), anchor.line, anchor.column),
        'revealLocationInEditor outside the workspace',
      );
      assertCursorOnAnchor(outcome, await activeEditorFor(foreignFile), anchor);
    });

    it('clamps a position past the end of the file or line and reports it', async function () {
      const uri = vscode.Uri.file(targetFile);
      const document = await vscode.workspace.openTextDocument(uri);

      const pastEnd = expectOk(
        await revealLocationInEditor(uri, document.lineCount + 25, 7),
        'revealLocationInEditor past the last line',
      );
      const editor = await activeEditorFor(targetFile);
      const lastLine = document.lineAt(document.lineCount - 1);
      assert.equal(pastEnd.clamped, true, 'a line past the end is reported as clamped');
      assert.ok(
        editor.selection.active.isEqual(lastLine.range.end),
        'the cursor lands at the end of the document',
      );
      assert.ok(editor.selection.isEmpty);

      const pastLineEnd = expectOk(
        await revealLocationInEditor(uri, targetAnchor.line, 400),
        'revealLocationInEditor past the end of a line',
      );
      const anchorLine = document.lineAt(targetAnchor.line - 1);
      assert.equal(
        pastLineEnd.clamped,
        true,
        'a column past the end of the line is reported as clamped',
      );
      assert.equal(editor.selection.active.line, targetAnchor.line - 1, 'the line is kept');
      assert.equal(
        editor.selection.active.character,
        anchorLine.text.length,
        'the column is clamped to the line end',
      );
    });

    it('rejects a non-positive, fractional or non-finite line or column without opening anything', async function () {
      await openBaselineEditor(fixtureFile(BASELINE_MODULE));
      const uri = vscode.Uri.file(targetFile);
      const cases: readonly { line: number; column: number; invalid: readonly string[] }[] = [
        { line: 0, column: 1, invalid: ['line'] },
        { line: 1, column: 0, invalid: ['column'] },
        { line: -3, column: -1, invalid: ['line', 'column'] },
        { line: 1.5, column: 1, invalid: ['line'] },
        { line: Number.NaN, column: 1, invalid: ['line'] },
        { line: 1, column: Number.POSITIVE_INFINITY, invalid: ['column'] },
      ];

      for (const { line, column, invalid } of cases) {
        const what = `revealLocationInEditor(${line}, ${column})`;
        const before = snapshotEditors();
        const error = expectErr(
          await revealLocationInEditor(uri, line, column),
          PROTOCOL_INVALID_MESSAGE,
          what,
        );
        assert.deepEqual(error.details?.['invalid'], invalid, `${what}: the offending fields`);
        assert.deepEqual(snapshotEditors(), before, `${what} changed the open editors`);
      }
    });

    it('reports a file that cannot be opened as PROJECT_NOT_FOUND without opening anything', async function () {
      await openBaselineEditor(fixtureFile(BASELINE_MODULE));
      const missing = path.join(projectRoot, 'src', 'missing-module.ts');
      await assert.rejects(fsp.access(missing), 'the missing module must not exist');

      const before = snapshotEditors();
      expectErr(
        await revealLocationInEditor(vscode.Uri.file(missing), 1, 1),
        PROJECT_NOT_FOUND,
        'a missing file',
      );
      assert.deepEqual(snapshotEditors(), before, 'a missing file changed the open editors');
    });
  });

  describe('the transient highlight', function () {
    it('expires on the timer highlightDurationMs sets, not the default', async function () {
      const uri = vscode.Uri.file(targetFile);
      const result = await revealLocationInEditor(uri, targetAnchor.line, targetAnchor.column, {
        highlightDurationMs: SHORT_HIGHLIGHT_MS,
      });
      // From the return, for the reason given in the session expiry case.
      const revealedAt = performance.now();
      expectOk(result, 'a short highlight');
      assert.equal(hasActiveHighlight(uri), true);
      await waitFor(() => !hasActiveHighlight(uri), {
        timeoutMs: HIGHLIGHT_DURATION_MS,
        intervalMs: HIGHLIGHT_POLL_INTERVAL_MS,
        message: `a ${SHORT_HIGHLIGHT_MS} ms highlight to clear before the ${HIGHLIGHT_DURATION_MS} ms default would`,
      });
      const elapsed = performance.now() - revealedAt;
      assert.ok(
        elapsed >= SHORT_HIGHLIGHT_MS - TIMER_TOLERANCE_MS,
        `a ${SHORT_HIGHLIGHT_MS} ms highlight cleared ${elapsed.toFixed(0)} ms after the reveal`,
      );
    });

    it('reveals without any highlight when highlightDurationMs is 0', async function () {
      const uri = vscode.Uri.file(targetFile);
      const outcome = expectOk(
        await revealLocationInEditor(uri, targetAnchor.line, targetAnchor.column, {
          highlightDurationMs: 0,
        }),
        'a reveal with no highlight',
      );
      assertCursorOnAnchor(outcome, await activeEditorFor(targetFile), targetAnchor);
      assert.equal(hasActiveHighlight(uri), false);
    });

    it('replaces a document highlight when the same document is revealed again', async function () {
      const uri = vscode.Uri.file(targetFile);
      expectOk(
        await revealLocationInEditor(uri, targetAnchor.line, targetAnchor.column, {
          highlightDurationMs: EFFECTIVELY_PERMANENT_HIGHLIGHT_MS,
        }),
        'the first, long-lived highlight',
      );
      expectOk(
        await revealLocationInEditor(uri, 1, 1, { highlightDurationMs: SHORT_HIGHLIGHT_MS }),
        'the replacing, short highlight',
      );
      // Only the short highlight's timer can end it now: had the first survived,
      // this document would stay highlighted for the whole run.
      await waitFor(() => !hasActiveHighlight(uri), {
        timeoutMs: HIGHLIGHT_DURATION_MS + HIGHLIGHT_EXPIRY_MARGIN_MS,
        intervalMs: HIGHLIGHT_POLL_INTERVAL_MS,
        message: 'the replacing highlight to clear on its own timer',
      });
    });

    it('ends the highlight of a document whose editor is hidden or closed', async function () {
      const target = vscode.Uri.file(targetFile);
      const sample = await readFixture(SAMPLE_MODULE);
      const permanent = { highlightDurationMs: EFFECTIVELY_PERMANENT_HIGHLIGHT_MS };

      expectOk(
        await revealLocationInEditor(target, targetAnchor.line, targetAnchor.column, permanent),
        'first',
      );
      assert.equal(hasActiveHighlight(target), true);

      // A second document in the same column hides the first editor.
      const anchor = locateAnchor(sample.text, SAMPLE_ANCHORS[0], SAMPLE_MODULE);
      const second = vscode.Uri.file(sample.file);
      expectOk(
        await revealLocationInEditor(second, anchor.line, anchor.column, permanent),
        'second',
      );
      await waitFor(() => !hasActiveHighlight(target), {
        message: 'the hidden editor to lose its highlight',
      });
      assert.equal(hasActiveHighlight(second), true, 'the visible document keeps its highlight');

      await closeAllEditors();
      await waitFor(() => !hasActiveHighlight(second), {
        message: 'the closed editor to lose its highlight',
      });
    });

    it('disposeSourceRevealResources ends every pending highlight, and the module keeps working afterwards', async function () {
      const uri = vscode.Uri.file(targetFile);
      const permanent = { highlightDurationMs: EFFECTIVELY_PERMANENT_HIGHLIGHT_MS };
      expectOk(
        await revealLocationInEditor(uri, targetAnchor.line, targetAnchor.column, permanent),
        'before dispose',
      );
      assert.equal(hasActiveHighlight(uri), true);

      disposeSourceRevealResources();
      assert.equal(hasActiveHighlight(uri), false, 'dispose ends the highlight synchronously');
      disposeSourceRevealResources();

      const outcome = expectOk(
        await revealLocationInEditor(uri, targetAnchor.line, targetAnchor.column, permanent),
        'after dispose',
      );
      assertCursorOnAnchor(outcome, await activeEditorFor(targetFile), targetAnchor);
      assert.equal(hasActiveHighlight(uri), true, 'the resources are recreated on the next reveal');
    });
  });

  describe('openSourceLocation refusals open nothing', function () {
    beforeEach(async function () {
      await openBaselineEditor(fixtureFile(BASELINE_MODULE));
    });

    /**
     * Calls `openSourceLocation` and asserts the refusal: the expected code,
     * one warning, a warn record, no call into the reveal primitive, no change
     * to the visible editors, the active editor or any tab, no document loaded
     * from either scratch root, and no absolute path disclosed.
     *
     * Every guarantee is evaluated even when an earlier one has already failed,
     * and all violations are reported together. The error value and the
     * "opened nothing" evidence are independent verdicts, and a refusal that
     * regressed must show which of them broke, not only the first.
     */
    async function assertRefusedWithoutOpening(
      location: SourceLocation,
      root: string,
      code: DebuggenErrorCode,
      what: string,
    ): Promise<DebuggenError> {
      const roots = [projectRoot, foreignRoot];
      const before = snapshotEditors();
      const documentsBefore = documentsUnder(roots);
      assert.ok(before.active !== undefined, 'the baseline editor must be active before a refusal');

      const log = captureLog();
      const spy = spyOnReveal();
      const { showWarning, warnings } = collectWarnings();
      const result = await openSourceLocation(
        location,
        { projectRoot: root },
        { logger: log.logger, reveal: spy.reveal, showWarning },
      );

      const violations: string[] = [];
      function check(guarantee: string, assertion: () => void): void {
        try {
          assertion();
        } catch (failure) {
          const detail = failure instanceof Error ? failure.message : String(failure);
          violations.push(`${guarantee}: ${detail}`);
        }
      }

      let error: DebuggenError | undefined;
      check('the error value', () => {
        error = expectErr(result, code, what);
      });
      check('the reveal primitive is never reached', () => {
        assert.deepEqual(spy.calls, [], `${what} reached the reveal primitive`);
      });
      check('the editors are unchanged', () => {
        assert.deepEqual(snapshotEditors(), before, `${what} changed the open editors`);
      });
      check('no document is loaded from a scratch root', () => {
        assert.deepEqual(documentsUnder(roots), documentsBefore, `${what} loaded a document`);
      });
      check('exactly one warning', () => {
        assert.equal(warnings.length, 1, `${what} warned ${warnings.length} times`);
      });
      check('a warn record', () => {
        assert.ok(
          log.records.some((record) => record.level === 'warn'),
          `${what} logged no warning; logged: ${JSON.stringify(log.rendered)}`,
        );
      });
      check('no absolute path disclosed', () => {
        assertDisclosesNoPath(
          [...warnings, ...log.rendered],
          [projectRoot, foreignRoot, foreignFile],
          what,
        );
      });

      if (violations.length > 0 || error === undefined) {
        return assert.fail(
          `${what} broke ${violations.length} refusal guarantee(s):\n  - ${violations.join('\n  - ')}`,
        );
      }
      return error;
    }

    /** Asserts that the schema layer rejected the location, naming `field`. */
    function assertSchemaIssue(error: DebuggenError, field: string, what: string): void {
      const issues = error.details?.['issues'];
      assert.ok(Array.isArray(issues), `${what}: the schema error lists its issues`);
      assert.ok(
        issues.some(
          (issue: unknown) =>
            typeof issue === 'object' &&
            issue !== null &&
            (issue as { path?: unknown }).path === field,
        ),
        `${what}: expected an issue at ${field}, got ${JSON.stringify(issues)}`,
      );
    }

    it('refuses a ../ traversal escaping the injected project root', async function () {
      const file = 'src/../../outside-module.ts';
      assert.ok(
        !isInside(path.resolve(projectRoot, file), projectRoot),
        'the path must escape the root',
      );
      assert.ok(isErr(parseSourceLocation(makeSourceLocation({ file, line: 1, column: 1 }))));

      const error = await assertRefusedWithoutOpening(
        makeSourceLocation({ file, line: 1, column: 1 }),
        projectRoot,
        PROTOCOL_INVALID_MESSAGE,
        'a ../ traversal',
      );
      assertSchemaIssue(error, 'file', 'a ../ traversal');
    });

    it('refuses an absolute path, even to a real file', async function () {
      assert.ok(path.isAbsolute(foreignFile));
      const error = await assertRefusedWithoutOpening(
        makeSourceLocation({ file: foreignFile, line: 1, column: 1 }),
        projectRoot,
        PROTOCOL_INVALID_MESSAGE,
        'an absolute path',
      );
      assertSchemaIssue(error, 'file', 'an absolute path');
    });

    it('refuses a path that resolves inside a second scratch directory', async function () {
      const posix = `../${path.basename(foreignRoot)}/${FOREIGN_TARGET}`;
      const windows = posix.split('/').join('\\');
      assert.equal(
        path.resolve(projectRoot, posix),
        foreignFile,
        'the hostile path names the real foreign file',
      );

      for (const file of [posix, windows]) {
        const what = `a path into the second scratch directory (${file.includes('\\') ? 'backslashes' : 'slashes'})`;
        const error = await assertRefusedWithoutOpening(
          makeSourceLocation({ file, line: 1, column: 1 }),
          projectRoot,
          PROTOCOL_INVALID_MESSAGE,
          what,
        );
        assertSchemaIssue(error, 'file', what);
      }
    });

    it('refuses a line or column that is not 1-based', async function () {
      for (const [field, overrides] of [
        ['line', { line: 0 }],
        ['column', { column: 0 }],
      ] as const) {
        const what = `a 0 ${field}`;
        const error = await assertRefusedWithoutOpening(
          targetLocation(overrides),
          projectRoot,
          PROTOCOL_INVALID_MESSAGE,
          what,
        );
        assertSchemaIssue(error, field, what);
      }
    });

    it('reaches the containment gate for a schema-valid file under a project root that is not absolute', async function () {
      const relativeRoot = projectRoot.replace(/^\/+/, '');
      assert.ok(!path.isAbsolute(relativeRoot));
      assert.equal(
        path.resolve('/', relativeRoot),
        projectRoot,
        'the relative root names the real project root',
      );
      const location = targetLocation();
      assert.ok(isOk(parseSourceLocation(location)), 'the location itself is schema-valid');

      const error = await assertRefusedWithoutOpening(
        location,
        relativeRoot,
        PATH_OUTSIDE_PROJECT,
        'a relative root',
      );
      assert.ok(
        error.message.includes(`${SCRATCH_TARGET}:${targetAnchor.line}:${targetAnchor.column}`),
        `the refusal names the location: ${error.message}`,
      );
      assert.ok(
        !error.message.includes(relativeRoot),
        'the refusal message does not disclose the root',
      );
      const cause = error.cause;
      assert.ok(DebuggenError.is(cause), 'the containment gate verdict travels as the cause');
      assert.equal(cause.code, PATH_OUTSIDE_PROJECT);
      assert.equal(cause.details?.['reason'], 'project-root-not-absolute');
    });

    it('reaches the containment gate for a schema-valid file under a network-share project root', async function () {
      const uncRoot = `/${projectRoot}`;
      const location = targetLocation();
      assert.ok(isOk(parseSourceLocation(location)), 'the location itself is schema-valid');

      const error = await assertRefusedWithoutOpening(
        location,
        uncRoot,
        PATH_OUTSIDE_PROJECT,
        'a network-share root',
      );
      const cause = error.cause;
      assert.ok(DebuggenError.is(cause), 'the containment gate verdict travels as the cause');
      assert.equal(cause.code, PATH_OUTSIDE_PROJECT);
      assert.equal(cause.details?.['reason'], 'network-share-path');
    });

    it('refuses every location when the session has no project root', async function () {
      const error = await assertRefusedWithoutOpening(
        targetLocation(),
        '   ',
        PATH_OUTSIDE_PROJECT,
        'a blank root',
      );
      assert.equal(error.cause, undefined, 'a blank root is refused before the containment gate');
    });
  });
});
