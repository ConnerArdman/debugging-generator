/**
 * Workspace discovery for the extension host: **which project** this editor
 * acts on, and **whether that project's dev server is already answering**.
 *
 * AAP §0.7.1 Group 3 gives `src/service/` the job of discovering "the project
 * root from the workspace folder" and probing "`debuggen.devServerUrl`"; this
 * module is that half, and it is deliberately the side-effect-free member of
 * the folder:
 *
 * - {@link resolveProjectRoot} picks the one absolute project root the
 *   extension announces in `client.hello` and sends as `POST /sessions
 *   { projectRoot }`. The editor credential is scoped to the announced root
 *   (AAP §0.5.6), and the service compares every later request body against it,
 *   so the string produced here is normalised once, in the service's own
 *   spelling (see {@link normalizeProjectRootPath}), and never carries a
 *   trailing separator.
 * - {@link listProjectRoots} enumerates every eligible folder of a multi-root
 *   workspace, and {@link isPathInsideProject} is the containment predicate for
 *   callers that must stay inside the credential's scope.
 * - {@link probeDevServer} is a liveness check of the configured dev-server URL,
 *   so a command can tell the developer "your dev server is already up" or
 *   decide to ask the service to launch one (`POST /dev-server/launch`, issued
 *   by `client.ts`). {@link normalizeDevServerUrl} is its pure input gate.
 *
 * ## What this module deliberately does not do
 *
 * - **No spawning.** The embedded service's process is `process.ts`'s; the
 *   target project's dev server is launched by the service
 *   (`apps/local-service/src/dev-server/launcher.ts`).
 * - **No service HTTP.** Every request to the local service goes through
 *   `client.ts`. The only request this module makes is the dev-server probe,
 *   which is sent to the *target project's* loopback dev server, never to the
 *   service.
 * - **No detection depth.** Reading the target's `package.json`, choosing its
 *   package manager and dev script, and deciding whether a running dev server
 *   carries the telemetry preload all belong to the service's
 *   `dev-server/detect.ts`, which is authoritative. This module never reads a
 *   file from the target project — in particular never a `.env*` file (AAP
 *   §0.5.2) — and touches no filesystem at all.
 * - **No user interface.** Every expected condition is returned as a typed
 *   `Result` (AAP §0.5.5); the command and extension layers decide how to
 *   render it. Nothing here throws for an expected condition or calls
 *   `vscode.window.show*Message`.
 * - **No subscriptions.** The project root is re-resolved on demand rather than
 *   watched: `src/extension.ts` owns the `workspace.onDidChangeWorkspaceFolders`
 *   subscription and `client.ts` owns the reconnect-on-root-change policy, so
 *   this module holds no state and returns no `Disposable`.
 *
 * Importing it has no side effect: settings are read lazily on every call via
 * `workspace.getConfiguration`, so a changed `debuggen.devServerUrl` takes
 * effect without a reload, and there is no top-level `await` (the host bundle
 * is CommonJS, emitted by `esbuild.mjs`).
 *
 * @packageDocumentation
 */

import { URL } from 'node:url';

import * as vscode from 'vscode';

import {
  DebuggenError,
  basenamePosix,
  err,
  isAbsolutePosix,
  isErr,
  isOk,
  isWithin,
  noopLogger,
  normalizePosix,
  nowEpochMs,
  ok,
  toPosix,
} from '@debuggen/shared';
import type { Logger, Result } from '@debuggen/shared';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Default bound on one dev-server probe, in milliseconds.
 *
 * The same value the service's `dev-server/detect.ts` uses, so the editor and
 * the service give up on an unresponsive address at the same moment.
 */
export const DEFAULT_DEV_SERVER_PROBE_TIMEOUT_MS = 1500;

/** Upper bound for an injected probe timeout; larger values are clamped. */
export const MAX_DEV_SERVER_PROBE_TIMEOUT_MS = 60_000;

/** The configuration section every `debuggen.*` setting lives under. */
const CONFIGURATION_SECTION = 'debuggen';

/** The key, within {@link CONFIGURATION_SECTION}, of the dev-server URL setting. */
const DEV_SERVER_URL_KEY = 'devServerUrl';

/** The only URI scheme whose workspace folders name a real filesystem path. */
const FILE_SCHEME = 'file';

/** The developer's next step whenever no usable project folder is open. */
const OPEN_PROJECT_HINT =
  'Open the project folder you want to debug in VS Code, then start a session.';

/** The fix for a dev-server URL this module refuses, mirroring the service's hint. */
const DEV_SERVER_URL_HINT =
  'Set debuggen.devServerUrl to the local address the dev server prints, for example http://localhost:<port>.';

/** The recovery for an unset dev-server URL: configure it, or let the service launch one. */
const DEV_SERVER_NOT_CONFIGURED_HINT =
  'Set debuggen.devServerUrl to the address your dev server prints, or run "Debug Generator: Launch Dev Server" to let the service start it.';

