/**
 * Click-to-source, editor end: the terminal hop of the product's source-open
 * path (AAP §0.4.2).
 *
 * ```text
 * SourceLink → PanelActions.openSource → the DevTools panel's actions.ts
 *   → a runtime port → the Chrome service worker → WebSocket `source.open`
 *   → the local service, which validates containment against the session's
 *     projectRoot → WebSocket to the VS Code client → THIS MODULE
 *   → WebSocket `source.result` back to the service, relayed to the panel
 * ```
 *
 * Everything upstream of here is transport. This module is where a
 * {@link SourceLocation} — project-relative POSIX file, 1-based line, 1-based
 * column — becomes a document, a cursor, a selection and a brief line
 * highlight in the developer's editor, which is the moment the product either
 * lands on the `pool.query` call site the panel pointed at (AAP §0.8.4,
 * acceptance test 1) or quietly opens the wrong line and loses the developer's
 * trust.
 *
 * ## Two entry points, deliberately not merged
 *
 * The module exposes two functions because its two callers have **incompatible
 * containment policies**, and collapsing them would mean one of the two
 * silently getting the other's:
 *
 * - {@link revealLocationInEditor} is the editor primitive and has **no
 *   containment policy of its own**. It takes a `vscode.Uri` a caller has
 *   already decided to trust, and validates only the numeric contract;
 *   {@link revealDocumentInEditor} is the same primitive for a document the
 *   caller already loaded and verified. This is
 *   what `src/uri-handler.ts` uses, because a `vscode://` URI can be triggered
 *   by any web page and is therefore validated against the **open workspace
 *   folders** with `fs.realpath` and a developer confirmation — a policy this
 *   module must not second-guess (AAP §0.2.3).
 * - {@link openSourceLocation} is the session-scoped opener, and the sink every
 *   other editor open ends in: each inbound `source.open` message
 *   (`src/extension.ts`), the `debuggen.openSource` command, and the session
 *   view's `openFile` frame that dispatches to it. Its policy is the
 *   **session's `projectRoot`**, proved here even though
 *   `apps/local-service`'s `source/open.ts` already checked a forwarded frame:
 *   the location is untrusted at every hop, so this sink proves containment
 *   itself instead of trusting an upstream verdict.
 *
 * ## The canonical, identity-pinned gate
 *
 * A lexical check cannot see a symbolic link: `src/link/passwd` is inside the
 * project as text when `src/link → /etc`. And a check made anywhere else — the
 * service's `realpath` before it forwards a frame — is true only at the
 * instant it was made, while the frame still has a socket to cross. So the
 * session-scoped opener proves, itself and immediately before it shows
 * anything, that the location names a regular file inside the canonical
 * project root:
 *
 * - both the root and the candidate are resolved with `fs.realpath`, so every
 *   link on the path counts, and the candidate must land strictly inside;
 * - the canonical path must be a regular file under a non-following `lstat`,
 *   whose device and inode become its identity;
 * - a forwarded frame carries the service's pin — the canonical relative path,
 *   device and inode it proved — and anything else resolved here is refused,
 *   which is what defeats a link re-pointed while the frame was queued;
 * - the canonical path is opened `O_NOFOLLOW` and the descriptor must still be
 *   that inode;
 * - holding that descriptor, the document is loaded without being shown, and
 *   the path must *still* name the same inode afterwards, and the document's
 *   text must equal the bytes read through the descriptor after the load;
 * - only then is that same loaded document revealed — never the path reopened
 *   — and the descriptor is released once the editor shows it.
 *
 * VS Code loads a document by path through its own file service, which offers
 * no no-follow read, so the gate brackets that read instead of trusting it: a
 * name re-pointed after the probe is caught by the identity check that follows
 * the load, and one re-pointed and restored within it is caught by the text
 * check unless the text it read is the proved file's own. What the editor
 * shows is therefore the proved file's content, under a path proved after the
 * load to name it. A load the gate refuses is never shown.
 *
 * It is the same sequence `src/uri-handler.ts` applies to a `vscode://` URI
 * against the open workspace folders, applied here against the session's
 * project root; the two policies stay separate because neither root subsumes
 * the other.
 *
 * ## The answer the panel is waiting for
 *
 * A click in the DevTools panel is not done when a frame was queued: the panel
 * shows success only once the editor has opened the location. So every
 * `source.open` the service forwards is answered with one `source.result`,
 * built by {@link sourceResultFor} from what became of the attempt — `opened`,
 * or `failed` with an error code and a constant sentence that repeats nothing
 * the editor saw. `src/extension.ts` sends it; the service relays it.
 *
 * ## The one place the off-by-one lives
 *
 * The wire contract is 1-based on both axes; `vscode.Position` is 0-based on
 * both. The subtraction happens in exactly one private helper here,
 * {@link toZeroBasedPosition}, and nowhere else in the extension — see the
 * comment on that function, and the note in `@debuggen/shared`'s
 * `source-location.ts` that names this file as the single conversion site.
 *
 * ## Failure behaviour and privacy
 *
 * Neither entry point throws and neither returned promise rejects: every
 * outcome is a `Result`, so a stale panel row, a deleted file or a malformed
 * message degrades to a warning the developer can act on rather than an
 * extension crash (AAP §0.5.5). A location pointing past the end of a file is
 * **clamped**, never rejected, because a capture outlives the edits made after
 * it.
 *
 * That promise is kept call by call rather than assumed. **Every** VS Code API
 * call here is guarded, because each one can fail in two different ways: a
 * rejection, and a synchronous throw from a document the editor closed or an
 * editor it disposed between two awaits. A rejection-only guard cannot absorb
 * the second — the call has to be evaluated before there is a promise to
 * await — which is what {@link fromEditorCall} exists to close.
 *
 * The transient highlight is the one step that fails *without* failing the
 * reveal. Once the document is open and the range is revealed, the developer
 * has what they clicked for (AAP §0.8.4, acceptance test 1); a second and a
 * half of colour on top of it is not worth refusing the navigation over, so a
 * decoration the editor refuses is logged at warning level and the reveal
 * still succeeds.
 *
 * Nothing here logs an absolute path, a `fsPath`, a resolved symlink target or
 * any document content (AAP §0.5.2). The primitive is handed a URI and no
 * project root, so it logs no path at all; the session-scoped opener logs and
 * displays the project-relative `file:line:column` only, and reduces every
 * filesystem failure to its errno code, because a platform error message
 * quotes the path it failed on.
 */

import { constants, lstat, open, realpath, type FileHandle } from 'node:fs/promises';
import { resolve as resolveFsPath } from 'node:path';

import * as vscode from 'vscode';

import { parseSourceResultPayload } from '@debuggen/protocol';
import type { SourceOpenPayload, SourceResultPayload } from '@debuggen/protocol';
import {
  DebuggenError,
  err,
  formatSourceLocation,
  fromPromise,
  isSafeRelativePath,
  isWithin,
  ok,
  parseSourceLocation,
  relativePosix,
  resolveWithinProject,
  toPosix,
  tryCatch,
} from '@debuggen/shared';
import type { DebuggenErrorCode, Logger, Result, SourceLocation } from '@debuggen/shared';
// The Node entry of `@debuggen/shared`: the extension host is a Node process.
// The identity shape and its exact `bigint` comparison are `safe-fs`'s own, the
// same ones `src/uri-handler.ts` uses, so "the same file" means one thing in
// both of the editor's source-open gates.
import { isSameFileIdentity, type FileIdentity } from '@debuggen/shared/node';

/**
 * How long the transient line highlight stays on the revealed line, in
 * milliseconds.
 *
 * AAP §0.7.1 Group 3 specifies "a 1.5 s line highlight" for this module, and
 * this is the only duration literal in the file: callers that need a different
 * value (the host suite uses a very short one so it can assert the highlight
 * has gone) pass {@link RevealLocationOptions.highlightDurationMs} instead of
 * restating a number.
 */
export const HIGHLIGHT_DURATION_MS = 1500;

/**
 * The offset between the product's 1-based line/column contract and VS Code's
 * 0-based {@link vscode.Position}.
 *
 * Named so the subtraction in {@link toZeroBasedPosition} and the lower bound
 * in {@link positionContractRejection} cannot drift apart.
 */
const ONE_BASED_OFFSET = 1;

/**
 * The first character of a line, as a 0-based column.
 *
 * Used to widen a highlight to whole lines; `isWholeLine` on the decoration
 * type does the visual work, but a range that starts at the line's first
 * character is what keeps the decoration aligned when a caller asked for a
 * column deep into the line.
 */
const LINE_START_CHARACTER = 0;

/**
 * Options for {@link revealLocationInEditor}.
 *
 * Every member is optional: the primitive's required inputs are the URI and the
 * 1-based position, and everything here either refines the selection, tunes the
 * editor behaviour or gives the call a logger. All members are `readonly` —
 * these objects are built once by a caller and read here.
 */
export interface RevealLocationOptions {
  /**
   * The 1-based last line of the symbol's range, when the caller knows it.
   *
   * When present and greater than the target line, the reveal selects from the
   * target position to the end of this line, which is what makes a function's
   * whole body visible rather than just its first character. Ignored when it
   * is not greater than the target line — a range that does not span anything
   * is indistinguishable from an empty selection, and the empty selection is
   * the simpler shape.
   */
  readonly endLine?: number;

  /**
   * The symbol the location names, for diagnostics only.
   *
   * It never changes what is revealed. It is logged with the reveal so a
   * developer reading the output channel can tell which panel row they clicked
   * apart from another row on the same line.
   */
  readonly symbol?: string;

  /**
   * How long the transient line highlight lasts, in milliseconds.
   *
   * Defaults to {@link HIGHLIGHT_DURATION_MS}. `0` disables the highlight
   * entirely — no decoration is applied and no timer is created — which is
   * what a caller wants when it is revealing a location without a click behind
   * it.
   */
  readonly highlightDurationMs?: number;

  /**
   * Whether the editor should keep focus where it is. Defaults to `false`: a
   * click on a source chip is a request to go there, so the cursor follows.
   */
  readonly preserveFocus?: boolean;

  /**
   * Whether the editor opens as a preview tab. Defaults to `false`, so a
   * second click on a different location does not recycle and replace the tab
   * the developer just opened.
   */
  readonly preview?: boolean;

  /** The column to show the editor in. Defaults to VS Code's active column. */
  readonly viewColumn?: vscode.ViewColumn;

  /**
   * How the range is scrolled into view. Defaults to
   * {@link vscode.TextEditorRevealType.InCenterIfOutsideViewport}, which
   * scrolls only when the target is off screen and so does not jolt a document
   * the developer is already looking at the right part of.
   */
  readonly revealType?: vscode.TextEditorRevealType;

