/**
 * Click-to-source, service end: the `source.open` gate and forwarder.
 *
 * Every runtime item a generated panel shows — a span, a render row, a request
 * group, a query — may carry a {@link SourceLocation}: the project-relative file,
 * line and column it came from. Clicking one is supposed to put the developer's
 * editor on that line. This module is the hop in the middle of that journey, and
 * it is the **service's containment gate**: no path leaves it unless it has been
 * proven, lexically and on the filesystem, to lie inside the session's project.
 *
 * ## The hop sequence
 *
 * ```text
 * a SourceLink chip in the rendered panel (@debuggen/panel-renderer)
 *   → PanelActions.openSource, the callback PanelHost hands every component
 *   → apps/chrome-extension/src/panel/actions.ts
 *   → a runtime port to apps/chrome-extension/src/background/service-worker.ts
 *   → WebSocket `source.open { sessionId, location }` to this service
 *   → THIS MODULE: validate → look the session up → authorize → contain → forward
 *   → WebSocket `source.open` to the session's VS Code client(s)
 *   → apps/vscode-extension/src/source/open-location.ts, which opens the document
 *     with `window.showTextDocument` and a selection at the location's 1-based
 *     line and column, then flashes a transient highlight
 * ```
 *
 * The location arrives already resolved and stamped (`resolvedBy`,
 * `confidence`) by whichever route produced it — patch metadata, the code
 * graph, a source map, the route map or the React owner chain. Resolution is
 * `./resolve.ts`'s job and this module deliberately does not import it: what it
 * forwards is the validated location exactly as the panel sent it, never
 * normalised, re-stamped or re-resolved.
 *
 * ## Containment first, and why
 *
 * A click-to-source request is data from a browser tab. The DevTools panel that
 * sends it renders a panel specification a model helped author, over telemetry a
 * web page helped produce, so the service treats the location as hostile until
 * proven otherwise. The handler therefore runs in a fixed order, and **no code
 * path reaches the forward step without both containment halves succeeding**:
 *
 * 1. **Validate the frame.** `parseSourceOpenPayload` (and, for a raw frame,
 *    `decodeMessage`/`parseMessage` first), then `parseSourceLocation` again as
 *    defence in depth. A rejection is described by issue paths and codes only;
 *    the rejected value is never echoed.
 * 2. **Look the session up** through the injected store port. The project root
 *    is taken from the stored `SessionRecord`, never from the message, so a
 *    client cannot name its own root.
 * 3. **Authorize** from the connection's *resolved* principal (AAP §0.5.6): an
 *    editor connection only for a project inside a workspace folder it
 *    announced; a DevTools connection only for the session bound to its own
 *    tab; the page agent and the dev-server agent never.
 * 4. **Contain, lexically** — {@link assertLocationWithinProject}: the shared
 *    path gate refuses `..` traversal, absolute POSIX paths, Windows drive and
 *    UNC forms, backslashes, control characters and the prefix-sibling case
 *    (`/proj-evil` is not inside `/proj`) without touching the filesystem.
 * 5. **Contain, on the filesystem** — {@link resolveRealPathWithinProject}: the
 *    project root and the candidate are both canonicalised through `realpath`
 *    and the canonical pair is re-checked with `isWithin`, so a symbolic link
 *    *inside* the project whose target lies outside it is refused. Optionally
 *    (on by default) a non-following `lstat` then confirms the canonical target
 *    is a regular file.
 * 6. **Forward** — `createEnvelope('source.open', …)` to the session's `vscode`
 *    clients through the injected client port.
 *
 * Only after step 5 has succeeded is anything sent, and the only filesystem
 * operations this module ever performs are `realpath` and `lstat`: it writes
 * nothing, reads no file content and opens no database.
 *
 * ## Three independent enforcement points
 *
 * The question "may this path be opened" is answered three times, by parties
 * that do not trust each other:
 *
 * 1. **This handler**, which holds the session's project root and the service's
 *    view of the filesystem.
 * 2. **The editor**: `apps/vscode-extension/src/source/open-location.ts` for a
 *    forwarded message, and the `vscode://debuggen.debug-generator/open` URI
 *    handler in `apps/vscode-extension/src/uri-handler.ts`, which performs its
 *    own `fs.realpath` plus workspace-folder containment and asks the developer
 *    to confirm, because any web page can trigger such a URI.
 * 3. **The shared pure-string path layer** in `@debuggen/shared`
 *    (`isSafeRelativePath`, `resolveWithinProject`, `isWithin`), which is the
 *    single containment predicate the other two apply. A bare `startsWith` is
 *    never used anywhere in this chain.
 *
 * ## Shape validation is not containment
 *
 * `parseSourceOpenPayload` validates **shape only** — the protocol module's own
 * documentation says so, and says that containment is enforced here and,
 * independently, by the editor. The embedded source-location schema happens to
 * refuse obvious traversal through `isSafeRelativePath`, but a string can never
 * reveal a symbolic link, so shape validation is never a substitute for steps 4
 * and 5 above; both run on every request, whatever the parser concluded.
 *
 * ## Non-delivery is an answer, not a failure
 *
 * When no editor client is connected for the session, the handler answers
 * `ok({ delivered: false, reason: 'no-editor-client' })`. That is the honest
 * outcome the caller needs: it is what tells the DevTools side to fall back to
 * the `vscode://debuggen.debug-generator/open?file&line&col` URI, which the
 * editor's URI handler validates on its own. The fallback is produced elsewhere;
 * this module only reports that the forward reached nobody.
 *
 * ## Wiring
 *
 * - `src/main.ts` constructs the handler with {@link createSourceOpenHandler},
 *   injecting the session store, the client registry, the service logger and,
 *   by default, `node:fs/promises` `realpath`.
 * - `src/server/ws.ts` routes each inbound `source.open` frame to
 *   {@link SourceOpenHandler.handle} together with the connection's
 *   {@link SourceOpenPrincipal}, and maps an `Err` onto the protocol `error`
 *   payload with `toErrorPayload` from `@debuggen/protocol`.
 * - `src/store/sessions-repo.ts` (`createSessionsRepo`) satisfies
 *   {@link SourceOpenSessionPort} structurally: `get` and `getBindingBySession`.
 * - `src/server/auth.ts` resolves the connection's credential into its
 *   `Principal`; `ws.ts` composes the {@link SourceOpenPrincipal} from that
 *   principal's `role`, the workspace folders the connection announced and the
 *   tab its binding names.
 * - `apps/vscode-extension/src/source/open-location.ts` is the terminal
 *   consumer of the forwarded frame.
 *
 * ## Privacy
 *
 * No log record and no error this module produces carries a credential or
 * token, an absolute path (inside or outside the project), a symbolic-link
 * target, file contents or a URL query value. Errors name at most the
 * project-relative file, and only once it has passed the lexical gate; a
 * lexically rejected path is not echoed at all, since it may itself be an
 * absolute path from elsewhere on the machine. Platform errors are reduced to
 * their `errno` code before they are recorded, because their messages quote the
 * absolute path they failed on.
 *
 * @module
 */

import { lstat, realpath as realpathAsync } from 'node:fs/promises';

