/**
 * The extension-host regression gate on `src/uri-handler.ts`: the
 * `vscode://debuggen.debug-generator/open?file&line&col` fallback of the
 * click-to-source path (AAP 0.2.3, 0.4.2), exercised inside a real VS Code
 * under `pnpm test:vscode` (`xvfb-run -a` in CI).
 *
 * WHY THIS SUITE EXISTS. Any web page can navigate to a `vscode://` URI, so
 * every component of the link is attacker-controlled. AAP 0.2.3 therefore
 * gives the handler validation of its own, independent of the service: it
 * rejects malformed parameters and out-of-range line/column values, resolves
 * the file with `fs.realpath`, requires the result to stay inside an open
 * workspace folder's realpath (an escaping symlink is refused), and asks the
 * developer to confirm "Open ‹file›:‹line›?" before opening. The mandated
 * assertion is that a URI naming a file outside the workspace, or a path
 * traversal, OPENS NOTHING.
 *
 * HOW "OPENS NOTHING" IS OBSERVED. Every hostile link is handed to a handler
 * built by `createOpenSourceUriHandler` whose collaborators are substituted
 * through its `deps` seam, so no second real registration is ever needed:
 *   - the reveal port records each call and then delegates to the real
 *     `revealLocationInEditor`, and the confirmation port answers YES. A link
 *     that slipped past any gate would therefore reach the editor and be
 *     counted, which is what makes "zero reveals" a meaningful observation;
 *   - the refusal reason is read from the handler's own log line, through a
 *     recording logger, and the notification sink is a spy;
 *   - `vscode.window.visibleTextEditors` is snapshotted around every hostile
 *     call and must be unchanged — an observation independent of the spies.
 * Each hostile `it` asserts the specific `UriRejectionReason` and the
 * `DebuggenError` code both on the pure function's `Err` and on the handler,
 * zero confirmations, zero reveals, exactly one notification that echoes none
 * of the hostile input, and unchanged visible editors.
 *
 * WHY THE POSITIVE CASES MATTER. A handler that opened nothing at all would
 * pass every negative case, so the suite also proves the handler opens: a
 * well-formed link inside the open fixture workspace, confirmed, reaches the
 * editor exactly once at its canonical path, line and column; the same link,
 * declined, reaches it zero times after exactly one question naming that file
 * and line; and the production dialog asks exactly "Open ‹file›:‹line›?".
 *
 * THE PRODUCER'S SIDE OF THE CONTRACT. The link a DevTools panel opens when no
 * editor is connected is built by `buildEditorOpenUri` of `@debuggen/protocol`
 * from its `EDITOR_OPEN_URI` table, encoding every value twice. The suite
 * proves the handler reads that table's path and parameter names, and that a
 * built link parsed by the real `vscode.Uri.parse` — the one decode this
 * editor applies before the handler's own query parser — gives back the exact
 * file, line and column for names carrying `+`, `&`, `=`, `%`, `#`, `?`, a
 * space and non-ASCII text, and opens such a file once when confirmed.
 *
 * WORKSPACE CONTAINMENT is driven through `resolveWithinWorkspace(request,
 * folders)` and the handler's injectable `workspaceFolders`, with a scratch
 * directory under `os.tmpdir()` standing in as the open folder and symlinks
 * planted there by `test/helpers.ts`. The window's real folders are never
 * mutated (`vscode.workspace.updateWorkspaceFolders` would restart the
 * extension host mid-run), and nothing is written into the repository or into
 * the fixture workspace, which this suite only reads.
 *
 * THE PLATFORM CONSTRAINT. VS Code allows one URI handler per extension, and
 * the activated extension owns it. The last case activates the extension and
 * proves that a second registration through `registerDebuggenUriHandler` is
 * refused, disposing anything it returned in a `finally`.
 *
 * HERMETICITY. No network, no child process, no provider credential (the run
 * is configured by `.vscode-test.mjs`). The single `vscode` API substitution —
 * `window.showWarningMessage`, to answer the production dialog — is restored in
 * a `finally`. `after` closes every editor, releases the reveal primitive's
 * decorations, removes every scratch directory and proves it is gone.
 *
 * Mocha's `bdd` interface is supplied as globals by the `@vscode/test-cli`
 * runner and this workspace declares no `@types/mocha` (see the
 * `compilerOptions.types` notes in `tsconfig.json`), so the globals this suite
 * calls are declared below in module scope, as `packaged-vsix.test.ts` does.
 *
 * @module apps/vscode-extension/test/suite/uri-handler
 */

import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';

import { EDITOR_OPEN_URI, buildEditorOpenUri } from '@debuggen/protocol';
import { DEBUGGEN_ERROR_CODES, DebuggenError, createConsoleLogger } from '@debuggen/shared';
import type { DebuggenErrorCode, LogRecord, Result, SourceLocation } from '@debuggen/shared';
import * as vscode from 'vscode';

import {
  disposeSourceRevealResources,
  revealLocationInEditor,
} from '../../src/source/open-location';
import type { RevealOutcome } from '../../src/source/open-location';
import {
  MAX_URI_COLUMN,
  MAX_URI_LINE,
  OPEN_SOURCE_URI_PATH,
  createOpenSourceUriHandler,
  parseOpenSourceUri,
  registerDebuggenUriHandler,
  resolveWithinWorkspace,
} from '../../src/uri-handler';
import type { ParsedOpenRequest, UriHandlerDeps, UriRejectionReason } from '../../src/uri-handler';
import {
  EXTENSION_ID,
  activateExtensionOnce,
  cleanupScratch,
  closeAllEditors,
  createScratchDir,
  fixtureFile,
  fixtureWorkspaceFolders,
  fixtureWorkspaceRoot,
  plantSymlink,
  readExtensionManifest,
  stopTrackedProcesses,
  waitFor,
  writeFixtureFile,
} from '../helpers';

// ---------------------------------------------------------------------------
// Mocha's bdd globals, as provided by the @vscode/test-cli runner
// ---------------------------------------------------------------------------

/** A test or hook body: synchronous, or a promise mocha awaits. */
type MochaRunnable = () => void | Promise<void>;

declare function describe(title: string, body: () => void): void;
declare function it(title: string, body: MochaRunnable): void;
declare function before(body: MochaRunnable): void;
declare function after(body: MochaRunnable): void;
declare function afterEach(body: MochaRunnable): void;

// ---------------------------------------------------------------------------
// The contract under test, stated once
// ---------------------------------------------------------------------------

/** The three query parameters of the published link, spelled as AAP 0.2.3 fixes them. */
type LinkParameter = 'file' | 'line' | 'col';

/** The parameters in the order the published link writes them. */
const LINK_PARAMETERS: readonly LinkParameter[] = Object.freeze(['file', 'line', 'col']);

/** The label of the production dialog's one affirmative button. */
const CONFIRM_BUTTON = 'Open';

/**
 * A code taken from the exported vocabulary, never written as a bare literal
 * in an assertion: the parameter type proves membership at compile time and
 * the lookup proves it at run time, against `DEBUGGEN_ERROR_CODES` itself.
 */