  /** Where this module's diagnostics go. Absent means no logging. */
  readonly logger?: Logger;
}

/**
 * What a successful reveal produced.
 *
 * `clamped` is the field worth reading: it is `true` when the requested
 * position did not exist in the document and had to be pulled back inside it,
 * which normally means the file changed after the capture that produced the
 * location. The reveal still succeeded — the editor is showing the nearest
 * valid spot — so a caller may surface that qualification rather than presenting
 * the position as exact. The host suite asserts on it directly.
 */
export interface RevealOutcome {
  /** The editor the document was shown in. */
  readonly editor: vscode.TextEditor;

  /**
   * The selection that was applied. Its `active` position is the requested
   * line and column (converted and clamped), so a caller can assert on the
   * cursor without re-deriving it.
   */
  readonly selection: vscode.Selection;

  /** Whether the requested position had to be clamped to the document. */
  readonly clamped: boolean;
}

/**
 * The canonical file and identity the service proved for a forwarded
 * `source.open` — the `pinned` member of its payload.
 *
 * Derived from the protocol's payload type rather than restated, so the shape
 * the service writes and the shape compared here cannot drift: `file` is the
 * target's path relative to the canonical project root with every link
 * resolved, final component included, and `dev`/`ino` are the canonical
 * decimal strings of a `bigint` `lstat` of that canonical path.
 */
export type SourceOpenPin = NonNullable<SourceOpenPayload['pinned']>;

/**
 * The session context {@link openSourceLocation} enforces its policy against.
 *
 * `projectRoot` is the **session's** project root, read from the stored
 * `SessionRecord` by the caller — never a value taken from the same message
 * that carried the location, which would let a sender nominate the root its own
 * path is contained by and defeat the check entirely.
 */
export interface OpenSourceContext {
  /** The absolute path of the session's project root. */
  readonly projectRoot: string;

  /**
   * What the service proved about the location, when the location arrived in
   * a forwarded `source.open`; see {@link SourceOpenPin}.
   *
   * When present, the file this function resolves for itself must be the same
   * canonical project-relative path on the same device and inode, or nothing
   * is opened: a link re-pointed or a file replaced while the frame crossed
   * the socket is refused rather than followed. Absent for a location that
   * never passed through the service — the `debuggen.openSource` command and
   * the session view's `openFile` frame — which the rest of the canonical gate
   * still covers in full. `src/extension.ts` refuses a forwarded frame that
   * lacks it before calling here ({@link forwardedSourcePin}).
   */
  readonly pinned?: SourceOpenPin;
}

/**
 * Injectable collaborators for {@link openSourceLocation}.
 *
 * All four are optional and default to the production implementation. They
 * exist so the containment verdict can be asserted without opening an editor
 * and without a toast appearing in a test run.
 */
export interface OpenSourceDeps {
  /** Where this module's diagnostics go. Absent means no logging. */
  readonly logger?: Logger;

  /**
   * The reveal primitive to delegate to. Defaults to
   * {@link revealDocumentInEditor}. It receives the document the gate loaded
   * and verified, never a path to open again.
   */
  readonly reveal?: typeof revealDocumentInEditor;

  /**
   * How the gate loads the canonical document, unshown, while it holds the
   * proved descriptor. Defaults to `vscode.workspace.openTextDocument`. The
   * seam lets a test change the file between the identity probe and the
   * editor's read of it — the interleaving the post-load checks exist for.
   */
  readonly loadDocument?: (uri: vscode.Uri) => Thenable<vscode.TextDocument>;

  /**
   * How a refusal is shown to the developer. Defaults to a thin, non-awaiting
   * wrapper over `vscode.window.showWarningMessage`.
   */
  readonly showWarning?: (message: string) => void;
}

/**
 * A pending transient highlight: the timer that will clear it and the editor it
 * was applied to.
 *
 * The editor reference is what makes the highlight reliably removable. A
 * decoration belongs to a `TextEditor` instance, not to a document, so an
 * editor the developer has switched away from cannot be reached through
 * `vscode.window.visibleTextEditors` — and a decoration nobody can reach is a
 * highlight that never goes away.
 */
interface PendingHighlight {
  readonly timer: ReturnType<typeof setTimeout>;
  readonly editor: vscode.TextEditor;
}

/**
 * The module's lazily created, disposable resources.
 *
 * Created on the first reveal that needs a highlight rather than at module
 * load: importing this module must stay free of side effects, since
 * `src/extension.ts` imports it during activation and the developer may never
 * click a source chip at all.
 */
interface RevealResources {
  readonly decorationType: vscode.TextEditorDecorationType;
  readonly listeners: readonly vscode.Disposable[];
}

/** The lazily created resources, or `undefined` before the first highlight. */
let revealResources: RevealResources | undefined;

/**
 * Pending highlights, keyed by `document.uri.toString()`.
 *
 * Keying by document rather than by editor is what makes a second reveal in the
 * same file *reset* the highlight instead of leaving two timers racing to clear
 * one decoration.
 */
const pendingHighlights = new Map<string, PendingHighlight>();

/**
 * Converts the product's 1-based line and column into a VS Code
 * {@link vscode.Position}.
 *
 * **This is the only place in the extension where that subtraction happens.**
 * The wire contract is 1-based on both axes (`@debuggen/shared`'s
 * `source-location.ts` says so, and names this file as the conversion site);
 * `vscode.Position` is 0-based on both. Every producer — the patcher, the code
 * graph, the route map, source maps, the React owner chain — reports 1-based,
 * so a second subtraction anywhere else in this extension would move the cursor
 * one line and one character off the code the developer clicked, in a way that
 * looks like a resolver bug rather than a conversion bug.
 *
 * The caller must have validated the numeric contract first
 * ({@link positionContractRejection}): `vscode.Position` throws on a negative
 * argument, so a `0` line reaching here would be an exception rather than a
 * `Result`.
 */
function toZeroBasedPosition(line: number, column: number): vscode.Position {
  return new vscode.Position(line - ONE_BASED_OFFSET, column - ONE_BASED_OFFSET);
}

/**
 * Validates the numeric half of the reveal contract.
 *
 * A violation means a *caller* broke the contract — the location schema in
 * `@debuggen/shared` already enforces 1-based integers, so anything failing
 * here arrived from a hand-built call or a URI query — hence
 * `PROTOCOL_INVALID_MESSAGE`, the code the shared parser uses for the same
 * class of failure, and a message written for the developer reading the output
 * channel.
 *
 * `Number.isInteger` is what rejects `NaN`, `Infinity` and fractional values in
 * one predicate, which matters because each of those would otherwise reach
 * `vscode.Position` and throw.
 *
 * @returns The rejection, or `undefined` when both values are usable.
 */
function positionContractRejection(line: number, column: number): DebuggenError | undefined {
  const invalid: string[] = [];
  if (!Number.isInteger(line) || line < ONE_BASED_OFFSET) {
    invalid.push('line');
  }
  if (!Number.isInteger(column) || column < ONE_BASED_OFFSET) {
    invalid.push('column');
  }

  if (invalid.length === 0) {
    return undefined;
  }

  return new DebuggenError(
    'PROTOCOL_INVALID_MESSAGE',
    'A source location must carry a 1-based integer line and column.',
    {
      hint: 'Report line and column as integers of 1 or more; a resolver that knows only the line reports column 1.',
      details: { invalid, line, column },
    },
  );
}

/**
 * The decoration type and the listeners, created on first use.
 *
 * The decoration is **theme-coloured only**: `editor.rangeHighlightBackground`
 * is the colour VS Code itself uses to flash a navigated-to range, so the
 * highlight matches the editor the developer configured, in light, dark and
 * high-contrast themes alike, and this module contains no colour value of its
 * own.
 *
 * The two listeners are what keep a pending highlight honest when the developer
 * moves faster than the timer: see {@link forgetHighlightsForClosedDocument}
 * and {@link clearHighlightsForHiddenEditors}.
 *
 * Acquisition is guarded and rolled back rather than left to throw, and the
 * reason is the assignment order: `revealResources` is written **last**, so
 * until both listeners are registered nothing but this function's own locals
 * can reach what it created. A decoration type created here and then abandoned
 * because a registration failed would be unreachable and therefore
 * undisposable — one leaked editor resource per attempt, on a path the caller
 * treats as recoverable. Every failure instead disposes what it acquired and
 * comes back as an `Err`.
 *
 * @returns The resources, or `Err` when the editor refused to create them.
 */
function ensureRevealResources(): Result<RevealResources, DebuggenError> {
  const existing = revealResources;
  if (existing !== undefined) {
    return ok(existing);
  }

  const decoration = tryCatch(
    () =>
      vscode.window.createTextEditorDecorationType({
        isWholeLine: true,
        backgroundColor: new vscode.ThemeColor('editor.rangeHighlightBackground'),
        overviewRulerColor: new vscode.ThemeColor('editor.rangeHighlightBackground'),
        overviewRulerLane: vscode.OverviewRulerLane.Center,
        // The highlight marks a place, not a span of text the developer is
        // editing: closed on both edges means typing at either boundary does not
        // drag the decoration along with it for the second and a half it lives.
        rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
      }),
    'INTERNAL',
  );
  if (!decoration.ok) {
    return err(decoration.error);
  }
  const decorationType = decoration.value;

  // Accumulated as they are registered, so the rollback below knows exactly
  // what was acquired when one of them failed.
  const listeners: vscode.Disposable[] = [];
  const subscribed = tryCatch(() => {
    listeners.push(vscode.workspace.onDidCloseTextDocument(forgetHighlightsForClosedDocument));
    listeners.push(vscode.window.onDidChangeVisibleTextEditors(clearHighlightsForHiddenEditors));
  }, 'INTERNAL');
  if (!subscribed.ok) {
    for (const listener of listeners) {
      disposeQuietly(listener);
    }
    disposeQuietly(decorationType);
    return err(subscribed.error);
  }

  const created: RevealResources = { decorationType, listeners };
  revealResources = created;
  return ok(created);
}

/**
 * Disposes a resource on a path where nothing is left to fail.
 *
 * Used by {@link ensureRevealResources}'s rollback: a `dispose` that threw
 * there would replace the failure being rolled back with its own and lose the
 * cause the caller is about to report.
 */
function disposeQuietly(resource: vscode.Disposable): void {
  try {
    resource.dispose();
  } catch {
    // Already gone, or refusing to go. Either way there is nothing further
    // this module can do with it.
  }
}

/**
 * Removes the decoration from an editor, tolerating an editor that has gone.
 *
 * `setDecorations` on an editor whose document was closed, or which the editor
 * has otherwise disposed, throws. Clearing a highlight is cleanup on a path
 * where nothing is left to fail, so the throw is absorbed: the alternative is
 * an unhandled rejection in a timer callback, which VS Code surfaces as an
 * extension error over a decoration the developer can no longer see anyway.
 */
