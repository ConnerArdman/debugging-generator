/**
 * The `vscode://debuggen.debug-generator/open` entry point, and this
 * extension's own security boundary.
 *
 * ## Why this file is written the way it is
 *
 * A `vscode://` URI is navigable from a web page. Any site the developer
 * visits — not only the DevTools panel this product ships — can ask the editor
 * to route one here, so **every component of the URI is attacker-controlled**:
 * the path, the parameter names, their number, and their values. The handler
 * consequently trusts nothing, and in particular it does not trust the local
 * service: AAP §0.2.3 requires this file to perform "its own validation
 * independent of the service", because the service is not on the path a page
 * takes to get here.
 *
 * This is also the **fallback** hop, never the primary one. A click on a source
 * chip in the DevTools panel travels `SourceLink → PanelActions.openSource →
 * service worker → WebSocket source.open → the service → the connected editor
 * client`, and the editor client opens the location through
 * {@link openSourceLocation} in `src/source/open-location.ts` — which enforces
 * the *session's* project root. This URI exists for the case where no editor
 * client is connected (AAP §0.4.2). Because the convenient path is the one that
 * carries a session, nothing here is optimised for convenience: correctness
 * under hostile input is the only property that matters.
 *
 * ## The validation sequence
 *
 * Each step is a gate, and they run in exactly this order, so that a value only
 * ever reaches the next step having survived the previous one:
 *
 * 1. **Verb.** `uri.path` must be exactly {@link OPEN_SOURCE_URI_PATH}. There
 *    is no default action to fall through to.
 * 2. **Parameters.** `file`, `line` and `col` must each appear exactly once. A
 *    repeated parameter is a refusal rather than a "last one wins", because
 *    "last one wins" is how a benign-looking link smuggles a second value past
 *    a reviewer.
 * 3. **`file`.** `isSafeRelativePath` from `@debuggen/shared` (traversal, an
 *    absolute or drive-lettered or UNC form, a backslash, a control character
 *    and the empty string are all refused), plus a local refusal of a
 *    scheme-like prefix and a leading `~`.
 * 4. **`line`/`col`.** Matched as digit strings *before* they are parsed, then
 *    range-checked against {@link MAX_URI_LINE} and {@link MAX_URI_COLUMN}.
 * 5. **A workspace.** At least one folder must be open; with none, "inside the
 *    project" has no meaning to check against.
 * 6. **Canonical containment.** Both the folder and the candidate are resolved
 *    with `fs.realpath` and compared with `isWithin`, then the result must be a
 *    regular file. This is the step that defeats a symlink inside the workspace
 *    whose target is outside it — the escape the string-level gate in
 *    `@debuggen/shared`'s `paths.ts` documents as beyond its reach.
 * 7. **The developer.** A modal confirmation, `Open ‹file›:‹line›?`, with one
 *    `Open` button. Only that button proceeds.
 *
 * Only then is anything opened, and the opening itself is delegated to
 * {@link revealLocationInEditor} — the primitive that enforces no containment
 * policy precisely because its two callers disagree about what authorisation
 * means (AAP §0.2.3).
 *
 * ## What is deliberately *not* here
 *
 * - **No path arithmetic of its own.** The lexical gate is
 *   `@debuggen/shared`'s, so the attack table in `paths.test.ts` covers this
 *   file too, and `isWithin` is used rather than `startsWith` — `/proj-evil` is
 *   not inside `/proj`.
 * - **No second percent-decode.** `vscode.Uri.parse` has already decoded
 *   `query`, and `URLSearchParams` decodes the pairs it splits; nothing here
 *   calls `decodeURIComponent` on the result, and **every gate above runs on
 *   the fully decoded value**. That ordering is what makes `%252e%252e`
 *   harmless: by the time it has become `..` it still has to pass step 3, which
 *   refuses it. Two consequences of that one decode are worth knowing, and
 *   neither is a hole: a file name containing a literal `&` or `=` is *split*
 *   at that character, so the request names a shorter path — which the
 *   confirmation dialog displays verbatim and which step 6 must still prove is
 *   a regular file inside an open folder, so nothing is opened silently or
 *   outside the workspace; and `+` decodes to a space, since a query is
 *   form-encoded, so a `+` in a file name has to arrive as `%2B`. Producing
 *   these URIs is `PanelActions.openSource`'s side of the contract, and it
 *   encodes the value it sends.
 * - **No editor policy.** Selection, clamping, scrolling and the transient
 *   highlight belong to `src/source/open-location.ts` and are not duplicated.
 * - **No echo of hostile input.** Every message and log line this file produces
 *   is assembled from the constant table in {@link REJECTIONS} plus a
 *   {@link UriRejectionReason}; the raw query, the `file` value and the
 *   resolved absolute path never reach a notification, a log field or an error
 *   message (AAP §0.5.2). The one place the `file` value is displayed is the
 *   confirmation dialog — after step 6 has proved it names a regular file
 *   inside an open folder, and after step 3 has proved it carries no control
 *   character that could rewrite the dialog around it.
 * - **No existence oracle.** A path that does not exist, one that cannot be
 *   canonicalised and one that resolves outside every folder are refused
 *   identically, so the handler cannot be used to probe the developer's
 *   filesystem.
 *
 * ## Shape
 *
 * {@link parseOpenSourceUri} and {@link resolveWithinWorkspace} are exported
 * and pure with respect to the editor — the first touches nothing but its
 * argument, the second nothing but the filesystem — so the hostile-input table
 * in `test/suite/uri-handler.test.ts` can be exhaustive without driving a modal
 * dialog. {@link createOpenSourceUriHandler} composes them with the
 * confirmation and the reveal, every collaborator injectable, and
 * {@link registerDebuggenUriHandler} is the single registration site.
 */