/**
 * Hostnames the probe accepts, exactly as `URL.hostname` renders them.
 *
 * The same set as the service's probe. IPv6 loopback appears only in its
 * bracketed form because that is the only form a URL can carry it in
 * (`http://[::1]:<port>`); `0.0.0.0` is absent on purpose, since it names every
 * interface rather than this machine.
 */
const LOOPBACK_HOSTNAMES: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** A URL that already names its scheme (`http://…`, `https://…`, `ftp://…`). */
const EXPLICIT_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;

/** A Windows path rooted at a drive, after separators were converted: `C:/…`. */
const WINDOWS_DRIVE_ROOTED = /^[A-Za-z]:\//;

/** A normalised Windows drive path: `C:` (the drive root) or `C:/…`. */
const NORMALIZED_WINDOWS_DRIVE = /^[A-Za-z]:(?:\/|$)/;

/** A bare drive root after normalisation, which strips the trailing separator. */
const WINDOWS_DRIVE_ROOT = /^[A-Za-z]:$/;

/** Transport error codes that are safe to surface verbatim. */
const TRANSPORT_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;

/** Developer-facing wording for the transport failures a probe commonly meets. */
const TRANSPORT_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  ECONNREFUSED: 'Connection refused: nothing is listening at this address.',
  ECONNRESET: 'The connection was reset before an HTTP response arrived.',
  EHOSTUNREACH: 'The host is unreachable.',
  ENETUNREACH: 'The network is unreachable.',
  ENOTFOUND: 'The host name could not be resolved.',
  EAI_AGAIN: 'The host name could not be resolved.',
  ETIMEDOUT: 'The connection attempt timed out.',
  UND_ERR_CONNECT_TIMEOUT: 'The connection attempt timed out.',
  UND_ERR_SOCKET: 'The socket closed before an HTTP response arrived.',
  ABORTED: 'The probe was aborted before an HTTP response arrived.',
});

// ---------------------------------------------------------------------------
// Project-root resolution
// ---------------------------------------------------------------------------

/**
 * One workspace folder this extension can act on.
 *
 * Only `file`-scheme folders qualify: the service's indexer, the instrumentation
 * patcher and the dev-server launcher all need a real filesystem path, which a
 * virtual or remote-scheme folder (`vscode-vfs:`, `untitled:`, …) does not have.
 */
export interface ProjectRootInfo {
  /**
   * The folder's absolute path in the product's one spelling: POSIX separators,
   * lexically normalised, no trailing separator — byte-identical to what the
   * service stores and compares (AAP §0.5.6). On Windows it keeps its drive
   * prefix (`c:/Users/dev/project`).
   */
  readonly projectRoot: string;

  /** The folder's display name in the workspace, falling back to its base name. */
  readonly name: string;

  /** The workspace folder's URI, the configuration scope of resource settings. */
  readonly folderUri: vscode.Uri;

  /** The folder's position in `workspace.workspaceFolders`. */
  readonly folderIndex: number;
}

/** Which rule of the selection policy chose the project root. */
export type ProjectRootSelection = 'active-editor' | 'first-folder';

/** The project root {@link resolveProjectRoot} selected, and why. */
export interface ResolvedProjectRoot extends ProjectRootInfo {
  /** The rule of the selection policy that chose this folder. */
  readonly selectedBy: ProjectRootSelection;
}

/** Options of {@link resolveProjectRoot}. All optional. */
export interface ResolveProjectRootOptions {
  /**
   * Whether the folder of the active text editor takes precedence over the
   * first folder. Default `true`; `false` applies rule 2 of the policy alone,
   * which gives a caller a selection that does not move with editor focus.
   */
  readonly preferActiveEditor?: boolean | undefined;

  /** Where the one `debug` record per resolution goes. Default: no-op. */
  readonly logger?: Logger | undefined;
}

/**
 * Normalises a folder path into the project-root spelling the service uses.
 *
 * Mirrors `normalizeRoot` in `apps/local-service/src/server/auth.ts`, so the
 * root this extension announces in `client.hello` and the root it sends in a
 * request body compare equal under the service's `requireProjectScope`:
 * separators become `/` ({@link toPosix}), then the path is normalised
 * lexically ({@link normalizePosix}) — exactly once, and only after it has been
 * validated. Refused, with `PROJECT_NOT_FOUND`:
 *
 * - an empty path or one containing a NUL byte;
 * - a network share (`\\server\share`, `//server/share`), which normalisation
 *   would otherwise collapse silently into a local root;
 * - a relative or drive-relative path (`src`, `C:dir`);
 * - a filesystem or drive root (`/`, `C:\`): an editor credential scoped to it
 *   would cover every project on the machine, and it is never one project.
 *
 * Pure string logic: no filesystem access, no `node:path`, no symlink
 * resolution. The result is absolute and never ends with a separator.
 *
 * @param rawPath A workspace folder's `fsPath`, or any path a caller holds.
 * @returns The normalised root, or a `PROJECT_NOT_FOUND` refusal.
 *
 * @example
 * ```ts
 * normalizeProjectRootPath('/home/dev/shop/'); // ok('/home/dev/shop')
 * normalizeProjectRootPath('C:\\work\\shop'); // ok('C:/work/shop')
 * normalizeProjectRootPath('\\\\server\\share'); // err(PROJECT_NOT_FOUND)
 * ```
 */