function clearDecoration(editor: vscode.TextEditor, resources: RevealResources): void {
  try {
    editor.setDecorations(resources.decorationType, []);
  } catch {
    // The editor is gone, and with it the decoration. Nothing to clear.
  }
}

/**
 * Cancels a pending highlight and, optionally, clears the decoration it left.
 *
 * `clearDecoration` is skipped for a document that has been closed — its
 * editors and their decorations went with it — and performed whenever the
 * highlight is being ended early while the editor may still exist.
 */
function cancelPendingHighlight(key: string, options: { readonly clear: boolean }): void {
  const pending = pendingHighlights.get(key);
  if (pending === undefined) {
    return;
  }

  clearTimeout(pending.timer);
  pendingHighlights.delete(key);

  const resources = revealResources;
  if (options.clear && resources !== undefined) {
    clearDecoration(pending.editor, resources);
  }
}

/**
 * Drops any pending highlight for a document the developer closed.
 *
 * Registered on `workspace.onDidCloseTextDocument`. The decoration died with
 * the document's editors, so this only stops a timer that would otherwise fire
 * into nothing.
 */
function forgetHighlightsForClosedDocument(document: vscode.TextDocument): void {
  cancelPendingHighlight(document.uri.toString(), { clear: false });
}

/**
 * Ends any pending highlight whose editor is no longer visible.
 *
 * Registered on `window.onDidChangeVisibleTextEditors`. Ending the highlight
 * *early* — clearing the decoration through the editor reference held in
 * {@link PendingHighlight}, then cancelling the timer — is the deliberate
 * choice here, because merely forgetting the timer would leave a decorated
 * editor the developer finds still highlighted when they switch back to it.
 */
function clearHighlightsForHiddenEditors(visible: readonly vscode.TextEditor[]): void {
  if (pendingHighlights.size === 0) {
    return;
  }

  const visibleKeys = new Set(visible.map((editor) => editor.document.uri.toString()));
  for (const key of [...pendingHighlights.keys()]) {
    if (!visibleKeys.has(key)) {
      cancelPendingHighlight(key, { clear: true });
    }
  }
}

/**
 * Applies the transient highlight and schedules its removal.
 *
 * A duration of `0` or less disables the highlight altogether: no decoration is
 * applied and no timer is created, so {@link hasActiveHighlight} answers
 * `false` immediately and the module allocates nothing.
 *
 * A second highlight in the same document replaces the first, timer included,
 * which is why the map is keyed by document rather than by editor.
 *
 * Every editor call is guarded and a failure leaves nothing behind: the
 * decoration is applied *before* the timer and the map entry exist, so an
 * editor that refuses it — one disposed between the reveal and this call being
 * the realistic case — yields a reveal with no highlight rather than a timer
 * with nothing to clear. The failure is returned rather than thrown because
 * the caller treats it as non-fatal: see {@link revealLocationInEditor}.
 *
 * @param editor The editor to decorate.
 * @param selection The revealed selection. The highlight widens it to whole
 * lines, which is what `isWholeLine` on the decoration type expects.
 * @param durationMs How long the highlight lasts; `0` or less disables it.
 * @returns `Ok(true)` when a highlight is now pending, `Ok(false)` when one was
 * deliberately not applied, and `Err` when the editor refused it.
 */
function applyTransientHighlight(
  editor: vscode.TextEditor,
  selection: vscode.Selection,
  durationMs: number,
): Result<boolean, DebuggenError> {
  if (durationMs <= 0) {
    return ok(false);
  }

  // Both values read the editor or its document, which a disposed editor can
  // refuse, so they are derived under the guard rather than before it. The
  // range runs from the first character of the target line to the end of the
  // selection, so the whole-line decoration stays aligned even when the caller
  // asked for a column deep into the line.
  const prepared = tryCatch(
    () => ({
      key: editor.document.uri.toString(),
      range: new vscode.Range(
        new vscode.Position(selection.start.line, LINE_START_CHARACTER),
        selection.end,
      ),
    }),
    'INTERNAL',
  );
  if (!prepared.ok) {
    return err(prepared.error);
  }
  const { key, range } = prepared.value;

  cancelPendingHighlight(key, { clear: true });

  const resources = ensureRevealResources();
  if (!resources.ok) {
    return err(resources.error);
  }
  const { decorationType } = resources.value;

  const decorated = tryCatch(() => {
    editor.setDecorations(decorationType, [range]);
  }, 'INTERNAL');
  if (!decorated.ok) {
    return err(decorated.error);
  }

  const timer = setTimeout(() => {
    // Read the map rather than closing over the entry: `disposeSourceRevealResources`
    // or a listener may have ended this highlight already, and clearing a
    // decoration that a later reveal has just applied would cancel the wrong
    // highlight. The callback is deliberately synchronous — a promise returned
    // from a timer callback is an unhandled rejection waiting to happen.
    const pending = pendingHighlights.get(key);
    if (pending === undefined) {
      return;
    }
    pendingHighlights.delete(key);

    const current = revealResources;
    if (current !== undefined) {
      clearDecoration(pending.editor, current);
    }
  }, durationMs);

  // The extension host is a Node process, so this is a `Timeout` handle:
  // unreferencing it keeps a highlight that is still pending from holding the
  // event loop open while the host shuts down. Guarded because the handle's
  // shape is the runtime's promise, not this module's.
  if (typeof timer.unref === 'function') {
    timer.unref();
  }

  pendingHighlights.set(key, { timer, editor });
  return ok(true);
}

/**
 * Whether a transient highlight is still pending for a document.
 *
 * Decorations cannot be read back through the VS Code API, so this is the only
 * way a test can assert that "the highlight is present after the reveal and
 * gone after its timeout" (the fourth case of
 * `test/suite/open-location.test.ts`). It is a pure map lookup — no editor is
 * touched — so it is harmless in production and equally usable by a caller that
 * wants to know whether a highlight it requested is still on screen.
 *
 * @param target The document, or its URI, to ask about.
 * @returns `true` while a highlight for that document is pending removal.
 */
export function hasActiveHighlight(target: vscode.TextDocument | vscode.Uri): boolean {
  // Structural narrowing rather than `instanceof vscode.Uri`: an editor's
  // document always carries `uri`, and a `Uri` never does, so this works
  // regardless of which bundle constructed the value.
  const uri = 'uri' in target ? target.uri : target;
  return pendingHighlights.has(uri.toString());
}

/**
 * Releases everything this module created: timers, decorations, listeners and
 * the decoration type.
 *
 * Idempotent, and safe to call at any point — including when nothing has been
 * revealed yet. Afterwards the module is back to its initial state, so the next
 * {@link revealLocationInEditor} recreates what it needs; the host suite relies
 * on that to run each case from a clean slate, and `src/extension.ts` may push
 * `new vscode.Disposable(disposeSourceRevealResources)` into
 * `context.subscriptions`.
 *
 * Nothing here is load-bearing for correctness: every timer this module creates
 * is short-lived, unreferenced and self-clearing, so a host that never calls
 * this still leaves no decorated document behind. This exists so that teardown
 * is *immediate* when a caller wants it to be.
 */
export function disposeSourceRevealResources(): void {
  const resources = revealResources;

  for (const pending of pendingHighlights.values()) {
    clearTimeout(pending.timer);
    if (resources !== undefined) {
      clearDecoration(pending.editor, resources);
    }
  }
  pendingHighlights.clear();

  if (resources === undefined) {
    return;
  }

  // Reset the lazy state before disposing, so a reveal that runs while this is
  // executing recreates the resources instead of decorating with a disposed
  // type.
  revealResources = undefined;

  for (const editor of vscode.window.visibleTextEditors) {
    clearDecoration(editor, resources);
  }
  // Tolerant disposal, for the same reason this function is documented as safe
  // to call at any point: it runs from `deactivate()` through
  // `context.subscriptions`, where one resource refusing to go would abort the
  // teardown of everything queued behind it. The lazy state has already been
  // reset, so every resource here is being released exactly once.
  for (const listener of resources.listeners) {
    disposeQuietly(listener);
  }
  disposeQuietly(resources.decorationType);
}

/**
 * Awaits a VS Code API call, absorbing a synchronous throw as well as a
 * rejection.
 *
 * `fromPromise` alone does not keep this module's promise never to reject,
 * because a call has to be *evaluated* before there is a thenable to hand it:
 * an argument the editor refuses outright — a URI it cannot handle, a document
 * it has already disposed — throws at a point where no promise exists and the
 * rejection helper never sees it. Taking the call as a thunk closes that gap,
 * and the two failure modes arrive as one `Err` so the caller has a single
 * branch to write.
 *
 * Deliberately not `async`: the fulfilled-`Result` promise is returned as it
 * is, which keeps this function's own rejection impossible by construction.
 *
 * @typeParam T What the API call resolves to.
 * @param call The API call to make.
 * @param code The error code a failure carries when the thrown or rejected
 * value does not already have one of its own.
 * @returns A promise that always fulfils with a `Result`.
 */
function fromEditorCall<T>(
  call: () => PromiseLike<T>,
  code: DebuggenErrorCode,
): Promise<Result<T, DebuggenError>> {
  const started = tryCatch(call, code);
  if (!started.ok) {
    // Already the shape the caller awaits; a resolved promise around it keeps
    // the one return type without introducing a rejection path.
    return Promise.resolve(err(started.error));
  }
  return fromPromise(started.value, code);
}

/**
 * The selection a reveal will apply, and whether the document forced it to
 * move.
 */
interface DerivedSelection {
  /** The selection to show, whose `active` is the requested position. */
  readonly selection: vscode.Selection;

  /** Whether the requested position had to be clamped to the document. */
  readonly clamped: boolean;
}

/**
 * Turns the 1-based request into a selection inside a document that exists.
 *
 * Kept out of {@link revealLocationInEditor} so the whole derivation is one
 * guarded expression there. Every call it makes belongs to the VS Code API —
 * `validatePosition`, `lineAt`, the `Position` and `Selection` constructors —
 * and each of them throws for a document the editor has closed since it was
 * opened, or a line it no longer has. That is the class of failure the reveal
 * converts into a typed `Err` rather than a rejected promise (AAP §0.5.5).
 *
 * The caller must have validated the numeric contract first
 * ({@link positionContractRejection}), because `vscode.Position` throws on a
 * negative argument.
 *
 * @param document The opened document.
 * @param line The 1-based line requested.
 * @param column The 1-based column requested.
 * @param endLine The 1-based last line of the symbol's range, when the caller
 * knows it.
 * @returns The selection to apply and whether it was clamped.
 */
