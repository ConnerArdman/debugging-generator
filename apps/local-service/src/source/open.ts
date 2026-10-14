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
 *   → WebSocket `source.open { sessionId, location, pinned }` to the session's
 *     VS Code client(s), a fresh envelope whose `id` (the "forwarded id") this
 *     module keeps
 *   → apps/vscode-extension/src/source/open-location.ts, which resolves the
 *     location again, refuses it unless it lands on the `pinned` file, then
 *     opens the document with `window.showTextDocument` and a selection at the
 *     location's 1-based line and column, and flashes a transient highlight
 *   → WebSocket `source.result { ref: <forwarded id>, status }` from the editor
 *   → THIS MODULE: {@link SourceOpenHandler.acceptEditorResult} settles the
 *     forward's pending entry
 *   → `src/server/ws.ts`, which relays the outcome to the original sender as
 *     `source.result { ref: <the sender's own frame id>, status }`
 * ```
 *
 * The location arrives already resolved and stamped (`resolvedBy`,
 * `confidence`) by whichever route produced it — patch metadata, the code
 * graph, a source map, the route map or the React owner chain. Resolution is
 * `./resolve.ts`'s job and this module deliberately does not import it: the
 * location it forwards is the validated location exactly as the panel sent it,
 * never normalised, re-stamped or re-resolved. Beside it travels `pinned`, the
 * canonical file and identity containment proved (see "Pinning the target").
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
 *    defence in depth. A frame that already carries `pinned` is refused: only
 *    this service mints a pin. A rejection is described by issue paths and codes
 *    only; the rejected value is never echoed.
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
 *    is a regular file and reads its device and inode.
 * 6. **Forward** — `createEnvelope('source.open', { sessionId, location, pinned })`
 *    to the session's `vscode` clients through the injected client port.
 *
 * Only after step 5 has succeeded is anything sent, and the only filesystem
 * operations this module ever performs are `realpath` and `lstat`: it writes
 * nothing, reads no file content and opens no database.
 *
 * ## Pinning the target
 *
 * Step 5 proves where the location leads at one instant, and the editor acts on
 * the frame only after a socket hop, so a link re-pointed in between would make
 * the editor open a file this handler never checked (CWE-367). The forwarded
 * frame therefore carries `pinned: { file, dev, ino }`: the target's path
 * relative to the canonical root with every link resolved, and the `st_dev` and
 * `st_ino` of the `bigint` `lstat` of that canonical path, in canonical decimal
 * (a `number` would round an inode above 2^53). The editor resolves the
 * location itself and opens nothing unless its own canonical path and identity
 * equal the pin, so a substitution in flight is refused rather than opened.
 *
 * ## Three independent enforcement points
 *
 * The question "may this path be opened" is answered three times, by parties
 * that do not trust each other:
 *
 * 1. **This handler**, which holds the session's project root and the service's
 *    view of the filesystem.
 * 2. **The editor**: `apps/vscode-extension/src/source/open-location.ts` for a
 *    forwarded message, which re-derives containment against the session's
 *    project root and requires the pin, and the
 *    `vscode://debuggen.debug-generator/open` URI handler in
 *    `apps/vscode-extension/src/uri-handler.ts`, which performs its own
 *    `fs.realpath` plus workspace-folder containment and asks the developer to
 *    confirm, because any web page can trigger such a URI.
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
 * outcome the caller needs: `src/server/ws.ts` answers the sender with
 * `source.result { status: 'no-editor' }`, which is what tells the DevTools
 * side to fall back to the `vscode://debuggen.debug-generator/open?file&line&col`
 * URI, which the editor's URI handler validates on its own. The fallback is
 * produced elsewhere; this module only reports that the forward reached nobody,
 * and only after every containment check passed.
 *
 * ## Delivery is not opening: the editor's answer is correlated
 *
 * A frame written to an editor's socket proves nothing about the editor: the
 * window may be frozen, the file may fail to open, the workspace may have
 * changed. So a delivered forward carries a promise, `editorResult`, that
 * settles exactly once — and never rejects — by these rules:
 *
 * - the **first `opened`** from any addressed editor settles it `opened`;
 * - when **every** addressed editor answered `failed`, it settles with the
 *   **first** failure, unchanged;
 * - when nothing settled it within the editor deadline
 *   (`SOURCE_OPEN_EDITOR_TIMEOUT_MS` of `@debuggen/protocol` by default), it
 *   settles `failed` with `TRANSPORT_DISCONNECTED` and a constant sentence;
 * - {@link SourceOpenHandler.close} settles every outstanding one `failed`, and
 *   a forward attempted after it is settled that way at once.
 *
 * Correlation is by the forwarded envelope's `id`, which the editor echoes as
 * the `ref` of its `source.result`. The pending entry is registered **before**
 * the frame is handed to the client registry, so an editor that answers within
 * the send itself cannot race the registration. The table of pending entries is
 * bounded ({@link DEFAULT_MAX_PENDING_EDITOR_RESULTS}); past the bound the oldest
 * entry is settled `failed`, so a flood of clicks cannot grow memory. Every
 * deadline timer is `unref()`ed and cleared on settlement.
 *
 * An editor's answer is itself authorized: only a `vscode` connection may send
 * one, it must name the session of the forward it answers, and the connection's
 * announced workspace folders must cover that session's project root — the same
 * rule that lets an editor open source at all. An answer for a `ref` that is not
 * pending (never forwarded, already settled, or late after the deadline) is
 * accepted and ignored: a late answer is normal, and refusing it would only
 * surface a notice in the editor for a request the sender has already closed.
 *
 * ## Wiring
 *
 * - `src/main.ts` constructs the handler with {@link createSourceOpenHandler},
 *   injecting the session store, the client registry, the service logger and,
 *   by default, `node:fs/promises` `realpath` and `lstat`, the global timers and
 *   the protocol's editor deadline — so every forward it makes is pinned.
 * - `src/server/ws.ts` routes each inbound `source.open` frame to
 *   {@link SourceOpenHandler.handle} together with the connection's
 *   {@link SourceOpenPrincipal}, and maps an `Err` onto the protocol `error`
 *   payload with `toErrorPayload` from `@debuggen/protocol`. An `Ok` is answered
 *   to the sender with `source.result` — `no-editor` at once for an undelivered
 *   forward, and the settled `editorResult` for a delivered one — whose `ref` is
 *   the sender's own frame `id`. Each inbound `source.result` goes to
 *   {@link SourceOpenHandler.acceptEditorResult}, and `WsServer.close` calls
 *   {@link SourceOpenHandler.close}, so no deadline outlives the server.
 * - `src/store/sessions-repo.ts` (`createSessionsRepo`) satisfies
 *   {@link SourceOpenSessionPort} structurally: `get` and `getBindingBySession`.
 * - `src/server/auth.ts` resolves the connection's credential into its
 *   `Principal`; `ws.ts` composes the {@link SourceOpenPrincipal} from that
 *   principal's `role`, the workspace folders the connection announced and the
 *   tab its binding names.
 * - `apps/vscode-extension/src/source/open-location.ts` is the terminal
 *   consumer of the forwarded frame, and the producer of the `source.result`
 *   that answers it.
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
 * absolute path they failed on. An editor's `source.result` is logged by its
 * status, error code and ids only — never by its message or hint, which are
 * text from another process.
 *
 * @module
 */