import { lstat, realpath } from 'node:fs/promises';
import { resolve as resolveFsPath } from 'node:path';
import { URLSearchParams } from 'node:url';

import * as vscode from 'vscode';

import {
  DebuggenError,
  err,
  isSafeRelativePath,
  isWithin,
  mapErr,
  noopLogger,
  ok,
  toPosix,
} from '@debuggen/shared';
import type { DebuggenErrorCode, Logger, Result } from '@debuggen/shared';

import { revealLocationInEditor } from './source/open-location';

/**
 * The only `uri.path` this handler answers to, compared with `===`.
 *
 * Exact and case-sensitive, and that is the whole of the rule: `/open/`,
 * `//open`, `/Open`, `/open/source` and the empty path are all something else,
 * and something else has no behaviour here. A prefix or suffix match would
 * invent a second, undocumented verb out of whatever a caller appended.
 */
export const OPEN_SOURCE_URI_PATH = '/open';

/**
 * The highest 1-based line a URI may name.
 *
 * AAP §0.2.3 requires "out-of-range line/column values" to be rejected, and a
 * bound is what makes "out of range" decidable. A million lines is past any
 * source file a developer navigates and far below the point where the number
 * itself becomes interesting, so the constant costs nothing legitimate while
 * making the refusal a fixed, testable fact rather than a judgement about
 * whichever document happens to be on disk. The document's real length is the
 * reveal primitive's business: it clamps, because a capture can outlive the
 * edits made after it.
 */
export const MAX_URI_LINE = 1_000_000;

/**
 * The highest 1-based column a URI may name. Two orders of magnitude below the
 * line bound, for the same reason and with the same margin: a ten-thousand
 * character line is already pathological.
 */
export const MAX_URI_COLUMN = 10_000;

/** The lowest 1-based line or column, since the wire contract is 1-based. */
const MIN_URI_POSITION = 1;

/**
 * A line or column as it must be *written* in the query: one to seven ASCII
 * digits and nothing else.
 *
 * Applied to the raw string **before** any numeric conversion, which is the
 * only ordering that works. `Number.parseInt` and `Number` are both lenient in
 * ways that matter here — `parseInt('1abc')` is `1`, `Number(' 1 ')` is `1`,
 * `Number('1e3')` is `1000`, `Number('0x10')` is `16`, `Number('')` is `0` —
 * so a value converted first and validated afterwards has already lost the
 * evidence that it was malformed. Anchored at both ends, so no prefix or suffix
 * survives, and the digit class is ASCII-only: `[0-9]` rather than `\d` with
 * any Unicode flag, because a digit from another script is not a position this
 * product wrote.
 *
 * Seven digits is a deliberate ceiling below `Number.MAX_SAFE_INTEGER`: it caps
 * the value at 9 999 999 before {@link MAX_URI_LINE} and
 * {@link MAX_URI_COLUMN} narrow it further, so the range check operates on a
 * number that is already safe and the two checks can be read independently.
 */
const POSITION_PATTERN = /^[0-9]{1,7}$/;

/** The query parameter naming the project-relative file. */
const FILE_PARAMETER = 'file';

/** The query parameter naming the 1-based line. */
const LINE_PARAMETER = 'line';

/**
 * The query parameter naming the 1-based column.
 *
 * `col`, not `column`: AAP §0.2.3 fixes the fallback URI as
 * `vscode://debuggen.debug-generator/open?file&line&col`, and a handler that
 * silently accepted both spellings would make the documented one a suggestion.
 */
const COLUMN_PARAMETER = 'col';

/**
 * The label of the one button that proceeds, and the exact value
 * `showWarningMessage` resolves with when it is pressed.
 *
 * Declared once so the button and the comparison cannot drift: a dialog offering
 * `Open` while the code compares against something else would accept nothing,
 * and — far worse in the other direction — a comparison loose enough to accept
 * a dismissal would open a file nobody agreed to.
 */
const CONFIRM_ACTION = 'Open';

/**
 * The explanatory second line of the confirmation dialog.
 *
 * Modal dialogs are the only place VS Code renders `MessageOptions.detail`, and
 * the developer is being asked to authorise a filesystem read triggered by
 * something outside the editor, so the provenance belongs in front of them. The
 * string is a constant: no part of the request is interpolated into it.
 */
const CONFIRM_DETAIL =
  'A link asked Debug Generator to open this file at this position. Open it only if you expected it.';

/** The `vscode.Uri` scheme of a local file, the only kind of folder this handler can contain a path in. */
const FILE_SCHEME = 'file';

/** A scheme-like prefix anywhere in the `file` value, which a project-relative path never has. */
const SCHEME_SEPARATOR = '://';

/** A leading `~`, which a shell — not this product — expands to a home directory. */
const HOME_PREFIX = '~';

/**
 * A backslash anywhere in the `file` value.
 *
 * `isSafeRelativePath` already refuses one, and this file checks for it anyway.
 * The duplication is the point: the contract this handler enforces is
 * "project-relative POSIX", and stating it locally means a future change to the
 * shared predicate cannot quietly widen what a web page may name here.
 */
const BACKSLASH = '\\';

/** The one log message every refusal shares; the reason travels as a field, never in the text. */
const REJECTION_LOG_MESSAGE = 'Refused a vscode:// source-open request';