export function normalizeProjectRootPath(rawPath: string): Result<string, DebuggenError> {
  if (typeof rawPath !== 'string' || rawPath.length === 0 || rawPath.includes('\u0000')) {
    return projectRootRefusal(
      'unsupported-path',
      'The workspace folder does not name a filesystem path this product can use.',
    );
  }

  const posix = toPosix(rawPath);
  if (posix.startsWith('//')) {
    return projectRootRefusal(
      'network-share',
      'Workspace folders on a network share cannot be debugged; the project must be on a local disk.',
    );
  }

  if (!isAbsolutePosix(posix) && !WINDOWS_DRIVE_ROOTED.test(posix)) {
    return projectRootRefusal(
      'relative-path',
      'The workspace folder path is not absolute, so it cannot be a project root.',
    );
  }

  const normalized = normalizePosix(posix);
  if (!isAbsolutePosix(normalized) && !NORMALIZED_WINDOWS_DRIVE.test(normalized)) {
    // A drive path whose '..' segments consumed the drive itself ('C:/..').
    return projectRootRefusal(
      'relative-path',
      'The workspace folder path is not absolute, so it cannot be a project root.',
    );
  }

  if (normalized === '/' || WINDOWS_DRIVE_ROOT.test(normalized)) {
    return projectRootRefusal(
      'filesystem-root',
      'A filesystem root cannot be debugged as a single project.',
    );
  }

  return ok(normalized);
}

/**
 * Every workspace folder this extension can act on, in workspace order.
 *
 * A folder qualifies when its URI has the `file` scheme and its path passes
 * {@link normalizeProjectRootPath}; everything else is skipped silently here
 * (it is {@link resolveProjectRoot} that explains an empty result). Two folders
 * that normalise to the same root appear once. The protocol announces a single
 * root per connection, so a multi-root workspace is surfaced through this list
 * and a re-resolve-and-reconnect in `client.ts`, never as a plural field.
 *
 * @returns A frozen array; empty when no folder qualifies or none is open.
 */
export function listProjectRoots(): readonly ProjectRootInfo[] {
  try {
    return eligibleRoots(readWorkspaceFolders());
  } catch {
    // The workspace API does not throw in practice; if it ever does, "nothing
    // eligible" is the fail-closed answer and resolveProjectRoot explains it.
    return Object.freeze([]);
  }
}

/**
 * Resolves the one project root this extension acts on.
 *
 * **Selection policy** — the root is the scope of the editor credential the
 * service honours (AAP §0.5.6), so it is chosen by exactly these rules:
 *
 * 1. If the active text editor shows a `file`-scheme document inside a
 *    `file`-scheme workspace folder, **that folder wins**: the developer is
 *    working in it, which is the best available signal of which project a
 *    question is about.
 * 2. Otherwise the **first** eligible (`file`-scheme) entry of
 *    `workspace.workspaceFolders` wins — the stable default of a single-folder
 *    workspace and the conventional primary folder of a multi-root one.
 * 3. If no folder is open, or none is eligible, the answer is a
 *    `PROJECT_NOT_FOUND` error whose hint tells the developer what to open.
 *
 * The active editor is preferred over the first folder rather than the other
 * way round because, in a multi-root workspace, the folder the developer is
 * editing is the one whose dev server and source they are debugging; a caller
 * that needs a selection independent of editor focus passes
 * `preferActiveEditor: false`.
 *
 * Nothing is cached: every call reads the workspace afresh, so the caller that
 * reacts to `workspace.onDidChangeWorkspaceFolders` (`src/extension.ts`) simply
 * calls this again. Never throws; an unexpected failure of the workspace API is
 * returned as an `INTERNAL` error.
 *
 * @param options Whether to honour the active editor, and a logger.
 * @returns The selected root and the rule that chose it, or a typed refusal.
 *
 * @example
 * ```ts
 * const root = resolveProjectRoot();
 * if (isOk(root)) {
 *   await client.createSession({ projectRoot: root.value.projectRoot, question });
 * }
 * ```
 */
