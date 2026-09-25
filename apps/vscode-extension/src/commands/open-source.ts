/**
 * `debuggen.openSource` — opens a {@link SourceLocation} in the editor.
 *
 * This is the command behind every click-to-source affordance that starts in
 * the editor itself: the `RelevantFiles`, `ModificationsList` and
 * `AnalysisSummary` rows of the Debug Generator view (their `openFile` message
 * reaches here through `src/views/session-view-provider.ts`), and any
 * programmatic `vscode.commands.executeCommand('debuggen.openSource', …)`. The
 * DevTools panel's source chips travel the same contract over WebSocket
 * `source.open` and end in the same opener (AAP §0.2.3, §0.4.2).
 *
 * ## What it does — and deliberately nothing more
 *
 * 1. **Validates the argument as untrusted.** A command can be invoked by
 *    anything in the editor with anything as its argument, so the value is
 *    parsed with `parseSourceLocation` from `@debuggen/shared` — the single
 *    schema every hop of the source path uses — before anything else happens.
 *    Both a bare `SourceLocation` and a `{ location }` envelope are accepted.
 * 2. **Resolves the containment root.** The active session's `projectRoot`
 *    when its record is loaded, otherwise the workspace project the shared
 *    guard resolves. The root is never taken from the argument: a caller that
 *    could nominate its own root would defeat the containment check.
 * 3. **Delegates once** to the injected `OpenSourcePort`, whose production
 *    implementation is `openSourceLocation` in `src/source/open-location.ts`.
 *    That function re-validates the location against the root it is given,
 *    refuses anything outside it, and owns every editor mechanic — the
 *    document, the 1-based → 0-based conversion, the selection, the reveal and
 *    the transient line highlight.
 *
 * This module never calls `showTextDocument`, `openTextDocument` or
 * `revealRange`, and never touches `revealLocationInEditor`: that primitive
 * has no containment policy of its own and is reserved for
 * `src/uri-handler.ts`, whose policy is the open workspace folders. Reaching
 * it from here would open a file on the strength of no check at all.
 *
 * It performs no HTTP operation — it is the terminal hop of the source path,
 * not an initiator — and holds no server state.
 *
 * ## Failure behaviour
 *
 * Nothing here throws. Every failure is reported exactly once through
 * `CommandUi`, which renders it in the Debug Generator view and as a
 * notification; success is silent, because the editor moving to the location
 * is the feedback. A refused location opens nothing (AAP §0.5.5).
 *
 * ## Privacy
 *
 * A rejected argument is never echoed: the message names the offending fields
 * and the schema's own description of what was wrong with them, not the value
 * (AAP §0.5.2). An accepted location is displayed only in its project-relative
 * `file:line:column` form, and the log lines record the resolution route or an
 * error code alone — never a path or file content.
 */

import type { SourceLocation } from '@debuggen/protocol';
import {
  DebuggenError,
  err,
  formatSourceLocation,
  isErr,
  parseSourceLocation,
} from '@debuggen/shared';
import type { Result } from '@debuggen/shared';

import type { OpenSourceContext, RevealOutcome } from '../source/open-location';

import type { CommandContext, CommandId, CommandNotice } from './index';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** This module's command id, checked against the contributed id table. */
const COMMAND_ID = 'debuggen.openSource' satisfies CommandId;

/**
 * The key of the envelope form, `{ location: SourceLocation }` — the payload
 * shape of the webview's `openFile` message and of the `source.open` message,
 * which a caller may forward whole rather than unwrapped.
 */
const ENVELOPE_KEY = 'location';

/**
 * The key a bare location always carries. An object that has it is treated as
 * the location itself, even if it also happens to carry a `location` key: the
 * schema strips unknown keys, so that extra key cannot change what is opened.
 */
const BARE_LOCATION_KEY = 'file';

/** Shown when the command is run without a location, e.g. from a keybinding. */
const MISSING_LOCATION_NOTICE: CommandNotice = Object.freeze({
  level: 'info',
  message: 'Open Source Location needs a source location to open.',
  detail: 'Choose a source link in the generated panel or a file in the Debug Generator view.',
});

/** The failure prefix for an argument that is not a valid source location. */
const INVALID_LOCATION_PREFIX = 'Could not open that location';

/**
 * How many validation issues the failure message names. The rest are counted,
 * not listed: a notification is not where a whole validation dump belongs, and
 * the first few fields are enough to fix a producer.
 */
const MAX_REPORTED_ISSUES = 3;

/** Upper bound on one issue's schema message in the failure text. */
const MAX_ISSUE_MESSAGE_LENGTH = 160;

/** The label of an issue raised on the location object itself (empty path). */
const WHOLE_VALUE_LABEL = 'location';

