/**
 * Click-to-source, editor end: the terminal hop of the product's source-open
 * path (AAP §0.4.2).
 *
 * ```text
 * SourceLink → PanelActions.openSource → the DevTools panel's actions.ts
 *   → a runtime port → the Chrome service worker → WebSocket `source.open`
 *   → the local service, which validates containment against the session's
 *     projectRoot → WebSocket to the VS Code client → THIS MODULE
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
 *   already decided to trust, and validates only the numeric contract. This is
 *   what `src/uri-handler.ts` uses, because a `vscode://` URI can be triggered
 *   by any web page and is therefore validated against the **open workspace
 *   folders** with `fs.realpath` and a developer confirmation — a policy this
 *   module must not second-guess (AAP §0.2.3).
 * - {@link openSourceLocation} is the session-scoped opener used by
 *   `src/extension.ts` for every inbound `source.open` message and for the
 *   `debuggen.openSource` command. Its policy is the **session's
 *   `projectRoot`**, re-checked here even though `apps/local-service`'s
 *   `source/open.ts` already checked it: the location is untrusted at every
 *   hop, and defence in depth is the stated design (AAP §0.2.3).
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
 * displays the project-relative `file:line:column` only.
 */

import * as vscode from 'vscode';

import {
  DebuggenError,
  err,
  formatSourceLocation,
  fromPromise,
  isWithin,
  ok,
  parseSourceLocation,
  resolveWithinProject,
  toPosix,
  tryCatch,
} from '@debuggen/shared';
import type { DebuggenErrorCode, Logger, Result, SourceLocation } from '@debuggen/shared';

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
}

/**
 * Injectable collaborators for {@link openSourceLocation}.
 *
 * All three are optional and default to the production implementation. They
 * exist so the containment verdict can be asserted without opening an editor
 * and without a toast appearing in a test run.
 */
export interface OpenSourceDeps {
  /** Where this module's diagnostics go. Absent means no logging. */
  readonly logger?: Logger;

  /**
   * The reveal primitive to delegate to. Defaults to
   * {@link revealLocationInEditor}.
   */
  readonly reveal?: typeof revealLocationInEditor;

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

  const document = opened.value;

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
  const revealed = tryCatch(() => {
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

/**
 * Opens a {@link SourceLocation} that belongs to a session, enforcing the
 * session's project root.
 *
 * This is what `src/extension.ts` calls for every inbound `source.open` message
 * and for the `debuggen.openSource` command, and it is the boundary that treats
 * the location as untrusted. `apps/local-service`'s `source/open.ts` has
 * already validated the payload, authorised the principal and checked
 * containment and `realpath` before forwarding — and this function checks
 * containment again anyway, because a click-to-source path that reads a file
 * outside the project on the strength of one process's verdict has no defence
 * in depth at all (AAP §0.2.3).
 *
 * The order is: shape, then project root, then containment, and only then any
 * editor call — so a refused location never opens anything at all, not even
 * briefly.
 *
 * What this function deliberately does **not** do is resolve symlinks.
 * Filesystem-level escape checking belongs to the two policies that own a
 * filesystem question: `src/uri-handler.ts`, which validates a web-triggerable
 * `vscode://` URI against the open workspace folders with `fs.realpath`, and
 * the service's `source/open.ts`, which does the same against the session's
 * project root before the message is ever sent. Adding a third, differently
 * scoped `realpath` here would blur which policy actually decided, and would
 * make this module's containment answer depend on the state of the disk rather
 * than on the session it was given.
 *
 * Every failure is reported exactly once, as a warning notification and as an
 * `Err`; nothing throws (AAP §0.5.5).
 *
 * @param location The location to open. Validated here, whatever validated it
 * upstream.
 * @param context The session's project root — from the stored session record,
 * never from the message that carried the location.
 * @param deps Optional logger, reveal implementation and warning sink.
 * @returns `Ok` with the reveal outcome, or `Err` carrying
 * `PROTOCOL_INVALID_MESSAGE` for a malformed location, `PATH_OUTSIDE_PROJECT`
 * for one outside the session's project, or whatever the reveal itself
 * reported.
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

    // 4. The URI. `resolveWithinProject` returns a POSIX path, and
    //    `Uri.file` accepts forward slashes on every platform including
    //    Windows, so no separator surgery is needed here; a caller that ever
    //    needs a platform-native path should use `node:path` rather than
    //    rewriting the string.
    const uri = vscode.Uri.file(absolutePath);

    const reveal = deps?.reveal ?? revealLocationInEditor;
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
    // VS Code's 0-based positions happens only inside the primitive.
    const outcome = await reveal(uri, valid.line, valid.column, revealOptions);
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