export function resolveProjectRoot(
  options: ResolveProjectRootOptions = {},
): Result<ResolvedProjectRoot, DebuggenError> {
  const logger = options.logger ?? noopLogger;

  try {
    const folders = readWorkspaceFolders();
    if (folders.length === 0) {
      return err(
        new DebuggenError('PROJECT_NOT_FOUND', 'No folder is open in this VS Code window.', {
          hint: OPEN_PROJECT_HINT,
          details: { reason: 'no-workspace-folder' },
        }),
      );
    }

    if (options.preferActiveEditor !== false) {
      const editorFolder = folderOfActiveEditor();
      if (editorFolder !== undefined) {
        const info = toProjectRootInfo(editorFolder);
        if (isOk(info)) {
          return selected(info.value, 'active-editor', logger);
        }
      }
    }

    const first = eligibleRoots(folders)[0];
    if (first !== undefined) {
      return selected(first, 'first-folder', logger);
    }

    const schemes = [...new Set(folders.map((folder) => folder.uri.scheme))].sort();
    logSafely(() => {
      logger.debug('No workspace folder can be a project root', {
        folderCount: folders.length,
        schemes,
      });
    });
    return err(
      new DebuggenError(
        'PROJECT_NOT_FOUND',
        'None of the open folders is a folder on this machine’s filesystem that can be debugged.',
        {
          hint: `Virtual and remote-scheme folders cannot be instrumented. ${OPEN_PROJECT_HINT}`,
          details: { reason: 'no-eligible-folder', folderCount: folders.length, schemes },
        },
      ),
    );
  } catch (caught) {
    return err(DebuggenError.from(caught, 'INTERNAL'));
  }
}

/**
 * Whether an absolute path lies inside a project root (or is the root itself).
 *
 * The containment predicate for callers that must respect the editor
 * credential's scope (AAP §0.5.6). Built on `isWithin` from `@debuggen/shared`,
 * so `/proj-evil` is **not** inside `/proj`, and fail-closed on every input it
 * cannot vouch for: a root {@link normalizeProjectRootPath} refuses, a relative
 * or drive-relative candidate, a network-share candidate and a NUL byte all
 * answer `false`.
 *
 * String-level only, like `isWithin`: a symlink inside the root whose target is
 * outside it passes. A caller about to open a path it did not construct itself
 * must canonicalise it first (`src/uri-handler.ts` does so with `fs.realpath`).
 * The comparison is case-sensitive, so a differently cased drive letter answers
 * `false` — the fail-closed direction.
 *
 * @param projectRoot The project root, typically {@link ProjectRootInfo.projectRoot}.
 * @param absPath The absolute path being tested, POSIX or Windows.
 * @returns `true` only when the candidate is the root or beneath it.
 */
export function isPathInsideProject(projectRoot: string, absPath: string): boolean {
  const root = normalizeProjectRootPath(projectRoot);
  if (isErr(root)) {
    return false;
  }

  if (typeof absPath !== 'string' || absPath.length === 0 || absPath.includes('\u0000')) {
    return false;
  }

  const candidate = toPosix(absPath);
  if (candidate.startsWith('//')) {
    return false;
  }
  if (!isAbsolutePosix(candidate) && !WINDOWS_DRIVE_ROOTED.test(candidate)) {
    return false;
  }

  return isWithin(root.value, candidate);
}

/** The open workspace folders, or an empty list when none is open. */
function readWorkspaceFolders(): readonly vscode.WorkspaceFolder[] {
  return vscode.workspace.workspaceFolders ?? [];
}

/**
 * The `file`-scheme workspace folder containing the active editor's document,
 * when there is one. A document of another scheme (an untitled buffer, an
 * output channel, a virtual file) never selects a folder.
 */
function folderOfActiveEditor(): vscode.WorkspaceFolder | undefined {
  const documentUri = vscode.window.activeTextEditor?.document.uri;
  if (documentUri === undefined || documentUri.scheme !== FILE_SCHEME) {
    return undefined;
  }

  const folder = vscode.workspace.getWorkspaceFolder(documentUri);
  return folder !== undefined && folder.uri.scheme === FILE_SCHEME ? folder : undefined;
}

/** The eligible roots among `folders`, deduplicated by normalised root, frozen. */
function eligibleRoots(folders: readonly vscode.WorkspaceFolder[]): readonly ProjectRootInfo[] {
  const seen = new Set<string>();
  const roots: ProjectRootInfo[] = [];

  for (const folder of folders) {
    const info = toProjectRootInfo(folder);
    if (isErr(info) || seen.has(info.value.projectRoot)) {
      continue;
    }
    seen.add(info.value.projectRoot);
    roots.push(info.value);
  }

  return Object.freeze(roots);
}

/** One workspace folder as a {@link ProjectRootInfo}, or the reason it is not one. */
function toProjectRootInfo(folder: vscode.WorkspaceFolder): Result<ProjectRootInfo, DebuggenError> {
  if (folder.uri.scheme !== FILE_SCHEME) {
    return err(
      new DebuggenError(
        'PROJECT_NOT_FOUND',
        'The workspace folder is not on this machine’s filesystem, so it cannot be debugged.',
        {
          hint: OPEN_PROJECT_HINT,
          details: { reason: 'non-file-scheme', scheme: folder.uri.scheme },
        },
      ),
    );
  }

  const root = normalizeProjectRootPath(folder.uri.fsPath);
  if (isErr(root)) {
    return root;
  }

  const displayName = folder.name.trim();
  return ok(
    Object.freeze({
      projectRoot: root.value,
      name: displayName.length > 0 ? displayName : basenamePosix(root.value),
      folderUri: folder.uri,
      folderIndex: folder.index,
    }),
  );
}