function deriveSelection(
  document: vscode.TextDocument,
  line: number,
  column: number,
  endLine: number | undefined,
): DerivedSelection {
  const rawPosition = toZeroBasedPosition(line, column);
  const position = document.validatePosition(rawPosition);
  let clamped = !position.isEqual(rawPosition);

  // The end of the symbol's range, when the caller knows it and it spans more
  // than the target line. `lineAt` throws for a line outside the document, so
  // the end line is validated as a position first and the end of *that* line is
  // taken — which needs no sentinel column and cannot land past the text.
  //
  // A non-integer `endLine` is treated as an absent one rather than as a reason
  // to refuse the whole reveal: the field only refines the selection, and
  // failing to navigate because an optional refinement was malformed would cost
  // the developer the click. The location schema in `@debuggen/shared` already
  // guarantees an integer `endLine` of at least `line`, so this only guards the
  // hand-built calls that reach the primitive directly.
  let rangeEnd = position;
  if (endLine !== undefined && Number.isInteger(endLine) && endLine > line) {
    const rawEndPosition = toZeroBasedPosition(endLine, ONE_BASED_OFFSET);
    const validatedEnd = document.validatePosition(rawEndPosition);
    clamped = clamped || validatedEnd.line !== rawEndPosition.line;
    rangeEnd = document.lineAt(validatedEnd.line).range.end;
  }

  // Anchor at the range's end and active at the target position, so
  // `editor.selection.active` is still the requested line and column while the
  // symbol's range is what the editor highlights. An empty selection when there
  // is no range to select.
  return { selection: new vscode.Selection(rangeEnd, position), clamped };
}

/**
 * Opens a document and puts the cursor on a 1-based line and column, with a
 * brief highlight.
 *
 * This is the editor primitive, and it enforces **no containment policy**: the
 * URI is taken as already authorised. That is not an oversight but the reason
 * this export exists separately — its two callers disagree about what
 * authorisation means. `src/uri-handler.ts` validates a `vscode://` URI against
 * the open workspace folders with `fs.realpath` and a developer confirmation,
 * because any web page can trigger one; {@link openSourceLocation} validates
 * against the session's `projectRoot`. Adding either policy here would impose
 * it on the other caller (AAP §0.2.3).
 *
 * It also shows no user interface. A failure comes back as an `Err` whose
 * message is phrased for a developer so the caller can display it verbatim —
 * the URI handler has its own confirmation flow and
 * {@link openSourceLocation} owns the warning toast, and a notification raised
 * here would double every refusal.
 *
 * A position past the end of the document is **clamped** rather than refused
 * (`RevealOutcome.clamped` reports it): a capture can outlive the edits made
 * after it, and landing near the code beats refusing to navigate.
 *
 * Every editor call it makes is guarded — the open, the position derivation,
 * the show, the reveal and the highlight — so "never rejects" holds for a
 * document closed mid-flight or an editor disposed between two awaits, not
 * only for a file that was already missing (AAP §0.5.5). Of those five, the
 * highlight alone is non-fatal: it is logged and the reveal still succeeds,
 * because the developer already has the document, the cursor and the scrolled
 * range that the click asked for.
 *
 * @param uri The document to open. Already authorised by the caller.
 * @param line The 1-based line to put the cursor on.
 * @param column The 1-based column to put the cursor on.
 * @param options Selection, editor and highlight refinements; see
 * {@link RevealLocationOptions}.
 * @returns `Ok` with the editor, the applied selection and the clamp flag, or
 * `Err` when the numeric contract was broken, the document could not be
 * opened, its position could not be resolved, or the editor could not be shown
 * or scrolled to. A highlight the editor refused is reported through the
 * logger and does not turn a completed reveal into a failure. Never throws,
 * and never rejects.
 */
export async function revealLocationInEditor(
  uri: vscode.Uri,
  line: number,
  column: number,
  options?: RevealLocationOptions,
): Promise<Result<RevealOutcome, DebuggenError>> {
  // Checked before the open as well as inside the document primitive, so a
  // broken numeric contract never loads a document.
  const contractRejection = positionContractRejection(line, column);
  if (contractRejection !== undefined) {
    return err(contractRejection);
  }

  // `PROJECT_NOT_FOUND` is the nearest code in the closed vocabulary of
  // `@debuggen/shared`'s `DEBUGGEN_ERROR_CODES` for "something the product
  // expected on disk was not there": there is no file-level not-found code, and
  // `INTERNAL` would tell the user interface nothing, which is exactly what the
  // vocabulary's own guidance warns against. The rejection reason travels as
  // `cause`.
  const opened = await fromEditorCall(
    () => vscode.workspace.openTextDocument(uri),
    'PROJECT_NOT_FOUND',
  );
  if (!opened.ok) {
    return err(
      new DebuggenError('PROJECT_NOT_FOUND', 'The file could not be opened in the editor.', {
        hint: 'The file may have been moved, renamed or deleted since it was captured.',
        details: { line, column },
        cause: opened.error,
      }),
    );
  }

  return revealDocumentInEditor(opened.value, line, column, options);
}

/**
 * Puts the cursor on a 1-based line and column of a document that is already
 * loaded, with a brief highlight — {@link revealLocationInEditor} without the
 * open.
 *
 * The document is shown as it is: no path is resolved again, so a caller that
 * verified this document's content shows exactly what it verified. That is how
 * {@link openSourceLocation} reveals the copy its canonical gate checked. Like
 * {@link revealLocationInEditor} it enforces no containment policy, shows no
 * user interface, clamps a position past the end of the document, and guards
 * every editor call.
 *
 * @param document The loaded document to show. Already authorised by the caller.
 * @param line The 1-based line to put the cursor on.
 * @param column The 1-based column to put the cursor on.
 * @param options Selection, editor and highlight refinements; see
 * {@link RevealLocationOptions}.
 * @returns `Ok` with the editor, the applied selection and the clamp flag, or
 * `Err` when the numeric contract was broken, the position could not be
 * resolved, or the editor could not be shown or scrolled to. Never throws, and
 * never rejects.
 */
export async function revealDocumentInEditor(
  document: vscode.TextDocument,
  line: number,
  column: number,
  options?: RevealLocationOptions,
): Promise<Result<RevealOutcome, DebuggenError>> {
  const contractRejection = positionContractRejection(line, column);
  if (contractRejection !== undefined) {
    return err(contractRejection);
  }

  // Derived under a guard: the document was open a moment ago, but the editor
  // may have closed it since, and `validatePosition`/`lineAt` throw for a
  // document or a line that is gone. Nothing has been shown to the developer
  // yet at this point, so the failure costs them nothing but the click — and
  // it must be an `Err` rather than a rejection, because `RevealOutcome`
  // promises a selection this function could not build.
  const derived = tryCatch(
    () => deriveSelection(document, line, column, options?.endLine),
    'INTERNAL',
  );
  if (!derived.ok) {
    return err(
      new DebuggenError(
        'INTERNAL',
        'The position for this location could not be resolved in the document.',
        {
          hint: 'Try the location again; if it keeps failing, reload the window.',
          details: { line, column },
          cause: derived.error,
        },
      ),
    );
  }
  const { selection, clamped } = derived.value;

  const showOptions: vscode.TextDocumentShowOptions = {
    selection,
    preserveFocus: options?.preserveFocus ?? false,
    preview: options?.preview ?? false,
  };
  // Assigned conditionally rather than as `viewColumn: options?.viewColumn`:
  // `exactOptionalPropertyTypes` distinguishes an absent key from one holding
  // `undefined`, and VS Code's default column is "no key".
  if (options?.viewColumn !== undefined) {
    showOptions.viewColumn = options.viewColumn;
  }

  const shown = await fromEditorCall(
    () => vscode.window.showTextDocument(document, showOptions),
    'INTERNAL',
  );
  if (!shown.ok) {
    return err(
      new DebuggenError('INTERNAL', 'The editor could not be shown for this location.', {
        hint: 'Try the location again; if it keeps failing, reload the window.',
        details: { line, column },
        cause: shown.error,
      }),
    );
  }

  const editor = shown.value;

  // One step later in the same race as the derivation: `showTextDocument`
  // resolved, but the tab can be gone by the time this line runs and a
  // disposed editor refuses `revealRange`. This is not cosmetic — an editor
  // that cannot be scrolled is an editor the developer is not looking at the
  // right part of, and `RevealOutcome.editor` would hand back a dead one — so
  // it fails the reveal instead of being logged and passed over.
  //
  // The selection is assigned again here, explicitly, because
  // `TextDocumentShowOptions.selection` is typed as a `Range`: the editor
  // applies it with the anchor at the range's start and the cursor at its
  // end, discarding the direction `deriveSelection` gave it. For an `endLine`
  // selection that would leave the cursor at the end of the symbol's range
  // rather than on the requested line and column, and `RevealOutcome.selection`
  // would disagree with `editor.selection`. Assigning the `Selection` itself
  // keeps its anchor and active positions exactly as derived.
  const revealed = tryCatch(() => {
    editor.selection = selection;
    editor.revealRange(
      selection,
      options?.revealType ?? vscode.TextEditorRevealType.InCenterIfOutsideViewport,
    );
  }, 'INTERNAL');
  if (!revealed.ok) {
    return err(
      new DebuggenError('INTERNAL', 'The editor could not be scrolled to this location.', {
        hint: 'Try the location again; if it keeps failing, reload the window.',
        details: { line, column },
        cause: revealed.error,
      }),
    );
  }

  // Deliberately NOT fatal, and the only step here that is not. The document
  // is open, the cursor is on the requested line and column and the range has
  // been revealed — everything the click asked for and everything AAP §0.8.4
  // acceptance test 1 checks. The highlight is a second and a half of colour
  // on top of that, so refusing the whole navigation because a decoration
  // could not be applied would cost the developer the one thing that matters
  // for something they cannot see. It is reported through the logger so the
  // omission is visible in the output channel rather than silent.
  const highlighted = applyTransientHighlight(
    editor,
    selection,
    options?.highlightDurationMs ?? HIGHLIGHT_DURATION_MS,
  );
  if (!highlighted.ok) {
    options?.logger?.warn('Revealed a source location without its transient highlight', {
      line,
      column,
      symbol: options.symbol,
      code: highlighted.error.code,
    });
  }

  // No path is logged, by design: this function is handed a URI and no project
  // root, so the only privacy-safe identification of the target is its position
  // and the caller-supplied symbol (AAP §0.5.2). The session-scoped opener logs
  // the project-relative file.
  options?.logger?.debug('Revealed a source location in the editor', {
    line,
    column,
    clamped,
    symbol: options.symbol,
  });

  return ok({ editor, selection, clamped });
}