/**
 * Why a request was refused.
 *
 * Carried as `details.reason` on the {@link DebuggenError} every refusal
 * produces and as the only distinguishing field in the log line, which is what
 * makes a refusal diagnosable without repeating the hostile input that caused
 * it (AAP §0.5.2). The union is closed and exhaustively keyed by
 * {@link REJECTIONS}, so adding a reason without giving it a message, a hint
 * and a code is a compile error.
 *
 * - `unsupported-path` — `uri.path` was not {@link OPEN_SOURCE_URI_PATH}.
 * - `missing-parameter` — `file`, `line` or `col` was absent, or given more
 *   than once.
 * - `malformed-file` — the `file` value is not a project-relative POSIX path.
 * - `malformed-position` — `line` or `col` was not written as a plain decimal
 *   integer.
 * - `position-out-of-range` — a well-formed position below `1` or above its
 *   bound.
 * - `no-workspace` — no folder is open, so containment is undefined.
 * - `outside-workspace` — no open folder canonically contains the path. A
 *   path that does not exist, one that cannot be canonicalised and one that
 *   escapes through a symlink all arrive here, deliberately
 *   indistinguishable.
 * - `not-a-file` — the path is contained, but what it names is a directory, a
 *   socket, a FIFO or a device.
 * - `declined` — the developer did not press `Open`.
 * - `busy` — a confirmation for another request is already open, and dialogs
 *   are never stacked.
 * - `reveal-failed` — everything was authorised and the editor still could not
 *   open the document, which normally means the file changed underneath the
 *   request.
 * - `unexpected` — anything thrown that this file did not anticipate. It
 *   exists so `handleUri` can honour "never throws" without swallowing the
 *   failure silently.
 */
export type UriRejectionReason =
  | 'unsupported-path'
  | 'missing-parameter'
  | 'malformed-file'
  | 'malformed-position'
  | 'position-out-of-range'
  | 'no-workspace'
  | 'outside-workspace'
  | 'not-a-file'
  | 'declined'
  | 'busy'
  | 'reveal-failed'
  | 'unexpected';

/**
 * What a refusal says, and under which code it travels.
 *
 * Every field is a constant string: the developer-facing text of this file is
 * fully determined by the {@link UriRejectionReason}, so no code path exists
 * along which attacker-supplied text could reach a notification or a log. That
 * is a structural guarantee rather than a discipline to remember.
 */
interface RejectionDescriptor {
  /**
   * The closed-vocabulary code from `@debuggen/shared`, chosen so a caller — or
   * a reader of the output channel — can tell a malformed request from a
   * containment refusal without matching on prose.
   */
  readonly code: DebuggenErrorCode;

  /** One sentence stating that nothing was opened, and why. */
  readonly message: string;

  /** The developer's next step, in their terms. */
  readonly hint: string;
}

/**
 * The complete text of every refusal, keyed exhaustively by reason.
 *
 * `Record<UriRejectionReason, …>` rather than a partial map, so a new reason
 * cannot be introduced without deciding what the developer is told and which
 * code it reports under.
 *
 * On the codes, since the vocabulary in `@debuggen/shared` is closed and its
 * own guidance says an inaccurate code removes the only signal a user interface
 * has:
 *
 * - `PROTOCOL_INVALID_MESSAGE` for every malformed request. A URI is a frame
 *   that did not parse as the one message this handler accepts, which is
 *   exactly what that code names — and `src/source/open-location.ts` already
 *   uses it for a broken position arriving "from a hand-built call or a URI
 *   query".
 * - `PATH_OUTSIDE_PROJECT` for the containment refusal. The vocabulary's
 *   guidance names this handler as one of the two places that raise it, "because
 *   a click-to-source request can originate from a page".
 * - `FS_UNSAFE_PATH` for a contained path that is not a regular file: a policy
 *   refusal about a filesystem object, not a raw errno under another name.
 * - `PROJECT_NOT_FOUND` when there is no folder to contain anything, and for a
 *   document the editor could not open.
 * - `UNAUTHORIZED` for a declined confirmation, which is precisely a refused
 *   authorisation.
 * - `RATE_LIMITED` for the flood guard, whose guidance — "the caller should
 *   back off, not retry immediately" — is the whole of this case.
 */
const REJECTIONS: Readonly<Record<UriRejectionReason, RejectionDescriptor>> = Object.freeze({
  'unsupported-path': {
    code: 'PROTOCOL_INVALID_MESSAGE',
    message: 'Debug Generator ignored a link that does not name a supported action.',
    hint: 'Only the source-location link this extension publishes is handled.',
  },
  'missing-parameter': {
    code: 'PROTOCOL_INVALID_MESSAGE',
    message: 'Debug Generator ignored a link with missing or repeated parameters.',
    hint: 'A link must name a file, a line and a column exactly once each.',
  },
  'malformed-file': {
    code: 'PROTOCOL_INVALID_MESSAGE',
    message: 'Debug Generator ignored a link whose file is not a project-relative path.',
    hint: 'A link may name only a path inside an open folder, written with forward slashes.',
  },
  'malformed-position': {
    code: 'PROTOCOL_INVALID_MESSAGE',
    message: 'Debug Generator ignored a link whose line or column is not a whole number.',
    hint: 'Both positions are plain 1-based whole numbers.',
  },
  'position-out-of-range': {
    code: 'PROTOCOL_INVALID_MESSAGE',
    message: 'Debug Generator ignored a link whose line or column is out of range.',
    hint: `Lines run from ${MIN_URI_POSITION} to ${MAX_URI_LINE} and columns to ${MAX_URI_COLUMN}.`,
  },
  'no-workspace': {
    code: 'PROJECT_NOT_FOUND',
    message: 'Debug Generator cannot open a file because no folder is open in this window.',
    hint: 'Open the project folder first, then use the link again.',
  },
  'outside-workspace': {
    code: 'PATH_OUTSIDE_PROJECT',
    message: 'Debug Generator refused a link that does not resolve to a file in an open folder.',
    hint: 'Links can only open files inside the folders open in this window.',
  },
  'not-a-file': {
    code: 'FS_UNSAFE_PATH',
    message: 'Debug Generator refused a link because the path it names is not a regular file.',
    hint: 'Only a regular file can be opened in an editor.',
  },
  declined: {
    code: 'UNAUTHORIZED',
    message: 'Debug Generator did not open the file.',
    hint: 'The request was not confirmed, so nothing was opened.',
  },
  busy: {
    code: 'RATE_LIMITED',
    message: 'Debug Generator is already asking about another link.',
    hint: 'Answer the open dialog, then use the link again.',
  },
  'reveal-failed': {
    code: 'PROJECT_NOT_FOUND',
    message: 'Debug Generator could not open the file the link named.',
    hint: 'The file may have been moved, renamed or changed since the link was made.',
  },
  unexpected: {
    code: 'INTERNAL',
    message: 'Debug Generator could not handle the link.',
    hint: 'Check the Debug Generator output channel, then use the link again.',
  },
});