/** The success value of {@link resolveProjectRoot}, logged once. */
function selected(
  info: ProjectRootInfo,
  selectedBy: ProjectRootSelection,
  logger: Logger,
): Result<ResolvedProjectRoot, DebuggenError> {
  // The folder's display name and index identify it well enough for a log;
  // the absolute path is left out, as it names the developer's home directory.
  logSafely(() => {
    logger.debug('Resolved the project root', {
      selectedBy,
      folder: info.name,
      folderIndex: info.folderIndex,
    });
  });
  return ok(Object.freeze({ ...info, selectedBy }));
}

/** A `PROJECT_NOT_FOUND` refusal of a folder path; the path itself is never echoed. */
function projectRootRefusal(reason: string, message: string): Result<never, DebuggenError> {
  return err(
    new DebuggenError('PROJECT_NOT_FOUND', message, {
      hint: OPEN_PROJECT_HINT,
      details: { reason },
    }),
  );
}

// ---------------------------------------------------------------------------
// Dev-server probing
// ---------------------------------------------------------------------------

/** The request options {@link probeDevServer} passes to a {@link FetchLike}. */
export interface FetchLikeInit {
  readonly method?: string;
  readonly redirect?: 'manual' | 'follow';
  readonly signal?: AbortSignal;
}

/**
 * The slice of a fetch response a probe reads. `body` is optional so a test
 * double can return `{ status }` alone; when present it is cancelled unread.
 */
export interface FetchLikeResponse {
  readonly status: number;
  readonly body?: { cancel(reason?: unknown): Promise<void> } | null | undefined;
}

/**
 * The narrow slice of `fetch` a probe calls — structural, so neither a DOM
 * `Request`/`Response` type (the host project has no DOM lib) nor a network is
 * needed to substitute it. Defaults to Node's global `fetch`.
 */
export type FetchLike = (input: string, init?: FetchLikeInit) => Promise<FetchLikeResponse>;

/** Where the probed URL came from. */
export type DevServerUrlSource = 'argument' | 'setting';

/** Why a probe got no HTTP response. Never carries a raw exception message. */
export interface DevServerProbeFailure {
  /**
   * `'TIMEOUT'`, `'ABORTED'`, an errno-style code such as `'ECONNREFUSED'`, or
   * `'NETWORK_ERROR'` when the failure carried no recognisable code.
   */
  readonly code: string;

  /** A fixed developer-facing sentence; never echoes the URL or the error. */
  readonly message: string;
}

/**
 * The outcome of one dev-server probe.
 *
 * `running` is `true` for **any** HTTP status — a dev server answering 404 or
 * 500 is still running — and `false` only for a transport failure or the
 * timeout, which {@link DevServerProbe.failure} then explains. This matches the
 * service's own probe, so the editor and the service never disagree about
 * whether an address is live.
 */
export interface DevServerProbe {
  /**
   * The probed URL as {@link normalizeDevServerUrl} renders it: origin and
   * path only, no query, no fragment, no trailing slash (AAP §0.5.2).
   */
  readonly url: string;

  /** Whether any HTTP response arrived within the timeout. */
  readonly running: boolean;

  /** The HTTP status, when a response arrived. */
  readonly status?: number;

  /** Wall time of the probe from the injected clock; finite and `>= 0`. */
  readonly durationMs: number;

  /** Why no response arrived, when `running` is `false`. */
  readonly failure?: DevServerProbeFailure;

  /** Whether the URL was passed in or read from `debuggen.devServerUrl`. */
  readonly source: DevServerUrlSource;
}

/** Options of {@link probeDevServer}. All optional. */
export interface ProbeDevServerOptions {
  /**
   * The URL to probe. When absent, `debuggen.devServerUrl` is read — lazily,
   * on this call — in the configuration scope {@link scope} names. A value
   * given here is normalised exactly like the setting.
   */
  readonly url?: string | undefined;

  /**
   * The configuration scope of the resource-scoped `debuggen.devServerUrl`
   * setting, normally {@link ProjectRootInfo.folderUri}. When absent, the
   * folder {@link resolveProjectRoot} selects is used, or the window scope when
   * no folder can be resolved.
   */
  readonly scope?: vscode.Uri | undefined;

  /**
   * Probe timeout in milliseconds. Default
   * {@link DEFAULT_DEV_SERVER_PROBE_TIMEOUT_MS}; a non-positive or non-finite
   * value falls back to it, a larger one is clamped to
   * {@link MAX_DEV_SERVER_PROBE_TIMEOUT_MS}.
   */
  readonly timeoutMs?: number | undefined;

  /** HTTP client for the probe. Default: the global `fetch` (Node 24). */
  readonly fetch?: FetchLike | undefined;

  /** Clock for the probe's duration, in milliseconds. Default: `nowEpochMs`. */
  readonly now?: (() => number) | undefined;

  /** Where the one `debug` record per probe goes. Default: no-op. */
  readonly logger?: Logger | undefined;
}