import { lstat as lstatAsync, realpath as realpathAsync } from 'node:fs/promises';

import {
  MESSAGE_TYPE,
  SOURCE_OPEN_EDITOR_TIMEOUT_MS,
  clientKindSchema,
  createEnvelope,
  decodeMessage,
  isMessageOfType,
  isPlainRecord,
  parseMessage,
  parseSourceOpenPayload,
  parseSourceResultPayload,
} from '@debuggen/protocol';
import type {
  ClientKind,
  ProtocolMessage,
  SessionRecord,
  SourceOpenPayload,
  SourceResultPayload,
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
 * | `invalid-payload` | `PROTOCOL_INVALID_MESSAGE` | the frame is not a well-formed `source.open`, or carries the `pinned` only this service sets |
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
  /**
   * The service's process-local id of the connection, as the client registry
   * assigned it. Never an authority: {@link SourceOpenHandler.acceptEditorResult}
   * reads it only so that one editor answering `failed` twice counts once
   * towards "every addressed editor failed". Absent, each answer counts on its
   * own.
   */
  readonly connectionId?: string | undefined;
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

/**
 * What the regular-file check reads of the canonical target: the subset of
 * `node:fs` `BigIntStats` it uses. `dev` and `ino` are `bigint` so that an
 * inode above 2^53 is pinned exactly rather than rounded.
 */
export interface SourceOpenFileStats {
  /** The device the entry lives on (`st_dev`). */
  readonly dev: bigint;
  /** The entry's inode number (`st_ino`). */
  readonly ino: bigint;
  /** Whether the entry is a regular file. */
  isFile(): boolean;
  /** Whether the entry is itself a symbolic link. */
  isSymbolicLink(): boolean;
}

/**
 * The non-following inspector the regular-file check and the pin use.
 *
 * The shape of `node:fs/promises` `lstat` called with `{ bigint: true }`: it
 * reports the entry at the path itself — a link as a link, never its target —
 * and throws (or rejects) with the platform error when there is none.
 */
export type SourceOpenLstat = (path: string) => MaybePromise<SourceOpenFileStats>;

/**
 * The `pinned` member of a forwarded `source.open` payload: the canonical
 * project-relative `file` and the decimal `dev` and `ino` of the target this
 * handler proved. See "Pinning the target" in the module header.
 */
export type SourceOpenPin = NonNullable<SourceOpenPayload['pinned']>;

/**
 * The timer functions the editor deadline runs on: the shape of the globals.
 *
 * Injectable so a test drives the deadline with a fake clock. The handle is
 * opaque — the handler only ever hands a value its own `setTimeout` returned back
 * to `clearTimeout` — and it is `unref()`ed whenever it offers `unref`, so a
 * pending deadline never keeps the process alive. Declared with method syntax so
 * the global functions, whose handle type is narrower than `unknown`, satisfy it.
 */
export interface SourceOpenTimers {
  /** Schedules `callback` once, after `delayMs` milliseconds. */
  setTimeout(callback: () => void, delayMs: number): unknown;
  /** Cancels a callback scheduled by {@link SourceOpenTimers.setTimeout}. */
  clearTimeout(handle: unknown): void;
}

/** Each member of a `source.result` payload union, without `sessionId` and `ref`. */
type WithoutCorrelation<T> = T extends unknown ? Omit<T, 'sessionId' | 'ref'> : never;

/**
 * How an editor may answer a forwarded `source.open`, without the per-hop
 * correlation fields: `{ status: 'opened' }`, or
 * `{ status: 'failed', error: { code, message, hint? } }`.
 *
 * Derived from the protocol's `SourceResultPayload` rather than restated, so the
 * two can never drift. `no-editor` is excluded: it is the service's own answer
 * for a forward that reached nobody, never an editor's. `sessionId` and `ref` are
 * removed because they differ on each hop — the relay re-adds the sender's own.
 */
export type SourceOpenEditorResult = WithoutCorrelation<
  Exclude<SourceResultPayload, { readonly status: 'no-editor' }>
>;

/** The `failed` member of {@link SourceOpenEditorResult}. */
export type SourceOpenEditorFailure = Extract<
  SourceOpenEditorResult,
  { readonly status: 'failed' }
>;

/** What {@link SourceOpenHandler.acceptEditorResult} answers with on success. */
export interface SourceOpenResultAcceptance {
  /**
   * Whether this answer settled a pending forward. `false` for an answer to a
   * `ref` that is not pending (unknown, already settled, or late), and for a
   * `failed` answer while another addressed editor has yet to answer.
   */
  readonly settled: boolean;
}

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
   * The non-following inspector of the canonical target. Defaults to
   * `node:fs/promises` `lstat` with `{ bigint: true }`; tests inject one to
   * report identities a real filesystem cannot stage on demand.
   */
  readonly lstat?: SourceOpenLstat | undefined;
  /**
   * Whether to confirm, with a non-following `lstat` of the canonical target,
   * that it is a regular file, and to pin its identity on the forwarded frame.
   * Defaults to `true`, which is what `src/main.ts` runs with, so every forward
   * the service makes is pinned.
   *
   * Containment itself never depends on this flag: both halves run on every
   * request, and the canonicalisation of the filesystem half already fails for
   * a path that does not exist. Turning it off skips the `lstat`, so no identity
   * exists and the frame is forwarded **without** `pinned` — which the editor,
   * requiring the pin on a forwarded frame, refuses to open. It exists only for
   * a caller that injects a table-based `realpath` over a filesystem that does
   * not hold the files and exercises the service's own half.
   */
  readonly verifyExists?: boolean | undefined;
  /**
   * The clock stamped on the outbound envelope's `ts`, in epoch milliseconds.
   * Defaults to the protocol's own clock inside `createEnvelope`.
   */
  readonly now?: (() => number) | undefined;
  /**
   * How long a delivered forward waits for an editor's `source.result` before it
   * settles `failed`, in milliseconds. Defaults to the protocol's
   * `SOURCE_OPEN_EDITOR_TIMEOUT_MS`, which the DevTools side's own deadline is
   * sized to exceed; a value that is not a positive integer a timer accepts is
   * replaced by that default (and logged).
   */
  readonly editorResultTimeoutMs?: number | undefined;
  /** The timers the editor deadline runs on. Defaults to the globals. */
  readonly timers?: SourceOpenTimers | undefined;
  /**
   * The most forwards that may await an editor's answer at once. Defaults to
   * {@link DEFAULT_MAX_PENDING_EDITOR_RESULTS}; registering one more settles the
   * oldest `failed`. A value that is not a positive safe integer is replaced by
   * that default (and logged).
   */
  readonly maxPendingEditorResults?: number | undefined;
}