/**
 * Shows a refusal to the developer, without waiting for them to dismiss it.
 *
 * `showWarningMessage` resolves when the notification is dismissed or an item
 * is picked; this path offers no items and has no decision to wait for, so the
 * thenable is discarded deliberately with `void` rather than left to float.
 */
function showWarningNotification(message: string): void {
  void vscode.window.showWarningMessage(message);
}

/**
 * Builds the one sentence the developer sees for a failed open.
 *
 * The error's `hint` carries the actionable half — that is what the field is
 * for — so it is appended when present, and the result is a single
 * notification. Nothing absolute reaches it: the headline names the
 * project-relative `file:line:column` and the hints in this module and in
 * `@debuggen/shared`'s path gate disclose no filesystem layout.
 */
function refusalMessage(headline: string, error: DebuggenError): string {
  const hint = error.hint;
  return hint === undefined ? headline : `${headline} ${hint}`;
}

// ---------------------------------------------------------------------------
// The canonical gate of the session-scoped opener
// ---------------------------------------------------------------------------

/**
 * Why the canonical gate refused, one value per distinct cause.
 *
 * The reason is logged and chooses the sentence the developer sees; only its
 * {@link GateRefusalCopy.code} leaves the editor, in `source.result`. Every
 * reason that concerns what lies *outside* the project shares one code and one
 * sentence, `leaves-project`, so the answer never says whether an outside
 * target exists.
 */
type GateRefusalReason =
  | 'project-root-missing'
  | 'project-root-unresolvable'
  | 'missing'
  | 'leaves-project'
  | 'unresolvable'
  | 'unsafe-canonical-path'
  | 'not-a-file'
  | 'pin-mismatch'
  | 'changed'
  | 'unreadable'
  | 'editor-load-failed'
  | 'decode-failed';

/** One refusal of the canonical gate. */
interface GateRefusal {
  /** Why the gate refused. */
  readonly reason: GateRefusalReason;

  /**
   * The errno of the filesystem call that failed, when one did — a code such
   * as `ELOOP`, never the error's message, which quotes the absolute path.
   */
  readonly errno?: string;
}

/** The error code and the developer-facing sentences of one {@link GateRefusalReason}. */
interface GateRefusalCopy {
  /** A code from `DEBUGGEN_ERROR_CODES`; the only part of a refusal that leaves the editor. */
  readonly code: DebuggenErrorCode;

  /** The sentence naming the refused location by its project-relative `file:line:column`. */
  readonly headline: (at: string) => string;

  /** The next step. Constant, and discloses no filesystem layout. */
  readonly hint: string;
}

/** The hint of every refusal that a fresh click can resolve once the disk has settled. */
const CLICK_AGAIN_HINT = 'Click the source link again so the file is checked as it is on disk now.';

/**
 * The code and copy of every canonical-gate refusal.
 *
 * `FS_UNSAFE_PATH` is the code for every refusal where the filesystem leads
 * somewhere the session's project cannot vouch for, or changed underneath the
 * check — the code the service's `source/open.ts` reports for the same
 * symbolic-link escape, so both hops name one failure alike. Absence inside
 * the project is `PROJECT_NOT_FOUND`, as it is for the reveal primitive and the
 * service. Nothing here quotes an absolute path or a link target.
 */
const GATE_REFUSALS: Readonly<Record<GateRefusalReason, GateRefusalCopy>> = Object.freeze({
  'project-root-missing': {
    code: 'PROJECT_NOT_FOUND',
    headline: (at: string) =>
      `The session's project folder is no longer on disk, so ${at} cannot be opened.`,
    hint: 'Start a session again from the Debug Generator view for the project as it is now.',
  },
  'project-root-unresolvable': {
    code: 'FS_UNSAFE_PATH',
    headline: (at: string) =>
      `The session's project folder cannot be resolved on disk, so ${at} cannot be checked against it.`,
    hint: 'Check that the project folder exists and can be read, then start the session again.',
  },
  missing: {
    code: 'PROJECT_NOT_FOUND',
    headline: (at: string) => `${at} does not exist in the session's project.`,
    hint: 'The file may have been moved, renamed or deleted since it was captured.',
  },
  'leaves-project': {
    code: 'FS_UNSAFE_PATH',
    headline: (at: string) =>
      `${at} resolves outside the session's project, or through a link that cannot be followed; Debug Generator will not open it.`,
    hint: 'A source location cannot follow a symbolic link out of the project the session was started for.',
  },
  unresolvable: {
    code: 'FS_UNSAFE_PATH',
    headline: (at: string) =>
      `${at} cannot be resolved on disk, so Debug Generator cannot prove it is inside the session's project.`,
    hint: 'A link loop, a directory that cannot be read or an over-long path prevents the check; fix the path in the project, then click the link again.',
  },
  'unsafe-canonical-path': {
    code: 'FS_UNSAFE_PATH',
    headline: (at: string) =>
      `${at} resolves to a file whose name cannot be treated as project-relative; Debug Generator will not open it.`,
    hint: 'Rename the file so its path holds no backslash or control character, then capture again.',
  },
  'not-a-file': {
    code: 'PROJECT_NOT_FOUND',
    headline: (at: string) => `${at} is not a regular file, so Debug Generator will not open it.`,
    hint: 'A source location must name a source file, not a directory, a device or a pipe.',
  },
  'pin-mismatch': {
    code: 'FS_UNSAFE_PATH',
    headline: (at: string) =>
      `${at} is no longer the file the Debug Generator service checked; nothing was opened.`,
    hint: `The file, or a link on its path, changed after the click. ${CLICK_AGAIN_HINT}`,
  },
  changed: {
    code: 'FS_UNSAFE_PATH',
    headline: (at: string) =>
      `${at} changed while Debug Generator was opening it; nothing was opened.`,
    hint: CLICK_AGAIN_HINT,
  },
  unreadable: {
    code: 'FS_UNSAFE_PATH',
    headline: (at: string) =>
      `${at} could not be read, so Debug Generator cannot verify the file it names.`,
    hint: "Check the file's permissions, then click the link again.",
  },
  'editor-load-failed': {
    code: 'PROJECT_NOT_FOUND',
    headline: (at: string) => `The editor could not load ${at}.`,
    hint: 'The file may be binary, too large for the editor, or removed since it was captured.',
  },
  'decode-failed': {
    code: 'INTERNAL',
    headline: (at: string) =>
      `The editor could not decode ${at} to verify it against the file on disk.`,
    hint: 'Try the location again; if it keeps failing, reload the window.',
  },
});

/** Builds a {@link GateRefusal}, leaving `errno` absent rather than `undefined`. */
function gateRefusal(reason: GateRefusalReason, errno?: string): GateRefusal {
  return errno === undefined ? { reason } : { reason, errno };
}

/** The errno codes meaning "nothing is at this path", as opposed to "this path cannot be examined". */
const MISSING_ERRNOS: ReadonlySet<string> = new Set(['ENOENT', 'ENOTDIR']);

/**
 * The errno codes a no-follow open answers when the canonical path no longer
 * binds to a file: removed (`ENOENT`, `ENOTDIR`), or replaced by a link at its
 * final component (`ELOOP` on Linux and macOS, `EMLINK` on FreeBSD).
 */
const REBOUND_ERRNOS: ReadonlySet<string> = new Set(['ENOENT', 'ENOTDIR', 'ELOOP', 'EMLINK']);

/** The shape of a Node errno code; anything else a thrower put in `code` is not reported. */
const ERRNO_PATTERN = /^E[A-Z0-9]{1,31}$/;

/**
 * The errno code of a failed filesystem call, or `undefined`.
 *
 * Only the code is kept: a Node filesystem error's `message` and `path` quote
 * the absolute path the call was made with, and neither may reach a log line,
 * an error's details or a notification.
 */
function errnoOf(caught: unknown): string | undefined {
  if (typeof caught !== 'object' || caught === null || !('code' in caught)) {
    return undefined;
  }
  const code: unknown = caught.code;
  return typeof code === 'string' && ERRNO_PATTERN.test(code) ? code : undefined;
}

/** Whether an errno means that nothing is at the path. */
function isMissing(errno: string | undefined): boolean {
  return errno !== undefined && MISSING_ERRNOS.has(errno);
}

/** A filesystem call that failed, reduced to its errno. */
interface FsFailure {
  readonly errno: string | undefined;
}

/**
 * Runs one filesystem call, turning a rejection into its errno.
 *
 * The gate's promise never to reject rests on this: every `realpath`, `lstat`,
 * `open`, `stat` and read below goes through it, and what survives of a
 * failure is the errno alone.
 */
async function settleFs<T>(call: () => Promise<T>): Promise<Result<T, FsFailure>> {
  try {
    return ok(await call());
  } catch (caught) {
    return err({ errno: errnoOf(caught) });
  }
}

/** A file the canonical gate has proved: where it is, how the session names it, and which object it is. */
interface CanonicalTarget {
  /** The `realpath` of the candidate, exactly as it passed containment. The only path ever opened. */
  readonly canonicalPath: string;

  /**
   * The canonical path relative to the canonical project root — what the
   * service writes as `pinned.file`. Compared, never logged: through an
   * in-project link it discloses where that link points.
   */
  readonly relativePath: string;

  /**
   * The device and inode a non-following `lstat` of the canonical path
   * reported, as exact `bigint`s — see `FileIdentity` in `@debuggen/shared/node`.
   */
  readonly identity: FileIdentity;
}

/**
 * Classifies a candidate that `realpath` reported missing, without disclosing
 * whether anything exists outside the project.
 *
 * "Missing" alone would be an oracle: through `src/link → /etc`, the location
 * `src/link/passwd` resolves (and is refused as outside) while
 * `src/link/absent` fails with `ENOENT`, so answering the second
 * `PROJECT_NOT_FOUND` would tell the sender which outside files exist. So the
 * candidate's own ancestors are canonicalised from the deepest up, and the
 * first one that resolves decides:
 *
 * - it resolves outside the canonical root — the path leads out of the project
 *   whether or not the rest of it exists: `leaves-project`;
 * - it is inside, and the next name below it is a link — one that cannot be
 *   followed, wherever it points: `leaves-project`;
 * - it is inside, and the next name below it does not exist: `missing`, the
 *   only case that honestly is "not in the project".
 *
 * The walk is bounded by the location's segment count, which the location
 * schema bounds in turn.
 *
 * @param projectRoot The session's project root, as validated lexically.
 * @param lexicalTarget The lexical candidate `resolveWithinProject` produced.
 * @param realRoot The canonical project root, POSIX-separated.
 * @returns The refusal. Never throws.
 */