// ---------------------------------------------------------------------------
// Argument handling
// ---------------------------------------------------------------------------

/**
 * The command's argument after unwrapping: either absent, or a value still to
 * be validated.
 */
type LocationArgument =
  { readonly kind: 'missing' } | { readonly kind: 'present'; readonly value: unknown };

/** Whether a value is a plain, non-array object whose keys can be inspected. */
function isInspectableObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Reads the command's first argument and unwraps a `{ location }` envelope.
 *
 * The envelope's `location` is read through its property descriptor rather
 * than by property access, so an accessor on a hand-built argument is never
 * invoked: its data value is taken when it has one, and an accessor yields
 * `undefined`, which then fails validation like any other malformed value.
 *
 * `undefined` and `null` count as no argument at all — the two values VS Code
 * and a programmatic caller use for "nothing was passed".
 *
 * @param args The command's arguments, untrusted.
 * @returns The value to validate, or `missing`.
 */
function readLocationArgument(args: readonly unknown[]): LocationArgument {
  const first: unknown = args[0];
  if (first === undefined || first === null) {
    return { kind: 'missing' };
  }
  if (
    isInspectableObject(first) &&
    Object.hasOwn(first, ENVELOPE_KEY) &&
    !Object.hasOwn(first, BARE_LOCATION_KEY)
  ) {
    const descriptor = Object.getOwnPropertyDescriptor(first, ENVELOPE_KEY);
    return { kind: 'present', value: descriptor?.value };
  }
  return { kind: 'present', value: first };
}

/** One validation issue as `parseSourceLocation` reports it: a field path and the schema's message. */
interface LocationIssue {
  readonly path: string;
  readonly message: string;
}

/**
 * Reads the `details.issues` array `parseSourceLocation` attaches to its
 * error. Defensive: `details` is typed as an open record, so every entry is
 * checked rather than assumed, and a malformed entry is skipped.
 */
function readIssues(error: DebuggenError): readonly LocationIssue[] {
  const issues: unknown = error.details?.['issues'];
  if (!Array.isArray(issues)) {
    return [];
  }
  const read: LocationIssue[] = [];
  for (const issue of issues as readonly unknown[]) {
    if (!isInspectableObject(issue)) {
      continue;
    }
    const path: unknown = Object.getOwnPropertyDescriptor(issue, 'path')?.value;
    const message: unknown = Object.getOwnPropertyDescriptor(issue, 'message')?.value;
    if (typeof path === 'string' && typeof message === 'string' && message.trim() !== '') {
      read.push({ path, message });
    }
  }
  return read;
}

/** Bounds one issue message so a single verbose issue cannot crowd out the rest. */
function boundIssueMessage(message: string): string {
  const trimmed = message.trim().replace(/[\s.]+$/, '');
  return trimmed.length > MAX_ISSUE_MESSAGE_LENGTH
    ? `${trimmed.slice(0, MAX_ISSUE_MESSAGE_LENGTH - 1).trimEnd()}…`
    : trimmed;
}

/**
 * Rebuilds a `parseSourceLocation` rejection into the error the developer sees.
 *
 * The message is composed from the schema's own issue descriptions — the
 * dotted field path and the validator's message, e.g. `line — Too small:
 * expected number to be >=1` — and never from the rejected value, which
 * `parseSourceLocation` already keeps out of `details` (AAP §0.5.2). The
 * original code and hint are preserved, and the original error travels as
 * `cause` for anything that inspects it.
 *
 * @param error The rejection returned by `parseSourceLocation`.
 * @returns An error whose message states which fields failed and why.
 */
function describeInvalidLocation(error: DebuggenError): DebuggenError {
  const issues = readIssues(error);
  if (issues.length === 0) {
    return error;
  }
  const listed = issues
    .slice(0, MAX_REPORTED_ISSUES)
    .map(
      (issue) =>
        `${issue.path === '' ? WHOLE_VALUE_LABEL : issue.path} — ${boundIssueMessage(issue.message)}`,
    );
  const unlisted = issues.length - listed.length;
  const more = unlisted > 0 ? `; and ${unlisted} more` : '';
  const message = `The value is not a valid source location (${listed.join('; ')}${more}).`;

  return new DebuggenError(error.code, message, {
    ...(error.hint !== undefined ? { hint: error.hint } : {}),
    ...(error.details !== undefined ? { details: error.details } : {}),
    cause: error,
  });
}

// ---------------------------------------------------------------------------
// Containment root and delegation
// ---------------------------------------------------------------------------