/** The outcome of a request the editor received. */
export interface SourceOpenDelivered {
  readonly delivered: true;
  /** How many editor clients the forwarded frame reached; at least one. */
  readonly clients: number;
  /** The validated location, exactly as it was forwarded. */
  readonly location: SourceLocation;
  /**
   * The canonical project-relative path containment proved, which the
   * forwarded frame carries as `pinned.file` — the only file the editor will
   * open. Equal to `location.file` unless the file was reached through a
   * symbolic link that stays inside the project.
   */
  readonly file: string;
  /**
   * The `id` of the `source.open` envelope handed to the editors: the `ref`
   * their `source.result` answers carry.
   */
  readonly forwardedId: string;
  /**
   * The editors' answer, settled exactly once by the rules of the module header
   * ("Delivery is not opening"). **Never rejects**: a silent editor settles it
   * `failed` at the deadline, and {@link SourceOpenHandler.close} settles it
   * `failed` on shutdown.
   */
  readonly editorResult: Promise<SourceOpenEditorResult>;
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
 * `src/server/ws.ts` for every inbound `source.open` and `source.result` frame,
 * and closed with the WebSocket server.
 */
export interface SourceOpenHandler {
  /**
   * Validates, authorizes, contains and forwards one `source.open` request.
   *
   * Never throws and never rejects: every failure is a typed `Err` the caller
   * maps onto the protocol `error` payload with `toErrorPayload`. A delivered
   * outcome carries the `editorResult` the caller relays once it settles.
   *
   * @param input The request, in any of three forms, each validated in full: a
   * parsed `source.open` envelope (`MessageByType<'source.open'>`), a raw
   * frame (a JSON string, or an unparsed envelope object), or the bare
   * `{ sessionId, location }` payload. One that carries `pinned` is refused.
   * @param principal The connection's resolved identity.
   * @returns The delivery outcome, or the refusal or failure. A delivered
   * forward was sent as `{ sessionId, location, pinned }`.
   */
  handle(
    input: unknown,
    principal: SourceOpenPrincipal,
  ): Promise<Result<SourceOpenOutcome, DebuggenError>>;

  /**
   * Accepts an editor's `source.result` for a `source.open` this handler
   * forwarded, settling that forward's `editorResult` by the rules of the module
   * header.
   *
   * Never throws and never rejects. Refusals — every one carrying its
   * {@link SourceOpenRejection} — are: a frame that is not a well-formed
   * `source.result`, or one answering `no-editor` (`invalid-payload`); a
   * connection that is not an editor, an answer naming a different session than
   * the forward it answers, or an editor whose announced workspace folders do not
   * cover that session's project root (`not-authorized`). An answer for a `ref`
   * that is not pending is **not** a refusal: it is `ok({ settled: false })`.
   *
   * @param input The answer, in any of three forms, each validated in full: a
   * parsed `source.result` envelope, a raw frame, or the bare payload.
   * @param principal The answering connection's resolved identity.
   * @returns Whether the answer settled a forward, or the refusal.
   */
  acceptEditorResult(
    input: unknown,
    principal: SourceOpenPrincipal,
  ): Promise<Result<SourceOpenResultAcceptance, DebuggenError>>;