async function classifyMissingTarget(
  projectRoot: string,
  lexicalTarget: string,
  realRoot: string,
): Promise<GateRefusal> {
  const segments = relativePosix(toPosix(projectRoot), toPosix(lexicalTarget)).split('/');

  for (let depth = segments.length - 1; depth >= 0; depth -= 1) {
    const ancestor = resolveFsPath(projectRoot, ...segments.slice(0, depth));
    const resolved = await settleFs(() => realpath(ancestor));
    if (!resolved.ok) {
      if (isMissing(resolved.error.errno)) {
        continue;
      }
      return gateRefusal('unresolvable', resolved.error.errno);
    }

    if (!isWithin(realRoot, toPosix(resolved.value))) {
      return gateRefusal('leaves-project');
    }

    const next = resolveFsPath(projectRoot, ...segments.slice(0, depth + 1));
    const entry = await settleFs(() => lstat(next));
    if (entry.ok) {
      // Something is at that name, yet its path did not resolve: a dangling
      // link, or one into a chain that ends nowhere. Where it points is not
      // asked — reading a link target is disclosing it.
      return entry.value.isSymbolicLink() ? gateRefusal('leaves-project') : gateRefusal('missing');
    }
    return isMissing(entry.error.errno)
      ? gateRefusal('missing')
      : gateRefusal('unresolvable', entry.error.errno);
  }

  // Even the project root stopped resolving since it was canonicalised a
  // moment ago; the root, not the location, is what is missing.
  return gateRefusal('project-root-missing');
}

/**
 * Canonical containment and identity: the steps that decide *which object*
 * a lexically contained location names on disk.
 *
 * 1. The project root and the candidate are both canonicalised with
 *    `realpath`, which resolves every link on the path, final component
 *    included. A candidate that does not resolve is classified by
 *    {@link classifyMissingTarget}; one that resolves outside the canonical
 *    root is `leaves-project` — the symbolic-link escape a lexical check
 *    cannot see (`src/link/passwd` under `src/link → /etc`).
 * 2. The canonical candidate must be strictly below the canonical root, and
 *    its path relative to that root must be a safe project-relative path.
 * 3. A non-following `lstat` of the canonical path must report a regular file,
 *    whose device and inode become the identity every later step compares
 *    against. A link found there means the entry changed since `realpath`
 *    resolved it; anything that is not a regular file — a directory, a FIFO
 *    that would block the extension host, a device — is refused.
 *
 * @param projectRoot The session's project root, as validated lexically.
 * @param lexicalTarget The lexical candidate `resolveWithinProject` produced.
 * @returns The proved target, or the refusal. Never throws, never rejects.
 */
async function resolveCanonicalTarget(
  projectRoot: string,
  lexicalTarget: string,
): Promise<Result<CanonicalTarget, GateRefusal>> {
  const root = await settleFs(() => realpath(projectRoot));
  if (!root.ok) {
    const errno = root.error.errno;
    return err(
      gateRefusal(isMissing(errno) ? 'project-root-missing' : 'project-root-unresolvable', errno),
    );
  }
  const realRoot = toPosix(root.value);

  const target = await settleFs(() => realpath(lexicalTarget));
  if (!target.ok) {
    const errno = target.error.errno;
    return err(
      isMissing(errno)
        ? await classifyMissingTarget(projectRoot, lexicalTarget, realRoot)
        : gateRefusal('unresolvable', errno),
    );
  }
  const canonicalPath = target.value;
  const realTarget = toPosix(canonicalPath);

  if (!isWithin(realRoot, realTarget)) {
    return err(gateRefusal('leaves-project'));
  }

  // `'.'` is the root itself: contained, but not a file anything can open.
  const relativePath = relativePosix(realRoot, realTarget);
  if (relativePath === '.') {
    return err(gateRefusal('not-a-file'));
  }
  if (!isSafeRelativePath(relativePath)) {
    return err(gateRefusal('unsafe-canonical-path'));
  }

  const inspected = await settleFs(() => lstat(canonicalPath, { bigint: true }));
  if (!inspected.ok) {
    return err(gateRefusal('changed', inspected.error.errno));
  }
  const stats = inspected.value;
  if (stats.isSymbolicLink()) {
    return err(gateRefusal('changed'));
  }
  if (!stats.isFile()) {
    return err(gateRefusal('not-a-file'));
  }

  return ok({ canonicalPath, relativePath, identity: { dev: stats.dev, ino: stats.ino } });
}

/**
 * Whether the proved target is the one the service pinned: the same canonical
 * project-relative path, on the same device, at the same inode.
 *
 * Plain string equality is exact because the protocol writes device and inode
 * numbers in canonical decimal, and `String` of a `bigint` is canonical
 * decimal. A pin whose members are not strings — a hand-built call — compares
 * unequal and is refused.
 */
function matchesPin(target: CanonicalTarget, pinned: SourceOpenPin): boolean {
  return (
    target.relativePath === pinned.file &&
    String(target.identity.dev) === pinned.dev &&
    String(target.identity.ino) === pinned.ino
  );
}

/**
 * An `open` flag read through `unknown`, or `0` where the platform lacks it.
 *
 * The same capability detection as `src/uri-handler.ts` and `safe-fs` in
 * `@debuggen/shared/node`: the type declarations describe the POSIX constant
 * set, while on Windows `O_NOFOLLOW` and `O_NONBLOCK` are absent at runtime. A
 * missing flag contributes nothing rather than a `NaN`, and the guarantee lost
 * with it is covered by the `lstat` {@link holdsIdentity} runs regardless.
 */
function openFlag(flag: unknown): number {
  return typeof flag === 'number' ? flag : 0;
}

/**
 * The flags of the identity probe: read-only, refusing a link at the final
 * component, and never blocking — a FIFO swapped in at the last moment would
 * otherwise hang the extension host every other extension shares.
 */
function probeOpenFlags(): number {
  return constants.O_RDONLY | openFlag(constants.O_NOFOLLOW) | openFlag(constants.O_NONBLOCK);
}

/**
 * Proves that an open descriptor reached the proved inode, and that the
 * canonical path still names it.
 *
 * The descriptor's own `stat` says what the open actually reached; a
 * descriptor cannot be re-pointed. An `lstat` of the path, taken while that
 * descriptor is held, proves the name still binds to that inode with no link
 * at its final component — which is also what refuses a link where the
 * platform has no `O_NOFOLLOW`.
 *
 * @returns `true` only when both observations are the proved regular file.
 * Never throws.
 */
async function holdsIdentity(handle: FileHandle, target: CanonicalTarget): Promise<boolean> {
  const held = await settleFs(() => handle.stat({ bigint: true }));
  if (!held.ok || !held.value.isFile() || !isSameFileIdentity(target.identity, held.value)) {
    return false;
  }

  const bound = await settleFs(() => lstat(target.canonicalPath, { bigint: true }));
  return bound.ok && bound.value.isFile() && isSameFileIdentity(target.identity, bound.value);
}

/** A leading byte-order mark, which a decoder may or may not keep in the text it returns. */
const BYTE_ORDER_MARK = '\uFEFF';

/** Every line break the editor's text model recognises: `\r\n`, a lone `\r` and — untouched — `\n`. */
const LINE_BREAKS = /\r\n?/g;

/**
 * The form in which the editor's text and the proved bytes are compared.
 *
 * Only the two differences that are the editor's representation rather than a
 * different file are removed: the text model normalises line breaks, and
 * whether one leading byte-order mark survives decoding depends on the
 * encoding. Nothing else is folded, because anything else could make two
 * different files compare equal.
 */
function comparableText(text: string): string {
  const unmarked = text.startsWith(BYTE_ORDER_MARK) ? text.slice(BYTE_ORDER_MARK.length) : text;
  return unmarked.replace(LINE_BREAKS, '\n');
}

/**
 * Loads the canonical document without showing it and proves that what the
 * editor now holds is the proved file, while the probe's descriptor is held.
 *
 * VS Code reads a document by path through its own file service, which has no
 * no-follow read, so a name re-pointed after the identity probe is what the
 * editor would read. The load is therefore bracketed rather than trusted:
 *
 * 1. after the load, {@link holdsIdentity} must hold again — the path still
 *    names the proved inode with no link at its final component — so a name
 *    re-pointed before the read and left that way is refused;
 * 2. the proved bytes are then read through the descriptor — the one
 *    reference to the proved inode no rename or link can re-point — decoded
 *    in the document's own encoding with the editor's decoder, and must equal
 *    the document's text in {@link comparableText} form, so a name re-pointed
 *    and restored within the read is refused unless what the editor read is
 *    the proved file's own content.
 *
 * A document with unsaved edits is accepted once the identity holds: a fresh
 * load is never dirty, so it is the developer's own buffer, open before this
 * call, and this load read nothing from disk.
 *
 * Every editor call and every read of the document is guarded: a document
 * the editor closed between two awaits throws rather than rejects.
 *
 * @param handle The descriptor {@link holdsIdentity} verified. Not closed here.
 * @param target The proved target.
 * @param uri The canonical `file:` URI.
 * @param load How the document is loaded; see {@link OpenSourceDeps.loadDocument}.
 * @returns `Ok` with the verified document — the one the reveal must show —
 * otherwise the refusal. Never throws, never rejects.
 */
async function loadVerifiedDocument(
  handle: FileHandle,
  target: CanonicalTarget,
  uri: vscode.Uri,
  load: (uri: vscode.Uri) => Thenable<vscode.TextDocument>,
): Promise<Result<vscode.TextDocument, GateRefusal>> {
  const loaded = await fromEditorCall(() => load(uri), 'PROJECT_NOT_FOUND');
  if (!loaded.ok) {
    return err(gateRefusal('editor-load-failed'));
  }
  const document = loaded.value;

  if (!(await holdsIdentity(handle, target))) {
    return err(gateRefusal('changed'));
  }

  const state = tryCatch(
    () => ({ dirty: document.isDirty, encoding: document.encoding }),
    'INTERNAL',
  );
  if (!state.ok) {
    return err(gateRefusal('editor-load-failed'));
  }
  if (state.value.dirty) {
    return ok(document);
  }

  const bytes = await settleFs(() => handle.readFile());
  if (!bytes.ok) {
    return err(gateRefusal('changed', bytes.error.errno));
  }

  const { encoding } = state.value;
  const decoded = await fromEditorCall(
    () => vscode.workspace.decode(bytes.value, { encoding }),
    'INTERNAL',
  );
  if (!decoded.ok) {
    return err(gateRefusal('decode-failed'));
  }

  const text = tryCatch(() => document.getText(), 'INTERNAL');
  if (!text.ok) {
    return err(gateRefusal('editor-load-failed'));
  }

  return comparableText(text.value) === comparableText(decoded.value)
    ? ok(document)
    : err(gateRefusal('changed'));
}

/**
 * Closes the probe's descriptor on a path where the verdict is already known.
 *
 * A close that fails cannot change what was verified, so it is logged by errno
 * and does not turn the verdict into a failure.
 */