function vocabularyCode(code: DebuggenErrorCode): DebuggenErrorCode {
  const found = DEBUGGEN_ERROR_CODES.find((candidate) => candidate === code);
  if (found === undefined) {
    throw new Error(`${code} is not in DEBUGGEN_ERROR_CODES exported by @debuggen/shared.`);
  }
  return found;
}

/** The codes the handler reports its refusals under. */
const ERROR_CODE = Object.freeze({
  invalidMessage: vocabularyCode('PROTOCOL_INVALID_MESSAGE'),
  outsideProject: vocabularyCode('PATH_OUTSIDE_PROJECT'),
  unsafePath: vocabularyCode('FS_UNSAFE_PATH'),
  projectNotFound: vocabularyCode('PROJECT_NOT_FOUND'),
  unauthorized: vocabularyCode('UNAUTHORIZED'),
});

/** One expected refusal: the reason the handler states and the code it travels under. */
interface Refusal {
  readonly reason: UriRejectionReason;
  readonly code: DebuggenErrorCode;
}

/** Every refusal this suite provokes, keyed by what provokes it. */
const REFUSAL = Object.freeze({
  unsupportedPath: { reason: 'unsupported-path', code: ERROR_CODE.invalidMessage },
  missingParameter: { reason: 'missing-parameter', code: ERROR_CODE.invalidMessage },
  malformedFile: { reason: 'malformed-file', code: ERROR_CODE.invalidMessage },
  malformedPosition: { reason: 'malformed-position', code: ERROR_CODE.invalidMessage },
  positionOutOfRange: { reason: 'position-out-of-range', code: ERROR_CODE.invalidMessage },
  noWorkspace: { reason: 'no-workspace', code: ERROR_CODE.projectNotFound },
  outsideWorkspace: { reason: 'outside-workspace', code: ERROR_CODE.outsideProject },
  notAFile: { reason: 'not-a-file', code: ERROR_CODE.unsafePath },
  declined: { reason: 'declined', code: ERROR_CODE.unauthorized },
} satisfies Record<string, Refusal>);

// ---------------------------------------------------------------------------
// Fixture workspace targets (read only) and the scratch stand-in workspace
// ---------------------------------------------------------------------------

/**
 * The legitimate in-workspace targets of the fixture workspace the window has
 * open. Positions are found by scanning for these anchor tokens, never
 * hardcoded, so an edit to a fixture cannot silently move a target.
 */
const FIXTURE = Object.freeze({
  sampleFile: 'src/sample-module.ts',
  sampleAnchor: 'SAMPLE_ANCHOR_PRIMARY',
  nestedFile: 'src/nested/deep-module.ts',
  nestedAnchor: 'deep-anchor-inner',
});

/** Directory and file names of the scratch tree, relative to its root. */
const SCRATCH = Object.freeze({
  workspace: 'workspace',
  workspaceAlias: 'workspace-alias',
  outside: 'outside',
  // Starts with the workspace directory's name: the prefix-sibling trap a bare
  // `startsWith(root)` check falls into.
  prefixSibling: 'workspace-sibling',
  secret: 'secret-module.ts',
});

/** Entries inside the scratch workspace, as the project-relative paths a link names. */
const IN_WORKSPACE = Object.freeze({
  module: 'src/inside-module.ts',
  innerLink: 'src/inner-link.ts',
  escapingFileLink: 'src/escaping-link.ts',
  escapingDirLink: 'linked-outside',
  prefixSiblingLink: 'src/prefix-sibling-link.ts',
  directory: 'src',
  missing: 'src/never-written.ts',
});

/** The token the scratch module's position is found by. */
const SCRATCH_ANCHOR = 'scratchAnchorTarget';

const INSIDE_MODULE_TEXT = [
  '/** A module inside the stand-in workspace of the URI-handler suite. */',
  `export function ${SCRATCH_ANCHOR}(): string {`,
  "  return 'inside the workspace';",
  '}',
  '',
].join('\n');

const OUTSIDE_MODULE_TEXT = "export const outsideValue = 'outside the workspace';\n";

/** A 1-based position, as the link and `ParsedOpenRequest` carry it. */
interface AnchorPosition {
  readonly line: number;
  readonly column: number;
}

/** The first position of every file, for requests whose position is irrelevant. */
const FIRST_POSITION: AnchorPosition = Object.freeze({ line: 1, column: 1 });

/** The scratch tree built once in the suite's `before` hook. All paths are canonical. */
interface ScratchWorkspace {
  /** The scratch root from `createScratchDir`, removed by `cleanupScratch`. */
  readonly root: string;
  /** The directory standing in as the open workspace folder. */
  readonly workspaceRoot: string;
  /** That directory as the only open folder. */
  readonly folders: readonly vscode.WorkspaceFolder[];
  /** The same directory opened through a symlinked path. */
  readonly aliasFolders: readonly vscode.WorkspaceFolder[];
  /** The legitimate regular file inside the stand-in workspace. */
  readonly insideModule: string;
  /** Where the anchor of {@link ScratchWorkspace.insideModule} is. */
  readonly anchor: AnchorPosition;
  /** A regular file outside the workspace, the target of the escaping links. */
  readonly outsideSecret: string;
  /** A regular file in the prefix-sibling directory. */
  readonly siblingSecret: string;
}

let scratch: ScratchWorkspace | undefined;

function requireScratch(): ScratchWorkspace {
  if (scratch === undefined) {
    throw new Error(
      'The scratch workspace was not built: the suite-level before hook did not run.',
    );
  }
  return scratch;
}

/** A workspace folder value, as `vscode.workspace.workspaceFolders` lists them. */
function workspaceFolder(uri: vscode.Uri, name: string): vscode.WorkspaceFolder {
  return Object.freeze({ uri, name, index: 0 });
}

/** The 1-based position of the first occurrence of `anchor` in `file`. */
async function locateAnchor(file: string, anchor: string): Promise<AnchorPosition> {
  const lines = (await fsp.readFile(file, 'utf8')).split(/\r\n|\r|\n/);
  const index = lines.findIndex((text) => text.includes(anchor));
  const text = lines[index];
  if (index === -1 || text === undefined) {
    throw new Error(`The anchor ${JSON.stringify(anchor)} does not occur in ${file}.`);
  }
  return Object.freeze({ line: index + 1, column: text.indexOf(anchor) + 1 });
}

/**
 * Builds the scratch tree:
 *
 * ```text
 * <root>/workspace/src/inside-module.ts          regular file (the legitimate target)
 * <root>/workspace/src/inner-link.ts            -> <root>/workspace/src/inside-module.ts
 * <root>/workspace/src/escaping-link.ts         -> <root>/outside/secret-module.ts
 * <root>/workspace/src/prefix-sibling-link.ts   -> <root>/workspace-sibling/secret-module.ts
 * <root>/workspace/linked-outside               -> <root>/outside            (directory link)
 * <root>/workspace-alias                        -> <root>/workspace          (directory link)
 * <root>/outside/secret-module.ts                regular file outside the workspace
 * <root>/workspace-sibling/secret-module.ts      regular file beside it
 * ```
 *
 * Link targets are absolute, so each link means the same thing whatever
 * directory resolves it. Files are written before any link is planted, because
 * `writeFixtureFile` refuses to write through a symlinked parent.
 */