  /**
   * Settles every forward still awaiting an editor `failed`
   * (`TRANSPORT_DISCONNECTED`, "The Debug Generator service is shutting down.")
   * and clears every deadline timer. Idempotent. A forward made afterwards is
   * still sent, but its `editorResult` is settled the same way at once, because
   * no answer can be correlated any more.
   */
  close(): void;
}

/* -------------------------------------------------------------------------------------------------
 * Internal constants
 * ---------------------------------------------------------------------------------------------- */

/** The `subsystem` binding every record of this module carries. */
const SOURCE_SUBSYSTEM = 'source';

/** The message this module handles and the message it forwards. */
const SOURCE_OPEN_TYPE = MESSAGE_TYPE.SOURCE_OPEN;

/** The message an editor answers a forwarded `source.open` with. */
const SOURCE_RESULT_TYPE = MESSAGE_TYPE.SOURCE_RESULT;

/**
 * The default bound on forwards awaiting an editor's answer at once.
 *
 * The same order as the WebSocket server's per-connection frame backlog: far
 * more clicks than a developer makes within one editor deadline, and small
 * enough that a flooding panel costs a bounded, trivial amount of memory. Past
 * it the oldest forward is settled `failed` rather than the new one refused,
 * because the newest click is the one the developer is looking at.
 */
export const DEFAULT_MAX_PENDING_EDITOR_RESULTS = 256;

/** The largest delay a Node timer accepts, in milliseconds. */
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;

/** The constant sentence of a forward no editor answered within the deadline. */
const EDITOR_TIMEOUT_MESSAGE =
  'VS Code did not confirm that it opened the source location in time.';

/** The constant sentence of a forward settled because the service is closing. */
const SHUTDOWN_MESSAGE = 'The Debug Generator service is shutting down.';

/** The constant sentence of a forward given up on to keep the pending table bounded. */
const OVERFLOW_MESSAGE =
  'Too many source links were waiting for VS Code to confirm them, so the oldest one was given up on.';

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

/**
 * Why an editor's `source.result` was refused, beyond the shared access reasons:
 * a non-editor answering at all, an answer naming another session than the
 * forward it answers, and `no-editor` — the service's own status — sent by an
 * editor.
 */
type ResultRefusalReason = 'role-not-permitted' | 'session-mismatch' | 'status-not-permitted';

/** Why the filesystem half refused a path it could not vouch for. */
type UnsafePathReason =
  | 'root-not-resolvable'
  | 'not-resolvable'
  | 'resolved-path-not-absolute'
  | 'symlink-escapes-project-root'
  | 'unsafe-canonical-path'
  | 'changed-after-resolution'
  | 'identity-unavailable';

/** Why the filesystem half found nothing openable. */
type FileMissingReason = 'project-root-missing' | 'not-found' | 'not-a-file';

/** The developer-facing next steps, one per situation, stated once. */
const HINTS = Object.freeze({
  invalidPayload:
    'A source.open request carries the session id and a source location with a project-relative file, 1-based line and column, a resolver and a confidence.',
  pinNotPermitted:
    'Send source.open with the session id and the source location only; the service pins the file itself when it forwards the request to VS Code.',
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
  editorTimeout:
    'Make sure the VS Code window for the project is responsive, then click the source link again.',
  shuttingDown:
    'Start the Debug Generator service again from VS Code, then click the source link again.',
  overflow: 'Give VS Code a moment to catch up, then click the source link again.',
  resultPayload:
    'An editor answers a forwarded source.open with a source.result naming the same session, the forwarded frame id as ref, and a status of opened or failed.',
  resultRole:
    'A source.result is sent only by the VS Code window a source location was forwarded to.',
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

/**
 * A request that arrived already carrying `pinned`. Only this service mints a
 * pin — it is the proof its own containment check produced — so a sender that
 * supplies one is trying to nominate the file it wants trusted. A constant
 * sentence: none of the supplied values is quoted.
 */
function pinNotPermitted(): DebuggenError {
  return refusal(
    'PROTOCOL_INVALID_MESSAGE',
    'invalid-payload',
    `A ${SOURCE_OPEN_TYPE} request may not carry pinned: only the Debug Generator service sets it, on the frame it forwards to the editor.`,
    HINTS.pinNotPermitted,
    { reason: 'pin-not-permitted' },
  );
}

/** A well-formed frame of another message type where an editor's answer was expected. */
function notSourceResult(type: string): DebuggenError {
  return refusal(
    'PROTOCOL_INVALID_MESSAGE',
    'invalid-payload',
    `Expected a ${SOURCE_RESULT_TYPE} message; received a ${type} message.`,
    HINTS.resultPayload,
    { receivedType: type },
  );
}

/**
 * A refusal of an editor's `source.result` that is not the shared workspace-scope
 * rule (which {@link notAuthorized} words): a connection that is not an editor,
 * an answer naming another session than the forward it answers, and an editor
 * answering with the service's own `no-editor` status.
 */
function resultRefused(reason: ResultRefusalReason, client: string): DebuggenError {
  switch (reason) {
    case 'role-not-permitted':
      return refusal(
        'UNAUTHORIZED',
        'not-authorized',
        'Only the VS Code editor a source location was forwarded to may answer it.',
        HINTS.resultRole,
        { reason, client },
      );
    case 'session-mismatch':
      return refusal(
        'UNAUTHORIZED',
        'not-authorized',
        'This source.result names a different session than the source.open it answers.',
        HINTS.resultPayload,
        { reason, client },
      );
    case 'status-not-permitted':
      return refusal(
        'PROTOCOL_INVALID_MESSAGE',
        'invalid-payload',
        'An editor answers a forwarded source.open with opened or failed; no-editor is the service’s own answer.',
        HINTS.resultPayload,
        { reason, client },
      );
  }
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
    case 'identity-unavailable':
      return `${quoted} could not be identified on disk, so it could not be pinned for the editor and was not opened.`;
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
 * A `failed` editor result the service settles on its own: a constant sentence
 * and hint under `code`, shaped by `DebuggenError.toPayload()` — exactly the
 * `{ code, message, hint? }` the protocol's `source.result` carries. Frozen in
 * depth, because one value is shared by every forward it settles.
 */
function serviceFailure(
  code: DebuggenErrorCode,
  message: string,
  hint: string,
): SourceOpenEditorFailure {
  const error = Object.freeze(new DebuggenError(code, message, { hint }).toPayload());
  return Object.freeze({ status: 'failed', error });
}

/** No addressed editor answered within the deadline. */
const EDITOR_TIMEOUT_RESULT = serviceFailure(
  'TRANSPORT_DISCONNECTED',
  EDITOR_TIMEOUT_MESSAGE,
  HINTS.editorTimeout,
);

/** The service is closing; nothing can be correlated any more. */
const SHUTDOWN_RESULT = serviceFailure(
  'TRANSPORT_DISCONNECTED',
  SHUTDOWN_MESSAGE,
  HINTS.shuttingDown,
);

/** The pending table was full, and this was the oldest entry in it. */
const OVERFLOW_RESULT = serviceFailure('RATE_LIMITED', OVERFLOW_MESSAGE, HINTS.overflow);

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
 * Canonicalisation is a check at a moment, not a lock: the handler pins the
 * `relativePath` proved here, with the target's identity, on the forwarded
 * frame, and the editor re-derives the same answer independently and opens
 * nothing that does not match the pin.
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

/** The device and inode of a proved target, in the canonical decimal a pin carries. */
interface FileIdentity {
  readonly dev: string;
  readonly ino: string;
}

/**
 * The largest device or inode number accepted: `st_dev` and `st_ino` are
 * unsigned 64-bit on every platform Node supports, so anything larger is an
 * inspector answering nonsense.
 */
const MAX_FILE_ID = 0xffff_ffff_ffff_ffffn;

/** Whether an inspector's answer offers the two type tests the check calls. */
function isFileStats(value: unknown): value is SourceOpenFileStats {
  return (
    isPlainRecord(value) &&
    typeof value['isFile'] === 'function' &&
    typeof value['isSymbolicLink'] === 'function'
  );
}

/** Whether a reported device or inode number is a usable, exact identity. */
function isFileId(value: unknown): value is bigint {
  return typeof value === 'bigint' && value >= 0n && value <= MAX_FILE_ID;
}

/**
 * Confirms, without following a link at the final component, that the
 * canonical target is a regular file, and reads the identity the forwarded
 * frame pins.
 *
 * The target is canonical, so a symbolic link here means the entry was replaced
 * between canonicalisation and this check: refused as unsafe. A directory, FIFO,
 * socket or device is `file-missing` (`not-a-file`), since there is no source
 * file to open. An answer without an exact `bigint` device and inode is refused
 * as `identity-unavailable`: a forward the editor could not match is never
 * sent. Reads metadata only — never content.
 *
 * @returns The target's `dev` and `ino` as canonical decimal strings —
 * `String` of a `bigint` has no sign, no leading zero and no rounding, which is
 * exactly the form the protocol's pin schema compares as written.
 */
async function inspectRegularFile(
  realPath: string,
  file: string,
  inspect: SourceOpenLstat,
): Promise<Result<FileIdentity>> {
  const inspected = await settle<unknown>(() => inspect(realPath), 'FS_UNSAFE_PATH');
  if (!inspected.ok) {
    const errno = errnoOf(inspected.error);
    return err(
      errno !== undefined && MISSING_ERRNOS.has(errno)
        ? fileMissing('not-found', file)
        : unsafePath('not-resolvable', file, errno),
    );
  }

  const stats = inspected.value;
  if (!isFileStats(stats)) {
    return err(unsafePath('identity-unavailable', file));
  }

  if (stats.isSymbolicLink()) {
    return err(unsafePath('changed-after-resolution', file));
  }

  if (!stats.isFile()) {
    return err(fileMissing('not-a-file', file));
  }

  const { dev, ino } = stats;
  if (!isFileId(dev) || !isFileId(ino)) {
    return err(unsafePath('identity-unavailable', file));
  }

  return ok({ dev: dev.toString(), ino: ino.toString() });
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
 *
 * A payload that carries `pinned` at all is refused (`invalid-payload`, reason
 * `pin-not-permitted`). The shared schema accepts the key because the frame this
 * service forwards carries it, and `src/server/ws.ts` hands the parsed frame
 * over unchanged, so this is the one gate that keeps a sender from nominating
 * the file it wants trusted. What is returned never has a pin: only the
 * handler's own containment proof becomes one.
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

  // By presence, not by value: an explicitly undefined pin is refused as well.
  if (isPlainRecord(payload) && Object.hasOwn(payload, 'pinned')) {
    return err(pinNotPermitted());
  }

  const location = parseSourceLocation(parsed.value.location);
  if (!location.ok) {
    return err(invalidPayload(location.error));
  }

  return ok({ sessionId: parsed.value.sessionId, location: location.value });
}

/**
 * Turns any accepted form of an editor's answer into a validated
 * `source.result` payload, exactly as {@link decodeSourceOpenInput} does for a
 * request: a raw frame or an envelope is decoded and validated in full (the
 * routing key included), and the payload is then validated with
 * `parseSourceResultPayload`, whose rejection names issue paths only — never the
 * `message` of a malformed failure, which is text from another process.
 */
function decodeSourceResultInput(input: unknown): Result<SourceResultPayload> {
  let payload: unknown = input;

  if (typeof input === 'string' || looksLikeEnvelope(input)) {
    const decoded = decodeMessage(input);
    if (!decoded.ok) {
      return err(invalidPayload(decoded.error));
    }
    const message = decoded.value;
    if (!isMessageOfType(message, SOURCE_RESULT_TYPE)) {
      return err(notSourceResult(message.type));
    }
    payload = message.payload;
  }

  const parsed = parseSourceResultPayload(payload);
  if (!parsed.ok) {
    return err(invalidPayload(parsed.error));
  }

  return ok(parsed.value);
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

/** The longest connection id read off a principal; the registry's own ids are far shorter. */
const MAX_CONNECTION_ID_LENGTH = 128;

/**
 * The principal's connection id, when it carries a usable one; `undefined`
 * otherwise. Read defensively, like every other principal field: it only ever
 * de-duplicates one connection's repeated answers, so a missing or odd value
 * degrades to counting each answer separately rather than to a refusal.
 */
function connectionIdOf(principal: unknown): string | undefined {
  if (!isPlainRecord(principal)) {
    return undefined;
  }
  const id = principal['connectionId'];
  return typeof id === 'string' && id.length > 0 && id.length <= MAX_CONNECTION_ID_LENGTH
    ? id
    : undefined;
}

/** The workspace folders a principal announced, read defensively for {@link authorizeEditor}. */
function projectRootsOf(principal: unknown): unknown {
  return isPlainRecord(principal) ? principal['projectRoots'] : undefined;
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
 * refuse is never sent — the pin's decimal `dev` and `ino` included. The frame
 * built, not the parser's copy, is returned: the location travels exactly as it
 * was validated.
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
 * Correlating the editor's answer
 * ---------------------------------------------------------------------------------------------- */

/** The one `opened` result, shared by every forward it settles. */
const OPENED_RESULT: SourceOpenEditorResult = Object.freeze({ status: 'opened' });

/** A failed timer start: the deadline could not be armed, so the forward is not left waiting. */
const TIMER_FAILURE_RESULT = serviceFailure(
  'INTERNAL',
  'The Debug Generator service could not start waiting for VS Code to confirm the source location.',
  HINTS.internal,
);

/** The global timers, called at the moment of use so a fake clock installed later is honoured. */
const GLOBAL_TIMERS: SourceOpenTimers = Object.freeze({
  setTimeout: (callback: () => void, delayMs: number) => setTimeout(callback, delayMs),
  clearTimeout: (handle: ReturnType<typeof setTimeout>) => {
    clearTimeout(handle);
  },
});

/**
 * Calls `unref()` on a timer handle that offers one, so a pending deadline never
 * keeps the process alive. A handle without it (a fake clock's number) is left
 * alone.
 */
function unrefTimer(handle: unknown): void {
  if (typeof handle !== 'object' || handle === null) {
    return;
  }
  const unref: unknown = Reflect.get(handle, 'unref');
  if (typeof unref === 'function') {
    Reflect.apply(unref, handle, []);
  }
}

/** One forward awaiting its editors' answer. */
interface PendingForward {
  /** The forwarded envelope's `id`: the `ref` an editor's answer carries. */
  readonly forwardedId: string;
  /** The session the forward belongs to; an answer naming another is refused. */
  readonly sessionId: SessionId;
  /** The stored project root an answering editor's workspace must cover. */
  readonly projectRoot: string;
  /** The `editorResult` handed to the caller. Never rejects. */
  readonly promise: Promise<SourceOpenEditorResult>;
  /** Settles {@link PendingForward.promise}. */
  readonly resolve: (result: SourceOpenEditorResult) => void;
  /** How many editors the frame reached; `undefined` while the send is in flight. */
  expected: number | undefined;
  /** The connections that answered `failed`, each counted once. */
  readonly failedBy: Set<string>;
  /** `failed` answers from principals that carried no connection id. */
  anonymousFailures: number;
  /** The first `failed` answer, which is what "every editor failed" settles with. */
  firstFailure: SourceOpenEditorFailure | undefined;
  /** The deadline timer's handle, until settlement. */
  timer: unknown;
  /** Whether {@link PendingForward.promise} has been settled (or the forward dropped). */
  settled: boolean;
}

/** What {@link createEditorResultCorrelator} is built from. */
interface CorrelatorOptions {
  readonly timers: SourceOpenTimers;
  readonly timeoutMs: number;
  readonly maxPending: number;
  /** Records one diagnostic; never throws. */
  readonly emit: (level: RecordLevel, message: string, fields: LogFields) => void;
}

/** The table of forwards awaiting an editor's answer, and the rules that settle them. */
interface EditorResultCorrelator {
  /**
   * Registers a forward — before its frame is sent — and arms its deadline.
   * After {@link EditorResultCorrelator.close}, the entry is returned already
   * settled `failed` and is not stored.
   */
  register(forwardedId: string, sessionId: SessionId, projectRoot: string): PendingForward;
  /** Records how many editors the frame reached, settling at once if all of them already failed. */
  delivered(entry: PendingForward, count: number): void;
  /** Drops a forward whose frame reached nobody or could not be sent; its promise is never handed out. */
  forget(entry: PendingForward): void;
  /** The pending forward an answer's `ref` names, if any. */
  lookup(ref: string): PendingForward | undefined;
  /**
   * Applies one editor's answer by the settlement rules.
   * @returns Whether this answer settled the forward.
   */
  answer(entry: PendingForward, result: SourceOpenEditorResult, connectionId?: string): boolean;
  /**
   * Settles every pending forward `failed` for shutdown and refuses to hold new ones.
   * @returns How many forwards were pending. Idempotent.
   */
  close(): number;
}

/**
 * Builds the correlator a handler keeps between its `source.open` forwards and
 * its editors' `source.result` answers.
 *
 * Map insertion order is registration order, which is what makes "the oldest
 * forward" the first key when the bound is reached. Every settlement clears the
 * deadline timer and removes the entry, so a settled forward holds nothing.
 */
function createEditorResultCorrelator(options: CorrelatorOptions): EditorResultCorrelator {
  const { timers, timeoutMs, maxPending, emit } = options;
  const pending = new Map<string, PendingForward>();
  let closed = false;

  /** Clears an entry's deadline, tolerating a timer implementation that throws. */
  function disarm(entry: PendingForward): void {
    const handle = entry.timer;
    entry.timer = undefined;
    if (handle !== undefined) {
      tryCatch(() => {
        timers.clearTimeout(handle);
      });
    }
  }

  /** Removes an entry from the table and marks it settled; the one exit of every entry. */
  function retire(entry: PendingForward): boolean {
    if (entry.settled) {
      return false;
    }
    entry.settled = true;
    disarm(entry);
    if (pending.get(entry.forwardedId) === entry) {
      pending.delete(entry.forwardedId);
    }
    return true;
  }

  /** Settles an entry with `result`, once; later calls are no-ops. */
  function settleEntry(entry: PendingForward, result: SourceOpenEditorResult): boolean {
    if (!retire(entry)) {
      return false;
    }
    entry.resolve(result);
    return true;
  }

  function failureCount(entry: PendingForward): number {
    return entry.failedBy.size + entry.anonymousFailures;
  }

  /** Settles the oldest forwards until there is room for one more. */
  function makeRoom(): void {
    while (pending.size >= maxPending) {
      const oldest = pending.values().next();
      if (oldest.done === true) {
        return;
      }
      settleEntry(oldest.value, OVERFLOW_RESULT);
      emit('warn', 'Gave up on the oldest source.open awaiting an editor answer', {
        ref: oldest.value.forwardedId,
        [LOG_BINDING_KEYS.sessionId]: oldest.value.sessionId,
        code: OVERFLOW_RESULT.error.code,
        pending: pending.size,
      });
    }
  }

  function arm(entry: PendingForward): void {
    const scheduled = tryCatch(() =>
      timers.setTimeout(() => {
        if (settleEntry(entry, EDITOR_TIMEOUT_RESULT)) {
          emit('debug', 'No editor confirmed a forwarded source.open before the deadline', {
            ref: entry.forwardedId,
            [LOG_BINDING_KEYS.sessionId]: entry.sessionId,
            code: EDITOR_TIMEOUT_RESULT.error.code,
          });
        }
      }, timeoutMs),
    );
    if (!scheduled.ok) {
      settleEntry(entry, TIMER_FAILURE_RESULT);
      emit('error', 'The deadline of a forwarded source.open could not be armed', {
        ref: entry.forwardedId,
        [LOG_BINDING_KEYS.sessionId]: entry.sessionId,
        code: scheduled.error.code,
      });
      return;
    }
    entry.timer = scheduled.value;
    tryCatch(() => {
      unrefTimer(scheduled.value);
    });
  }

  return Object.freeze({
    register(forwardedId: string, sessionId: SessionId, projectRoot: string): PendingForward {
      let resolve: (result: SourceOpenEditorResult) => void = () => undefined;
      const promise = new Promise<SourceOpenEditorResult>((settleWith) => {
        resolve = settleWith;
      });
      const entry: PendingForward = {
        forwardedId,
        sessionId,
        projectRoot,
        promise,
        resolve,
        expected: undefined,
        failedBy: new Set<string>(),
        anonymousFailures: 0,
        firstFailure: undefined,
        timer: undefined,
        settled: false,
      };
      if (closed) {
        settleEntry(entry, SHUTDOWN_RESULT);
        return entry;
      }
      makeRoom();
      pending.set(forwardedId, entry);
      arm(entry);
      return entry;
    },

    delivered(entry: PendingForward, count: number): void {
      entry.expected = count;
      if (entry.firstFailure !== undefined && failureCount(entry) >= count) {
        settleEntry(entry, entry.firstFailure);
      }
    },

    forget(entry: PendingForward): void {
      retire(entry);
    },

    lookup(ref: string): PendingForward | undefined {
      return pending.get(ref);
    },

    answer(entry: PendingForward, result: SourceOpenEditorResult, connectionId?: string): boolean {
      if (entry.settled) {
        return false;
      }
      if (result.status === 'opened') {
        return settleEntry(entry, OPENED_RESULT);
      }
      if (connectionId === undefined) {
        entry.anonymousFailures += 1;
      } else if (entry.failedBy.has(connectionId)) {
        return false;
      } else {
        entry.failedBy.add(connectionId);
      }
      entry.firstFailure ??= result;
      return entry.expected !== undefined && failureCount(entry) >= entry.expected
        ? settleEntry(entry, entry.firstFailure)
        : false;
    },

    close(): number {
      closed = true;
      const outstanding = [...pending.values()];
      for (const entry of outstanding) {
        settleEntry(entry, SHUTDOWN_RESULT);
      }
      pending.clear();
      return outstanding.length;
    },
  });
}

/**
 * Validates one optional numeric option: a safe integer in `[1, max]`.
 * @returns the value, or `undefined` when it is absent or unusable.
 */
function positiveIntegerOption(value: unknown, max: number): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= max
    ? value
    : undefined;
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
 * is `apps/vscode-extension/src/source/open-location.ts`, whose `source.result`
 * `ws.ts` hands to {@link SourceOpenHandler.acceptEditorResult}.
 *
 * Each request runs the fixed sequence of the module header — validate, look the
 * session up, authorize, contain lexically, contain on the filesystem, then
 * forward — and returns at the first refusal. The forward is reachable only
 * through both containment halves. Nothing is cached between requests: a file
 * that changes into a link between two clicks is judged afresh on the second.
 *
 * @param deps The injected ports and options; see {@link SourceOpenDeps}.
 * @returns The handler. Frozen; its only state is the bounded table of forwards
 * awaiting an editor's answer, emptied by {@link SourceOpenHandler.close}.
 *
 * @example
 * ```ts
 * const sourceOpen = createSourceOpenHandler({ sessions: sessionsRepo, clients, logger });
 * const result = await sourceOpen.handle(frame, principalOf(connection));
 * if (!result.ok) {
 *   connection.send(createEnvelope('error', toErrorPayload(result.error, frame.id)));
 * } else if (!result.value.delivered) {
 *   // no editor connected: answer `no-editor`, the DevTools cue for the vscode:// URI
 *   connection.send(createEnvelope('source.result', { sessionId, ref: frame.id, status: 'no-editor' }));
 * } else {
 *   void result.value.editorResult.then((answer) =>
 *     connection.send(createEnvelope('source.result', { sessionId, ref: frame.id, ...answer })),
 *   );
 * }
 * // an editor's answer to the forwarded frame:
 * await sourceOpen.acceptEditorResult(editorFrame, principalOf(editorConnection));
 * ```
 */
export function createSourceOpenHandler(deps: SourceOpenDeps): SourceOpenHandler {
  const derived = tryCatch(() => subsystemLogger(deps.logger ?? noopLogger, SOURCE_SUBSYSTEM));
  const log = derived.ok ? derived.value : noopLogger;
  const realpath: SourceOpenRealPath = deps.realpath ?? ((path: string) => realpathAsync(path));
  const inspect: SourceOpenLstat =
    deps.lstat ?? ((path: string) => lstatAsync(path, { bigint: true }));
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

  /** A numeric option, or its default when it is absent or unusable (the latter logged). */
  function optionOrDefault(name: string, value: unknown, fallback: number, max: number): number {
    if (value === undefined) {
      return fallback;
    }
    const usable = positiveIntegerOption(value, max);
    if (usable === undefined) {
      emit('warn', 'Replaced an unusable source.open option with its default', {
        option: name,
        fallback,
      });
      return fallback;
    }
    return usable;
  }

  const correlator = createEditorResultCorrelator({
    timers: deps.timers ?? GLOBAL_TIMERS,
    timeoutMs: optionOrDefault(
      'editorResultTimeoutMs',
      deps.editorResultTimeoutMs,
      SOURCE_OPEN_EDITOR_TIMEOUT_MS,
      MAX_TIMER_DELAY_MS,
    ),
    maxPending: optionOrDefault(
      'maxPendingEditorResults',
      deps.maxPendingEditorResults,
      DEFAULT_MAX_PENDING_EDITOR_RESULTS,
      Number.MAX_SAFE_INTEGER,
    ),
    emit,
  });

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

  /** {@link refuse}, for an editor's `source.result`. */
  function refuseAnswer(
    error: DebuggenError,
    context: LogFields,
  ): Result<SourceOpenResultAcceptance> {
    const level = levelFor(sourceOpenRejectionOf(error));
    emit(
      level,
      level === 'error' ? 'A source.result answer failed' : 'Refused a source.result answer',
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
    // The pin: the canonical file just proved and the identity the inspection
    // read of it. With `verifyExists` off nothing is inspected, so no identity
    // exists and the frame goes unpinned, which the editor refuses to open.
    let pinned: SourceOpenPin | undefined;
    if (verifyExists) {
      const identity = await inspectRegularFile(
        contained.value.realPath,
        displayFile(location.file),
        inspect,
      );
      if (!identity.ok) {
        return refuse(identity.error, context);
      }
      pinned = {
        file: contained.value.relativePath,
        dev: identity.value.dev,
        ino: identity.value.ino,
      };
    }

    // Step 6 — forward the validated location, unchanged, to the editor, with the
    // pin beside it. The answer's pending entry is registered first, keyed by the
    // forwarded frame's id, so an editor that answers within the send itself
    // cannot race it.
    const payload: SourceOpenPayload =
      pinned === undefined ? { sessionId, location } : { sessionId, location, pinned };
    const envelope = buildSourceOpenEnvelope(payload, now);
    if (!envelope.ok) {
      return refuse(envelope.error, context);
    }
    const forwardedId = envelope.value.id;
    const pending = correlator.register(forwardedId, sessionId, session.projectRoot);
    const delivery = await settle(
      () => clients.sendToSessionClients(sessionId, EDITOR_CLIENT, envelope.value),
      'TRANSPORT_DISCONNECTED',
    );
    if (!delivery.ok) {
      correlator.forget(pending);
      return refuse(deliveryFailure(delivery.error), context);
    }
    const count: unknown = delivery.value;
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) {
      correlator.forget(pending);
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
      correlator.forget(pending);
      emit(
        'debug',
        'No editor client is connected for this session; the caller falls back to the vscode:// URI',
        fields,
      );
      return ok({ delivered: false, reason: 'no-editor-client', location });
    }
    correlator.delivered(pending, count);
    emit('debug', 'Forwarded source.open to the editor', { ...fields, ref: forwardedId });
    return ok({
      delivered: true,
      clients: count,
      location,
      file: contained.value.relativePath,
      forwardedId,
      editorResult: pending.promise,
    });
  }

  /**
   * Validates, authorizes and applies one editor answer, in the order of
   * {@link SourceOpenHandler.acceptEditorResult}'s contract. Records carry
   * statuses, codes and ids only; an editor's message and hint are never logged.
   */
  function answer(
    input: unknown,
    principal: SourceOpenPrincipal,
  ): Result<SourceOpenResultAcceptance> {
    const client = clientKindOf(principal) ?? UNRESOLVED_CLIENT;
    const context: LogFields = { [LOG_BINDING_KEYS.client]: client };

    const decoded = decodeSourceResultInput(input);
    if (!decoded.ok) {
      return refuseAnswer(decoded.error, context);
    }
    const result = decoded.value;
    context[LOG_BINDING_KEYS.sessionId] = result.sessionId;
    context['ref'] = result.ref;
    context['status'] = result.status;

    if (client !== EDITOR_CLIENT) {
      return refuseAnswer(resultRefused('role-not-permitted', client), context);
    }
    if (result.status === 'no-editor') {
      return refuseAnswer(resultRefused('status-not-permitted', client), context);
    }

    const entry = correlator.lookup(result.ref);
    if (entry === undefined) {
      emit('debug', 'Ignored a source.result that answers no pending source.open', context);
      return ok({ settled: false });
    }
    if (entry.sessionId !== result.sessionId) {
      return refuseAnswer(resultRefused('session-mismatch', client), context);
    }
    const scoped = authorizeEditor(projectRootsOf(principal), entry.projectRoot);
    if (!scoped.ok) {
      return refuseAnswer(scoped.error, context);
    }

    const editorResult: SourceOpenEditorResult =
      result.status === 'opened' ? OPENED_RESULT : { status: 'failed', error: result.error };
    const settledNow = correlator.answer(entry, editorResult, connectionIdOf(principal));
    emit(
      'debug',
      settledNow
        ? 'Settled a forwarded source.open with an editor answer'
        : 'Recorded an editor answer to a forwarded source.open',
      result.status === 'failed'
        ? { ...context, settled: settledNow, code: result.error.code }
        : { ...context, settled: settledNow },
    );
    return ok({ settled: settledNow });
  }

  return Object.freeze({
    acceptEditorResult(
      input: unknown,
      principal: SourceOpenPrincipal,
    ): Promise<Result<SourceOpenResultAcceptance, DebuggenError>> {
      try {
        return Promise.resolve(answer(input, principal));
      } catch (thrown) {
        // Reached only by a defect; the thrown value is reduced to its code.
        const failure = internalFailure('The source.result answer failed unexpectedly.');
        const fields: LogFields = { code: failure.code };
        if (DebuggenError.is(thrown)) {
          fields['causeCode'] = thrown.code;
        }
        emit('error', 'A source.result answer failed unexpectedly', fields);
        return Promise.resolve(err(failure));
      }
    },

    close(): void {
      const outstanding = correlator.close();
      if (outstanding > 0) {
        emit('debug', 'Settled the source.open forwards still awaiting an editor on shutdown', {
          pending: outstanding,
        });
      }
    },

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