import {
  clientKindSchema,
  createEnvelope,
  decodeMessage,
  isMessageOfType,
  isPlainRecord,
  parseMessage,
  parseSourceOpenPayload,
} from '@debuggen/protocol';
import type {
  ClientKind,
  ProtocolMessage,
  SessionRecord,
  SourceOpenPayload,
} from '@debuggen/protocol';
import {
  DebuggenError,
  err,
  fromPromise,
  isAbsolutePosix,
  isSafeRelativePath,
  isWindowsAbsolute,
  isWithin,
  noopLogger,
  normalizePosix,
  ok,
  parseSourceLocation,
  relativePosix,
  resolveWithinProject,
  toPosix,
  tryCatch,
} from '@debuggen/shared';
import type {
  DebuggenErrorCode,
  LogFields,
  Logger,
  Result,
  SessionId,
  SourceLocation,
} from '@debuggen/shared';

import { LOG_BINDING_KEYS, subsystemLogger } from '../logging.js';

/* -------------------------------------------------------------------------------------------------
 * Public vocabulary
 * ---------------------------------------------------------------------------------------------- */

/**
 * A value that may be produced synchronously or asynchronously.
 *
 * The ports below accept both so that the synchronous `node:sqlite`-backed
 * store (`src/store/sessions-repo.ts`) and an asynchronous test double or a
 * future remote registry satisfy them alike; the handler `await`s every port
 * result, which is a no-op for a plain value.
 */
export type MaybePromise<T> = T | Promise<T>;

/**
 * The closed vocabulary of reasons this handler refuses a `source.open`
 * request.
 *
 * Every refusal is a `DebuggenError` whose `details.rejection` is one of these
 * values, read back with {@link sourceOpenRejectionOf}; never a free-form
 * string. Operational failures — the store or the client registry failing — are
 * not refusals and carry no `rejection`.
 *
 * | Rejection | Error code | Meaning |
 * | --- | --- | --- |
 * | `invalid-payload` | `PROTOCOL_INVALID_MESSAGE` | the frame is not a well-formed `source.open` |
 * | `session-not-found` | `SESSION_NOT_FOUND` | the named session does not exist |
 * | `not-authorized` | `UNAUTHORIZED` or `TAB_NOT_BOUND` | the connection may not act on this session |
 * | `outside-project` | `PATH_OUTSIDE_PROJECT` | the path, as written, escapes the project root |
 * | `unsafe-path` | `FS_UNSAFE_PATH` | the path is inside as text, but the filesystem leads outside or cannot be vouched for |
 * | `file-missing` | `PROJECT_NOT_FOUND` | nothing openable exists at the path in the project |
 *
 * `not-authorized` mirrors the access-boundary vocabulary of
 * `src/server/auth.ts` exactly: a DevTools connection acting on a session its
 * tab is not bound to is `TAB_NOT_BOUND`; every other refusal is `UNAUTHORIZED`.
 * `file-missing` uses `PROJECT_NOT_FOUND`, the shared vocabulary's "the project
 * on disk: finding it" code, because no code names a single missing file and
 * inventing one is not permitted.
 */
export const SOURCE_OPEN_REJECTIONS = Object.freeze([
  'invalid-payload',
  'session-not-found',
  'not-authorized',
  'outside-project',
  'unsafe-path',
  'file-missing',
] as const);

/** One member of {@link SOURCE_OPEN_REJECTIONS}. */
export type SourceOpenRejection = (typeof SOURCE_OPEN_REJECTIONS)[number];

/**
 * The resolved identity of the connection a `source.open` frame arrived on.
 *
 * AAP §0.5.6: "the resolved role and scope become the request's identity, so
 * authorization never depends on a client's self-description." `src/server/ws.ts`
 * builds this value from what the service itself established about the
 * connection — the `role` of the `Principal` that `src/server/auth.ts` resolved
 * from the presented credential, the workspace folders the connection announced
 * in its authenticated `client.hello`, and the tab its binding names — never
 * from fields inside the frame.
 *
 * The role vocabulary is the protocol's `ClientKind`; none is declared here.
 */
export interface SourceOpenPrincipal {
  /** The client kind the connection authenticated as. */
  readonly client: ClientKind;
  /**
   * The absolute workspace folders an editor (`vscode`) connection announced.
   * An editor may open source only for a session whose project root is one of
   * them or lies beneath one; an editor that announced none may open nothing.
   */
  readonly projectRoots?: readonly string[] | undefined;
  /**
   * The inspected tab a DevTools (`devtools`) connection is bound to. Required
   * for a DevTools principal: it may open source only for the session bound to
   * this tab.
   */
  readonly tabId?: number | undefined;
  /**
   * The session the connection's binding names, when it has one. For a
   * DevTools principal a value here that differs from the frame's session is a
   * refusal, whatever the tab lookup says.
   */
  readonly sessionId?: string | undefined;
  /**
   * The credential's scope label (for example the paired extension id). It is
   * never consulted for a decision here — the folder and tab carriers above are
   * the scope that matters for this message — and it is never logged.
   */
  readonly scope?: string | undefined;
}

/**
 * The tab binding shape {@link SourceOpenSessionPort.getBindingBySession}
 * returns — a structural subset of the store's `TabBinding`, whose `tab` is a
 * `SessionRecord.boundTab` value.
 */
export interface SourceOpenBinding {
  /** The bound tab. */
  readonly tab: { readonly tabId: number };
}

/**
 * The session store as this handler needs to see it.
 *
 * Satisfied structurally by `createSessionsRepo(…)` from
 * `src/store/sessions-repo.ts`, whose methods are synchronous and return a
 * `Result`; an asynchronous implementation satisfies it equally.
 */
export interface SourceOpenSessionPort {
  /**
   * Reads one session.
   *
   * @param sessionId The session named in the frame.
   * @returns `ok(record)`, `ok(undefined)` when there is no such session, or
   * `err` when the store failed.
   */
  get(sessionId: SessionId): MaybePromise<Result<SessionRecord | undefined, DebuggenError>>;

  /**
   * Reads the tab bound to one session from the bindings table.
   *
   * Optional. When present it is authoritative for the DevTools rule — the
   * bindings table is where a bind is recorded — and `SessionRecord.boundTab`
   * is not consulted; when absent, `SessionRecord.boundTab` is.
   *
   * @param sessionId The session named in the frame.
   * @returns `ok(binding)`, `ok(undefined)` when no tab is bound, or `err`.
   */
  getBindingBySession?(
    sessionId: SessionId,
  ): MaybePromise<Result<SourceOpenBinding | undefined, DebuggenError>>;
}

/**
 * The delivery seam to connected clients.
 *
 * Satisfied by the service's client registry (`src/server/clients.ts`), wired
 * in `src/main.ts`. It is message-shaped on purpose: this module knows nothing
 * about sockets, `ws` or hono.
 */
export interface SourceOpenClientPort {
  /**
   * Sends one protocol message to every connected client of `clientKind` that
   * belongs to `sessionId`.
   *
   * @param sessionId The session whose clients receive the message.
   * @param clientKind Which kind of client receives it — always `'vscode'` here.
   * @param message The envelope to send, already validated.
   * @returns How many clients the message reached: a non-negative integer.
   */
  sendToSessionClients(
    sessionId: SessionId,
    clientKind: ClientKind,
    message: ProtocolMessage,
  ): MaybePromise<number>;
}