/**
 * Builds the error for one refusal reason.
 *
 * The message and the hint come from {@link REJECTIONS} and the reason travels
 * in `details`, so every error this module produces is diagnosable and none of
 * them can carry the request that caused it. A `cause` is attached when the
 * refusal wraps a thrown value or another module's error, which keeps the
 * original reachable through the standard property without putting any of it in
 * the text.
 */
function rejection(reason: UriRejectionReason, cause?: unknown): DebuggenError {
  const descriptor = REJECTIONS[reason];
  const options = { hint: descriptor.hint, details: { reason } };

  return cause === undefined
    ? new DebuggenError(descriptor.code, descriptor.message, options)
    : new DebuggenError(descriptor.code, descriptor.message, { ...options, cause });
}

/**
 * The single short sentence a refusal shows the developer: the statement and
 * the next step, in that order, and nothing else.
 */
function refusalNotification(reason: UriRejectionReason): string {
  const descriptor = REJECTIONS[reason];
  return `${descriptor.message} ${descriptor.hint}`;
}

/**
 * A validated `open` request: the three values, and nothing derived from them.
 *
 * `file` is still the **project-relative POSIX path as written** — validated,
 * but not resolved. That is deliberate: it is the value the confirmation dialog
 * shows the developer, and an absolute path would disclose the filesystem
 * layout for no benefit (AAP §0.5.2). Resolution happens in
 * {@link resolveWithinWorkspace}, which returns a URI and keeps the resolved
 * path out of every other surface.
 *
 * `line` and `column` are 1-based, as everything on this product's wire is
 * (AAP §0.2.3); the single conversion to VS Code's 0-based `Position` lives in
 * `src/source/open-location.ts`.
 */
export interface ParsedOpenRequest {
  /** The project-relative POSIX path, exactly as the URI wrote it. */
  readonly file: string;

  /** The 1-based line, between {@link MIN_URI_POSITION} and {@link MAX_URI_LINE}. */
  readonly line: number;

  /** The 1-based column, between {@link MIN_URI_POSITION} and {@link MAX_URI_COLUMN}. */
  readonly column: number;
}

/**
 * The collaborators {@link createOpenSourceUriHandler} and
 * {@link registerDebuggenUriHandler} may have substituted.
 *
 * Every member is optional and defaults to the production implementation, so
 * `registerDebuggenUriHandler(context)` is a complete call. They exist because
 * the assertions this file has to support — "a traversal opens nothing", "a
 * symlink escaping the workspace opens nothing", "declining opens nothing",
 * "no workspace is a refusal" — are about what did *not* happen, and a test
 * that cannot substitute the confirmation would have to drive a modal dialog to
 * make any of them.
 */
export interface UriHandlerDeps {
  /** Where refusals and successful opens are logged. Absent means no logging. */
  readonly logger?: Logger;

  /**
   * Asks the developer to authorise one request, resolving `true` only for an
   * explicit yes.
   *
   * Defaults to the modal dialog of AAP §0.2.3. A substitute must keep the
   * contract that matters: resolve `false` for anything that is not an explicit
   * confirmation, and never reject.
   */
  readonly confirm?: (request: ParsedOpenRequest) => Promise<boolean>;

  /**
   * The editor primitive that opens the document. Defaults to
   * {@link revealLocationInEditor}, which owns the 1-based conversion, the
   * selection, the clamping and the transient highlight.
   */
  readonly reveal?: typeof revealLocationInEditor;

  /**
   * How a refusal is shown. Defaults to a non-awaiting
   * `vscode.window.showWarningMessage`.
   */
  readonly showWarning?: (message: string) => void;

  /**
   * The open folders to check containment against. Defaults to
   * `vscode.workspace.workspaceFolders`, and is injectable so the
   * no-workspace refusal can be asserted in a window that does have one open.
   */
  readonly workspaceFolders?: () => readonly vscode.WorkspaceFolder[] | undefined;
}

/**
 * Reads a query parameter that must appear **exactly once**.
 *
 * `getAll` rather than `get`, because `get` answers with the first value and
 * says nothing about how many there were. `?file=a&file=../../b` is not a
 * request with an interesting second opinion; it is a request that two readers
 * would disagree about, so it is not honoured at all.
 *
 * An empty value (`?file=`) counts as present and is refused one step later, by
 * the validator that owns the shape of that parameter — which keeps "how many"
 * and "what" as two separate questions with two separate reasons.
 *
 * @returns The single value, or `undefined` when the parameter was absent or
 * repeated.
 */
function singleParameter(params: URLSearchParams, name: string): string | undefined {
  const values = params.getAll(name);
  return values.length === 1 ? values[0] : undefined;
}