async function closeDescriptor(handle: FileHandle, logger: Logger | undefined): Promise<void> {
  try {
    await handle.close();
  } catch (caught) {
    logger?.warn('Could not close the descriptor a source location was verified through', {
      errno: errnoOf(caught),
    });
  }
}

/**
 * Binds the canonical path to the proved inode at the moment of opening, binds
 * the editor's copy to that same inode, and shows that copy — through one
 * descriptor held from the probe until the editor has shown the document.
 *
 * The canonical path is opened `O_RDONLY | O_NOFOLLOW | O_NONBLOCK`: a link at
 * the final component fails the open, a FIFO cannot stall it. An open that
 * fails because the path no longer binds to a file is `changed`; one that
 * fails for any other reason — permissions withdrawn, above all — is
 * `unreadable`. The document is then loaded and verified by
 * {@link loadVerifiedDocument}, and `show` receives that verified document
 * itself, so the reveal displays exactly the model that was checked instead of
 * resolving the path a second time. The descriptor is closed on every path,
 * once `show` has settled.
 *
 * @param target The proved target.
 * @param uri The canonical `file:` URI.
 * @param load How the document is loaded; see {@link OpenSourceDeps.loadDocument}.
 * @param logger Where a failed close is reported.
 * @param show The reveal, called with the verified document only.
 * @returns `Ok` with what `show` returned, or the refusal — in which case
 * `show` was never called and nothing was shown. Never throws, and never
 * rejects unless `show` does.
 */
async function showThroughGate<T>(
  target: CanonicalTarget,
  uri: vscode.Uri,
  load: (uri: vscode.Uri) => Thenable<vscode.TextDocument>,
  logger: Logger | undefined,
  show: (document: vscode.TextDocument) => Promise<T>,
): Promise<Result<T, GateRefusal>> {
  const opened = await settleFs(() => open(target.canonicalPath, probeOpenFlags()));
  if (!opened.ok) {
    const errno = opened.error.errno;
    return err(
      gateRefusal(
        errno === undefined || REBOUND_ERRNOS.has(errno) ? 'changed' : 'unreadable',
        errno,
      ),
    );
  }

  const handle = opened.value;
  try {
    if (!(await holdsIdentity(handle, target))) {
      return err(gateRefusal('changed'));
    }
    const verified = await loadVerifiedDocument(handle, target, uri, load);
    if (!verified.ok) {
      return err(verified.error);
    }
    return ok(await show(verified.value));
  } finally {
    await closeDescriptor(handle, logger);
  }
}

/**
 * The pin a forwarded `source.open` must carry, or the refusal of a frame that
 * carries none.
 *
 * The service pins the canonical file and identity it proved on every frame it
 * forwards to an editor, and the pin is what lets {@link openSourceLocation}
 * refuse a link re-pointed while the frame was in flight. A forwarded frame
 * without one therefore cannot be held to that check and opens nothing:
 * `src/extension.ts` calls this before any session lookup, filesystem or
 * editor call, answers the refusal's code in `source.result`, and shows its
 * message and hint once.
 *
 * @param pinned The frame's `pinned` member, as the protocol parsed it.
 * @returns `Ok` with the pin, or `Err` with `FS_UNSAFE_PATH` and constant
 * copy that repeats nothing from the frame. Never throws.
 */
export function forwardedSourcePin(
  pinned: SourceOpenPin | undefined,
): Result<SourceOpenPin, DebuggenError> {
  if (pinned !== undefined) {
    return ok(pinned);
  }
  return err(
    new DebuggenError(
      'FS_UNSAFE_PATH',
      'Debug Generator did not open a source location the service forwarded without the file identity it checked.',
      {
        hint: 'Run the same version of the Debug Generator extension and service, then click the source link again.',
        details: { reason: 'unpinned-forward' },
      },
    ),
  );
}

/**
 * Opens a {@link SourceLocation} that belongs to a session, enforcing the
 * session's project root.
 *
 * This is the one sink every session-scoped editor open ends in: a forwarded
 * `source.open` (`src/extension.ts`), the `debuggen.openSource` command, and
 * the session view's `openFile` frame, which dispatches to that command. It is
 * the boundary that treats the location as untrusted — a model-suggested
 * location included. `apps/local-service`'s `source/open.ts` has already
 * checked containment and `realpath` for a forwarded frame, and this function
 * proves it all again anyway, because that verdict was true only at the
 * instant it was computed and the frame then crossed a socket; and the command
 * and the webview have no service verdict at all.
 *
 * The gate, in order, with no editor call before step 8 and nothing shown
 * before step 9:
 *
 * 1. **Shape** — `parseSourceLocation`, whatever validated it upstream.
 * 2. **Project root** — present, from the session record.
 * 3. **Lexical containment** — `resolveWithinProject`, then `isWithin`.
 * 4. **Canonical containment** — `realpath` of the root and of the candidate,
 *    the candidate strictly inside, its canonical relative path safe; a link
 *    that leads out of the project, at any component, is refused here.
 * 5. **Regular-file identity** — a non-following `lstat` of the canonical path
 *    must be a regular file; its device and inode are recorded.
 * 6. **The pin** — when {@link OpenSourceContext.pinned} is present, the
 *    canonical relative path, device and inode must all equal it.
 * 7. **Identity at opening** — the canonical path opened
 *    `O_RDONLY | O_NOFOLLOW | O_NONBLOCK`, the descriptor's `fstat` and a
 *    fresh `lstat` both the recorded inode; the descriptor stays open.
 * 8. **The editor's copy** — the document loaded without being shown; after
 *    the load the path must still name the recorded inode, and the document's
 *    text must equal the bytes then read through that descriptor.
 * 9. **The reveal** — of that same verified document, at the **canonical**
 *    path, never the lexical one and never reopened by path; the descriptor
 *    is released once the editor has shown it.
 *
 * Refusal codes: `PROTOCOL_INVALID_MESSAGE` (shape), `PATH_OUTSIDE_PROJECT`
 * (steps 2–3), `FS_UNSAFE_PATH` (a path the filesystem leads out of the
 * project, one that cannot be resolved or read, a pin that does not match, or
 * a file that changed between steps — the service's code for the same escape),
 * and `PROJECT_NOT_FOUND` (nothing to open inside the project). A location
 * reached through a link out of the project is refused alike whether or not
 * its outside target exists, so the answer is no filesystem oracle. No
 * refusal's message, details or log line holds an absolute path or a link
 * target: the project-relative `file:line:column` and an errno code are all
 * that is reported.
 *
 * Every failure is reported exactly once, as a warning notification and as an
 * `Err`; nothing throws (AAP §0.5.5).
 *
 * @param location The location to open. Validated here, whatever validated it
 * upstream.
 * @param context The session's project root — from the stored session record,
 * never from the message that carried the location — and, for a forwarded
 * frame, the service's pin.
 * @param deps Optional logger, reveal implementation and warning sink.
 * @returns `Ok` with the reveal outcome, or `Err` carrying one of the refusal
 * codes above, or whatever the reveal itself reported.
 */