/**
 * The canonicaliser the filesystem half of containment uses.
 *
 * The shape of `node:fs/promises` `realpath`: it resolves **every** component,
 * symbolic links included, returns an absolute path, and throws (or rejects)
 * with the platform error — `ENOENT`, `ENOTDIR`, `ELOOP`, `EACCES` — when the
 * path cannot be resolved.
 */
export type SourceOpenRealPath = (path: string) => MaybePromise<string>;

/** Everything {@link createSourceOpenHandler} is given; nothing is reached for globally. */
export interface SourceOpenDeps {
  /** The session store. See {@link SourceOpenSessionPort}. */
  readonly sessions: SourceOpenSessionPort;
  /** The client registry. See {@link SourceOpenClientPort}. */
  readonly clients: SourceOpenClientPort;
  /**
   * The service logger. The handler derives a child with the standard
   * `subsystem: "source"` binding. Defaults to `noopLogger`.
   */
  readonly logger?: Logger | undefined;
  /**
   * The canonicaliser. Defaults to `node:fs/promises` `realpath`; tests inject
   * a table of links to exercise the symbolic-link cases deterministically.
   */
  readonly realpath?: SourceOpenRealPath | undefined;
  /**
   * Whether to confirm, with a non-following `lstat` of the canonical target,
   * that it is a regular file before forwarding. Defaults to `true`.
   *
   * Containment itself never depends on this flag: both halves run on every
   * request, and the canonicalisation of the filesystem half already fails for
   * a path that does not exist. Turning it off skips only the regular-file
   * check, which is what a caller that injects a table-based `realpath` over a
   * filesystem that does not hold the files needs.
   */
  readonly verifyExists?: boolean | undefined;
  /**
   * The clock stamped on the outbound envelope's `ts`, in epoch milliseconds.
   * Defaults to the protocol's own clock inside `createEnvelope`.
   */
  readonly now?: (() => number) | undefined;
}

/** The outcome of a request the editor received. */
export interface SourceOpenDelivered {
  readonly delivered: true;
  /** How many editor clients the forwarded frame reached; at least one. */
  readonly clients: number;
  /** The validated location, exactly as it was forwarded. */
  readonly location: SourceLocation;
  /**
   * The canonical project-relative path containment proved — the file the
   * editor will open. Equal to `location.file` unless the file was reached
   * through a symbolic link that stays inside the project.
   */
  readonly file: string;
}

/**
 * The outcome of a request no editor was connected to receive.
 *
 * A legitimate `Ok`: the location passed every check, and the caller should
 * now fall back to the `vscode://debuggen.debug-generator/open` URI.
 */
export interface SourceOpenUndelivered {
  readonly delivered: false;
  readonly reason: 'no-editor-client';
  /** The validated location, for the caller to build the fallback URI from. */
  readonly location: SourceLocation;
}

/** What {@link SourceOpenHandler.handle} answers with on success. */
export type SourceOpenOutcome = SourceOpenDelivered | SourceOpenUndelivered;

/** The lexical half's proof: where the location lands inside the project, as text. */
export interface LexicalContainment {
  /** The absolute POSIX path of the location's file under the project root. */
  readonly absolutePath: string;
}

/** The filesystem half's proof: where the location lands once every link is resolved. */
export interface RealPathContainment {
  /** The project root, canonicalised. */
  readonly realProjectRoot: string;
  /** The target, canonicalised; lies strictly beneath {@link RealPathContainment.realProjectRoot}. */
  readonly realPath: string;
  /** {@link RealPathContainment.realPath} relative to the canonical root, POSIX. */
  readonly relativePath: string;
}

/**
 * The `source.open` handler.
 *
 * Constructed by `src/main.ts` through {@link createSourceOpenHandler}; called by
 * `src/server/ws.ts` for every inbound `source.open` frame.
 */
export interface SourceOpenHandler {
  /**
   * Validates, authorizes, contains and forwards one `source.open` request.
   *
   * Never throws and never rejects: every failure is a typed `Err` the caller
   * maps onto the protocol `error` payload with `toErrorPayload`.
   *
   * @param input The request, in any of three forms, each validated in full: a
   * parsed `source.open` envelope (`MessageByType<'source.open'>`), a raw
   * frame (a JSON string, or an unparsed envelope object), or the bare
   * `{ sessionId, location }` payload.
   * @param principal The connection's resolved identity.
   * @returns The delivery outcome, or the refusal or failure.
   */
  handle(
    input: unknown,
    principal: SourceOpenPrincipal,
  ): Promise<Result<SourceOpenOutcome, DebuggenError>>;
}

/* -------------------------------------------------------------------------------------------------
 * Internal constants
 * ---------------------------------------------------------------------------------------------- */

/** The `subsystem` binding every record of this module carries. */
const SOURCE_SUBSYSTEM = 'source';

/** The message this module handles and the message it forwards. */
const SOURCE_OPEN_TYPE = 'source.open';

/** The only client kind a location is ever forwarded to. */
const EDITOR_CLIENT: ClientKind = 'vscode';

/** The client label logged when the principal's kind could not be resolved. */
const UNRESOLVED_CLIENT = 'unresolved';

/** The longest project-relative file name an error message quotes before eliding it. */
const MAX_REPORTED_FILE_LENGTH = 200;

/** Appended to a file name elided at {@link MAX_REPORTED_FILE_LENGTH}. */
const ELISION_MARKER = '…';

/** Stands in for a control character in a quoted file name. */
const REPLACEMENT_CHARACTER = '\uFFFD';

/**
 * The platform codes that mean "nothing is there" rather than "the service
 * cannot vouch for what is there": a missing entry, or a component that is not a
 * directory. Every other resolution failure is treated as unsafe.
 */
const MISSING_ERRNOS: ReadonlySet<string> = new Set(['ENOENT', 'ENOTDIR']);

/**
 * The shape of a platform errno code. Only a value of exactly this shape is
 * recorded in an error's details — never the platform error itself, whose
 * message quotes the absolute path it failed on.
 */
const ERRNO_PATTERN = /^E[A-Z0-9]{1,23}$/;

/** The shape of an enumerated reason copied from a shared-layer error's details. */
const REASON_PATTERN = /^[a-z][a-z-]{0,63}$/;

/** The access-boundary reasons of `src/server/auth.ts`, mirrored by name. */
type AuthorizationReason = 'role-not-permitted' | 'project-out-of-scope' | 'session-not-bound';

/** Why the filesystem half refused a path it could not vouch for. */
type UnsafePathReason =
  | 'root-not-resolvable'
  | 'not-resolvable'
  | 'resolved-path-not-absolute'
  | 'symlink-escapes-project-root'
  | 'unsafe-canonical-path'
  | 'changed-after-resolution';

/** Why the filesystem half found nothing openable. */
type FileMissingReason = 'project-root-missing' | 'not-found' | 'not-a-file';