/**
 * Whether a `file` value may be treated as a project-relative POSIX path.
 *
 * The first call does the work: `isSafeRelativePath` refuses the empty and
 * whitespace-only string, any C0 or C1 control character (NUL, which truncates
 * a path in C string APIs, and ESC, which rewrites a log line), any backslash,
 * every absolute form — POSIX, Windows drive-lettered, UNC — and any `..`
 * segment that survives lexical normalisation. Its attack table in
 * `packages/shared/src/paths.test.ts` is the specification for all of that, and
 * reimplementing it here would mean maintaining a second, weaker one.
 *
 * The three local refusals afterwards are this file's own, and are not
 * redundant in spirit even where they overlap: a URI is written by whoever
 * navigated to it, so `https://elsewhere/x`, `C:\x` and `~/.ssh/id_ed25519` are
 * the shapes a caller reaches for when guessing what the handler might accept,
 * and each is refused by name rather than by a general rule a later edit could
 * loosen. An absolute path is never a convenience here: the contract is
 * project-relative (AAP §0.2.3), and resolving an absolute path against a
 * workspace folder would mean answering "which folder is it absolute to?".
 */
function isAcceptableFile(file: string): boolean {
  if (!isSafeRelativePath(file)) {
    return false;
  }

  if (file.includes(SCHEME_SEPARATOR)) {
    return false;
  }

  if (file.includes(BACKSLASH)) {
    return false;
  }

  return !file.startsWith(HOME_PREFIX);
}

/**
 * Validates one position parameter and converts it, in that order.
 *
 * See {@link POSITION_PATTERN} for why the string is matched before it is
 * parsed. `Number.isSafeInteger` afterwards is belt and braces — seven digits
 * cannot exceed the safe range — kept because it is the property the range
 * check assumes, and an assumption that is cheap to state should be stated.
 *
 * @param raw The parameter value exactly as it was written.
 * @param max The inclusive upper bound for this axis.
 * @returns The 1-based value, or the reason it was refused.
 */
function parsePosition(raw: string, max: number): Result<number, UriRejectionReason> {
  if (!POSITION_PATTERN.test(raw)) {
    return err('malformed-position');
  }

  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value)) {
    return err('malformed-position');
  }

  if (value < MIN_URI_POSITION || value > max) {
    return err('position-out-of-range');
  }

  return ok(value);
}

/**
 * The parse, expressed in reasons — the form the handler wants, because it logs
 * the reason and builds the error once.
 *
 * {@link parseOpenSourceUri} is the same function with the reason wrapped in a
 * {@link DebuggenError}, which is the form a caller outside this module wants.
 */
function parseOpenRequest(uri: vscode.Uri): Result<ParsedOpenRequest, UriRejectionReason> {
  // 1. The verb. The authority is deliberately not re-checked: VS Code routes a
  //    `vscode://<publisher>.<name>/…` URI to the extension named in it, so a
  //    handler only ever sees its own, and a second identity check here would
  //    be a copy of the extension id with no authority of its own. The path is
  //    what selects behaviour, and it is checked exactly.
  if (uri.path !== OPEN_SOURCE_URI_PATH) {
    return err('unsupported-path');
  }

  // 2. The parameters. `uri.query` has already been percent-decoded by
  //    `Uri.parse`; `URLSearchParams` splits the pairs and decodes each one,
  //    and nothing below decodes again — every gate that follows reads the
  //    fully decoded value, which is what makes a doubly-encoded traversal a
  //    refusal rather than a bypass. Unknown extra parameters are ignored: they
  //    cannot influence any decision, so refusing them would only make the URI
  //    brittle.
  const params = new URLSearchParams(uri.query);
  const file = singleParameter(params, FILE_PARAMETER);
  const line = singleParameter(params, LINE_PARAMETER);
  const column = singleParameter(params, COLUMN_PARAMETER);
  if (file === undefined || line === undefined || column === undefined) {
    return err('missing-parameter');
  }

  // 3. The path, as text.
  if (!isAcceptableFile(file)) {
    return err('malformed-file');
  }

  // 4. The position, as text and then as a number.
  const parsedLine = parsePosition(line, MAX_URI_LINE);
  if (!parsedLine.ok) {
    return err(parsedLine.error);
  }

  const parsedColumn = parsePosition(column, MAX_URI_COLUMN);
  if (!parsedColumn.ok) {
    return err(parsedColumn.error);
  }

  return ok({ file, line: parsedLine.value, column: parsedColumn.value });
}

/**
 * Validates a `vscode://debuggen.debug-generator/open` URI, touching nothing
 * but its argument.
 *
 * Pure: no filesystem, no editor, no module state, no clock. That is what lets
 * the hostile-input table be exhaustive and fast, and it is why this function
 * rather than the handler is the one a test hammers.
 *
 * What it proves, and no more: the URI names this handler's one action, carries
 * each of its three parameters exactly once, and its `file` is a
 * project-relative POSIX path that cannot escape *as text*, with a 1-based line
 * and column inside their bounds. What it deliberately does not prove: that
 * anything exists on disk, or that the path stays inside an open folder once
 * symbolic links are resolved. Those are filesystem questions, and
 * {@link resolveWithinWorkspace} is the only answer to them — a caller that
 * opens what this function returns without that second step has validated a
 * string and authorised a file.
 *
 * @param uri The URI as VS Code routed it.
 * @returns `Ok` with the validated request, or `Err` carrying
 * `PROTOCOL_INVALID_MESSAGE` and the {@link UriRejectionReason} in
 * `details.reason`. Never throws.
 */