/**
 * Normalises a dev-server URL a developer configured or typed, and refuses one
 * the product will not probe.
 *
 * In order:
 *
 * 1. Trims surrounding whitespace; an empty value is refused.
 * 2. Adds `http://` when no scheme is given, so `localhost:3000` (which a URL
 *    parser would otherwise read as scheme `localhost:`) means what the
 *    developer meant, and `//localhost:3000` becomes `http://localhost:3000`.
 * 3. Parses the result as an absolute URL.
 * 4. Requires `http:` or `https:`.
 * 5. Refuses embedded credentials: a URL with a user name or password before
 *    its host (`user@host` or `user:password@host`) is never stored or probed.
 * 6. Requires a loopback host: `localhost`, `127.0.0.1` or `[::1]` — the same
 *    set the service's probe accepts. `0.0.0.0` and every other host are
 *    refused; this product only ever talks to a dev server on this machine.
 * 7. Renders origin and path only, with trailing slashes stripped: the query
 *    and fragment are dropped rather than kept, so they are never stored,
 *    probed or logged (AAP §0.5.2). Scheme and host are lower-cased and a
 *    default port disappears, as `URL.origin` renders them.
 *
 * Every refusal is `CONFIG_INVALID` with a `details.reason` of
 * `'not-a-string'`, `'empty'`, `'malformed-url'`, `'unsupported-protocol'`,
 * `'credentials-in-url'` or `'non-loopback-host'`, and a hint naming the
 * setting. Refusal messages never echo the value. Pure: no I/O, no settings
 * read, so it is table-testable.
 *
 * @param raw The value to normalise — typically the setting, which the editor
 * types as `unknown` until it is read.
 * @returns The normalised URL, or the refusal.
 *
 * @example
 * ```ts
 * normalizeDevServerUrl('  localhost:3000/ '); // ok('http://localhost:3000')
 * normalizeDevServerUrl('http://127.0.0.1:5173/app/?q=1'); // ok('http://127.0.0.1:5173/app')
 * normalizeDevServerUrl('http://example.com'); // err(CONFIG_INVALID, reason 'non-loopback-host')
 * ```
 */
export function normalizeDevServerUrl(raw: unknown): Result<string, DebuggenError> {
  if (typeof raw !== 'string') {
    return devServerUrlRefusal('not-a-string', 'The dev-server URL must be text.');
  }

  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return devServerUrlRefusal('empty', 'The dev-server URL is empty.');
  }

  const withScheme = EXPLICIT_SCHEME.test(trimmed)
    ? trimmed
    : trimmed.startsWith('//')
      ? `http:${trimmed}`
      : `http://${trimmed}`;

  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    return devServerUrlRefusal('malformed-url', 'The dev-server URL is not a valid URL.');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return devServerUrlRefusal(
      'unsupported-protocol',
      'The dev-server URL must use http: or https:; no other scheme is probed.',
    );
  }

  if (parsed.username !== '' || parsed.password !== '') {
    return devServerUrlRefusal(
      'credentials-in-url',
      'The dev-server URL must not embed credentials.',
    );
  }

  if (!LOOPBACK_HOSTNAMES.has(parsed.hostname)) {
    return devServerUrlRefusal(
      'non-loopback-host',
      'Only a loopback dev server (localhost, 127.0.0.1 or [::1]) is probed; this URL names another host.',
    );
  }

  return ok(`${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`);
}

/**
 * Reads the `debuggen.devServerUrl` setting, lazily, and normalises it.
 *
 * The setting is resource-scoped (`apps/vscode-extension/package.json`), so a
 * multi-root workspace may configure one URL per folder; pass the folder's URI
 * as `scope` to read that folder's value. The value is read on every call —
 * never cached — so a settings change takes effect without a reload.
 *
 * @param scope The configuration scope, normally a workspace folder's URI.
 * @returns `ok(undefined)` when the setting is unset or blank (the documented
 * "let the service detect or launch it" state), `ok(url)` for a usable value,
 * or the {@link normalizeDevServerUrl} refusal for an unusable one.
 */
export function readDevServerUrlSetting(
  scope?: vscode.Uri,
): Result<string | undefined, DebuggenError> {
  let raw: unknown;
  try {
    raw = vscode.workspace
      .getConfiguration(CONFIGURATION_SECTION, scope)
      .get<unknown>(DEV_SERVER_URL_KEY);
  } catch (caught) {
    return err(
      new DebuggenError('CONFIG_INVALID', 'The debuggen.devServerUrl setting could not be read.', {
        hint: DEV_SERVER_URL_HINT,
        details: { reason: 'unreadable-setting' },
        cause: caught,
      }),
    );
  }

  if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim().length === 0)) {
    return ok(undefined);
  }

  return normalizeDevServerUrl(raw);
}