/** The developer-facing next steps, one per situation, stated once. */
const HINTS = Object.freeze({
  invalidPayload:
    'A source.open request carries the session id and a source location with a project-relative file, 1-based line and column, a resolver and a confidence.',
  sessionNotFound:
    'Reopen the session from the Debug Generator view in VS Code, or start a new one, then click the source link again.',
  roleNotPermitted:
    'Source links are opened from the Debug Generator panel in DevTools or from the Debug Generator view in VS Code.',
  projectOutOfScope: 'Open the project as a workspace folder in VS Code before debugging it.',
  sessionNotBound: 'Open the Debug Generator panel on the tab running the session.',
  outsideProject: 'Source links must name a project-relative file inside the session’s project.',
  unsafePath:
    'Open the file from VS Code directly; Debug Generator only opens files that resolve inside the project.',
  fileMissing:
    'The file may have moved or been deleted since the capture; capture again to refresh the source links.',
  projectRootMissing: 'Reopen the project in VS Code and start a new session.',
  store: 'Check the Debug Generator service log, then click the source link again.',
  delivery:
    'Check that VS Code is connected to the Debug Generator service, then click the source link again.',
  internal: 'The Debug Generator service log holds the reason; click the source link again.',
} as const);

/* -------------------------------------------------------------------------------------------------
 * Error construction
 *
 * Every refusal is built here, from constants and from values already proven
 * safe to quote: a validated message type, a project-relative file that passed
 * the lexical gate, an enumerated reason, an errno code. Nothing a client sent
 * is interpolated before it has been validated, and no absolute path is ever
 * interpolated at all.
 * ---------------------------------------------------------------------------------------------- */

/** Builds one refusal carrying its {@link SourceOpenRejection} in `details.rejection`. */
function refusal(
  code: DebuggenErrorCode,
  rejection: SourceOpenRejection,
  message: string,
  hint: string,
  details: LogFields = {},
): DebuggenError {
  return new DebuggenError(code, message, { hint, details: { ...details, rejection } });
}

/**
 * A malformed frame. The parser's own message is reused because the protocol
 * and shared parse helpers render a failure from issue paths, issue codes and
 * schema metadata only, never from the rejected value; the parser's error is
 * deliberately not attached as a cause, so nothing of the frame travels with it.
 */
function invalidPayload(parserError: DebuggenError): DebuggenError {
  return refusal(
    'PROTOCOL_INVALID_MESSAGE',
    'invalid-payload',
    parserError.message,
    parserError.hint ?? HINTS.invalidPayload,
  );
}

/** A well-formed frame of another message type. */
function notSourceOpen(type: string): DebuggenError {
  return refusal(
    'PROTOCOL_INVALID_MESSAGE',
    'invalid-payload',
    `Expected a ${SOURCE_OPEN_TYPE} message; received a ${type} message.`,
    HINTS.invalidPayload,
    { receivedType: type },
  );
}

/** The named session does not exist (or was purged by retention). */
function sessionNotFound(sessionId: SessionId): DebuggenError {
  return refusal(
    'SESSION_NOT_FOUND',
    'session-not-found',
    'The session this source link belongs to does not exist.',
    HINTS.sessionNotFound,
    { sessionId },
  );
}

/** A refusal by the access rules, mirroring `src/server/auth.ts`'s reason names. */
function notAuthorized(reason: AuthorizationReason, client: string): DebuggenError {
  switch (reason) {
    case 'role-not-permitted':
      return refusal(
        'UNAUTHORIZED',
        'not-authorized',
        'Only the VS Code editor, or the DevTools panel bound to this session, may open a source location.',
        HINTS.roleNotPermitted,
        { reason, client },
      );
    case 'project-out-of-scope':
      return refusal(
        'UNAUTHORIZED',
        'not-authorized',
        'This editor connection has not announced a workspace folder containing the session’s project, so it may not open its source.',
        HINTS.projectOutOfScope,
        { reason, client },
      );
    case 'session-not-bound':
      return refusal(
        'TAB_NOT_BOUND',
        'not-authorized',
        'This DevTools panel may open source only for the session its inspected tab is bound to.',
        HINTS.sessionNotBound,
        { reason, client },
      );
  }
}

/**
 * The lexical half's refusal. The rejected path is **not** quoted: it failed
 * the gate that makes a path safe to quote, and it may be an absolute path from
 * elsewhere on the machine. Only the shared layer's enumerated reason is kept.
 */
function outsideProject(pathReason?: string): DebuggenError {
  return refusal(
    'PATH_OUTSIDE_PROJECT',
    'outside-project',
    'The source location does not name a path inside this session’s project, so it was not opened.',
    HINTS.outsideProject,
    pathReason === undefined ? {} : { pathReason },
  );
}

/** The sentence for one {@link UnsafePathReason}; `quoted` is a safe, already-quoted file name. */
function unsafePathMessage(reason: UnsafePathReason, quoted: string): string {
  switch (reason) {
    case 'root-not-resolvable':
      return 'This session’s project root could not be resolved safely, so the source location was not opened.';
    case 'not-resolvable':
      return `${quoted} could not be resolved safely inside this session’s project, so it was not opened.`;
    case 'resolved-path-not-absolute':
      return `Resolving ${quoted} produced a path that is not absolute, so containment could not be established.`;
    case 'symlink-escapes-project-root':
      return `${quoted} is inside this session’s project as written, but a symbolic link resolves it outside the project, so it was not opened.`;
    case 'unsafe-canonical-path':
      return `${quoted} resolves to a path inside the project that this service cannot vouch for, so it was not opened.`;
    case 'changed-after-resolution':
      return `${quoted} was replaced by a symbolic link while it was being checked, so it was not opened.`;
  }
}

/**
 * The filesystem half's refusal of a path it cannot vouch for. `file` is the
 * project-relative name that passed the lexical gate; neither the canonical
 * path nor a symbolic link's target is ever quoted.
 */
function unsafePath(reason: UnsafePathReason, file?: string, errno?: string): DebuggenError {
  const quoted = file === undefined ? 'The source location' : `'${file}'`;
  const message = unsafePathMessage(reason, quoted);
  const details: LogFields = { reason };
  if (file !== undefined) {
    details['file'] = file;
  }
  if (errno !== undefined) {
    details['errno'] = errno;
  }
  return refusal('FS_UNSAFE_PATH', 'unsafe-path', message, HINTS.unsafePath, details);
}

/** The filesystem half found nothing openable at the path. */
function fileMissing(reason: FileMissingReason, file?: string): DebuggenError {
  const quoted = file === undefined ? 'The source location' : `'${file}'`;
  switch (reason) {
    case 'project-root-missing':
      return refusal(
        'PROJECT_NOT_FOUND',
        'file-missing',
        'This session’s project root no longer exists on disk, so the source location was not opened.',
        HINTS.projectRootMissing,
        { reason },
      );
    case 'not-found':
      return refusal(
        'PROJECT_NOT_FOUND',
        'file-missing',
        `${quoted} does not exist in this session’s project.`,
        HINTS.fileMissing,
        file === undefined ? { reason } : { reason, file },
      );
    case 'not-a-file':
      return refusal(
        'PROJECT_NOT_FOUND',
        'file-missing',
        `${quoted} is not a regular file in this session’s project.`,
        HINTS.fileMissing,
        file === undefined ? { reason } : { reason, file },
      );
  }
}

/** The session store failed. Not a refusal: no `rejection` is recorded. */
function storeFailure(cause?: DebuggenError): DebuggenError {
  return new DebuggenError(
    'STORE_ERROR',
    'The session store could not be read while opening a source location.',
    cause === undefined ? { hint: HINTS.store } : { hint: HINTS.store, cause },
  );
}