export function parseOpenSourceUri(uri: vscode.Uri): Result<ParsedOpenRequest, DebuggenError> {
  return mapErr(parseOpenRequest(uri), rejection);
}

/**
 * Canonicalises a candidate against one folder and answers only if the folder
 * genuinely contains it.
 *
 * **Both** sides are resolved with `realpath`, and that is the load-bearing
 * detail. Canonicalising only the candidate leaves the comparison running
 * against a root that may itself be reached through a link — the common case on
 * macOS, where `/tmp` is `/private/tmp`, and in any checkout the developer
 * reaches through a symlinked parent — so a legitimate file would be refused
 * while the escape this step exists to catch would still get through the
 * opposite mismatch. Resolving both puts the two paths in the same namespace,
 * which is the only namespace in which `isWithin` means anything.
 *
 * `isWithin` rather than a prefix test: it requires equality or the root plus
 * exactly one separator and at least one further character, which is what makes
 * `/proj-evil` not inside `/proj`. Both paths are converted with `toPosix`
 * first, because the gate is defined over POSIX separators.
 *
 * A failure to canonicalise either side — `ENOENT` for a path that does not
 * exist, `ELOOP` for a link cycle, `EACCES` for a directory the process cannot
 * traverse, `ENAMETOOLONG`, anything else — answers `undefined`, the same
 * answer an uncontained path gets. The caller cannot distinguish them, and
 * neither can whoever navigated to the URI: a handler that reported "that file
 * does not exist" separately from "that file is not yours to open" would be a
 * filesystem oracle for any page that can fire a URI.
 *
 * @param rootFsPath The folder's own path, as `folder.uri.fsPath` gave it.
 * @param file The validated project-relative POSIX path.
 * @returns The canonical absolute path when the folder contains it, otherwise
 * `undefined`. Never throws.
 */
async function resolveInFolder(rootFsPath: string, file: string): Promise<string | undefined> {
  // Safe because `file` has passed `isAcceptableFile`: with no absolute form
  // and no surviving `..`, `resolve` can only descend from the root. The
  // canonical check below is what covers what a string cannot.
  const candidate = resolveFsPath(rootFsPath, file);

  let realRoot: string;
  let realCandidate: string;
  try {
    realRoot = await realpath(rootFsPath);
    realCandidate = await realpath(candidate);
  } catch {
    return undefined;
  }

  return isWithin(toPosix(realRoot), toPosix(realCandidate)) ? realCandidate : undefined;
}

/**
 * Whether a canonical path names a regular file.
 *
 * `lstat`, not `stat`, even though `realpath` has already resolved every link
 * in the chain: if a link has appeared at that path in the interval — the
 * window between the check and the open that no single syscall closes —
 * `lstat` reports the link itself and `isFile()` is `false`, so the race
 * resolves to a refusal. `stat` would follow the new link and report on its
 * target, which is the one answer that must not be given here.
 *
 * Everything that is not a regular file is refused, not only a directory:
 * opening a FIFO blocks on a reader that may never come, a character device can
 * be endless, and a socket is not a document. A `stat` that throws is a
 * refusal too.
 */
async function isRegularFile(fsPath: string): Promise<boolean> {
  try {
    const stats = await lstat(fsPath);
    return stats.isFile();
  } catch {
    return false;
  }
}

/**
 * The containment step, expressed in reasons. See
 * {@link resolveWithinWorkspace} for the contract; this is the same function
 * before the reason is wrapped in an error.
 */
async function resolveOpenRequest(
  request: ParsedOpenRequest,
  folders: readonly vscode.WorkspaceFolder[],
): Promise<Result<vscode.Uri, UriRejectionReason>> {
  if (folders.length === 0) {
    return err('no-workspace');
  }

  // Re-validated rather than assumed. This function is exported, so it is
  // reachable with a request that never passed `parseOpenSourceUri` — from the
  // host's own code, or from a test — and `resolve` with an absolute second
  // argument discards the first, which would turn one hand-built call into an
  // arbitrary-file read. The check is a few string operations; the assumption
  // would be a vulnerability.
  if (!isAcceptableFile(request.file)) {
    return err('malformed-file');
  }

  // Remembered rather than returned immediately: in a multi-root window the
  // same relative path can name a directory in one folder and a file in
  // another, so a non-file resolution means "this folder does not have the
  // file" and the search continues. The flag only decides which reason is
  // reported once every folder has been tried, which is what makes the refusal
  // precise without making it order-dependent.
  let sawNonFile = false;

  // First match wins, in the order the window lists its folders — the order
  // `vscode.workspace.workspaceFolders` returns, which is stable for a given
  // window. Deterministic by construction: no folder is preferred by depth,
  // name or length of match.
  for (const folder of folders) {
    // A folder on a virtual filesystem (`vscode-vfs:`, `untitled:`, a remote
    // provider) has no path `realpath` can canonicalise, so containment cannot
    // be established for it and it is skipped. Refusing is the only safe
    // answer; a `fsPath` derived from a non-file scheme is a fabrication.
    if (folder.uri.scheme !== FILE_SCHEME) {
      continue;
    }

    const resolved = await resolveInFolder(folder.uri.fsPath, request.file);
    if (resolved === undefined) {
      continue;
    }

    if (!(await isRegularFile(resolved))) {
      sawNonFile = true;
      continue;
    }

    // The URI is built from the canonical path — the exact path that passed
    // containment — and not from the lexical candidate. Opening anything else
    // would mean authorising one path and reading another.
    return ok(vscode.Uri.file(resolved));
  }

  return err(sawNonFile ? 'not-a-file' : 'outside-workspace');
}