async function buildScratchWorkspace(): Promise<ScratchWorkspace> {
  const root = createScratchDir('uri-handler-');
  const workspaceRoot = path.join(root, SCRATCH.workspace);
  const aliasRoot = path.join(root, SCRATCH.workspaceAlias);

  const insideModule = writeFixtureFile(workspaceRoot, IN_WORKSPACE.module, INSIDE_MODULE_TEXT);
  const outsideSecret = writeFixtureFile(
    path.join(root, SCRATCH.outside),
    SCRATCH.secret,
    OUTSIDE_MODULE_TEXT,
  );
  const siblingSecret = writeFixtureFile(
    path.join(root, SCRATCH.prefixSibling),
    SCRATCH.secret,
    OUTSIDE_MODULE_TEXT,
  );

  plantSymlink(path.join(workspaceRoot, IN_WORKSPACE.innerLink), insideModule);
  plantSymlink(path.join(workspaceRoot, IN_WORKSPACE.escapingFileLink), outsideSecret);
  plantSymlink(path.join(workspaceRoot, IN_WORKSPACE.prefixSiblingLink), siblingSecret);
  plantSymlink(path.join(workspaceRoot, IN_WORKSPACE.escapingDirLink), path.dirname(outsideSecret));
  plantSymlink(aliasRoot, workspaceRoot);

  return Object.freeze({
    root,
    workspaceRoot,
    folders: Object.freeze([workspaceFolder(vscode.Uri.file(workspaceRoot), 'stand-in')]),
    aliasFolders: Object.freeze([workspaceFolder(vscode.Uri.file(aliasRoot), 'stand-in-alias')]),
    insideModule,
    anchor: await locateAnchor(insideModule, SCRATCH_ANCHOR),
    outsideSecret,
    siblingSecret,
  });
}