/** The client registry failed to take the message. Not a refusal. */
function deliveryFailure(cause: DebuggenError): DebuggenError {
  return new DebuggenError(
    'TRANSPORT_DISCONNECTED',
    'The source location could not be handed to the editor connection.',
    { hint: HINTS.delivery, cause },
  );
}

/** A product defect on the service's own side of the hop. Not a refusal. */
function internalFailure(message: string, cause?: unknown): DebuggenError {
  return new DebuggenError(
    'INTERNAL',
    message,
    cause === undefined ? { hint: HINTS.internal } : { hint: HINTS.internal, cause },
  );
}

/**
 * Reads the {@link SourceOpenRejection} a refusal from this module carries.
 *
 * `src/server/ws.ts` and the integration suite use it to tell a refusal from an
 * operational failure (a store or transport error, which carries none) without
 * parsing a message.
 *
 * @param error Any error returned by {@link SourceOpenHandler.handle} or by the
 * two containment functions.
 * @returns The rejection, or `undefined` when the error is not a refusal.
 */
export function sourceOpenRejectionOf(error: DebuggenError): SourceOpenRejection | undefined {
  const rejection = error.details?.['rejection'];
  return SOURCE_OPEN_REJECTIONS.find((candidate) => candidate === rejection);
}

/* -------------------------------------------------------------------------------------------------
 * Small, pure helpers
 * ---------------------------------------------------------------------------------------------- */

/** Whether a UTF-16 code unit is a C0 or C1 control character. */
function isControlCode(code: number): boolean {
  return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
}

/**
 * A project-relative file name made safe to quote in a message: control
 * characters replaced and the length bounded. Applied only to names that have
 * already passed the lexical gate.
 */
function displayFile(file: string): string {
  const bounded =
    file.length > MAX_REPORTED_FILE_LENGTH
      ? `${file.slice(0, MAX_REPORTED_FILE_LENGTH)}${ELISION_MARKER}`
      : file;
  let safe = '';
  for (let index = 0; index < bounded.length; index += 1) {
    safe += isControlCode(bounded.charCodeAt(index))
      ? REPLACEMENT_CHARACTER
      : bounded.charAt(index);
  }
  return safe;
}

/** Converts to POSIX separators, then normalises lexically — in that order. */
function normalizeToPosix(path: string): string {
  return normalizePosix(toPosix(path));
}

/**
 * The platform errno code carried by a failure, when it has one of the
 * expected shape; `undefined` otherwise. `DebuggenError.from` keeps the
 * platform error as its `cause`, so both a raw error and a wrapped one are read.
 */
function errnoOf(failure: unknown): string | undefined {
  const source: unknown = DebuggenError.is(failure) ? failure.cause : failure;
  if (!isPlainRecord(source)) {
    return undefined;
  }
  const code = source['code'];
  return typeof code === 'string' && ERRNO_PATTERN.test(code) ? code : undefined;
}

/** The enumerated `details.reason` of a shared path-layer error, when it has one. */
function pathReasonOf(error: DebuggenError): string | undefined {
  const reason = error.details?.['reason'];
  return typeof reason === 'string' && REASON_PATTERN.test(reason) ? reason : undefined;
}

/**
 * Calls a port or filesystem function and settles it into a `Result`.
 *
 * `Promise.resolve().then(fn)` turns a synchronous throw into a rejection as
 * well as adopting a returned promise, and `fromPromise` never rejects, so
 * neither a throwing store nor a rejecting registry can escape the handler.
 */
function settle<T>(fn: () => MaybePromise<T>, code: DebuggenErrorCode): Promise<Result<T>> {
  return fromPromise(Promise.resolve().then(fn), code);
}

/* -------------------------------------------------------------------------------------------------
 * Containment — the two halves, exported so each is unit-testable without a socket
 * ---------------------------------------------------------------------------------------------- */

/**
 * The lexical half of containment: where a location's file lands under the
 * project root, **as text**, or a refusal.
 *
 * Delegates to the shared path gate, `resolveWithinProject` from
 * `@debuggen/shared`, which refuses — without touching the filesystem — an
 * empty or whitespace-only path, `..` traversal (including an interior `..`
 * that climbs out), an absolute POSIX path, a Windows drive-letter or UNC form,
 * a backslash, a NUL or other control character, a relative or network-share
 * project root, and the prefix-sibling case: `/proj-evil/secret.ts` is not
 * inside `/proj`, because the gate's `isWithin` requires the root followed by a
 * separator rather than a bare string prefix. The result is re-checked with
 * `isWithin` so the guarantee does not rest on a single call.
 *
 * A string cannot reveal a symbolic link, so this is never a complete check on
 * its own: {@link resolveRealPathWithinProject} is the half that sees links, and
 * the handler never forwards without both.
 *
 * The location is re-read defensively — a caller may hand over an object that
 * never passed the schema — and the refusal never quotes the rejected path.
 *
 * @param projectRoot The session's absolute project root, from the stored
 * `SessionRecord`.
 * @param location The location whose `file` is tested.
 * @returns `ok({ absolutePath })`, or `err` with code `PATH_OUTSIDE_PROJECT` and
 * rejection `outside-project`.
 *
 * @example
 * ```ts
 * assertLocationWithinProject('/work/app', { file: 'src/lib/a.ts', … });
 * // ok({ absolutePath: '/work/app/src/lib/a.ts' })
 * assertLocationWithinProject('/work/app', { file: '../app-evil/a.ts', … });
 * // err(PATH_OUTSIDE_PROJECT)
 * ```
 */
export function assertLocationWithinProject(
  projectRoot: string,
  location: SourceLocation,
): Result<LexicalContainment, DebuggenError> {
  const candidate: unknown = location;
  if (typeof projectRoot !== 'string' || !isPlainRecord(candidate)) {
    return err(outsideProject());
  }

  const file = candidate['file'];
  if (typeof file !== 'string') {
    return err(outsideProject());
  }

  const lexical = resolveWithinProject(projectRoot, file);
  if (!lexical.ok) {
    return err(outsideProject(pathReasonOf(lexical.error)));
  }

  if (!isWithin(projectRoot, lexical.value)) {
    return err(outsideProject());
  }

  return ok({ absolutePath: lexical.value });
}