/**
 * Resolves a validated request to a file the developer's own workspace
 * genuinely contains.
 *
 * This is the filesystem half of the boundary, and the half the string-level
 * gate in `@debuggen/shared`'s `paths.ts` explicitly cannot cover: that module
 * is pure string logic and says so, naming this file as the place where
 * `fs.realpath` closes the gap. A symlink inside the workspace whose target
 * lies outside it passes every lexical check ever written and is refused here.
 *
 * The policy is the **open workspace folders**, and that is a different policy
 * from the one `openSourceLocation` in `src/source/open-location.ts` enforces —
 * the session's `projectRoot`. Neither subsumes the other: a URI can arrive
 * with no session at all, and a session's project root can be a folder the
 * window does not have open. Merging them would weaken both, which is why
 * AAP §0.2.3 keeps them apart and why this function does not consult a session.
 *
 * @param request A request whose `file` is a project-relative POSIX path. It is
 * re-validated here, whatever validated it before.
 * @param folders The open folders to check containment against, in the order
 * the window lists them. The first folder that canonically contains a regular
 * file at the path wins.
 * @returns `Ok` with a `file:` URI for the canonical path, or `Err` carrying
 * `PROJECT_NOT_FOUND` (no folders), `PROTOCOL_INVALID_MESSAGE` (the path is not
 * project-relative), `FS_UNSAFE_PATH` (contained, but not a regular file) or
 * `PATH_OUTSIDE_PROJECT` (no folder contains it, including because it does not
 * exist). Never throws, and never rejects.
 */
export async function resolveWithinWorkspace(
  request: ParsedOpenRequest,
  folders: readonly vscode.WorkspaceFolder[],
): Promise<Result<vscode.Uri, DebuggenError>> {
  return mapErr(await resolveOpenRequest(request, folders), rejection);
}

/**
 * The production confirmation: one modal dialog, one affirmative button.
 *
 * Modal is required, not stylistic. A non-modal notification can be missed
 * entirely while a page fires URIs, and "missed" would mean a file opened
 * without anybody deciding to open it. The dialog also has exactly one action
 * besides dismissal, so there is no second button whose label could be
 * misread — anything that is not {@link CONFIRM_ACTION}, including `Escape`,
 * dismissal, window closure and the `undefined` those produce, is a refusal.
 *
 * The question is the one AAP §0.2.3 specifies, `Open ‹file›:‹line›?`, and it
 * shows the **project-relative** path: it is the path the developer recognises,
 * and the resolved absolute path would disclose the filesystem layout to
 * whatever is looking over their shoulder for no gain (AAP §0.5.2). By the time
 * this runs, that value has passed every gate — no control character can
 * rewrite the dialog around it, and the path is known to name a regular file
 * inside a folder the window has open.
 */
async function confirmOpenRequest(request: ParsedOpenRequest): Promise<boolean> {
  const answer = await vscode.window.showWarningMessage(
    `Open ${request.file}:${request.line}?`,
    { modal: true, detail: CONFIRM_DETAIL },
    CONFIRM_ACTION,
  );

  return answer === CONFIRM_ACTION;
}

/**
 * The production refusal sink: one warning notification, not waited on.
 *
 * `showWarningMessage` resolves when the notification is dismissed, and a
 * refusal has no decision to collect, so the thenable is discarded deliberately
 * with `void` rather than left to float — the same treatment
 * `src/source/open-location.ts` gives its own notifications.
 */
function showWarningNotification(message: string): void {
  void vscode.window.showWarningMessage(message);
}

/**
 * The production source of open folders.
 *
 * Read through a function rather than captured once, because
 * `vscode.workspace.workspaceFolders` changes while the window lives: a folder
 * added or removed after activation must be reflected in the very next request,
 * and a captured array would authorise against a workspace that no longer
 * exists.
 */
function defaultWorkspaceFolders(): readonly vscode.WorkspaceFolder[] | undefined {
  return vscode.workspace.workspaceFolders;
}

/** The one log message a completed open produces; no path appears in its fields. */
const OPEN_LOG_MESSAGE = 'Opened a source location requested through a vscode:// URI';

/**
 * Builds the handler, with its own flood-guard state and its collaborators
 * bound.
 *
 * Separate from {@link registerDebuggenUriHandler} for one reason: a test — and
 * the host suite in `test/suite/uri-handler.test.ts` in particular — has to be
 * able to drive `handleUri` directly. Going through the editor's URI routing
 * would mean asking the operating system to dispatch a `vscode://` navigation
 * and then waiting to see whether nothing happened, which is not an assertion
 * anybody can write.
 *
 * The state that makes this a factory rather than a bare function is the
 * `pending` flag. It is a closure field, one per handler, never a module
 * global: module state would be shared by every handler a test constructs, so
 * one test's dialog would make the next test's request `busy`, and the guard
 * would be untestable in exactly the scenario it exists for.
 *
 * @param deps Collaborators to substitute; every one is optional and defaults
 * to the production implementation.
 * @returns A `vscode.UriHandler` whose `handleUri` never throws and never
 * rejects.
 */