/**
 * Probes the target project's dev server with one bounded `GET`.
 *
 * A liveness check only: it answers "does anything answer HTTP at this
 * address?", and it is the service — not this probe — that decides whether a
 * running dev server carries the telemetry preload.
 *
 * **Result contract**, so a caller knows exactly what to branch on:
 *
 * - **`Err` means misuse or absence of a URL, and no request was made.** A URL
 *   {@link normalizeDevServerUrl} refuses — malformed, not `http:`/`https:`,
 *   with credentials, or on a non-loopback host — is `CONFIG_INVALID`, and the
 *   injected `fetch` is provably never called for it: the only call site is
 *   after the normalisation gate has returned `ok`. An unset
 *   `debuggen.devServerUrl` (when no `url` is passed) is
 *   `DEV_SERVER_UNAVAILABLE`, with a hint to configure the setting or let the
 *   service launch the dev server (`POST /dev-server/launch`, issued by
 *   `client.ts`).
 * - **`Ok` is an answer.** Any HTTP status — 404 and 500 included — is
 *   `running: true` with its `status`; a refused connection, a reset or the
 *   timeout is `running: false` with a coded {@link DevServerProbe.failure}.
 *   A transport failure is data, never an error and never a throw.
 *
 * The request is a plain `GET` of the normalised URL (origin and path; no
 * application-specific endpoint), redirects are not followed, the response
 * body is cancelled unread, and a request that never settles is abandoned when
 * the timeout fires — the timer is always cleared, so nothing outlives the
 * probe. The promise never rejects: an unexpected failure is returned as an
 * `INTERNAL` error. Logging carries the origin-and-path URL only.
 *
 * @param options The URL (or the setting's scope), timeout, `fetch`, clock and logger.
 * @returns The probe outcome, or a typed refusal made before any request.
 *
 * @example
 * ```ts
 * const probe = await probeDevServer({ scope: root.folderUri });
 * if (isOk(probe) && probe.value.running) {
 *   // A dev server already answers at probe.value.url.
 * }
 * ```
 */
export async function probeDevServer(
  options: ProbeDevServerOptions = {},
): Promise<Result<DevServerProbe, DebuggenError>> {
  const logger = options.logger ?? noopLogger;

  try {
    const target = resolveProbeTarget(options);
    if (isErr(target)) {
      logSafely(() => {
        logger.debug('Dev-server probe not attempted', {
          code: target.error.code,
          reason: reasonOf(target.error),
        });
      });
      return target;
    }

    const { url, source } = target.value;
    const fetchImpl = options.fetch ?? defaultFetch;
    const now = options.now ?? nowEpochMs;
    const timeoutMs = normalizeProbeTimeout(options.timeoutMs);

    const startedAt = readClock(now);
    const outcome = await requestWithTimeout(fetchImpl, url, timeoutMs);
    const durationMs = elapsedMs(startedAt, readClock(now));

    if (outcome.kind === 'response') {
      const status = outcome.response.status;
      const probe: DevServerProbe = Number.isInteger(status)
        ? { url, running: true, status, durationMs, source }
        : { url, running: true, durationMs, source };
      logSafely(() => {
        logger.debug('Dev-server probe answered', { url, status: probe.status, durationMs });
      });
      return ok(Object.freeze(probe));
    }

    const failure: DevServerProbeFailure =
      outcome.kind === 'timeout'
        ? {
            code: 'TIMEOUT',
            message: `No HTTP response arrived within ${String(timeoutMs)} ms.`,
          }
        : describeTransportFailure(outcome.error);
    logSafely(() => {
      logger.debug('Dev-server probe got no response', {
        url,
        failureCode: failure.code,
        durationMs,
      });
    });
    return ok(
      Object.freeze({ url, running: false, durationMs, failure: Object.freeze(failure), source }),
    );
  } catch (caught) {
    return err(DebuggenError.from(caught, 'INTERNAL'));
  }
}

/** A URL cleared for probing, and where it came from. */
interface ProbeTarget {
  readonly url: string;
  readonly source: DevServerUrlSource;
}

/** How one probe request ended. */
type ProbeOutcome =
  | { readonly kind: 'response'; readonly response: FetchLikeResponse }
  | { readonly kind: 'failure'; readonly error: unknown }
  | { readonly kind: 'timeout' };

/** The default {@link FetchLike}: Node 24's global `fetch`, resolved at call time. */
const defaultFetch: FetchLike = (input, init) => fetch(input, init);

/**
 * The URL a probe may be sent to: the explicit argument when given, otherwise
 * the setting in the requested (or the resolved project's) scope — in both
 * cases only after {@link normalizeDevServerUrl} has accepted it.
 */
function resolveProbeTarget(options: ProbeDevServerOptions): Result<ProbeTarget, DebuggenError> {
  if (options.url !== undefined) {
    const normalized = normalizeDevServerUrl(options.url);
    return isErr(normalized) ? normalized : ok({ url: normalized.value, source: 'argument' });
  }

  const configured = readDevServerUrlSetting(options.scope ?? defaultConfigurationScope());
  if (isErr(configured)) {
    return configured;
  }
  if (configured.value === undefined) {
    return err(
      new DebuggenError(
        'DEV_SERVER_UNAVAILABLE',
        'No dev-server URL is configured for this workspace folder.',
        {
          hint: DEV_SERVER_NOT_CONFIGURED_HINT,
          details: { reason: 'not-configured' },
        },
      ),
    );
  }
  return ok({ url: configured.value, source: 'setting' });
}