/**
 * The filesystem half of containment: proves that a path already inside the
 * project as text is **still** inside it once every symbolic link is resolved.
 *
 * The sequence:
 *
 * 1. The pair is re-checked lexically (`isWithin`, then the shared gate over the
 *    relative remainder), so a direct caller cannot skip the lexical half.
 * 2. The project root is canonicalised — a canonical target can only be
 *    compared against a canonical root, and a root reached through a link (a
 *    checkout under a symlinked home directory) canonicalises elsewhere.
 * 3. The target is canonicalised **in full, final component included**. This
 *    is deliberately stricter than the synchronous `resolveRealPathWithinProject`
 *    of `@debuggen/shared`, which leaves the final component unresolved for a
 *    caller that then opens it with `O_NOFOLLOW`: the editor this handler
 *    forwards to follows a link at the final component, so a link there is
 *    exactly as dangerous as one in a directory and must be resolved and
 *    judged.
 * 4. `isWithin(realRoot, realTarget)` must hold; a link that leads out of the
 *    project — including to a prefix sibling of the root — is refused.
 * 5. The target may not be the project root itself, and its canonical
 *    remainder must be a safe project-relative path.
 *
 * A resolution failure is classified by its errno: `ENOENT` or `ENOTDIR` is
 * `file-missing` (nothing is there), anything else — `ELOOP`, `EACCES`, a
 * resolver that returned nonsense — is `unsafe-path`. The two are different
 * developer-facing situations, and neither error quotes an absolute path, a
 * link target or the platform's own message.
 *
 * Canonicalisation is a check at a moment, not a lock; the editor re-derives the
 * same answer independently before it opens anything.
 *
 * @param projectRoot The session's absolute project root.
 * @param absolutePath The candidate, as {@link assertLocationWithinProject}
 * produced it.
 * @param realpath The canonicaliser; see {@link SourceOpenRealPath}.
 * @returns `ok` with the canonical proof, or `err` with rejection
 * `outside-project` (`PATH_OUTSIDE_PROJECT`), `unsafe-path` (`FS_UNSAFE_PATH`)
 * or `file-missing` (`PROJECT_NOT_FOUND`). Never rejects.
 */
export async function resolveRealPathWithinProject(
  projectRoot: string,
  absolutePath: string,
  realpath: SourceOpenRealPath,
): Promise<Result<RealPathContainment, DebuggenError>> {
  if (
    typeof projectRoot !== 'string' ||
    typeof absolutePath !== 'string' ||
    !isWithin(projectRoot, absolutePath)
  ) {
    return err(outsideProject());
  }

  const lexicalRoot = normalizeToPosix(projectRoot);
  const lexicalTarget = normalizeToPosix(absolutePath);
  const relative = relativePosix(lexicalRoot, lexicalTarget);

  // The shared gate again, over the relative remainder: it is what refuses a
  // relative or network-share root and any remainder that is not a safe
  // project-relative path, so this function holds even for a direct caller.
  const regate = resolveWithinProject(lexicalRoot, relative);
  if (!regate.ok) {
    return err(outsideProject(pathReasonOf(regate.error)));
  }

  const file = displayFile(relative);

  const root = await canonicalise(realpath, lexicalRoot);
  if (!root.ok) {
    return err(
      root.errno !== undefined && MISSING_ERRNOS.has(root.errno)
        ? fileMissing('project-root-missing')
        : unsafePath('root-not-resolvable', undefined, root.errno),
    );
  }

  const target = await canonicalise(realpath, lexicalTarget);
  if (!target.ok) {
    return err(
      target.errno !== undefined && MISSING_ERRNOS.has(target.errno)
        ? fileMissing('not-found', file)
        : unsafePath('not-resolvable', file, target.errno),
    );
  }

  if (!isAbsolutePosix(root.value) || !isAbsolutePosix(target.value)) {
    return err(unsafePath('resolved-path-not-absolute', file));
  }

  if (!isWithin(root.value, target.value)) {
    return err(unsafePath('symlink-escapes-project-root', file));
  }

  if (target.value === root.value) {
    return err(fileMissing('not-a-file', file));
  }

  const relativePath = relativePosix(root.value, target.value);
  if (!isSafeRelativePath(relativePath)) {
    return err(unsafePath('unsafe-canonical-path', file));
  }

  return ok({ realProjectRoot: root.value, realPath: target.value, relativePath });
}

/** The outcome of one canonicalisation: the canonical path, or the errno it failed with. */
type Canonicalised =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly errno: string | undefined };

/**
 * Canonicalises one absolute path with the caller's resolver, reducing a
 * failure to its errno code. A resolver that answers with something other than
 * a non-empty string, or with a Windows-style path on this POSIX-only contract,
 * is a failure without an errno.
 */
async function canonicalise(realpath: SourceOpenRealPath, path: string): Promise<Canonicalised> {
  const resolved = await settle<unknown>(() => realpath(path), 'FS_UNSAFE_PATH');
  if (!resolved.ok) {
    return { ok: false, errno: errnoOf(resolved.error) };
  }

  const value = resolved.value;
  if (typeof value !== 'string' || value.length === 0 || isWindowsAbsolute(value)) {
    return { ok: false, errno: undefined };
  }

  return { ok: true, value: normalizeToPosix(value) };
}

/**
 * Confirms, without following a link at the final component, that the
 * canonical target is a regular file.
 *
 * The target is canonical, so a symbolic link here means the entry was replaced
 * between canonicalisation and this check: refused as unsafe. A directory, FIFO,
 * socket or device is `file-missing` (`not-a-file`), since there is no source
 * file to open. Reads metadata only — never content.
 */
async function verifyRegularFile(realPath: string, file: string): Promise<Result<void>> {
  const inspected = await settle(() => lstat(realPath), 'FS_UNSAFE_PATH');
  if (!inspected.ok) {
    const errno = errnoOf(inspected.error);
    return err(
      errno !== undefined && MISSING_ERRNOS.has(errno)
        ? fileMissing('not-found', file)
        : unsafePath('not-resolvable', file, errno),
    );
  }

  const stats = inspected.value;
  if (stats.isSymbolicLink()) {
    return err(unsafePath('changed-after-resolution', file));
  }

  if (!stats.isFile()) {
    return err(fileMissing('not-a-file', file));
  }

  return ok(undefined);
}

/* -------------------------------------------------------------------------------------------------
 * Step 1 — decoding and validating the request
 * ---------------------------------------------------------------------------------------------- */

/** Whether an object looks like an envelope rather than a bare payload. */
function looksLikeEnvelope(value: unknown): boolean {
  return isPlainRecord(value) && Object.hasOwn(value, 'type') && Object.hasOwn(value, 'payload');
}

/**
 * Turns any accepted input form into a validated `{ sessionId, location }`.
 *
 * A string is a raw frame (`decodeMessage` parses the JSON and the envelope);
 * an object with `type` and `payload` is an envelope, parsed or not
 * (`parseMessage` validates it in full, including the rule that an envelope's
 * routing key agrees with its payload's session); anything else is taken as
 * the bare payload. In every case the payload is then validated with
 * `parseSourceOpenPayload` and its location once more with
 * `parseSourceLocation`.
 */
function decodeSourceOpenInput(input: unknown): Result<SourceOpenPayload> {
  let payload: unknown = input;

  if (typeof input === 'string' || looksLikeEnvelope(input)) {
    const decoded = decodeMessage(input);
    if (!decoded.ok) {
      return err(invalidPayload(decoded.error));
    }
    const message = decoded.value;
    if (!isMessageOfType(message, SOURCE_OPEN_TYPE)) {
      return err(notSourceOpen(message.type));
    }
    payload = message.payload;
  }

  const parsed = parseSourceOpenPayload(payload);
  if (!parsed.ok) {
    return err(invalidPayload(parsed.error));
  }

  const location = parseSourceLocation(parsed.value.location);
  if (!location.ok) {
    return err(invalidPayload(location.error));
  }

  return ok({ sessionId: parsed.value.sessionId, location: location.value });
}

/* -------------------------------------------------------------------------------------------------
 * Step 3 — authorization from the resolved principal (AAP §0.5.6)
 * ---------------------------------------------------------------------------------------------- */