export function createOpenSourceUriHandler(deps: UriHandlerDeps = {}): vscode.UriHandler {
  const logger = deps.logger ?? noopLogger;
  const confirm = deps.confirm ?? confirmOpenRequest;
  const reveal = deps.reveal ?? revealLocationInEditor;
  const showWarning = deps.showWarning ?? showWarningNotification;
  const readWorkspaceFolders = deps.workspaceFolders ?? defaultWorkspaceFolders;

  /**
   * Whether a confirmation raised by this handler is still unanswered.
   *
   * Checked and set in one synchronous step, which is what makes it a correct
   * guard on a single-threaded runtime: whichever request reaches the check
   * first owns the dialog, and every other request in flight is refused rather
   * than queued.
   */
  let pending = false;

  /**
   * Reports one refusal: a single log line and, for most reasons, a single
   * notification.
   *
   * Nothing attacker-supplied reaches either. The text comes from
   * {@link REJECTIONS}, and the log fields are the reason, this module's code
   * and — when the refusal wraps another module's error — that error's code.
   * The raw query, the `file` value and the resolved path appear nowhere
   * (AAP §0.5.2).
   *
   * Two reasons are logged without a notification, and they share one
   * rationale: the developer has already seen the dialog the refused request is
   * about. `busy` fires while that dialog is open, and `declined` fires because
   * they answered it — so a toast would restate their own decision, and a page
   * firing hundreds of navigations would produce hundreds of toasts, which is
   * the very flood the guard exists to prevent. Everything else is stated
   * exactly once, because a request that was ignored silently is
   * indistinguishable from a broken extension (AAP §0.5.5).
   */
  function refuse(reason: UriRejectionReason, cause?: unknown): void {
    const error = rejection(reason, cause);

    const fields: Record<string, unknown> = { reason, code: error.code };
    if (DebuggenError.is(cause)) {
      fields.causeCode = cause.code;
    }
    logger.warn(REJECTION_LOG_MESSAGE, fields);

    if (reason !== 'busy' && reason !== 'declined') {
      showWarning(refusalNotification(reason));
    }
  }

  /**
   * The whole flow: parse, then workspace, then containment, then the flood
   * guard, then the developer, then the editor.
   *
   * Thin by design — each step is one call to one of the functions above — and
   * wrapped in a `try` that turns anything unforeseen into a refusal, because a
   * throw from a URI handler surfaces as an unhandled extension error and tells
   * the developer nothing about the request that caused it.
   */
  async function handleUri(uri: vscode.Uri): Promise<void> {
    try {
      // Steps 1-4: the URI as text. Nothing has been touched on disk yet.
      const parsed = parseOpenRequest(uri);
      if (!parsed.ok) {
        refuse(parsed.error);
        return;
      }
      const request = parsed.value;

      // Step 5: a workspace to be contained by. Without one there is no policy
      // to apply, and a handler with no policy opens anything.
      const folders = readWorkspaceFolders();
      if (folders === undefined || folders.length === 0) {
        refuse('no-workspace');
        return;
      }

      // Step 6: the canonical containment check, the gate a symlink cannot
      // cross.
      const resolved = await resolveOpenRequest(request, folders);
      if (!resolved.ok) {
        refuse(resolved.error);
        return;
      }

      // Step 8, ahead of the dialog it guards: one unanswered confirmation at a
      // time, so a page cannot trap the developer in a stack of dialogs.
      if (pending) {
        refuse('busy');
        return;
      }

      pending = true;
      try {
        // Step 7: the developer decides. Nothing is opened for any answer but
        // an explicit confirmation.
        const confirmed = await confirm(request);
        if (!confirmed) {
          refuse('declined');
          return;
        }

        // Step 9: the editor primitive owns everything about the document —
        // the 1-based conversion, the selection, clamping a position the file
        // no longer has, the scroll and the transient highlight.
        const revealed = await reveal(resolved.value, request.line, request.column, { logger });
        if (!revealed.ok) {
          refuse('reveal-failed', revealed.error);
          return;
        }

        // No path, by design: the position and the clamp flag identify the
        // outcome without recording where on the developer's disk it happened.
        logger.info(OPEN_LOG_MESSAGE, {
          line: request.line,
          column: request.column,
          clamped: revealed.value.clamped,
        });
      } finally {
        // Released on every path out of the confirmation and the reveal,
        // including a refusal and a thrown value. A guard that could stay set
        // would turn one failure into a handler that refuses everything for the
        // rest of the session.
        pending = false;
      }
    } catch (caught) {
      refuse('unexpected', caught);
    }
  }

  return { handleUri };
}

/**
 * Registers the extension's `vscode://` handler. The single registration site.
 *
 * VS Code permits **one** URI handler per extension —
 * `window.registerUriHandler` keys them by extension id — so this function is
 * called exactly once, from `activate`, and a second call anywhere would
 * silently replace the first. That is why the verb dispatch lives in
 * {@link parseOpenSourceUri} rather than being spread across several
 * registrations.
 *
 * `onUri` is in this extension's `activationEvents`, which is what makes the
 * handler reachable from a cold editor: a navigation activates the extension,
 * activation registers the handler, and VS Code then delivers the URI that
 * caused the activation. A handler registered late — after an `await` in
 * `activate` — can therefore miss the very request that woke the extension, so
 * this call belongs on the synchronous path of activation.
 *
 * The registration is pushed into `context.subscriptions`, because the editor
 * disposing it on deactivation is the only thing that stops a reloaded window
 * from holding a handler for an extension instance that no longer exists. It is
 * also returned, for a caller that wants to dispose it earlier than
 * deactivation — a test, or a command that deliberately stops handling URIs.
 * A caller that pushes the returned value as well is harmless: a VS Code
 * disposable runs its callback at most once.
 *
 * @param context The activation context whose `subscriptions` take ownership of
 * the registration.
 * @param deps Collaborators to substitute; every one is optional, so
 * `registerDebuggenUriHandler(context)` is a complete call.
 * @returns The registration, already owned by `context.subscriptions`.
 */
export function registerDebuggenUriHandler(
  context: vscode.ExtensionContext,
  deps: UriHandlerDeps = {},
): vscode.Disposable {
  const registration = vscode.window.registerUriHandler(createOpenSourceUriHandler(deps));
  context.subscriptions.push(registration);

  return registration;
}