/**
 * The project root the location must lie inside.
 *
 * The active session's `projectRoot` is authoritative whenever its record is
 * loaded — that is the root the service validated the location against and the
 * one the session's runtime items are relative to. Only when no record is
 * loaded (the webview's relevant-file rows can outlive a service restart, for
 * instance) does the workspace project stand in. That fallback cannot widen
 * the policy: `openSourceLocation` checks the location against whichever root
 * it is handed and refuses anything outside it.
 *
 * @returns The root, or `undefined` when the workspace guard has already told
 * the developer what is missing.
 */
function resolveContainmentRoot(ctx: CommandContext): string | undefined {
  const session = ctx.state.activeSession;
  if (session !== undefined) {
    return session.projectRoot;
  }
  return ctx.guards.requireWorkspaceProject()?.projectRoot;
}

/**
 * Makes the one delegated call, keeping this command's "never throws" promise
 * even for a port that breaks its own contract: the production opener never
 * rejects, but a substituted one might, and a throw converted here is still
 * reported exactly once below rather than falling through to the generic
 * command-failure path.
 */
async function openThroughPort(
  ctx: CommandContext,
  location: SourceLocation,
  context: OpenSourceContext,
): Promise<Result<RevealOutcome, DebuggenError>> {
  try {
    return await ctx.openSource.open(location, context);
  } catch (thrown) {
    // The thrown value's own message may name an absolute path (an editor
    // file-system error does), so only a product error keeps its message; any
    // other value travels as `cause` behind a fixed one.
    const error = DebuggenError.is(thrown)
      ? thrown
      : new DebuggenError('INTERNAL', 'The editor could not show the file.', { cause: thrown });
    ctx.logger.warn('Source opener failed unexpectedly', { command: COMMAND_ID, code: error.code });
    return err(error);
  }
}

/**
 * The failure prefix for a location the opener did not open.
 *
 * A `PATH_OUTSIDE_PROJECT` result is a deliberate refusal, not a malfunction,
 * so it is worded as one. The location is named in its project-relative
 * `file:line:column` form unless the opener's message already names it, which
 * keeps the headline from stating the same reference twice.
 *
 * @param error The opener's rejection.
 * @param reference `formatSourceLocation(location)`.
 */
function openFailurePrefix(error: DebuggenError, reference: string): string {
  const verb = error.code === 'PATH_OUTSIDE_PROJECT' ? 'Refused to open' : 'Could not open';
  const target = error.message.includes(reference) ? 'the source location' : reference;
  return `${verb} ${target}`;
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

/**
 * `debuggen.openSource`: validates a source location, resolves the project it
 * must belong to, and hands it to the session-scoped opener.
 *
 * Accepts, as its first argument, either a bare {@link SourceLocation} (what
 * the Debug Generator view forwards) or a `{ location }` envelope (a forwarded
 * `openFile` or `source.open` payload). Any further arguments are ignored.
 *
 * Outcomes, each reported at most once and never by throwing:
 *
 * - no argument → an informational notice saying where to pick a location;
 * - an argument that is not a valid location → one failure naming the fields
 *   that failed validation, without echoing the value;
 * - no loaded session and no workspace project → the workspace guard's own
 *   notice, and nothing else;
 * - a location the opener refuses or cannot show → one failure naming the
 *   project-relative `file:line:column`;
 * - success → silence: the editor showing the location is the feedback.
 *
 * @param ctx The command context built by `registerCommands`.
 * @param args The command's arguments, untrusted.
 *
 * @example
 * ```ts
 * await vscode.commands.executeCommand('debuggen.openSource', {
 *   file: 'src/lib/thing.ts',
 *   line: 42,
 *   column: 3,
 *   resolvedBy: 'code-graph',
 *   confidence: 0.9,
 * });
 * ```
 */
export async function openSource(ctx: CommandContext, ...args: readonly unknown[]): Promise<void> {
  const argument = readLocationArgument(args);
  if (argument.kind === 'missing') {
    await ctx.ui.notify(MISSING_LOCATION_NOTICE);
    return;
  }

  const parsed = parseSourceLocation(argument.value);
  if (isErr(parsed)) {
    await ctx.ui.notifyFailure(describeInvalidLocation(parsed.error), {
      prefix: INVALID_LOCATION_PREFIX,
    });
    return;
  }
  const location = parsed.value;
  ctx.logger.debug('Open source requested', {
    command: COMMAND_ID,
    resolvedBy: location.resolvedBy,
  });

  const projectRoot = resolveContainmentRoot(ctx);
  if (projectRoot === undefined) {
    // The workspace guard has already explained what is missing.
    return;
  }

  const context: OpenSourceContext = { projectRoot };
  const opened = await openThroughPort(ctx, location, context);
  if (isErr(opened)) {
    await ctx.ui.notifyFailure(opened.error, {
      prefix: openFailurePrefix(opened.error, formatSourceLocation(location)),
    });
  }
}