/** The principal's client kind, when it is one of the protocol's; `undefined` otherwise. */
function clientKindOf(principal: unknown): ClientKind | undefined {
  if (!isPlainRecord(principal)) {
    return undefined;
  }
  const parsed = clientKindSchema.safeParse(principal['client']);
  return parsed.success ? parsed.data : undefined;
}

/**
 * The editor rule: the session's project root must be one of the workspace
 * folders the connection announced, or lie beneath one — by `isWithin`, so a
 * folder that merely shares a string prefix with the root never qualifies.
 */
function authorizeEditor(projectRoots: unknown, projectRoot: string): Result<void> {
  if (!Array.isArray(projectRoots)) {
    return err(notAuthorized('project-out-of-scope', EDITOR_CLIENT));
  }

  const covered = projectRoots.some(
    (folder: unknown) =>
      typeof folder === 'string' &&
      isAbsolutePosix(toPosix(folder)) &&
      !isWindowsAbsolute(folder) &&
      isWithin(folder, projectRoot),
  );

  return covered ? ok(undefined) : err(notAuthorized('project-out-of-scope', EDITOR_CLIENT));
}

/**
 * The tab currently bound to a session: from the bindings table when the port
 * offers it (authoritative), otherwise from `SessionRecord.boundTab`.
 */
async function boundTabOf(
  session: SessionRecord,
  sessions: SourceOpenSessionPort,
): Promise<Result<number | undefined>> {
  if (sessions.getBindingBySession === undefined) {
    return ok(session.boundTab?.tabId);
  }

  const lookup = await settle(() => sessions.getBindingBySession?.(session.id), 'STORE_ERROR');
  if (!lookup.ok) {
    return err(storeFailure(lookup.error));
  }

  const answer = lookup.value;
  if (answer === undefined) {
    return ok(undefined);
  }
  if (!answer.ok) {
    return err(storeFailure(answer.error));
  }

  const tabId: unknown = answer.value?.tab.tabId;
  return ok(typeof tabId === 'number' ? tabId : undefined);
}

/**
 * The DevTools rule: the connection must be bound to a tab, any session its
 * binding names must be this one, and this session's bound tab must be that
 * tab. A DevTools credential acting on another tab's session is refused.
 */
async function authorizeDevtools(
  principal: Record<string, unknown>,
  session: SessionRecord,
  sessions: SourceOpenSessionPort,
): Promise<Result<void>> {
  const tabId = principal['tabId'];
  if (typeof tabId !== 'number' || !Number.isSafeInteger(tabId) || tabId < 0) {
    return err(notAuthorized('session-not-bound', 'devtools'));
  }

  const boundSessionId = principal['sessionId'];
  if (boundSessionId !== undefined && boundSessionId !== session.id) {
    return err(notAuthorized('session-not-bound', 'devtools'));
  }

  const bound = await boundTabOf(session, sessions);
  if (!bound.ok) {
    return bound;
  }

  return bound.value === tabId
    ? ok(undefined)
    : err(notAuthorized('session-not-bound', 'devtools'));
}

/**
 * The per-role access matrix for `source.open`: an editor by announced
 * workspace folder, a DevTools panel by its own tab's binding, and the page
 * agent and the dev-server agent never. The principal is re-read defensively,
 * so a value that does not name a protocol client kind is refused rather than
 * trusted.
 */
function authorize(
  principal: SourceOpenPrincipal,
  session: SessionRecord,
  sessions: SourceOpenSessionPort,
): Promise<Result<void>> {
  const candidate: unknown = principal;
  const client = clientKindOf(candidate);
  if (client === undefined || !isPlainRecord(candidate)) {
    return Promise.resolve(err(notAuthorized('role-not-permitted', UNRESOLVED_CLIENT)));
  }

  switch (client) {
    case 'vscode':
      return Promise.resolve(authorizeEditor(candidate['projectRoots'], session.projectRoot));
    case 'devtools':
      return authorizeDevtools(candidate, session, sessions);
    case 'agent':
    case 'server-agent':
      return Promise.resolve(err(notAuthorized('role-not-permitted', client)));
  }
}

/* -------------------------------------------------------------------------------------------------
 * Step 6 — building the outbound frame
 * ---------------------------------------------------------------------------------------------- */

/**
 * Builds the `source.open` envelope for the editor with the protocol's own
 * `createEnvelope` — which mints the id, stamps `ts` and lifts the payload's
 * `sessionId` into the routing key — and validates the finished frame with
 * `parseMessage` before it is handed to anyone, so a frame the receiver would
 * refuse is never sent. The frame built, not the parser's copy, is returned: the
 * location travels exactly as it was validated.
 */
function buildSourceOpenEnvelope(
  payload: SourceOpenPayload,
  now: (() => number) | undefined,
): Result<ProtocolMessage> {
  const built = tryCatch(
    () =>
      now === undefined
        ? createEnvelope(SOURCE_OPEN_TYPE, payload)
        : createEnvelope(SOURCE_OPEN_TYPE, payload, { ts: now() }),
    'INTERNAL',
  );
  if (!built.ok) {
    return err(
      internalFailure('A source.open frame could not be built for the editor.', built.error),
    );
  }

  const verified = parseMessage(built.value);
  if (!verified.ok) {
    return err(
      internalFailure(
        'The source.open frame built for the editor did not validate, so it was not sent.',
        verified.error,
      ),
    );
  }

  return ok(built.value);
}

/* -------------------------------------------------------------------------------------------------
 * Logging
 * ---------------------------------------------------------------------------------------------- */

/** The level a refusal or failure is recorded at. */
type RecordLevel = 'debug' | 'warn' | 'error';

/**
 * Probing refusals — a path that escapes, a link that leads out, a connection
 * acting outside its scope — are warnings: they are what an attempt to misuse
 * the hop looks like. Everyday refusals — a stale link to a moved file, a
 * purged session, a malformed frame — are debug records. An operational failure
 * (no rejection) is an error.
 */
function levelFor(rejection: SourceOpenRejection | undefined): RecordLevel {
  switch (rejection) {
    case undefined:
      return 'error';
    case 'not-authorized':
    case 'outside-project':
    case 'unsafe-path':
      return 'warn';
    case 'invalid-payload':
    case 'session-not-found':
    case 'file-missing':
      return 'debug';
  }
}

/** The detail keys a refusal may carry that are safe, by construction, to log. */
const LOGGED_DETAIL_KEYS = Object.freeze(['reason', 'pathReason', 'file', 'errno'] as const);

/**
 * The fields recorded for a refusal or failure: the context bindings, the code,
 * the rejection, the message (built only from safe parts, see "Error
 * construction") and the enumerated details. A cause is reduced to its code.
 */
function refusalFields(error: DebuggenError, context: LogFields): LogFields {
  const fields: LogFields = { ...context, code: error.code, detail: error.message };

  const rejection = sourceOpenRejectionOf(error);
  if (rejection !== undefined) {
    fields['rejection'] = rejection;
  }

  for (const key of LOGGED_DETAIL_KEYS) {
    const value = error.details?.[key];
    if (typeof value === 'string') {
      fields[key] = value;
    }
  }

  if (DebuggenError.is(error.cause)) {
    fields['causeCode'] = error.cause.code;
  }

  return fields;
}