/** Whether anything, a dangling link included, exists at `target`. */
async function pathExists(target: string): Promise<boolean> {
  try {
    await fsp.lstat(target);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

/** One `name=value` pair, both unencoded. */
type QueryPair = readonly [name: string, value: string];

/** A query string with every name and value percent-encoded once. */
function encodeQuery(pairs: readonly QueryPair[]): string {
  return pairs
    .map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`)
    .join('&');
}

/**
 * A link routed to this extension, parsed exactly as the editor parses one it
 * dispatches: `vscode.Uri.parse`, which percent-decodes the query once. The
 * authority is the extension identity the suite shares with `test/helpers.ts`
 * (cross-checked against the manifest in the last `describe`), and `rawQuery`
 * is used verbatim — the encoded-traversal cases depend on that.
 */
function openLink(rawQuery: string, verb: string = OPEN_SOURCE_URI_PATH): vscode.Uri {
  return vscode.Uri.parse(`${vscode.env.uriScheme}://${EXTENSION_ID}${verb}?${rawQuery}`, true);
}

/** The well-formed link to `file` at `position`. */
function linkTo(file: string, position: AnchorPosition): vscode.Uri {
  return openLink(
    encodeQuery([
      ['file', file],
      ['line', String(position.line)],
      ['col', String(position.column)],
    ]),
  );
}

/**
 * The well-formed link to the scratch workspace's regular file, with some
 * parameters replaced (a string) or removed (`null`). Every other parameter is
 * valid and names a real file inside the open stand-in folder, so a gate that
 * failed to refuse the altered one would let the request through to the
 * editor.
 */
function variantLink(
  changes: Readonly<Partial<Record<LinkParameter, string | null>>>,
  verb: string = OPEN_SOURCE_URI_PATH,
): vscode.Uri {
  const layout = requireScratch();
  const baseline: Readonly<Record<LinkParameter, string>> = {
    file: IN_WORKSPACE.module,
    line: String(layout.anchor.line),
    col: String(layout.anchor.column),
  };
  const pairs: QueryPair[] = [];
  for (const name of LINK_PARAMETERS) {
    const change = changes[name];
    if (change !== null) {
      pairs.push([name, change ?? baseline[name]]);
    }
  }
  return openLink(encodeQuery(pairs), verb);
}

/** A valid `&line=…&col=…` tail for a link whose `file` pair is written by hand. */
function positionTail(): string {
  const layout = requireScratch();
  return `&line=${layout.anchor.line}&col=${layout.anchor.column}`;
}

// ---------------------------------------------------------------------------
// The editor-open URI a DevTools panel builds
// ---------------------------------------------------------------------------

/**
 * Project-relative names in which every special character means something to a
 * URI or to a form-encoded query. Each is written into a link by
 * `buildEditorOpenUri`, exactly as a DevTools panel does when no editor is
 * connected, and must come back out of the handler's parse byte for byte.
 */
const ROUND_TRIP_FILES: readonly string[] = Object.freeze([
  // `+` is a space in a form-encoded query.
  'src/a+b.ts',
  // `&` and `=` would split the pair and smuggle in a second `line`.
  'src/a&line=9.ts',
  // A bare percent sign, and escapes that must not be decoded a third time.
  'src/100%.ts',
  'src/%41%2e%2e%2f.ts',
  // `#` would start a fragment and `?` a second query.
  'src/hash#fragment?query.ts',
  // Spaces, including a run of them.
  'src/with space/and  two.ts',
  // Non-ASCII text: precomposed Latin letters, CJK, and an astral character.
  'src/ünïcødé/模块.ts',
  'src/emoji-😀.ts',
]);

/** The positions each round-trip name is carried at: an ordinary one, and both inclusive bounds. */
const ROUND_TRIP_POSITIONS: readonly AnchorPosition[] = Object.freeze([
  Object.freeze({ line: 12, column: 7 }),
  Object.freeze({ line: MAX_URI_LINE, column: MAX_URI_COLUMN }),
]);

/**
 * A real file inside the stand-in workspace whose name needs both encodings:
 * `+`, `&`, `=`, a `%` escape, spaces and non-ASCII text in one name.
 */
const FALLBACK_FILE = 'src/fallback a+b&c=d%41 ü.ts';

/** The token the position inside {@link FALLBACK_FILE} is found by. */
const FALLBACK_ANCHOR = 'fallbackAnchorTarget';

const FALLBACK_MODULE_TEXT = [
  '/** A module whose name needs both encodings of the editor-open URI. */',
  `export const ${FALLBACK_ANCHOR} = 'reached through buildEditorOpenUri';`,
  '',
].join('\n');

/** The shared source location a DevTools panel holds for `file` at `position`. */
function panelLocation(file: string, position: AnchorPosition): SourceLocation {
  return { file, ...position, resolvedBy: 'code-graph', confidence: 1 };
}

/** One link as `buildEditorOpenUri` wrote it, and as this editor parses it. */
interface BuiltLink {
  /** The URI text exactly as the DevTools panel would open it. */
  readonly text: string;
  /** That text through the real `vscode.Uri.parse`, which decodes the query once. */
  readonly uri: vscode.Uri;
}

/**
 * The link `buildEditorOpenUri` builds for `location`, parsed by the real
 * `vscode.Uri.parse` — the decode this editor applies to a `vscode://` URI
 * before any handler sees it.
 */
function builtLink(location: SourceLocation): BuiltLink {
  const text = expectAccepted(buildEditorOpenUri(location), `buildEditorOpenUri(${location.file})`);
  return { text, uri: vscode.Uri.parse(text, true) };
}

// ---------------------------------------------------------------------------
// The handler probe: every collaborator substituted and recorded
// ---------------------------------------------------------------------------

/** One call the handler made to its reveal port. */
interface RevealCall {
  readonly uri: vscode.Uri;
  readonly line: number;
  readonly column: number;
}

/** A handler built through the `deps` seam, and everything it did. */
interface HandlerProbe {
  readonly handler: vscode.UriHandler;
  /** Requests the substituted confirmation was asked about. */
  readonly confirmRequests: readonly ParsedOpenRequest[];
  /** Calls to the reveal port. Zero means the editor was never asked to open anything. */
  readonly revealCalls: readonly RevealCall[];
  /** What the real reveal primitive answered, one entry per call. */
  readonly revealResults: readonly Result<RevealOutcome, DebuggenError>[];
  /** Refusal notifications the handler raised. */
  readonly notifications: readonly string[];
  /** The handler's log records, copied as they were emitted. */
  readonly logRecords: readonly LogRecord[];
}

interface ProbeOptions {
  /**
   * The substituted confirmation's answer. Absent means the production modal
   * dialog runs, which only the dialog cases (with `showWarningMessage`
   * answered by a stub) may do.
   */
  readonly confirmAnswer?: boolean;
  /** The open folders. Absent means the window's real folders. */
  readonly workspaceFolders?: () => readonly vscode.WorkspaceFolder[] | undefined;
}

function createProbe(options: ProbeOptions): HandlerProbe {
  const confirmRequests: ParsedOpenRequest[] = [];
  const revealCalls: RevealCall[] = [];
  const revealResults: Result<RevealOutcome, DebuggenError>[] = [];
  const notifications: string[] = [];
  const logRecords: LogRecord[] = [];

  // Records the call, then opens for real: a hostile link that reached this
  // port would be both counted and visible in the editor.
  const reveal: typeof revealLocationInEditor = async (uri, line, column, revealOptions) => {
    revealCalls.push({ uri, line, column });
    const outcome = await revealLocationInEditor(uri, line, column, revealOptions);
    revealResults.push(outcome);
    return outcome;
  };

  const { confirmAnswer, workspaceFolders } = options;
  const deps: UriHandlerDeps = {
    logger: createConsoleLogger({
      level: 'trace',
      sink: (record) => {
        logRecords.push({ ...record, fields: { ...record.fields } });
      },
    }),
    reveal,
    showWarning: (message) => {
      notifications.push(message);
    },
    ...(confirmAnswer === undefined
      ? {}
      : {
          confirm: (request: ParsedOpenRequest): Promise<boolean> => {
            confirmRequests.push(request);
            return Promise.resolve(confirmAnswer);
          },
        }),
    ...(workspaceFolders === undefined ? {} : { workspaceFolders }),
  };

  return {
    handler: createOpenSourceUriHandler(deps),
    confirmRequests,
    revealCalls,
    revealResults,
    notifications,
    logRecords,
  };
}

/** The URIs of the visible text editors, order-independent. */
function visibleEditorSnapshot(): readonly string[] {
  return vscode.window.visibleTextEditors.map((editor) => editor.document.uri.toString()).sort();
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

/** The accepted value, or an assertion failure that names the refusal instead. */
function expectAccepted<T>(result: Result<T, DebuggenError>, subject: string): T {
  if (!result.ok) {
    throw new assert.AssertionError({
      message:
        `${subject} was refused (${result.error.code}, reason ` +
        `${JSON.stringify(result.error.details?.['reason'])}) but must be accepted.`,
    });
  }
  return result.value;
}

/**
 * The refusal carried by `result`: a genuine `DebuggenError` whose code is the
 * expected one from the exported vocabulary and whose `details.reason` is the
 * expected {@link UriRejectionReason}.
 */
function expectRefusal<T>(
  result: Result<T, DebuggenError>,
  expected: Refusal,
  subject: string,
): DebuggenError {
  if (result.ok) {
    throw new assert.AssertionError({
      message: `${subject} was accepted but must be refused as ${expected.reason}.`,
    });
  }
  const { error } = result;
  assert.ok(DebuggenError.is(error), `${subject}: the refusal is not a DebuggenError.`);
  assert.ok(
    DEBUGGEN_ERROR_CODES.includes(error.code),
    `${subject}: ${error.code} is outside DEBUGGEN_ERROR_CODES.`,
  );
  assert.equal(error.code, expected.code, `${subject}: error code.`);
  assert.equal(error.details?.['reason'], expected.reason, `${subject}: refusal reason.`);
  return error;
}

/** The handler logged exactly one refusal, with the expected reason and code. */
function assertHandlerRefusal(probe: HandlerProbe, expected: Refusal, subject: string): void {
  const refusals = probe.logRecords.filter((record) => record.level === 'warn');
  assert.equal(refusals.length, 1, `${subject}: the handler must log exactly one refusal.`);
  const [refusal] = refusals;
  assert.equal(refusal?.fields['reason'], expected.reason, `${subject}: logged refusal reason.`);
  assert.equal(refusal?.fields['code'], expected.code, `${subject}: logged refusal code.`);
}

/**
 * THE MANDATED ASSERTION: handing `link` to the handler opens nothing.
 *
 * The confirmation would answer yes and the reveal port would really open, so
 * this can only pass if a gate before the dialog refused the link: zero
 * questions, zero reveals, the expected reason in the handler's log, exactly
 * one notification (a refusal is stated, never silent), no hostile value
 * echoed into that notification or the log, and the visible editors exactly as
 * they were.
 *
 * @param folders The open folders the handler checks containment against;
 *   the scratch stand-in workspace unless a case says otherwise.
 * @param hostileValues Request values that must not be echoed.
 */
async function assertLinkOpensNothing(
  link: vscode.Uri,
  expected: Refusal,
  hostileValues: readonly string[] = [],
  folders: () => readonly vscode.WorkspaceFolder[] | undefined = () => requireScratch().folders,
): Promise<void> {
  const subject = `handleUri(${link.toString(true)})`;
  const editorsBefore = visibleEditorSnapshot();
  const probe = createProbe({ confirmAnswer: true, workspaceFolders: folders });

  await probe.handler.handleUri(link);

  assert.equal(probe.revealCalls.length, 0, `${subject} reached the editor.`);
  assert.equal(
    probe.confirmRequests.length,
    0,
    `${subject} asked the developer to confirm a request it must refuse before asking.`,
  );
  assertHandlerRefusal(probe, expected, subject);
  assert.equal(probe.notifications.length, 1, `${subject}: a refusal is stated exactly once.`);
  const surfaces = [
    ...probe.notifications,
    ...probe.logRecords.map((record) => `${record.message} ${JSON.stringify(record.fields)}`),
  ];
  for (const value of hostileValues) {
    for (const surface of surfaces) {
      assert.ok(
        !surface.includes(value),
        `${subject} echoed the hostile value ${JSON.stringify(value)}: ${surface}`,
      );
    }
  }
  assert.deepEqual(
    visibleEditorSnapshot(),
    editorsBefore,
    `${subject} changed the visible editors.`,
  );
}

/** `parseOpenSourceUri` refuses `link` as `expected`, and the handler opens nothing for it. */
async function assertMalformedLinkOpensNothing(
  link: vscode.Uri,
  expected: Refusal,
  hostileValues: readonly string[] = [],
): Promise<void> {
  expectRefusal(parseOpenSourceUri(link), expected, `parseOpenSourceUri(${link.toString(true)})`);
  await assertLinkOpensNothing(link, expected, hostileValues);
}

/**
 * `link` passes every string-level gate — `parseOpenSourceUri` accepts it —
 * and is refused as `expected` only once `resolveWithinWorkspace` has looked
 * at the filesystem; the handler opens nothing for it.
 */
async function assertContainedLookupOpensNothing(
  link: vscode.Uri,
  expected: Refusal,
  hostileValues: readonly string[] = [],
): Promise<void> {
  const layout = requireScratch();
  const subject = `resolveWithinWorkspace(${link.toString(true)})`;
  const request = expectAccepted(parseOpenSourceUri(link), `parseOpenSourceUri for ${subject}`);
  expectRefusal(await resolveWithinWorkspace(request, layout.folders), expected, subject);
  await assertLinkOpensNothing(link, expected, hostileValues);
}

/** A plain-object view of an unknown value, or `undefined` for anything else. */
function recordOf(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

/** The slice of `vscode.window` the production confirmation calls. */
interface WarningMessageWindow {
  showWarningMessage: (...args: unknown[]) => Thenable<unknown>;
}

/**
 * Runs `body` with `vscode.window.showWarningMessage` answered by a stub that
 * records its arguments and resolves `answer` — the only way to drive the
 * production modal dialog without a person — and restores the original in a
 * `finally`, whatever `body` does.
 */
async function withAnsweredWarningDialog(
  answer: string | undefined,
  calls: (readonly unknown[])[],
  body: () => vscode.ProviderResult<void>,
): Promise<void> {
  const editorWindow = vscode.window as unknown as WarningMessageWindow;
  const original = editorWindow.showWarningMessage;
  editorWindow.showWarningMessage = (...args: unknown[]): Thenable<unknown> => {
    calls.push(args);
    return Promise.resolve(answer);
  };
  try {
    await body();
  } finally {
    editorWindow.showWarningMessage = original;
  }
}

// ---------------------------------------------------------------------------
// The suite
// ---------------------------------------------------------------------------

describe('vscode:// source-open handler (src/uri-handler.ts)', () => {
  before(async () => {
    // Guard on the .vscode-test.mjs contract: the window has the generic
    // fixture workspace open, never the repository root or another project.
    fixtureWorkspaceRoot();
    await closeAllEditors();
    scratch = await buildScratchWorkspace();
  });

  after(async () => {
    const root = scratch?.root;
    disposeSourceRevealResources();
    try {
      await closeAllEditors();
    } finally {
      try {
        await cleanupScratch();
      } finally {
        await stopTrackedProcesses();
      }
    }
    scratch = undefined;
    if (root !== undefined) {
      assert.equal(await pathExists(root), false, `The scratch tree ${root} survived teardown.`);
    }
  });

  describe('parseOpenSourceUri accepts the published link shape', () => {
    it('parses a well-formed link into exactly the { file, line, column } it names', async () => {
      const position = await locateAnchor(fixtureFile(FIXTURE.nestedFile), FIXTURE.nestedAnchor);
      const request = expectAccepted(
        parseOpenSourceUri(linkTo(FIXTURE.nestedFile, position)),
        'parseOpenSourceUri(nested fixture link)',
      );
      assert.deepEqual(request, {
        file: FIXTURE.nestedFile,
        line: position.line,
        column: position.column,
      });
    });

    it('accepts the 1-based minimum and both inclusive bounds, MAX_URI_LINE and MAX_URI_COLUMN', () => {
      for (const position of [FIRST_POSITION, { line: MAX_URI_LINE, column: MAX_URI_COLUMN }]) {
        const request = expectAccepted(
          parseOpenSourceUri(linkTo(IN_WORKSPACE.module, position)),
          `parseOpenSourceUri(line ${position.line}, col ${position.column})`,
        );
        assert.deepEqual(request, { file: IN_WORKSPACE.module, ...position });
      }
    });
  });

  describe('the editor-open URI of @debuggen/protocol reaches the handler unchanged', () => {
    afterEach(async () => {
      disposeSourceRevealResources();
      await closeAllEditors();
    });

    it("is built from the path and parameter names the handler reads, under this extension's identity", () => {
      assert.equal(OPEN_SOURCE_URI_PATH, EDITOR_OPEN_URI.path);
      assert.deepEqual(
        [
          EDITOR_OPEN_URI.fileParameter,
          EDITOR_OPEN_URI.lineParameter,
          EDITOR_OPEN_URI.columnParameter,
        ],
        LINK_PARAMETERS,
      );
      const manifest = readExtensionManifest();
      assert.equal(EDITOR_OPEN_URI.authority, `${manifest.publisher}.${manifest.name}`);
      assert.equal(EDITOR_OPEN_URI.authority, EXTENSION_ID);

      const { uri } = builtLink(panelLocation(IN_WORKSPACE.module, FIRST_POSITION));
      assert.equal(uri.scheme, EDITOR_OPEN_URI.scheme);
      assert.equal(uri.authority, EDITOR_OPEN_URI.authority);
      assert.equal(uri.path, OPEN_SOURCE_URI_PATH);
    });

    it('gives back the exact file, line and column through vscode.Uri.parse, whatever the name holds', () => {
      for (const file of ROUND_TRIP_FILES) {
        for (const position of ROUND_TRIP_POSITIONS) {
          const { text, uri } = builtLink(panelLocation(file, position));
          const subject = `parseOpenSourceUri(Uri.parse(${text}))`;
          // Written as exactly three pairs: no `&` or `=` of the name survives
          // into the text as a separator.
          const query = text.slice(text.indexOf('?') + 1);
          assert.equal(query.split('&').length, LINK_PARAMETERS.length, `${subject}: pair count`);

          const request = expectAccepted(parseOpenSourceUri(uri), subject);
          assert.deepEqual(request, { file, ...position }, `${subject}: recovered request`);
        }
      }
    });

    it('opens a real file whose name needs both encodings, once, at its line and column', async () => {
      const layout = requireScratch();
      const written = writeFixtureFile(layout.workspaceRoot, FALLBACK_FILE, FALLBACK_MODULE_TEXT);
      const canonicalPath = await fsp.realpath(written);
      const position = await locateAnchor(written, FALLBACK_ANCHOR);
      const probe = createProbe({ confirmAnswer: true, workspaceFolders: () => layout.folders });

      await probe.handler.handleUri(builtLink(panelLocation(FALLBACK_FILE, position)).uri);

      // The developer is asked about the name exactly as the panel held it.
      assert.deepEqual(probe.confirmRequests, [{ file: FALLBACK_FILE, ...position }]);
      assert.equal(probe.revealCalls.length, 1, 'the editor must be asked exactly once');
      const [call] = probe.revealCalls;
      assert.ok(call !== undefined, 'no reveal call was recorded');
      assert.equal(call.uri.fsPath, canonicalPath, 'revealed file (canonical path)');
      assert.equal(call.line, position.line, 'revealed line');
      assert.equal(call.column, position.column, 'revealed column');
      const [outcome] = probe.revealResults;
      assert.ok(outcome !== undefined, 'the reveal did not settle');
      assert.equal(expectAccepted(outcome, 'revealLocationInEditor').clamped, false);
      assert.equal(probe.notifications.length, 0, 'a successful open raises nothing');
      assert.equal(
        probe.logRecords.filter((record) => record.level === 'warn').length,
        0,
        'a successful open logs no refusal',
      );

      const editor = await waitFor(
        () =>
          vscode.window.visibleTextEditors.find(
            (candidate) => candidate.document.uri.fsPath === canonicalPath,
          ),
        { message: `an editor showing ${FALLBACK_FILE}` },
      );
      assert.equal(editor.selection.active.line, position.line - 1, 'cursor line');
      assert.equal(editor.selection.active.character, position.column - 1, 'cursor column');
    });
  });

  describe('a malformed link opens nothing', () => {
    it('refuses a path other than the one open verb', async () => {
      for (const verb of ['/Open', '/open/', '//open', '/open/source', '/close', '']) {
        await assertMalformedLinkOpensNothing(variantLink({}, verb), REFUSAL.unsupportedPath);
      }
    });

    it('refuses a link without a file parameter, or with an empty one', async () => {
      await assertMalformedLinkOpensNothing(variantLink({ file: null }), REFUSAL.missingParameter);
      await assertMalformedLinkOpensNothing(variantLink({ file: '' }), REFUSAL.malformedFile);
    });

    it('refuses a link that repeats a parameter instead of letting one value win', async () => {
      const layout = requireScratch();
      const traversal = `../${SCRATCH.outside}/${SCRATCH.secret}`;
      const repeated = openLink(
        encodeQuery([
          ['file', IN_WORKSPACE.module],
          ['file', traversal],
          ['line', String(layout.anchor.line)],
          ['col', String(layout.anchor.column)],
        ]),
      );
      await assertMalformedLinkOpensNothing(repeated, REFUSAL.missingParameter, [traversal]);
    });

    it('refuses a link whose line is missing or empty', async () => {
      await assertMalformedLinkOpensNothing(variantLink({ line: null }), REFUSAL.missingParameter);
      await assertMalformedLinkOpensNothing(variantLink({ line: '' }), REFUSAL.malformedPosition);
    });

    it('refuses a link whose col is missing or empty', async () => {
      await assertMalformedLinkOpensNothing(variantLink({ col: null }), REFUSAL.missingParameter);
      await assertMalformedLinkOpensNothing(variantLink({ col: '' }), REFUSAL.malformedPosition);
    });

    it('refuses a non-numeric line or col, however leniently Number() would read it', async () => {
      // `+1` arrives as a space followed by 1: a query is form-encoded.
      const values = ['abc', '1abc', '1.5', '1e3', '0x10', ' 1', '1 ', '+1', '\u0661', 'Infinity'];
      for (const value of values) {
        await assertMalformedLinkOpensNothing(
          variantLink({ line: value }),
          REFUSAL.malformedPosition,
        );
        await assertMalformedLinkOpensNothing(
          variantLink({ col: value }),
          REFUSAL.malformedPosition,
        );
      }
    });

    it('refuses a negative or zero line or col, since positions are 1-based', async () => {
      for (const axis of [
        (value: string) => ({ line: value }),
        (value: string) => ({ col: value }),
      ]) {
        // A sign is not a digit, so a negative value is malformed as written.
        for (const value of ['-1', '-0', `-${MAX_URI_COLUMN}`]) {
          await assertMalformedLinkOpensNothing(
            variantLink(axis(value)),
            REFUSAL.malformedPosition,
          );
        }
        // Zero is well-formed and below the 1-based minimum.
        for (const value of ['0', '00']) {
          await assertMalformedLinkOpensNothing(
            variantLink(axis(value)),
            REFUSAL.positionOutOfRange,
          );
        }
      }
    });

    it('refuses a line above MAX_URI_LINE and a col above MAX_URI_COLUMN', async () => {
      await assertMalformedLinkOpensNothing(
        variantLink({ line: String(MAX_URI_LINE + 1) }),
        REFUSAL.positionOutOfRange,
      );
      await assertMalformedLinkOpensNothing(
        variantLink({ col: String(MAX_URI_COLUMN + 1) }),
        REFUSAL.positionOutOfRange,
      );
      // The column has a bound of its own, far below the line bound.
      assert.ok(MAX_URI_COLUMN + 1 < MAX_URI_LINE);
      // A value too long to be a position is malformed before any range check.
      await assertMalformedLinkOpensNothing(
        variantLink({ line: String(MAX_URI_LINE * 100) }),
        REFUSAL.malformedPosition,
      );
    });

    it('refuses a file that climbs out of the workspace with a .. traversal', async () => {
      const escape = `${SCRATCH.outside}/${SCRATCH.secret}`;
      const traversals = [
        `../${escape}`,
        `./../${escape}`,
        `src/../../${escape}`,
        `src/nested/../../../${escape}`,
        '..',
        `..\\${SCRATCH.outside}\\${SCRATCH.secret}`,
      ];
      for (const file of traversals) {
        await assertMalformedLinkOpensNothing(variantLink({ file }), REFUSAL.malformedFile, [file]);
      }
    });

    it('refuses an absolute path outside the workspace, in every absolute form', async () => {
      const layout = requireScratch();
      const absolutes = [
        layout.outsideSecret,
        layout.siblingSecret,
        'C:/Windows/win.ini',
        'C:\\Windows\\win.ini',
        '//server/share/secret-module.ts',
        'file:///etc/hosts',
        '~/.ssh/config',
      ];
      for (const file of absolutes) {
        await assertMalformedLinkOpensNothing(variantLink({ file }), REFUSAL.malformedFile, [file]);
      }
    });

    it('refuses a percent-encoded traversal, because every gate reads the decoded value', async () => {
      const layout = requireScratch();
      const encodedFiles = [
        `%2e%2e%2f${SCRATCH.outside}%2f${SCRATCH.secret}`,
        `%2E%2E%2F${SCRATCH.outside}%2F${SCRATCH.secret}`,
        `src%2f%2e%2e%2f%2e%2e%2f${SCRATCH.outside}%2f${SCRATCH.secret}`,
        `%2e%2e%5c${SCRATCH.outside}%5c${SCRATCH.secret}`,
        // Encoded twice: `Uri.parse` decodes once and the query parser once more.
        `%252e%252e%252f${SCRATCH.outside}%252f${SCRATCH.secret}`,
        encodeURIComponent(layout.outsideSecret),
      ];
      for (const encodedFile of encodedFiles) {
        const rawQuery = `file=${encodedFile}${positionTail()}`;
        // The hostile value exists only after decoding: the link as written
        // carries neither a `..` segment nor a leading slash.
        assert.ok(!rawQuery.includes('..') && !rawQuery.startsWith('file=/'), rawQuery);
        await assertMalformedLinkOpensNothing(openLink(rawQuery), REFUSAL.malformedFile, [
          layout.outsideSecret,
        ]);
      }
    });
  });

  describe('workspace containment is decided on realpaths', () => {
    it('resolves a regular file inside an open folder to the file: URI of its canonical path', async () => {
      const layout = requireScratch();
      const standIn = expectAccepted(
        await resolveWithinWorkspace(
          { file: IN_WORKSPACE.module, ...FIRST_POSITION },
          layout.folders,
        ),
        'resolveWithinWorkspace(stand-in module)',
      );
      assert.equal(standIn.scheme, 'file');
      assert.equal(standIn.fsPath, await fsp.realpath(layout.insideModule));

      // The same holds in the folder this window really has open.
      const nested = expectAccepted(
        await resolveWithinWorkspace(
          { file: FIXTURE.nestedFile, ...FIRST_POSITION },
          fixtureWorkspaceFolders(),
        ),
        'resolveWithinWorkspace(nested fixture module)',
      );
      assert.equal(nested.scheme, 'file');
      assert.equal(nested.fsPath, await fsp.realpath(fixtureFile(FIXTURE.nestedFile)));
    });

    it('canonicalises the folder too, so a folder opened through a symlink contains its own files', async () => {
      const layout = requireScratch();
      const [aliasFolder] = layout.aliasFolders;
      assert.ok(aliasFolder !== undefined);
      assert.equal(await fsp.realpath(aliasFolder.uri.fsPath), layout.workspaceRoot);

      const uri = expectAccepted(
        await resolveWithinWorkspace(
          { file: IN_WORKSPACE.module, ...FIRST_POSITION },
          layout.aliasFolders,
        ),
        'resolveWithinWorkspace(module through the aliased folder)',
      );
      // The URI names the canonical file, never the path through the alias.
      assert.equal(uri.fsPath, layout.insideModule);
    });

    it('accepts a symlink that stays inside the workspace, resolving it to its target', async () => {
      const layout = requireScratch();
      const linkPath = path.join(layout.workspaceRoot, IN_WORKSPACE.innerLink);
      assert.ok((await fsp.lstat(linkPath)).isSymbolicLink(), `${linkPath} is a symlink`);

      const uri = expectAccepted(
        await resolveWithinWorkspace(
          { file: IN_WORKSPACE.innerLink, ...FIRST_POSITION },
          layout.folders,
        ),
        'resolveWithinWorkspace(in-workspace symlink)',
      );
      assert.equal(uri.fsPath, layout.insideModule);
    });

    it('refuses a symlink inside the workspace whose realpath escapes it — the case only fs.realpath catches', async () => {
      const layout = requireScratch();
      const linkPath = path.join(layout.workspaceRoot, IN_WORKSPACE.escapingFileLink);
      // Lexically inside the workspace, a link, and canonically outside it.
      assert.ok((await fsp.lstat(linkPath)).isSymbolicLink(), `${linkPath} is a symlink`);
      assert.equal(await fsp.realpath(linkPath), layout.outsideSecret);

      await assertContainedLookupOpensNothing(
        linkTo(IN_WORKSPACE.escapingFileLink, FIRST_POSITION),
        REFUSAL.outsideWorkspace,
        [layout.outsideSecret],
      );
    });

    it('refuses a path through a symlinked directory that escapes the workspace', async () => {
      const layout = requireScratch();
      const file = `${IN_WORKSPACE.escapingDirLink}/${SCRATCH.secret}`;
      assert.equal(await fsp.realpath(path.join(layout.workspaceRoot, file)), layout.outsideSecret);

      await assertContainedLookupOpensNothing(
        linkTo(file, FIRST_POSITION),
        REFUSAL.outsideWorkspace,
        [layout.outsideSecret],
      );
    });

    it('refuses a symlink into a sibling directory whose name merely extends the workspace name', async () => {
      const layout = requireScratch();
      const target = await fsp.realpath(
        path.join(layout.workspaceRoot, IN_WORKSPACE.prefixSiblingLink),
      );
      // The trap a bare prefix test falls into: the target starts with the
      // workspace path and is still outside it.
      assert.equal(target, layout.siblingSecret);
      assert.ok(target.startsWith(layout.workspaceRoot));

      await assertContainedLookupOpensNothing(
        linkTo(IN_WORKSPACE.prefixSiblingLink, FIRST_POSITION),
        REFUSAL.outsideWorkspace,
        [layout.siblingSecret],
      );
    });

    it('refuses a path that does not exist exactly as it refuses an escape, so it is no existence oracle', async () => {
      const layout = requireScratch();
      assert.equal(await pathExists(path.join(layout.workspaceRoot, IN_WORKSPACE.missing)), false);

      await assertContainedLookupOpensNothing(
        linkTo(IN_WORKSPACE.missing, FIRST_POSITION),
        REFUSAL.outsideWorkspace,
      );
    });

    it('refuses a contained path that is not a regular file', async () => {
      await assertContainedLookupOpensNothing(
        linkTo(IN_WORKSPACE.directory, FIRST_POSITION),
        REFUSAL.notAFile,
      );
    });

    it('re-validates a hand-built request: a traversal or an absolute path is refused as written', async () => {
      const layout = requireScratch();
      for (const file of [`../${SCRATCH.outside}/${SCRATCH.secret}`, layout.outsideSecret]) {
        expectRefusal(
          await resolveWithinWorkspace({ file, ...FIRST_POSITION }, layout.folders),
          REFUSAL.malformedFile,
          `resolveWithinWorkspace(${JSON.stringify(file)})`,
        );
      }
    });

    it('refuses every request when no folder is open, since containment is then undefined', async () => {
      expectRefusal(
        await resolveWithinWorkspace({ file: IN_WORKSPACE.module, ...FIRST_POSITION }, []),
        REFUSAL.noWorkspace,
        'resolveWithinWorkspace(no folders)',
      );
      const link = linkTo(IN_WORKSPACE.module, requireScratch().anchor);
      await assertLinkOpensNothing(link, REFUSAL.noWorkspace, [], () => undefined);
      await assertLinkOpensNothing(link, REFUSAL.noWorkspace, [], () => []);
    });

    it('skips a folder on a virtual file system, which realpath cannot canonicalise', async () => {
      const layout = requireScratch();
      const virtualFolder = workspaceFolder(
        vscode.Uri.from({
          scheme: 'vscode-vfs',
          authority: 'stand-in',
          path: layout.workspaceRoot,
        }),
        'virtual',
      );
      const link = linkTo(IN_WORKSPACE.module, layout.anchor);
      expectRefusal(
        await resolveWithinWorkspace(
          expectAccepted(parseOpenSourceUri(link), 'parseOpenSourceUri(stand-in module)'),
          [virtualFolder],
        ),
        REFUSAL.outsideWorkspace,
        'resolveWithinWorkspace(virtual folder)',
      );
      await assertLinkOpensNothing(link, REFUSAL.outsideWorkspace, [], () => [virtualFolder]);
    });
  });

  describe("the developer's confirmation gates every open", () => {
    /** The legitimate link: the top-level fixture module, at its anchor, in the open folder. */
    interface LegitimateLink {
      readonly link: vscode.Uri;
      readonly request: ParsedOpenRequest;
      readonly canonicalPath: string;
    }

    let legitimate: LegitimateLink | undefined;

    function requireLegitimate(): LegitimateLink {
      if (legitimate === undefined) {
        throw new Error('The legitimate link was not built: the before hook did not run.');
      }
      return legitimate;
    }

    before(async () => {
      const absolute = fixtureFile(FIXTURE.sampleFile);
      const position = await locateAnchor(absolute, FIXTURE.sampleAnchor);
      legitimate = Object.freeze({
        link: linkTo(FIXTURE.sampleFile, position),
        request: Object.freeze({ file: FIXTURE.sampleFile, ...position }),
        canonicalPath: await fsp.realpath(absolute),
      });
    });

    afterEach(async () => {
      disposeSourceRevealResources();
      await closeAllEditors();
    });

    /** The one reveal call: the canonical file, at exactly the requested line and column. */
    async function assertRevealedOnce(probe: HandlerProbe, subject: string): Promise<void> {
      const { request, canonicalPath } = requireLegitimate();
      assert.equal(
        probe.revealCalls.length,
        1,
        `${subject}: the editor must be asked exactly once.`,
      );
      const [call] = probe.revealCalls;
      assert.ok(call !== undefined, `${subject}: no reveal call was recorded.`);
      assert.equal(call.uri.scheme, 'file', `${subject}: revealed URI scheme.`);
      assert.equal(call.uri.fsPath, canonicalPath, `${subject}: revealed file (canonical path).`);
      assert.equal(call.line, request.line, `${subject}: revealed line.`);
      assert.equal(call.column, request.column, `${subject}: revealed column.`);

      const [outcome] = probe.revealResults;
      assert.ok(outcome !== undefined, `${subject}: the reveal did not settle.`);
      const revealed = expectAccepted(outcome, `${subject}: revealLocationInEditor`);
      assert.equal(revealed.clamped, false, `${subject}: the anchor position exists in the file.`);

      // The editor really shows it, with the cursor on the anchor (0-based).
      const editor = await waitFor(
        () =>
          vscode.window.visibleTextEditors.find(
            (candidate) => candidate.document.uri.fsPath === canonicalPath,
          ),
        { message: `${subject}: an editor showing ${FIXTURE.sampleFile}` },
      );
      assert.equal(editor.selection.active.line, request.line - 1, `${subject}: cursor line.`);
      assert.equal(
        editor.selection.active.character,
        request.column - 1,
        `${subject}: cursor column.`,
      );

      assert.equal(probe.notifications.length, 0, `${subject}: a successful open raises nothing.`);
      assert.equal(
        probe.logRecords.filter((record) => record.level === 'warn').length,
        0,
        `${subject}: a successful open logs no refusal.`,
      );
    }

    it('opens a legitimate in-workspace link exactly once, at its line and column, when confirmed', async () => {
      const { link, request } = requireLegitimate();
      const probe = createProbe({ confirmAnswer: true });

      await probe.handler.handleUri(link);

      assert.deepEqual(probe.confirmRequests, [request], 'the developer is asked exactly once');
      await assertRevealedOnce(probe, 'confirmed legitimate link');
    });

    it('opens nothing when the same link is declined, after asking exactly once about its file and line', async () => {
      const { link, request } = requireLegitimate();
      const editorsBefore = visibleEditorSnapshot();
      const probe = createProbe({ confirmAnswer: false });

      await probe.handler.handleUri(link);

      assert.equal(probe.confirmRequests.length, 1, 'the developer is asked exactly once');
      const [asked] = probe.confirmRequests;
      assert.ok(asked !== undefined, 'no confirmation request was recorded');
      assert.equal(asked.file, request.file, 'the question names the file');
      assert.equal(asked.line, request.line, 'the question names the line');
      assert.equal(probe.revealCalls.length, 0, 'a declined link reached the editor');
      assertHandlerRefusal(probe, REFUSAL.declined, 'declined legitimate link');
      assert.equal(probe.notifications.length, 0, 'declining is not restated as a notification');
      assert.deepEqual(
        visibleEditorSnapshot(),
        editorsBefore,
        'a declined link changed the editors',
      );
    });

    it('asks exactly "Open ‹file›:‹line›?" in a modal dialog, and a dismissed dialog opens nothing', async () => {
      const { link, request } = requireLegitimate();
      const editorsBefore = visibleEditorSnapshot();
      const probe = createProbe({});
      const dialogCalls: (readonly unknown[])[] = [];

      await withAnsweredWarningDialog(undefined, dialogCalls, () => probe.handler.handleUri(link));

      assert.equal(dialogCalls.length, 1, 'the production dialog is raised exactly once');
      const [question, options, ...actions] = dialogCalls[0] ?? [];
      assert.equal(question, `Open ${request.file}:${request.line}?`);
      assert.equal(recordOf(options)?.['modal'], true, 'the confirmation is modal');
      assert.deepEqual(
        actions,
        [CONFIRM_BUTTON],
        'the dialog offers exactly one affirmative action',
      );
      assert.equal(probe.revealCalls.length, 0, 'a dismissed dialog reached the editor');
      assertHandlerRefusal(probe, REFUSAL.declined, 'dismissed production dialog');
      assert.deepEqual(
        visibleEditorSnapshot(),
        editorsBefore,
        'a dismissed dialog changed the editors',
      );
    });

    it(`opens the link once when the production dialog is answered "${CONFIRM_BUTTON}"`, async () => {
      const { link } = requireLegitimate();
      const probe = createProbe({});
      const dialogCalls: (readonly unknown[])[] = [];

      await withAnsweredWarningDialog(CONFIRM_BUTTON, dialogCalls, () =>
        probe.handler.handleUri(link),
      );

      assert.equal(dialogCalls.length, 1, 'the production dialog is raised exactly once');
      await assertRevealedOnce(probe, 'production dialog answered Open');
    });
  });

  describe('the one URI handler this extension may register', () => {
    it('is reached through the manifest identity, which onUri activates', () => {
      const manifest = readExtensionManifest();
      assert.equal(`${manifest.publisher}.${manifest.name}`, EXTENSION_ID);
      assert.ok(
        manifest.activationEvents.includes('onUri'),
        'without onUri a link cannot wake a cold editor',
      );
      assert.equal(linkTo(IN_WORKSPACE.module, FIRST_POSITION).authority, EXTENSION_ID);
    });

    it('refuses a second registration once the activated extension owns the handler', async () => {
      const extension = await activateExtensionOnce();
      assert.equal(extension.isActive, true);

      const subscriptions: { dispose(): unknown }[] = [];
      const context = { subscriptions } as unknown as vscode.ExtensionContext;
      const accepted: vscode.Disposable[] = [];
      try {
        assert.throws(
          () => {
            // Collaborators that can open nothing, should the registration
            // ever be accepted before the `finally` disposes it.
            accepted.push(
              registerDebuggenUriHandler(context, {
                confirm: () => Promise.resolve(false),
                showWarning: () => undefined,
                workspaceFolders: () => [],
              }),
            );
          },
          // The editor's refusal of a second handler for the same extension:
          // "Protocol handler already registered for extension …". Its text
          // names the extension through an identifier object, not its id, so
          // the refusal is recognised by what it says rather than by the id.
          (error: unknown) => error instanceof Error && /already registered/i.test(error.message),
          'VS Code keeps one URI handler per extension, and activation already registered it',
        );
        assert.equal(subscriptions.length, 0, 'a refused registration is not owned by the context');
      } finally {
        for (const registration of accepted) {
          registration.dispose();
        }
      }
    });
  });
});