/**
 * The configuration scope of the setting when the caller names none: the
 * folder the project-root policy selects, so the probe reads the same folder's
 * value the session will be created for; the window scope when none resolves.
 */
function defaultConfigurationScope(): vscode.Uri | undefined {
  const root = resolveProjectRoot();
  return isOk(root) ? root.value.folderUri : undefined;
}

/** An injected timeout when it is a positive finite number, clamped; the default otherwise. */
function normalizeProbeTimeout(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_DEV_SERVER_PROBE_TIMEOUT_MS;
  }
  return Math.min(value, MAX_DEV_SERVER_PROBE_TIMEOUT_MS);
}

/** Reads an injected clock, falling back to the wall clock if it throws or misbehaves. */
function readClock(now: () => number): number {
  try {
    const value = now();
    return Number.isFinite(value) ? value : nowEpochMs();
  } catch {
    return nowEpochMs();
  }
}

/** A duration that is always finite and non-negative. */
function elapsedMs(startedAt: number, endedAt: number): number {
  const duration = endedAt - startedAt;
  return Number.isFinite(duration) && duration > 0 ? duration : 0;
}

/**
 * Runs one request, racing it against an abort-backed timeout.
 *
 * The race — rather than trusting the client to honour its signal — is what
 * bounds a request that never settles. The timer is always cleared, and a
 * response that arrives after the timeout has its body released, so neither a
 * timer nor a socket outlives the probe. A client that throws synchronously
 * has failed the request: that is the answer "not running", not a crash.
 */
async function requestWithTimeout(
  fetchImpl: FetchLike,
  url: string,
  timeoutMs: number,
): Promise<ProbeOutcome> {
  const controller = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeout = new Promise<ProbeOutcome>((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      resolve({ kind: 'timeout' });
      controller.abort();
    }, timeoutMs);
  });

  let request: Promise<ProbeOutcome>;
  try {
    request = fetchImpl(url, { method: 'GET', redirect: 'manual', signal: controller.signal }).then(
      (response): ProbeOutcome => {
        releaseBody(response);
        return timedOut ? { kind: 'timeout' } : { kind: 'response', response };
      },
      (error: unknown): ProbeOutcome => ({ kind: 'failure', error }),
    );
  } catch (error) {
    request = Promise.resolve({ kind: 'failure', error });
  }

  try {
    return await Promise.race([request, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Cancels an unread response body so the connection is released promptly. */
function releaseBody(response: FetchLikeResponse): void {
  const body = response.body;
  if (body === undefined || body === null) {
    return;
  }
  try {
    body.cancel().catch(ignoreRejection);
  } catch {
    // A body that cannot be cancelled is reclaimed with the response; the
    // probe's answer — the status — is already known.
    return;
  }
}

/** Swallows a rejection whose only consequence would be an unhandled-rejection warning. */
function ignoreRejection(): undefined {
  return undefined;
}

/**
 * Classifies a failed request without echoing it: an errno-style code from the
 * error or its `cause` (undici wraps the socket error as `cause`), `ABORTED`
 * for an abort, `NETWORK_ERROR` otherwise. The message is a fixed sentence.
 */
function describeTransportFailure(error: unknown): DevServerProbeFailure {
  const code = transportCodeOf(error);
  return {
    code,
    message: TRANSPORT_MESSAGES[code] ?? 'The request failed before an HTTP response arrived.',
  };
}

/** The recognisable transport code of a caught value, or a generic one. */
function transportCodeOf(error: unknown): string {
  for (const candidate of [
    propertyOf(error, 'code'),
    propertyOf(propertyOf(error, 'cause'), 'code'),
  ]) {
    if (typeof candidate === 'string' && TRANSPORT_CODE_PATTERN.test(candidate)) {
      return candidate;
    }
  }
  return propertyOf(error, 'name') === 'AbortError' ? 'ABORTED' : 'NETWORK_ERROR';
}

/** Reads one property of a caught value without trusting its shape or its getters. */
function propertyOf(value: unknown, key: 'code' | 'cause' | 'name'): unknown {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  try {
    return (value as Readonly<Record<string, unknown>>)[key];
  } catch {
    return undefined;
  }
}

/** The `details.reason` of a refusal built in this module, for a log line. */
function reasonOf(error: DebuggenError): string | undefined {
  const reason = error.details?.['reason'];
  return typeof reason === 'string' ? reason : undefined;
}

/** A `CONFIG_INVALID` refusal of a dev-server URL; the value itself is never echoed. */
function devServerUrlRefusal(reason: string, message: string): Result<never, DebuggenError> {
  return err(
    new DebuggenError('CONFIG_INVALID', message, {
      hint: DEV_SERVER_URL_HINT,
      details: { reason },
    }),
  );
}

/** Runs a logging call so that a misbehaving logger can never break an answer. */
function logSafely(write: () => void): void {
  try {
    write();
  } catch {
    // Logging is diagnostic; its failure must not turn an answer into a throw.
  }
}