/** Whether a stored record carries what this handler reads, for the session it was asked for. */
function isUsableSession(record: SessionRecord, sessionId: SessionId): boolean {
  const candidate: unknown = record;
  return (
    isPlainRecord(candidate) &&
    candidate['id'] === sessionId &&
    typeof candidate['projectRoot'] === 'string'
  );
}

/* -------------------------------------------------------------------------------------------------
 * The handler
 * ---------------------------------------------------------------------------------------------- */

/**
 * Creates the `source.open` handler.
 *
 * Called once by `src/main.ts`, which injects the session store
 * (`createSessionsRepo(…)` from `src/store/sessions-repo.ts`), the client
 * registry and the service logger; `src/server/ws.ts` then calls
 * {@link SourceOpenHandler.handle} for every inbound `source.open` frame with the
 * connection's {@link SourceOpenPrincipal}, and maps an `Err` onto the protocol
 * `error` payload with `toErrorPayload`. The forwarded frame's terminal consumer
 * is `apps/vscode-extension/src/source/open-location.ts`.
 *
 * Each request runs the fixed sequence of the module header — validate, look the
 * session up, authorize, contain lexically, contain on the filesystem, then
 * forward — and returns at the first refusal. The forward is reachable only
 * through both containment halves. Nothing is cached between requests: a file
 * that changes into a link between two clicks is judged afresh on the second.
 *
 * @param deps The injected ports and options; see {@link SourceOpenDeps}.
 * @returns The handler. Frozen; stateless apart from its dependencies.
 *
 * @example
 * ```ts
 * const sourceOpen = createSourceOpenHandler({ sessions: sessionsRepo, clients, logger });
 * const result = await sourceOpen.handle(frame, principalOf(connection));
 * if (!result.ok) {
 *   connection.send(createEnvelope('error', toErrorPayload(result.error, frame.id)));
 * } else if (!result.value.delivered) {
 *   // no editor connected: the DevTools side falls back to the vscode:// URI
 * }
 * ```
 */
export function createSourceOpenHandler(deps: SourceOpenDeps): SourceOpenHandler {
  const derived = tryCatch(() => subsystemLogger(deps.logger ?? noopLogger, SOURCE_SUBSYSTEM));
  const log = derived.ok ? derived.value : noopLogger;
  const realpath: SourceOpenRealPath = deps.realpath ?? ((path: string) => realpathAsync(path));
  const verifyExists = deps.verifyExists ?? true;
  const now = deps.now;
  const { sessions, clients } = deps;

  /**
   * Writes one record. Logging is observation, never a decision: a logger that
   * throws is contained here, so it can neither turn a delivered request into a
   * failure nor a refusal into a rejection of the returned promise.
   */
  function emit(level: RecordLevel, message: string, fields: LogFields): void {
    tryCatch(() => {
      switch (level) {
        case 'debug':
          log.debug(message, fields);
          break;
        case 'warn':
          log.warn(message, fields);
          break;
        case 'error':
          log.error(message, fields);
          break;
      }
    });
  }

  /** Records a refusal or failure at its level and returns it as the `Err` it is. */
  function refuse(error: DebuggenError, context: LogFields): Result<SourceOpenOutcome> {
    const level = levelFor(sourceOpenRejectionOf(error));
    emit(
      level,
      level === 'error' ? 'A source.open request failed' : 'Refused a source.open request',
      refusalFields(error, context),
    );
    return err(error);
  }

  async function run(
    input: unknown,
    principal: SourceOpenPrincipal,
  ): Promise<Result<SourceOpenOutcome>> {
    const context: LogFields = {
      [LOG_BINDING_KEYS.client]: clientKindOf(principal) ?? UNRESOLVED_CLIENT,
    };

    // Step 1 — validate the frame; nothing else is looked at until it parses.
    const decoded = decodeSourceOpenInput(input);
    if (!decoded.ok) {
      return refuse(decoded.error, context);
    }
    const { sessionId, location } = decoded.value;
    context[LOG_BINDING_KEYS.sessionId] = sessionId;

    // Step 2 — the session, and with it the project root, come from the store.
    const lookup = await settle(() => sessions.get(sessionId), 'STORE_ERROR');
    if (!lookup.ok) {
      return refuse(storeFailure(lookup.error), context);
    }
    if (!lookup.value.ok) {
      return refuse(storeFailure(lookup.value.error), context);
    }
    const session = lookup.value.value;
    if (session === undefined) {
      return refuse(sessionNotFound(sessionId), context);
    }
    if (!isUsableSession(session, sessionId)) {
      return refuse(storeFailure(), context);
    }

    // Step 3 — the connection's resolved identity must cover this session.
    const authorized = await authorize(principal, session, sessions);
    if (!authorized.ok) {
      return refuse(authorized.error, context);
    }

    // Step 4 — lexical containment against the stored root.
    const lexical = assertLocationWithinProject(session.projectRoot, location);
    if (!lexical.ok) {
      return refuse(lexical.error, context);
    }

    // Step 5 — filesystem containment: every link resolved, then re-checked.
    const contained = await resolveRealPathWithinProject(
      session.projectRoot,
      lexical.value.absolutePath,
      realpath,
    );
    if (!contained.ok) {
      return refuse(contained.error, context);
    }
    if (verifyExists) {
      const regular = await verifyRegularFile(contained.value.realPath, displayFile(location.file));
      if (!regular.ok) {
        return refuse(regular.error, context);
      }
    }

    // Step 6 — forward the validated location, unchanged, to the editor.
    const envelope = buildSourceOpenEnvelope({ sessionId, location }, now);
    if (!envelope.ok) {
      return refuse(envelope.error, context);
    }
    const delivery = await settle(
      () => clients.sendToSessionClients(sessionId, EDITOR_CLIENT, envelope.value),
      'TRANSPORT_DISCONNECTED',
    );
    if (!delivery.ok) {
      return refuse(deliveryFailure(delivery.error), context);
    }
    const count: unknown = delivery.value;
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) {
      return refuse(
        internalFailure('The client registry reported an invalid delivery count for source.open.'),
        context,
      );
    }

    // Step 7 — record what happened: project-relative file only.
    const fields: LogFields = {
      ...context,
      file: displayFile(location.file),
      line: location.line,
      column: location.column,
      resolvedBy: location.resolvedBy,
      delivered: count,
    };
    if (count === 0) {
      emit(
        'debug',
        'No editor client is connected for this session; the caller falls back to the vscode:// URI',
        fields,
      );
      return ok({ delivered: false, reason: 'no-editor-client', location });
    }
    emit('debug', 'Forwarded source.open to the editor', fields);
    return ok({ delivered: true, clients: count, location, file: contained.value.relativePath });
  }

  return Object.freeze({
    async handle(
      input: unknown,
      principal: SourceOpenPrincipal,
    ): Promise<Result<SourceOpenOutcome, DebuggenError>> {
      try {
        return await run(input, principal);
      } catch (thrown) {
        // Reached only by a defect — every port and filesystem call above is
        // already settled into a Result. The thrown value is not attached or
        // logged verbatim: its message is unknown and may quote a path.
        const failure = internalFailure('The source.open request failed unexpectedly.');
        const fields: LogFields = { code: failure.code };
        if (DebuggenError.is(thrown)) {
          fields['causeCode'] = thrown.code;
        }
        emit('error', 'A source.open request failed unexpectedly', fields);
        return err(failure);
      }
    },
  });
}