export async function openSourceLocation(
  location: SourceLocation,
  context: OpenSourceContext,
  deps?: OpenSourceDeps,
): Promise<Result<RevealOutcome, DebuggenError>> {
  const logger = deps?.logger;
  const showWarning = deps?.showWarning ?? showWarningNotification;

  try {
    // 1. Shape. The parameter is typed, but the value reaches here from a
    //    WebSocket frame or a command argument, so the type is a claim rather
    //    than a guarantee. No location string is echoed into the message: a
    //    malformed value has no trustworthy `file`, `line` or `column` to name.
    const parsed = parseSourceLocation(location);
    if (!parsed.ok) {
      const error = parsed.error;
      logger?.warn('Refused an invalid source location', {
        code: error.code,
        details: error.details,
      });
      showWarning(refusalMessage('Debug Generator received an invalid source location.', error));
      return err(error);
    }
    const valid = parsed.value;
    const at = formatSourceLocation(valid);

    // 2. Project root sanity. `PATH_OUTSIDE_PROJECT` rather than a
    //    configuration code, and for the same reason the shared path gate uses
    //    it for a non-absolute root: containment is what cannot be established,
    //    and the caller's user interface treats that as one refusal whatever
    //    its cause.
    const projectRoot = context.projectRoot;
    if (projectRoot.trim().length === 0) {
      const error = new DebuggenError(
        'PATH_OUTSIDE_PROJECT',
        'This session has no project root, so a source location cannot be checked against it.',
        {
          hint: 'Start the session again from the Debug Generator view so its project root is recorded.',
          details: { file: valid.file, line: valid.line, column: valid.column },
        },
      );
      logger?.warn('Refused a source location: the session has no project root', {
        file: valid.file,
      });
      showWarning(refusalMessage(`Debug Generator could not open ${at}.`, error));
      return err(error);
    }

    // 3. Containment, twice. `resolveWithinProject` refuses an absolute path, a
    //    '..' traversal, a backslash, a control character and a non-absolute
    //    root; `isWithin` is then asserted explicitly on the resolved path.
    //    The second check is intentional belt and braces: it is the invariant
    //    this function's contract actually rests on, stated where a reader can
    //    see it, so a future change to either helper cannot open the gate
    //    without failing here. `startsWith` is never the predicate — it would
    //    accept a sibling directory whose name merely extends the root's.
    const resolved = resolveWithinProject(projectRoot, valid.file);
    if (!resolved.ok) {
      // The underlying message embeds the absolute project root, which must not
      // reach a log line or a notification (AAP §0.5.2), so it travels as
      // `cause` only and the code is preserved.
      const error = new DebuggenError(
        'PATH_OUTSIDE_PROJECT',
        `${at} is outside the session's project; Debug Generator will not open it.`,
        {
          hint: 'A source location must be a project-relative path inside the session you started.',
          details: { file: valid.file, resolvedBy: valid.resolvedBy },
          cause: resolved.error,
        },
      );
      logger?.warn('Refused a source location outside the project', { file: valid.file });
      showWarning(refusalMessage(error.message, error));
      return err(error);
    }

    const absolutePath = resolved.value;
    if (!isWithin(toPosix(projectRoot), absolutePath)) {
      const error = new DebuggenError(
        'PATH_OUTSIDE_PROJECT',
        `${at} is outside the session's project; Debug Generator will not open it.`,
        {
          hint: 'A source location must be a project-relative path inside the session you started.',
          details: { file: valid.file, resolvedBy: valid.resolvedBy },
        },
      );
      logger?.warn('Refused a source location that failed the containment re-check', {
        file: valid.file,
      });
      showWarning(refusalMessage(error.message, error));
      return err(error);
    }

    // Every refusal from here on is the canonical gate's: one log record by
    // reason and code, one warning, one `Err` — and no absolute path, link
    // target or platform message in any of them.
    const refuseAtGate = (refusal: GateRefusal): Result<RevealOutcome, DebuggenError> => {
      const copy = GATE_REFUSALS[refusal.reason];
      const details: Record<string, unknown> = {
        file: valid.file,
        line: valid.line,
        column: valid.column,
        reason: refusal.reason,
      };
      if (refusal.errno !== undefined) {
        details['errno'] = refusal.errno;
      }
      const error = new DebuggenError(copy.code, copy.headline(at), { hint: copy.hint, details });
      logger?.warn('Refused a source location that failed the canonical check', {
        file: valid.file,
        reason: refusal.reason,
        code: error.code,
        errno: refusal.errno,
      });
      showWarning(refusalMessage(error.message, error));
      return err(error);
    };

    // 4–5. Canonical containment and regular-file identity: which object the
    //      location names on disk, with every link on its path resolved.
    const canonical = await resolveCanonicalTarget(projectRoot, absolutePath);
    if (!canonical.ok) {
      return refuseAtGate(canonical.error);
    }
    const target = canonical.value;

    // 6. The pin. Checked after this function's own resolution, never instead
    //    of it: the pin says what the service proved, and a location whose
    //    link was re-pointed or whose file was replaced since then resolves to
    //    another path or another inode here.
    const pinned = context.pinned;
    if (pinned !== undefined && !matchesPin(target, pinned)) {
      return refuseAtGate(gateRefusal('pin-mismatch'));
    }

    // 7–9. Identity at opening, the editor's unshown copy re-checked after its
    //      load, then the reveal of that same copy — all through one held
    //      no-follow descriptor. The URI is built from the canonical path,
    //      which is the only path this function ever opens.
    const uri = vscode.Uri.file(target.canonicalPath);
    const load =
      deps?.loadDocument ?? ((toLoad: vscode.Uri) => vscode.workspace.openTextDocument(toLoad));
    const reveal = deps?.reveal ?? revealDocumentInEditor;
    // Built key by key: under `exactOptionalPropertyTypes` an absent `endLine`,
    // `symbol` or `logger` has to be an absent key, not one holding
    // `undefined`.
    const revealOptions: { endLine?: number; symbol?: string; logger?: Logger } = {};
    if (valid.endLine !== undefined) {
      revealOptions.endLine = valid.endLine;
    }
    if (valid.symbol !== undefined) {
      revealOptions.symbol = valid.symbol;
    }
    if (logger !== undefined) {
      revealOptions.logger = logger;
    }

    // The 1-based line and column pass through unchanged: the conversion to
    // VS Code's 0-based positions happens only inside the primitive, which
    // receives the verified document rather than the URI.
    const shown = await showThroughGate(target, uri, load, logger, (document) =>
      reveal(document, valid.line, valid.column, revealOptions),
    );
    if (!shown.ok) {
      return refuseAtGate(shown.error);
    }
    const outcome = shown.value;
    if (!outcome.ok) {
      const error = outcome.error;
      logger?.warn('Could not open a source location', {
        file: valid.file,
        line: valid.line,
        column: valid.column,
        code: error.code,
      });
      showWarning(refusalMessage(`Debug Generator could not open ${at}.`, error));
      return outcome;
    }

    logger?.info('Opened a source location', {
      file: valid.file,
      line: valid.line,
      column: valid.column,
      resolvedBy: valid.resolvedBy,
      confidence: valid.confidence,
      clamped: outcome.value.clamped,
      pinned: pinned !== undefined,
    });
    return outcome;
  } catch (thrown) {
    // Nothing above is expected to throw — every step returns a `Result` — so
    // this is the guarantee rather than a branch: a defect here must degrade to
    // a reported failure instead of an unhandled rejection the editor shows as
    // an extension crash (AAP §0.5.5).
    const error = DebuggenError.from(thrown, 'INTERNAL');
    logger?.error('Opening a source location failed unexpectedly', { code: error.code });
    showWarning(refusalMessage('Debug Generator could not open the source location.', error));
    return err(error);
  }
}

// ---------------------------------------------------------------------------
// The editor's answer: `source.result`
// ---------------------------------------------------------------------------

/**
 * The `source.open` frame being answered, reduced to the two values the answer
 * repeats: the session the frame named and the frame's own envelope `id`,
 * which becomes the answer's `ref`.
 */
export interface ForwardedSourceOpen {
  /** The `sessionId` of the `source.open` payload. */
  readonly sessionId: string;

  /**
   * The `id` of the `source.open` envelope the service sent this editor. The
   * service correlates the answer by this value alone and relays the outcome
   * to the DevTools panel that asked under the id of *that* panel's frame.
   */
  readonly ref: string;
}

/**
 * What became of one `source.open` the service forwarded to this editor — the
 * input of {@link sourceResultFor}.
 *
 * - `opened` — {@link openSourceLocation} revealed the location.
 * - `unknown-session` — no session this window can see carries the id the
 *   frame named, so there is no project root to check containment against and
 *   nothing was opened.
 * - `not-opened` — {@link openSourceLocation} answered an `Err`. Only its
 *   `code` is kept: the error's message names the location and its `cause` may
 *   quote the absolute project root, and neither may leave the editor
 *   (AAP §0.5.2).
 * - `unexpected` — the attempt threw.
 *
 * `no-editor` has no counterpart here: it is the service's answer when no
 * editor is connected, never an editor's.
 */
export type ForwardedSourceOpenOutcome =
  | { readonly kind: 'opened' }
  | { readonly kind: 'unknown-session' }
  | { readonly kind: 'not-opened'; readonly code: DebuggenErrorCode }
  | { readonly kind: 'unexpected' };

/** The developer-facing sentence and next step of one `failed` answer. */
interface SourceResultCopy {
  readonly message: string;
  readonly hint: string;
}

/** The answer for a session this window does not know. */
const UNKNOWN_SESSION_COPY: SourceResultCopy = Object.freeze({
  message:
    'The VS Code window that received this source link does not know its session, so nothing was opened.',
  hint: 'Open the session from the Debug Generator Sessions view in the VS Code window for its project, then click the link again.',
});

/**
 * The answer for each code {@link openSourceLocation} reports a refusal or a
 * failed reveal under. A code without an entry — anything the reveal primitive
 * or a later change reports — gets {@link NOT_OPENED_FALLBACK_COPY}, and its
 * code still travels, so the panel can tell the cases apart.
 */
const NOT_OPENED_COPY: Readonly<Partial<Record<DebuggenErrorCode, SourceResultCopy>>> =
  Object.freeze({
    PROTOCOL_INVALID_MESSAGE: {
      message:
        'VS Code refused the source location because it is not a valid project-relative location.',
      hint: 'Capture again so the panel carries a fresh location, then click the link again.',
    },
    PATH_OUTSIDE_PROJECT: {
      message:
        "VS Code refused the source location because it is not inside the session's project.",
      hint: 'A source link can only open a file inside the project the session was started for.',
    },
    PROJECT_NOT_FOUND: {
      message: 'VS Code could not open the file this source link names.',
      hint: 'The file may have been moved, renamed or deleted since the capture.',
    },
    FS_UNSAFE_PATH: {
      message:
        "VS Code refused the source location because the file it names could not be verified as the one inside the session's project.",
      hint: 'A source link cannot follow a symbolic link out of the project or open a file that changed after the service checked it; click the link again.',
    },
  });

/** The answer for a failure whose code has no entry in {@link NOT_OPENED_COPY}. */
const NOT_OPENED_FALLBACK_COPY: SourceResultCopy = Object.freeze({
  message: 'VS Code could not open the source location.',
  hint: 'The Debug Generator output channel in VS Code records the reason.',
});

/** The answer for an attempt that threw. */
const UNEXPECTED_COPY: SourceResultCopy = Object.freeze({
  message: 'VS Code could not open the source location because of an unexpected error.',
  hint: 'Check the Debug Generator output channel in VS Code, then click the link again.',
});

/**
 * Builds the `source.result` payload this editor answers a forwarded
 * `source.open` with.
 *
 * Pure: no editor call, no I/O, no clock. `src/extension.ts` calls it once per
 * forwarded frame, after {@link openSourceLocation} settled, and sends the
 * payload through `ServiceClient.send`; the service relays it to the DevTools
 * panel, which renders `opened` as done and a `failed` answer as the failure it
 * is — never a queued frame as a success.
 *
 * Every `message` and `hint` is a constant sentence chosen by the outcome and
 * the error code, so nothing the editor learned while trying — the location,
 * an absolute path, a thrown value — reaches the panel. The payload is
 * validated with the protocol's own `parseSourceResultPayload` before it is
 * returned, so a `ref` the service would refuse (an envelope id longer than a
 * `ref` may be) is an `Err` here rather than a frame the service drops.
 *
 * @param answered The frame being answered.
 * @param outcome What became of it.
 * @returns `ok(payload)`, or `err(error)` with `PROTOCOL_INVALID_MESSAGE` when
 * the frame's identifiers cannot form a valid answer. Never throws.
 *
 * @example
 * ```ts
 * const pin = forwardedSourcePin(payload.pinned);
 * const opened = isOk(pin)
 *   ? await openSourceLocation(payload.location, { projectRoot, pinned: pin.value })
 *   : pin;
 * const answer = sourceResultFor(
 *   { sessionId: payload.sessionId, ref: message.id },
 *   isOk(opened) ? { kind: 'opened' } : { kind: 'not-opened', code: opened.error.code },
 * );
 * if (isOk(answer)) {
 *   client.send('source.result', answer.value);
 * }
 * ```
 */
export function sourceResultFor(
  answered: ForwardedSourceOpen,
  outcome: ForwardedSourceOpenOutcome,
): Result<SourceResultPayload, DebuggenError> {
  const { sessionId, ref } = answered;
  switch (outcome.kind) {
    case 'opened':
      return parseSourceResultPayload({ sessionId, ref, status: 'opened' });
    case 'unknown-session':
      return parseSourceResultPayload({
        sessionId,
        ref,
        status: 'failed',
        error: { code: 'SESSION_NOT_FOUND', ...UNKNOWN_SESSION_COPY },
      });
    case 'not-opened':
      return parseSourceResultPayload({
        sessionId,
        ref,
        status: 'failed',
        error: {
          code: outcome.code,
          ...(NOT_OPENED_COPY[outcome.code] ?? NOT_OPENED_FALLBACK_COPY),
        },
      });
    case 'unexpected':
      return parseSourceResultPayload({
        sessionId,
        ref,
        status: 'failed',
        error: { code: 'INTERNAL', ...UNEXPECTED_COPY },
      });
  }
}
