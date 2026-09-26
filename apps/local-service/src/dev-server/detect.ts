/**
 * Dev-server detection: "is there already a usable dev server for this
 * project, and does it carry the Debug Generator telemetry preload?" — and,
 * when it does not, the **exact relaunch command** for this project and its
 * package manager.
 *
 * ## Why this module exists
 *
 * Server-side spans (the incoming request, the route handler, outgoing fetch,
 * Prisma and `pg` queries) need a tracer provider inside the dev-server
 * process. The product supplies one through a Node preload loaded with
 * `NODE_OPTIONS=--import …` (AAP §0.1.1), which is what keeps the developer's
 * source untouched for that signal (AAP §0.5.1). Before the launcher spawns
 * anything, and before readiness decides whether server signals can be
 * delivered, both ask this module the same question and get the same answer.
 *
 * ## Guarantees
 *
 * - **Read-only.** It reads exactly one file — `<projectRoot>/package.json`,
 *   through a no-follow reader — and performs at most one loopback HTTP probe.
 *   It never writes anywhere, never reads `.env*`, never spawns a process.
 *   Package-manager detection is reused from `@debuggen/code-analysis`, which
 *   inspects lockfiles by `stat` only and never through this module's reader.
 * - **Loopback only.** {@link probeDevServer} refuses any URL whose host is not
 *   `127.0.0.1`, `localhost` or `[::1]` *before* any request is made, so the
 *   service can never be turned into an outbound request engine for a URL that
 *   arrived over HTTP (AAP §0.5.6).
 * - **Preload presence is evidence, not inference.** The preload opens a
 *   `server-agent` WebSocket for its project (`client.hello { client:
 *   'server-agent', projectRoot }`), so "a `server-agent` connection exists for
 *   this project" is exactly "the preload is loaded and active". That fact
 *   arrives through the injected {@link ServerAgentPresence} port and nowhere
 *   else: preload presence is never inferred from a process table, a command
 *   line or an HTTP header.
 * - **Server identity is evidence too.** An HTTP answer at the session URL
 *   proves only that *something* listens there. The answering server counts as
 *   this project's dev server only when the response carries the framework's
 *   own signature — for Next.js, `X-Powered-By: Next.js` or the
 *   `next-router-state-tree` token in `Vary`, which `next dev` sends on every
 *   response, its 404 and 500 pages included. A connected `server-agent` does
 *   not identify the answer: presence is known per *project*, not per port, so
 *   an agent whose dev server listens at another address says nothing about
 *   whatever holds this one. Any unsigned answer is reported as
 *   {@link DevServerDetection.occupied} — another process holding the address,
 *   which a caller must neither reuse nor launch over, so `canLaunch` is
 *   `false` — whatever the registry says. Header values are read only to match
 *   that signature: none is ever stored, returned or logged.
 * - **Degradation is data.** {@link detectDevServer} never throws and never
 *   returns an error: every partial failure becomes a `notes` entry, because a
 *   detection failure must not fail the session — capture proceeds with the
 *   signals that are available (AAP §0.5.5).
 * - **No credentials.** The relaunch command names `DEBUGGEN_TOKEN` only as a
 *   shell reference (`"$DEBUGGEN_TOKEN"`); a {@link DevServerDetection} never
 *   carries a token, an `Authorization` value or any environment value, and
 *   nothing here logs a URL query value (AAP §0.5.2).
 * - **Framework-generic.** Dev-script selection matches a command's binary and
 *   subcommand shape, never a project-specific script or path, so detection
 *   works for any Next.js project (acceptance test 4, AAP §0.8.4).
 *
 * ## The relaunch command
 *
 * The command mirrors the environment the launcher injects into a child it
 * spawns — `NODE_OPTIONS` *appended* with `--import <preload file URL>`, plus
 * `DEBUGGEN_INGEST_URL` (the full ingest endpoint, whose origin the preload
 * also uses for its control socket), `DEBUGGEN_PROJECT_ROOT` and
 * `DEBUGGEN_TOKEN` — as one paste-ready POSIX-shell line. Values the caller
 * supplies (the resolved preload path, the service's host and port) are
 * rendered concretely; values it does not are rendered as shell references
 * (`"$DEBUGGEN_PRELOAD_URL"`, `"$DEBUGGEN_INGEST_URL"`) the developer exports
 * first, and unknown command parts as `<package-manager>` / `<dev-script>`
 * placeholders that deliberately refuse to run until filled in. The
 * developer-facing hint always leads with the token-free route — the editor's
 * "Debug Generator: Launch Dev Server" command, which mints the credential
 * itself — and offers the manual line as the fallback.
 *
 * Every relaunch hint and every preload-gap reason this module composes is
 * registered with `../sessions/progress.ts`'s `authorProductText` as it is
 * composed, so the failure surfaces that show only product-authored text
 * (CWE-209) can still show this exact command. The registry is in-memory and
 * bounded; nothing is written anywhere.
 *
 * @example
 * ```ts
 * const detection = await detectDevServer(
 *   { projectRoot: '/home/dev/storefront', devServerUrl: 'http://localhost:3000' },
 *   { config, logger, serverAgents: clients, preloadPath },
 * );
 * if (!detection.preloadAttached) {
 *   // e.g. an UnavailableSignal hint, or a launch refusal's hint
 *   report(detection.relaunchHint);
 * }
 * ```
 *
 * @module
 */

import { Buffer } from 'node:buffer';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  PACKAGE_MANAGERS,
  createProjectProbe,
  detectPackageManager,
  findWorkspaceRoot,
  readTargetManifest as readCodeAnalysisManifest,
  type ProjectProbe,
  type ProjectSummary,
  type TargetManifest as CodeAnalysisManifest,
  type WorkspacePackageManagerFallback,
} from '@debuggen/code-analysis';
import {
  BROWSER_CAPTURE_SIGNALS,
  READINESS_HINT_MAX_LENGTH,
  SERVER_CAPTURE_SIGNALS,
  type CaptureSignal,
  type UnavailableSignal,
} from '@debuggen/instrumentation';
import { buildPath } from '@debuggen/protocol';
import {
  DebuggenError,
  assertNever,
  err,
  isErr,
  isWithin,
  noopLogger,
  nowEpochMs,
  ok,
  toPosix,
  type Logger,
  type Result,
} from '@debuggen/shared';
import { readFileNoFollow } from '@debuggen/shared/node';

import type { ServiceConfig } from '../config.js';
import { describeException, subsystemLogger } from '../logging.js';
import { authorProductText } from '../sessions/progress.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** The logger binding every line from this module carries (`subsystem`). */
const LOG_SUBSYSTEM = 'dev-server';

/**
 * How long {@link probeDevServer} waits for any HTTP response, in milliseconds.
 *
 * A local dev server answers its first request within tens of milliseconds
 * once it is listening; 1.5 s tolerates a busy first compile without making a
 * "not running" answer feel like a hang in the editor.
 */
export const DEFAULT_PROBE_TIMEOUT_MS = 1500;

/** Upper bound for an injected probe timeout; larger values are clamped. */
export const MAX_PROBE_TIMEOUT_MS = 60_000;

/**
 * Largest `package.json` {@link readTargetManifest} will parse, in bytes.
 *
 * Real manifests are a few kilobytes; the cap bounds memory and parse time for
 * a file this service did not write and must not trust.
 */
export const MAX_MANIFEST_BYTES = 1_048_576;

/** The one project file this module reads. */
const MANIFEST_FILE_NAME = 'package.json';

/**
 * The editor command that relaunches a dev server with the preload and a
 * freshly minted ingest credential — the palette label of the VS Code command
 * `debuggen.launchDevServer` (category "Debug Generator", title "Launch Dev
 * Server"). The hint leads with it because it needs no token in the terminal.
 */
export const LAUNCH_DEV_SERVER_COMMAND_TITLE = 'Debug Generator: Launch Dev Server';

/**
 * The environment variables a preloaded dev server needs — the same four the
 * launcher injects into a child it spawns (its `PRELOAD_ENV_KEYS`) and that
 * `@debuggen/telemetry`'s preload reads. Stated here rather than imported
 * because the launcher depends on this module, never the reverse.
 */
const PRELOAD_ENV = Object.freeze({
  nodeOptions: 'NODE_OPTIONS',
  ingestUrl: 'DEBUGGEN_INGEST_URL',
  projectRoot: 'DEBUGGEN_PROJECT_ROOT',
  token: 'DEBUGGEN_TOKEN',
} as const);

/**
 * What the relaunch command renders for a value it does not know.
 *
 * - The three `$…` entries are shell references, so the line stays paste-ready
 *   once the developer exports them. `$DEBUGGEN_TOKEN` is **always** rendered
 *   this way: the token is a capability and is never printed (AAP §0.5.6).
 * - The two `<…>` entries stand for command parts only the developer can
 *   choose; a shell refuses to run them unfilled, which is the point — a
 *   guessed package-manager binary would be an invented command.
 */
export const RELAUNCH_PLACEHOLDERS = Object.freeze({
  preloadUrl: '$DEBUGGEN_PRELOAD_URL',
  ingestUrl: `$${PRELOAD_ENV.ingestUrl}`,
  token: `$${PRELOAD_ENV.token}`,
  packageManager: '<package-manager>',
  devScript: '<dev-script>',
} as const);

/** Every value {@link DevServerPreloadReason} can take, in matrix order. */
export const DEV_SERVER_PRELOAD_REASONS = Object.freeze([
  'server-agent-connected',
  'no-server-agent-connection',
  'not-running',
  'unknown',
] as const);

/**
 * Every framework whose dev server {@link probeDevServer} can recognise from
 * its own response signature — the value of
 * {@link DevServerProbeResult.framework}.
 */
export const DEV_SERVER_FRAMEWORKS = Object.freeze(['next'] as const);

/**
 * Every value {@link DevServerIdentityEvidence} can take: the framework's
 * response signature, the only evidence that ties an answer to the address it
 * came from. A `server-agent` connection is not among them — the registry
 * knows a project has one, not which port that agent's server holds.
 */
export const DEV_SERVER_IDENTITY_EVIDENCE = Object.freeze(['framework-signature'] as const);

/**
 * The response signature each {@link DEV_SERVER_FRAMEWORKS} member's dev
 * server sends, matched case-insensitively:
 *
 * - `poweredBy` — a substring of the `X-Powered-By` value (`next dev` sends
 *   `Next.js` on pages and on its 404 page);
 * - `varyToken` — one token of the comma-separated `Vary` list (`next dev`
 *   lists `rsc, next-router-state-tree, next-router-prefetch, …` on every
 *   response, route handlers and 500s included, so an app that disables
 *   `X-Powered-By` is still recognised).
 *
 * Only these fixed markers are compared; the header values themselves never
 * leave {@link frameworkOf}.
 */
const FRAMEWORK_RESPONSE_SIGNATURES: Readonly<
  Record<DevServerFramework, { readonly poweredBy: string; readonly varyToken: string }>
> = Object.freeze({
  next: Object.freeze({ poweredBy: 'next.js', varyToken: 'next-router-state-tree' }),
});

/** Every value {@link DevServerPackageManagerSource} can take, by precedence. */
export const PACKAGE_MANAGER_SOURCES = Object.freeze([
  'project-summary',
  'manifest-field',
  'code-analysis',
  'unknown',
] as const);

/**
 * The capture signals only the dev-server preload can supply: the server
 * signal set minus any signal the browser agent can also deliver (`fetch` is
 * both a browser request and a server-side outgoing call, and the browser half
 * does not depend on the preload).
 */
export const PRELOAD_DEPENDENT_SIGNALS: readonly CaptureSignal[] = Object.freeze(
  SERVER_CAPTURE_SIGNALS.filter(
    (signal) => !new Set<CaptureSignal>(BROWSER_CAPTURE_SIGNALS).has(signal),
  ),
);

/**
 * Framework dev commands recognised inside a script, as binary + subcommand.
 *
 * Matching the *shape* of the invocation — not a whole-command literal and not
 * a script name — is what lets `dev:web`, `cross-env … next dev` or
 * `node node_modules/next/dist/bin/next dev` all be found in any project.
 */
const FRAMEWORK_DEV_COMMANDS: readonly { readonly binary: string; readonly subcommand: string }[] =
  Object.freeze([{ binary: 'next', subcommand: 'dev' }]);

/** Hostnames {@link probeDevServer} accepts, as `URL.hostname` renders them. */
const LOOPBACK_HOSTNAMES: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '[::1]']);

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

/** Words a POSIX shell (and zsh) passes through unquoted and unexpanded. */
const SHELL_SAFE_WORD = /^[A-Za-z0-9_@%+:,./-]+$/;

/** Characters percent-encoded in a preload URL so it is inert inside `"…"`. */
const SHELL_ACTIVE_URL_CHARACTERS = /[!$`"\\]/g;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * A package manager this product can form a relaunch command for, derived
 * from the code-analysis vocabulary rather than restated: `ProjectSummary`'s
 * `packageManager` is `'pnpm' | 'npm' | 'yarn' | 'bun' | 'unknown'`, so the
 * `'unknown'` marker is already a member and every exhaustive switch over this
 * type handles it explicitly (it renders no binary).
 */
export type PackageManagerId = ProjectSummary['packageManager'];

/** A {@link PackageManagerId} with a real runner binary. */
export type KnownPackageManagerId = Exclude<PackageManagerId, 'unknown'>;

/**
 * Why a dev server is, or is not, known to carry the preload.
 *
 * - `'server-agent-connected'` — this project's dev server answered (its
 *   framework signature identified it) and a `server-agent` is connected for
 *   the project: the preload is attached.
 * - `'no-server-agent-connection'` — this project's dev server answered (its
 *   framework signature identified it) and the registry reports no
 *   `server-agent` connection: it runs without the preload.
 * - `'not-running'` — this project's dev server was not found answering at the
 *   session URL: nothing answered, no URL was known, or whatever answered
 *   carried no framework signature ({@link DevServerDetection.occupied}), even
 *   with a `server-agent` connected for the project.
 * - `'unknown'` — this project's dev server answered, but the registry was
 *   unavailable or failed, so whether it carries the preload is unknown.
 */
export type DevServerPreloadReason = (typeof DEV_SERVER_PRELOAD_REASONS)[number];

/** A framework whose dev server {@link probeDevServer} recognises by its response signature. */
export type DevServerFramework = (typeof DEV_SERVER_FRAMEWORKS)[number];

/**
 * What identified the server answering at the session URL as this project's
 * dev server.
 *
 * - `'framework-signature'` — the response carried the framework's own
 *   signature ({@link DevServerProbeResult.framework}). Whether a
 *   `server-agent` is connected decides preload presence, never identity.
 */
export type DevServerIdentityEvidence = (typeof DEV_SERVER_IDENTITY_EVIDENCE)[number];

/**
 * Which route produced {@link DevServerDetection.packageManager}.
 *
 * - `'project-summary'` — the caller's Stage 1 `ProjectSummary` or an injected
 *   {@link PackageManagerResolver} answered.
 * - `'manifest-field'` — the project's own `packageManager` field (Corepack).
 * - `'code-analysis'` — `@debuggen/code-analysis`'s lockfile and workspace-root
 *   detection answered.
 * - `'unknown'` — no route produced an answer.
 */
export type DevServerPackageManagerSource = (typeof PACKAGE_MANAGER_SOURCES)[number];

/** Why a probe got no HTTP response. Never carries a raw exception message. */
export interface DevServerProbeError {
  /**
   * `'TIMEOUT'`, `'ABORTED'`, an errno-style code such as `'ECONNREFUSED'`, or
   * `'NETWORK_ERROR'` when the failure carried no recognisable code.
   */
  readonly code: string;
  /** A fixed developer-facing sentence; never echoes the URL or the error. */
  readonly message: string;
}

/**
 * The outcome of one loopback probe.
 *
 * `reachable` is `true` for **any** HTTP status: something answering 404 or
 * 500 is still listening. Whether it is *this project's* dev server is a
 * separate fact, and `framework` is the whole of it (see
 * {@link DevServerDetection.identifiedBy}). `url` is
 * the probed origin and pathname only — the query and fragment are never
 * recorded (AAP §0.5.2) — and no header value is ever recorded.
 */
export interface DevServerProbeResult {
  readonly url: string;
  readonly reachable: boolean;
  /** The HTTP status, when a response arrived. */
  readonly status?: number;
  /**
   * The framework whose dev-server signature the response carried — for
   * `'next'`, an `X-Powered-By` value containing `Next.js` or a `Vary` list
   * with the `next-router-state-tree` token, both matched case-insensitively.
   * Present only when a response arrived and its headers matched; absent when
   * the response carried no signature or its headers could not be read.
   */
  readonly framework?: DevServerFramework;
  /** Wall time of the probe from the injected clock; finite and `>= 0`. */
  readonly durationMs: number;
  /** Why no response arrived, when `reachable` is `false`. */
  readonly error?: DevServerProbeError;
}

/**
 * The projection of a target project's `package.json` this module keeps —
 * nothing else: no dependency version maps, no file text.
 *
 * `scripts` holds string-valued entries only, as own properties (a
 * `"__proto__"` script is data, never a prototype).
 */
export interface TargetManifest {
  readonly name?: string;
  readonly scripts: Readonly<Record<string, string>>;
  /** The npm-standard `packageManager` field (e.g. `pnpm@10.4.1`), verbatim. */
  readonly packageManagerField?: string;
  /** Whether `next` appears in `dependencies` or `devDependencies`. */
  readonly hasNextDependency: boolean;
}

/** The script chosen to start the project's dev server. */
export interface DevScriptSelection {
  /** The script's key in `package.json#scripts`. */
  readonly name: string;
  /** The script's command line, as declared. */
  readonly command: string;
}

/**
 * Everything detection learned about a project's dev server.
 *
 * Plain JSON data — no class instances, no functions, no `undefined`-valued
 * keys — so it can be logged, persisted and sent as-is. It never carries a
 * token, an `Authorization` value or any environment value.
 */
export interface DevServerDetection {
  readonly projectRoot: string;
  /** The probed dev-server URL (origin and pathname), when one was known and valid. */
  readonly devServerUrl?: string;
  /**
   * Whether **this project's** dev server answered the probe: an HTTP response
   * (any status) arrived *and* it carried the framework's response signature
   * ({@link DevServerDetection.identifiedBy}). A `server-agent` connection for
   * the project never makes an unsigned answer `running`. An unsigned answer
   * is `running: false` with {@link DevServerDetection.occupied}.
   */
  readonly running: boolean;
  /**
   * What identified the answering server as this project's dev server.
   * Present exactly when `running` is `true`, and then always
   * `'framework-signature'`.
   */
  readonly identifiedBy?: DevServerIdentityEvidence;
  /**
   * `true` exactly when an HTTP response arrived at the session URL but carried
   * no framework signature, whatever the `server-agent` registry reports:
   * another process holds the address, which a caller must neither reuse nor
   * launch over (`canLaunch` is `false`). When a `server-agent` is connected
   * for the project, a note says its dev server may be listening at a
   * different address. Absent otherwise — never `false`.
   */
  readonly occupied?: true;
  /** The probe outcome, when a probe was attempted. */
  readonly probe?: DevServerProbeResult;
  /** `running` and a `server-agent` connection exists for this project. */
  readonly preloadAttached: boolean;
  readonly preloadReason: DevServerPreloadReason;
  readonly packageManager: PackageManagerId | 'unknown';
  readonly packageManagerSource: DevServerPackageManagerSource;
  /** The script that starts the dev server, when one could be selected. */
  readonly devScript?: DevScriptSelection;
  /** One paste-ready POSIX-shell line that starts an instrumented dev server. */
  readonly relaunchCommand: string;
  /**
   * One developer-facing line: the consequence, the action and
   * {@link DevServerDetection.relaunchCommand}. Fits
   * `READINESS_HINT_MAX_LENGTH`, so it can be an `UnavailableSignal.hint`
   * verbatim.
   */
  readonly relaunchHint: string;
  /**
   * Whether the launcher can start a dev server from this detection alone:
   * this project's dev server is not running, no other process holds the
   * session URL (`occupied` is absent) and a dev script was found. A launch
   * request that supplies its own `command` may still succeed when this is
   * `false`.
   */
  readonly canLaunch: boolean;
  /** Human-readable notes on every degraded step, in the order they occurred. */
  readonly notes: readonly string[];
}

/** Input of {@link detectDevServer}. */
export interface DetectDevServerInput {
  /** Absolute path of the project being debugged. */
  readonly projectRoot: string;
  /**
   * The session's dev-server URL (from the `debuggen.devServerUrl` setting or
   * a previous launch). Without one, nothing is probed and `running` is false.
   */
  readonly devServerUrl?: string | undefined;
}

/** Input of {@link formatRelaunchCommand} and the generic form of {@link buildRelaunchHint}. */
export interface RelaunchCommandInput {
  readonly projectRoot: string;
  readonly packageManager: PackageManagerId | 'unknown';
  readonly devScript?: DevScriptSelection | undefined;
  /**
   * The preload's `file:` URL. Anything that is not a `file:` URL is ignored
   * and the `"$DEBUGGEN_PRELOAD_URL"` reference is rendered instead.
   */
  readonly preloadUrl?: string | undefined;
  /**
   * The service's full ingest endpoint (`http(s)://host:port/telemetry/ingest`).
   * Anything that is not an `http:`/`https:` URL is ignored and the
   * `"$DEBUGGEN_INGEST_URL"` reference is rendered instead.
   */
  readonly ingestUrl?: string | undefined;
}

// ---------------------------------------------------------------------------
// Injected ports
// ---------------------------------------------------------------------------

/**
 * The client registry's answer to "is a `server-agent` connected for this
 * project?" — satisfied structurally by `src/server/clients.ts`, which tracks
 * connected clients by kind, project and tab. The only evidence of preload
 * presence this module accepts. It is never identity evidence: the registry
 * knows that a project has a connected agent, not which address that agent's
 * server listens on, so it cannot vouch for whatever answers at the session
 * URL ({@link DevServerIdentityEvidence}).
 */
export interface ServerAgentPresence {
  /** Whether a `server-agent` connection is online for `projectRoot`; only `true` counts. */
  hasServerAgentForProject(projectRoot: string): boolean;
}

/** The request options {@link probeDevServer} passes to {@link FetchLike}. */
export interface FetchLikeInit {
  readonly method?: string;
  readonly signal?: AbortSignal;
  readonly redirect?: 'manual' | 'follow';
}

/**
 * The slice of a fetch response a probe reads. `body` and `headers` are
 * optional so a test stub can return `{ status }` alone; a body is cancelled
 * unread, and headers (undici's `Headers` satisfies the shape) are consulted
 * only for the framework signature, by a lower-case name, defensively — a
 * `get` that throws or returns a non-string is "no signature", never a crash.
 */
export interface FetchLikeResponse {
  readonly status: number;
  readonly body?: { cancel(reason?: unknown): Promise<void> } | null | undefined;
  readonly headers?: { get(name: string): string | null } | null | undefined;
}

/** The narrow slice of `fetch` a probe calls. Defaults to Node's global `fetch`. */
export type FetchLike = (input: string, init?: FetchLikeInit) => Promise<FetchLikeResponse>;

/**
 * Reads one file by absolute path. Defaults to `readFileNoFollow` from
 * `@debuggen/shared/node`, which refuses a symlink at the final component
 * (`ELOOP`) rather than reading through it.
 */
export type ManifestReader = (absolutePath: string) => Uint8Array | string;

/** Input of a {@link PackageManagerResolver}. */
export interface PackageManagerResolverInput {
  readonly projectRoot: string;
  readonly manifest?: TargetManifest | undefined;
}

/**
 * An injected package-manager answer, typically from the pipeline's Stage 1
 * `ProjectSummary`. `undefined` or `'unknown'` means "no answer", and the next
 * route in the precedence is tried.
 */
export type PackageManagerResolver = (
  input: PackageManagerResolverInput,
) => PackageManagerId | undefined;

/**
 * Collaborators of every function here. All optional, so production wiring
 * stays terse and tests inject exactly what they need.
 */
export interface DevServerDetectDeps {
  /**
   * The service's own address, used to render `DEBUGGEN_INGEST_URL` concretely.
   * Absent → the `"$DEBUGGEN_INGEST_URL"` reference.
   */
  readonly config?: Pick<ServiceConfig, 'host' | 'port'> | undefined;
  /** Parent logger; lines are bound to `subsystem: "dev-server"`. Default: no-op. */
  readonly logger?: Logger | undefined;
  /**
   * Preload evidence only; identity always comes from the framework signature.
   * Absent → a running server's preload state is `'unknown'`.
   */
  readonly serverAgents?: ServerAgentPresence | undefined;
  /** HTTP client for the probe. Default: the global `fetch`. */
  readonly fetchImpl?: FetchLike | undefined;
  /** Manifest reader. Default: `readFileNoFollow`. */
  readonly readManifest?: ManifestReader | undefined;
  /** Highest-precedence package-manager answer (reported as `'project-summary'`). */
  readonly resolvePackageManager?: PackageManagerResolver | undefined;
  /** The Stage 1 summary, when the pipeline already built one (`'project-summary'`). */
  readonly projectSummary?: Pick<ProjectSummary, 'packageManager'> | undefined;
  /**
   * Absolute path of the preload module (`register.mjs`) the launcher resolved.
   * Absent → the `"$DEBUGGEN_PRELOAD_URL"` reference.
   */
  readonly preloadPath?: string | undefined;
  /** Full ingest endpoint; takes precedence over one derived from `config`. */
  readonly ingestUrl?: string | undefined;
  /** Clock for probe durations, in milliseconds. Default: `nowEpochMs`. */
  readonly now?: (() => number) | undefined;
  /** Probe timeout in ms. Default {@link DEFAULT_PROBE_TIMEOUT_MS}; clamped to `(0, 60 000]`. */
  readonly probeTimeoutMs?: number | undefined;
}

// ---------------------------------------------------------------------------
// probeDevServer
// ---------------------------------------------------------------------------

/**
 * Probe a local dev server with one bounded `GET`.
 *
 * Only misuse is an error: a malformed URL, a scheme other than `http:` /
 * `https:`, embedded credentials, or a host other than `127.0.0.1`,
 * `localhost` or `[::1]` is refused with `CONFIG_INVALID` **before any request
 * is made**. `0.0.0.0` is refused too: it names every interface rather than
 * this machine, the same policy `@debuggen/code-analysis` applies to source-map
 * fetches.
 *
 * Everything else is an answer: any HTTP status — 404 and 500 included — is
 * `reachable: true`, while a refused connection, a reset or the timeout is
 * `reachable: false` with a coded {@link DevServerProbeError}. The request is
 * sent to the URL's origin and pathname only; the query and fragment are
 * neither sent, recorded nor logged. Redirects are not followed, and the
 * response body is cancelled unread.
 *
 * `reachable` says only that *something* listens. When a response arrived,
 * its headers are also matched against each framework's dev-server signature
 * (for Next.js: `X-Powered-By` containing `Next.js`, or the
 * `next-router-state-tree` token in `Vary`, case-insensitively), and a match
 * sets {@link DevServerProbeResult.framework} — the only evidence
 * {@link detectDevServer} uses to tell this project's dev server from another
 * process on the port, whether or not a `server-agent` is connected. Headers are read
 * defensively (a missing, throwing or non-string `get` is "no signature"), and
 * no header value is ever stored, returned or logged; the debug line carries
 * the matched framework name only.
 *
 * @param url The dev-server URL, e.g. the session's `devServerUrl`.
 * @param deps `fetchImpl`, `now`, `probeTimeoutMs` and `logger` are read.
 * @returns The probe outcome, or `CONFIG_INVALID` for a URL that may not be probed.
 *
 * @example
 * ```ts
 * const probe = await probeDevServer('http://127.0.0.1:3000/', { probeTimeoutMs: 500 });
 * if (isOk(probe) && probe.value.reachable) {
 *   // something answered, whatever the status; `probe.value.framework === 'next'`
 *   // when the answer carried the Next.js dev-server signature
 * }
 * ```
 */
export async function probeDevServer(
  url: string,
  deps: DevServerDetectDeps = {},
): Promise<Result<DevServerProbeResult, DebuggenError>> {
  const logger = bindLogger(deps.logger);
  const target = parseProbeTarget(url);
  if (isErr(target)) {
    logSafely(() => {
      logger.debug('Refused to probe a dev-server URL', { code: target.error.code });
    });
    return target;
  }

  const probedUrl = displayUrlOf(target.value);
  const fetchImpl = deps.fetchImpl ?? defaultFetch;
  const now = deps.now ?? nowEpochMs;
  const timeoutMs = normalizeProbeTimeout(deps.probeTimeoutMs);

  const startedAt = readClock(now);
  const outcome = await requestWithTimeout(fetchImpl, probedUrl, timeoutMs);
  const durationMs = elapsedMs(startedAt, readClock(now));

  if (outcome.kind === 'response') {
    const status = outcome.response.status;
    const framework = frameworkOf(outcome.response);
    const result: DevServerProbeResult = {
      url: probedUrl,
      reachable: true,
      ...(Number.isInteger(status) ? { status } : {}),
      ...(framework === undefined ? {} : { framework }),
      durationMs,
    };
    logSafely(() => {
      logger.debug('Dev-server probe answered', { url: probedUrl, status, framework, durationMs });
    });
    return ok(result);
  }

  const error: DevServerProbeError =
    outcome.kind === 'timeout'
      ? { code: 'TIMEOUT', message: `No HTTP response arrived within ${timeoutMs} ms.` }
      : describeTransportFailure(outcome.error);
  logSafely(() => {
    logger.debug('Dev-server probe got no response', {
      url: probedUrl,
      errorCode: error.code,
      durationMs,
    });
  });
  return ok({ url: probedUrl, reachable: false, durationMs, error });
}

/** How one probe request ended. */
type ProbeOutcome =
  | { readonly kind: 'response'; readonly response: FetchLikeResponse }
  | { readonly kind: 'failure'; readonly error: unknown }
  | { readonly kind: 'timeout' };

/** The default {@link FetchLike}: Node 24's global `fetch`. */
const defaultFetch: FetchLike = (input, init) => fetch(input, init);

/**
 * Validate a URL against the probe policy: parseable, `http:`/`https:`, no
 * embedded credentials, loopback host. The refusal messages never echo the URL.
 */
function parseProbeTarget(url: string): Result<URL, DebuggenError> {
  const trimmed = typeof url === 'string' ? url.trim() : '';
  if (trimmed.length === 0) {
    return probeRefusal('malformed-url', 'The dev-server URL is empty.');
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return probeRefusal('malformed-url', 'The dev-server URL is not a valid absolute URL.');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return probeRefusal(
      'unsupported-protocol',
      'The dev-server URL must use http: or https:; no other scheme is probed.',
    );
  }

  if (parsed.username !== '' || parsed.password !== '') {
    return probeRefusal('credentials-in-url', 'The dev-server URL must not embed credentials.');
  }

  if (!LOOPBACK_HOSTNAMES.has(parsed.hostname)) {
    return probeRefusal(
      'non-loopback-host',
      'Only a loopback dev server (127.0.0.1, localhost or [::1]) is probed; this URL names another host.',
    );
  }

  return ok(parsed);
}

/** A `CONFIG_INVALID` refusal of a dev-server URL, with the fix as its hint. */
function probeRefusal(reason: string, message: string): Result<never, DebuggenError> {
  return err(
    new DebuggenError('CONFIG_INVALID', message, {
      hint: 'Set debuggen.devServerUrl to the local address the dev server prints, for example http://localhost:<port>.',
      details: { reason },
    }),
  );
}

/** Origin and pathname only: the form of a URL this module sends, stores and logs. */
function displayUrlOf(url: URL): string {
  return `${url.origin}${url.pathname}`;
}

/** An injected timeout when it is a positive finite number, clamped; the default otherwise. */
function normalizeProbeTimeout(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_PROBE_TIMEOUT_MS;
  }
  return Math.min(value, MAX_PROBE_TIMEOUT_MS);
}

/** Read an injected clock, falling back to the wall clock if it throws or misbehaves. */
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
 * Run one request, racing it against an abort-backed timeout.
 *
 * The race (rather than relying on the fetch honouring its signal) is what
 * bounds a request that never settles. The timer is always cleared, and a
 * request that settles after the timeout has its body released, so neither a
 * timer nor a socket outlives the probe.
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
    // A client that throws synchronously has failed the request; it is an
    // answer ("not reachable"), not a crash of the probe.
    request = Promise.resolve({ kind: 'failure', error });
  }

  try {
    return await Promise.race([request, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Cancel an unread response body so the connection is released promptly. */
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
 * The framework whose dev-server signature a response carries, or `undefined`.
 *
 * Each {@link FRAMEWORK_RESPONSE_SIGNATURES} entry is tried in
 * {@link DEV_SERVER_FRAMEWORKS} order; a response matches when its
 * `X-Powered-By` value contains the entry's marker or its comma-separated
 * `Vary` list holds the entry's token (both case-insensitive, tokens trimmed).
 * The header values are compared here and dropped: only the framework name
 * leaves this function.
 */
function frameworkOf(response: FetchLikeResponse): DevServerFramework | undefined {
  const poweredBy = headerValueOf(response, 'x-powered-by')?.toLowerCase();
  const varyTokens = new Set(
    (headerValueOf(response, 'vary') ?? '')
      .split(',')
      .map((token) => token.trim().toLowerCase())
      .filter((token) => token.length > 0),
  );

  return DEV_SERVER_FRAMEWORKS.find((framework) => {
    const signature = FRAMEWORK_RESPONSE_SIGNATURES[framework];
    return (
      (poweredBy !== undefined && poweredBy.includes(signature.poweredBy)) ||
      varyTokens.has(signature.varyToken)
    );
  });
}

/**
 * One response header's value, read without trusting the response's shape:
 * `undefined` when the response has no headers, when reading them or calling
 * `get` throws (a getter that throws, a `get` that is not a function), or when
 * `get` answers anything but a string.
 */
function headerValueOf(response: FetchLikeResponse, name: string): string | undefined {
  try {
    const headers = response.headers;
    if (headers === undefined || headers === null) {
      return undefined;
    }
    const value: unknown = headers.get(name);
    return typeof value === 'string' ? value : undefined;
  } catch {
    // An unreadable header is "no signature": the probe's answer — that
    // something responded — stands, and identity falls to the registry.
    return undefined;
  }
}

/**
 * Classify a failed request without echoing it: an errno-style code from the
 * error or its `cause` (undici wraps the socket error as `cause`), `ABORTED`
 * for an abort, `NETWORK_ERROR` otherwise. The message is a fixed sentence.
 */
function describeTransportFailure(error: unknown): DevServerProbeError {
  const code = transportCodeOf(error);
  return {
    code,
    message: TRANSPORT_MESSAGES[code] ?? 'The request failed before an HTTP response arrived.',
  };
}

function transportCodeOf(error: unknown): string {
  for (const candidate of [propertyOf(error, 'code'), propertyOf(causeOf(error), 'code')]) {
    if (typeof candidate === 'string' && TRANSPORT_CODE_PATTERN.test(candidate)) {
      return candidate;
    }
  }
  return propertyOf(error, 'name') === 'AbortError' ? 'ABORTED' : 'NETWORK_ERROR';
}

function causeOf(value: unknown): unknown {
  return typeof value === 'object' && value !== null && 'cause' in value ? value.cause : undefined;
}

/** Read one well-known property of a caught value without trusting its shape. */
function propertyOf(value: unknown, key: 'code' | 'message' | 'name'): unknown {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  switch (key) {
    case 'code':
      return 'code' in value ? value.code : undefined;
    case 'message':
      return 'message' in value ? value.message : undefined;
    case 'name':
      return 'name' in value ? value.name : undefined;
    default:
      return assertNever(key);
  }
}

// ---------------------------------------------------------------------------
// readTargetManifest
// ---------------------------------------------------------------------------

/**
 * Read and project the target project's `package.json` — the one project file
 * this module reads.
 *
 * The root must be absolute; the manifest path is checked to stay inside it;
 * the file is read through the injected {@link ManifestReader} (default: the
 * no-follow reader, so a symlinked `package.json` is refused with
 * `FS_UNSAFE_PATH` rather than read through); anything over
 * {@link MAX_MANIFEST_BYTES} is refused before parsing. Only the fields of
 * {@link TargetManifest} are kept. No error message ever echoes file content:
 * a syntax error is reported by file and position alone (AAP §0.5.2).
 *
 * Every failure is a typed `Err` — `PROJECT_NOT_FOUND` for a relative root, a
 * missing, unreadable, oversized or malformed manifest; `FS_UNSAFE_PATH` for a
 * symlink; `PATH_OUTSIDE_PROJECT` for an escaping path — which
 * {@link detectDevServer} downgrades to a note. Nothing is thrown.
 *
 * @param projectRoot Absolute path of the project.
 * @param deps `readManifest` is read.
 */
export function readTargetManifest(
  projectRoot: string,
  deps: DevServerDetectDeps = {},
): Result<TargetManifest, DebuggenError> {
  if (
    typeof projectRoot !== 'string' ||
    projectRoot.trim().length === 0 ||
    !isAbsolute(projectRoot)
  ) {
    return err(
      new DebuggenError(
        'PROJECT_NOT_FOUND',
        'The project root must be an absolute path; its package.json was not read.',
        {
          hint: 'Start the session from the project folder opened in VS Code, which supplies its absolute path.',
          details: { reason: 'relative-project-root' },
        },
      ),
    );
  }

  const manifestPath = join(projectRoot, MANIFEST_FILE_NAME);
  if (!isWithin(toPosix(projectRoot), toPosix(manifestPath))) {
    return err(
      new DebuggenError(
        'PATH_OUTSIDE_PROJECT',
        `The package.json path for ${projectRoot} resolves outside the project root.`,
        { details: { reason: 'manifest-outside-project', path: manifestPath } },
      ),
    );
  }

  const reader = deps.readManifest ?? readFileNoFollow;
  let raw: Uint8Array | string;
  try {
    raw = reader(manifestPath);
  } catch (error) {
    return err(manifestReadError(error, manifestPath));
  }

  const size = typeof raw === 'string' ? Buffer.byteLength(raw, 'utf8') : raw.byteLength;
  if (size > MAX_MANIFEST_BYTES) {
    return err(
      new DebuggenError(
        'PROJECT_NOT_FOUND',
        `${manifestPath} is ${size} bytes; a package.json larger than ${MAX_MANIFEST_BYTES} bytes is not parsed.`,
        { details: { reason: 'manifest-too-large', path: manifestPath, size } },
      ),
    );
  }

  // `TextDecoder` strips a UTF-8 byte-order mark; a string input is stripped by hand.
  const text = typeof raw === 'string' ? raw.replace(/^\uFEFF/, '') : new TextDecoder().decode(raw);

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const position = jsonErrorPosition(error);
    return err(
      new DebuggenError(
        'PROJECT_NOT_FOUND',
        `${manifestPath} is not valid JSON (${position.description}).`,
        {
          hint: 'Fix the syntax error in package.json, then retry.',
          details: { reason: 'manifest-invalid-json', path: manifestPath, ...position.details },
        },
      ),
    );
  }

  if (!isRecord(parsed)) {
    return err(
      new DebuggenError('PROJECT_NOT_FOUND', `${manifestPath} does not contain a JSON object.`, {
        hint: 'A package.json must be a JSON object with a "scripts" field.',
        details: { reason: 'manifest-not-object', path: manifestPath },
      }),
    );
  }

  return ok(projectManifest(parsed));
}

/** Map a reader failure to a typed error that names the file and never its content. */
function manifestReadError(error: unknown, manifestPath: string): DebuggenError {
  const rawCode = propertyOf(error, 'code');
  const code =
    typeof rawCode === 'string' && TRANSPORT_CODE_PATTERN.test(rawCode) ? rawCode : undefined;
  const errno = code === undefined ? {} : { errno: code };

  switch (code) {
    case 'ELOOP':
      return new DebuggenError(
        'FS_UNSAFE_PATH',
        `${manifestPath} is a symbolic link; it is not followed.`,
        {
          hint: 'Replace the link with the real package.json, or open the project at its real location.',
          details: { reason: 'manifest-symlink', path: manifestPath, ...errno },
          cause: error,
        },
      );
    case 'ENOENT':
    case 'ENOTDIR':
      return new DebuggenError(
        'PROJECT_NOT_FOUND',
        `No package.json was found at ${manifestPath}.`,
        {
          hint: 'Open the root folder of the Node.js project you want to debug.',
          details: { reason: 'manifest-missing', path: manifestPath, ...errno },
          cause: error,
        },
      );
    case 'EISDIR':
      return new DebuggenError('PROJECT_NOT_FOUND', `${manifestPath} is a directory, not a file.`, {
        details: { reason: 'manifest-unreadable', path: manifestPath, ...errno },
        cause: error,
      });
    case 'EACCES':
    case 'EPERM':
      return new DebuggenError(
        'PROJECT_NOT_FOUND',
        `${manifestPath} is not readable by the user running Debug Generator.`,
        {
          hint: 'Grant read access to package.json, then retry.',
          details: { reason: 'manifest-unreadable', path: manifestPath, ...errno },
          cause: error,
        },
      );
    default:
      return new DebuggenError(
        'PROJECT_NOT_FOUND',
        `${manifestPath} could not be read${code === undefined ? '' : ` (${code})`}.`,
        {
          details: { reason: 'manifest-unreadable', path: manifestPath, ...errno },
          cause: error,
        },
      );
  }
}

/**
 * Where a `JSON.parse` failure occurred, taken from the numbers in the engine's
 * message only — the message itself quotes the offending text, so it is never
 * passed on.
 */
function jsonErrorPosition(error: unknown): {
  readonly description: string;
  readonly details: Readonly<Record<string, number>>;
} {
  const message = propertyOf(error, 'message');
  const text = typeof message === 'string' ? message : '';

  const lineColumn = /\(line (\d+) column (\d+)\)/.exec(text);
  const line = lineColumn?.[1];
  const column = lineColumn?.[2];
  if (line !== undefined && column !== undefined) {
    return {
      description: `line ${line}, column ${column}`,
      details: { line: Number(line), column: Number(column) },
    };
  }

  const offset = /at position (\d+)/.exec(text)?.[1];
  if (offset !== undefined) {
    return { description: `at character ${offset}`, details: { position: Number(offset) } };
  }

  return { description: 'the parser reported no position', details: {} };
}

/** Keep exactly the {@link TargetManifest} fields of a parsed `package.json`. */
function projectManifest(raw: Readonly<Record<string, unknown>>): TargetManifest {
  const name = nonEmptyString(ownValue(raw, 'name'));
  const packageManagerField = nonEmptyString(ownValue(raw, 'packageManager'));
  const scripts: Readonly<Record<string, string>> = Object.freeze(
    Object.fromEntries(stringEntries(ownValue(raw, 'scripts'))),
  );
  const hasNextDependency =
    declaresDependency(ownValue(raw, 'dependencies'), 'next') ||
    declaresDependency(ownValue(raw, 'devDependencies'), 'next');

  return {
    ...(name === undefined ? {} : { name }),
    scripts,
    ...(packageManagerField === undefined ? {} : { packageManagerField }),
    hasNextDependency,
  };
}

/** The string-valued own entries of a record; anything else is dropped, not coerced. */
function stringEntries(value: unknown): [string, string][] {
  if (!isRecord(value)) {
    return [];
  }
  const entries: [string, string][] = [];
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string') {
      entries.push([key, entry]);
    }
  }
  return entries;
}

function declaresDependency(value: unknown, name: string): boolean {
  return isRecord(value) && Object.hasOwn(value, name);
}

/** An own property only — never one inherited from `Object.prototype`. */
function ownValue(record: Readonly<Record<string, unknown>>, key: string): unknown {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// selectDevScript
// ---------------------------------------------------------------------------

/**
 * Choose the script that starts the project's dev server.
 *
 * Precedence, deterministic and framework-generic:
 * 1. a script named exactly `dev`;
 * 2. otherwise the first script, by name in code-unit order, whose command
 *    invokes a framework dev command (`next dev`, matched as binary +
 *    subcommand, so `cross-env X=1 next dev`, `npx next dev` or a
 *    `node_modules/.bin/next dev` path all match);
 * 3. otherwise the first script, by name, whose name starts with `dev`;
 * 4. otherwise `undefined`.
 *
 * Scripts with a blank command are never selected.
 *
 * @example
 * ```ts
 * selectDevScript({ scripts: { start: 'next start', 'dev:web': 'next dev' } });
 * // → { name: 'dev:web', command: 'next dev' }
 * ```
 */
export function selectDevScript(
  manifest: Pick<TargetManifest, 'scripts'>,
): DevScriptSelection | undefined {
  const candidates = runnableScripts(manifest.scripts);

  const chosen =
    candidates.find(([name]) => name === 'dev') ??
    candidates.find(([, command]) => invokesFrameworkDevCommand(command)) ??
    candidates.find(([name]) => name.startsWith('dev'));

  return chosen === undefined ? undefined : { name: chosen[0], command: chosen[1] };
}

/** Own, string-valued, non-blank scripts, sorted by name in code-unit order. */
function runnableScripts(scripts: Readonly<Record<string, string>>): [string, string][] {
  const entries: [string, string][] = [];
  for (const [name, command] of Object.entries(scripts)) {
    if (typeof command === 'string' && command.trim().length > 0) {
      entries.push([name, command]);
    }
  }
  return entries.sort(([left], [right]) => compareCodeUnits(left, right));
}

/** Locale-independent ordering, so the choice never depends on the host's locale. */
function compareCodeUnits(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

/**
 * Whether a script command runs a framework dev command: a token whose binary
 * name is a {@link FRAMEWORK_DEV_COMMANDS} binary, followed — past any
 * `-`-prefixed flags — by that binary's dev subcommand.
 */
function invokesFrameworkDevCommand(command: string): boolean {
  const tokens = command
    .split(/[\s;&|()]+/)
    .map((token) => token.replace(/["'`]/g, ''))
    .filter((token) => token.length > 0);

  return tokens.some((token, index) => {
    const binary = binaryNameOf(token);
    return FRAMEWORK_DEV_COMMANDS.some(({ binary: expected, subcommand }) => {
      if (binary !== expected) {
        return false;
      }
      const next = tokens.slice(index + 1).find((candidate) => !candidate.startsWith('-'));
      return next === subcommand;
    });
  });
}

/** The executable name of a command token: last path segment, lower-cased, shim extension dropped. */
function binaryNameOf(token: string): string {
  const segment = token.split(/[\\/]/).pop() ?? '';
  return segment.toLowerCase().replace(/\.(?:cmd|exe|bat|ps1|js|mjs|cjs)$/, '');
}

// ---------------------------------------------------------------------------
// Relaunch command
// ---------------------------------------------------------------------------

/**
 * The runner words for a package manager, from one exhaustive table:
 * `pnpm run`, `npm run`, `yarn` (Yarn runs a script by name, without `run`),
 * `bun run`; `undefined` for `'unknown'`, which has no binary to invent.
 */
function runnerPrefix(packageManager: PackageManagerId): readonly string[] | undefined {
  switch (packageManager) {
    case 'pnpm':
      return ['pnpm', 'run'];
    case 'npm':
      return ['npm', 'run'];
    case 'yarn':
      return ['yarn'];
    case 'bun':
      return ['bun', 'run'];
    case 'unknown':
      return undefined;
    default:
      return assertNever(packageManager);
  }
}

/**
 * The argument vector that runs `script` with `packageManager` — e.g.
 * `['yarn', 'dev']` — or `undefined` for `'unknown'`. The launcher can spawn
 * this directly (no shell), which keeps its child and this module's relaunch
 * command running the same thing.
 */
export function packageManagerRunArgs(
  packageManager: PackageManagerId,
  script: string,
): readonly string[] | undefined {
  const prefix = runnerPrefix(packageManager);
  return prefix === undefined ? undefined : Object.freeze([...prefix, script]);
}

/**
 * One paste-ready POSIX-shell line that starts this project's dev server with
 * the telemetry preload attached, in the shape the launcher injects:
 *
 * ```sh
 * cd /home/dev/storefront && NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--import file:///…/register.mjs" \
 *   DEBUGGEN_INGEST_URL=http://127.0.0.1:43117/telemetry/ingest DEBUGGEN_PROJECT_ROOT=/home/dev/storefront \
 *   DEBUGGEN_TOKEN="$DEBUGGEN_TOKEN" pnpm run dev
 * ```
 *
 * (shown wrapped; the returned string is a single line).
 *
 * - `NODE_OPTIONS` is **appended to**, never replaced, as the launcher does.
 * - `DEBUGGEN_TOKEN` is always the `"$DEBUGGEN_TOKEN"` reference — never a
 *   value. The preload URL and ingest URL are concrete when supplied, else the
 *   `"$DEBUGGEN_PRELOAD_URL"` / `"$DEBUGGEN_INGEST_URL"` references.
 * - An `'unknown'` package manager renders `<package-manager> run`, and a
 *   missing script renders `<dev-script>`: no binary or script is invented.
 * - Concrete values are shell-quoted (single quotes, or `$'…'` for a value
 *   with control characters), so the result is always one line.
 *
 * Pure and deterministic: the same input yields the same bytes. POSIX shells
 * only; on Windows the editor command in {@link buildRelaunchHint} is the route.
 */
export function formatRelaunchCommand(input: RelaunchCommandInput): string {
  const projectRoot = quoteShellWord(input.projectRoot);
  const nodeOptions = PRELOAD_ENV.nodeOptions;
  const scriptName = input.devScript?.name;
  const script =
    scriptName === undefined || scriptName.trim().length === 0
      ? RELAUNCH_PLACEHOLDERS.devScript
      : quoteShellWord(scriptName);
  const runner =
    runnerPrefix(input.packageManager)?.join(' ') ?? `${RELAUNCH_PLACEHOLDERS.packageManager} run`;

  return [
    `cd ${projectRoot}`,
    '&&',
    `${nodeOptions}="\${${nodeOptions}:+$${nodeOptions} }--import ${preloadUrlWord(input.preloadUrl)}"`,
    `${PRELOAD_ENV.ingestUrl}=${ingestUrlWord(input.ingestUrl)}`,
    `${PRELOAD_ENV.projectRoot}=${projectRoot}`,
    `${PRELOAD_ENV.token}="${RELAUNCH_PLACEHOLDERS.token}"`,
    `${runner} ${script}`,
  ].join(' ');
}

/**
 * The preload URL as it appears inside the double-quoted `NODE_OPTIONS`
 * value. A URL serialiser already percent-encodes spaces, quotes and control
 * characters; the few shell-active characters it leaves (`!`, `$`, backslash)
 * are percent-encoded too, which a `file:` URL resolves identically.
 */
function preloadUrlWord(preloadUrl: string | undefined): string {
  const parsed = parseUrl(preloadUrl);
  if (parsed === undefined || parsed.protocol !== 'file:') {
    return RELAUNCH_PLACEHOLDERS.preloadUrl;
  }
  return parsed.href.replace(SHELL_ACTIVE_URL_CHARACTERS, percentEncodeCharacter);
}

/** The ingest URL as a shell word, or the quoted shell reference. */
function ingestUrlWord(ingestUrl: string | undefined): string {
  const parsed = parseUrl(ingestUrl);
  if (
    parsed === undefined ||
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
    parsed.username !== '' ||
    parsed.password !== ''
  ) {
    return `"${RELAUNCH_PLACEHOLDERS.ingestUrl}"`;
  }
  return quoteShellWord(parsed.href);
}

function parseUrl(value: string | undefined): URL | undefined {
  if (value === undefined || value.trim().length === 0) {
    return undefined;
  }
  try {
    return new URL(value.trim());
  } catch {
    return undefined;
  }
}

function percentEncodeCharacter(character: string): string {
  return `%${character.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`;
}

/**
 * Quote a value as one POSIX shell word: unchanged when it is made of inert
 * characters only, single-quoted otherwise, and ANSI-C quoted (`$'…'`, which
 * bash and zsh read) when it contains control characters, so a pathological
 * path can never split the command across lines.
 */
function quoteShellWord(value: string): string {
  if (SHELL_SAFE_WORD.test(value)) {
    return value;
  }
  if (!hasControlCharacter(value)) {
    return `'${value.replaceAll("'", `'\\''`)}'`;
  }
  let escaped = '';
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (character === '\\' || character === "'") {
      escaped += `\\${character}`;
    } else if (isControlCode(code)) {
      escaped += `\\x${code.toString(16).padStart(2, '0')}`;
    } else {
      escaped += character;
    }
  }
  return `$'${escaped}'`;
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    if (isControlCode(character.codePointAt(0) ?? 0)) {
      return true;
    }
  }
  return false;
}

/** C0 controls, DEL and C1 controls — what the single-line rule of a readiness hint refuses. */
function isControlCode(code: number): boolean {
  return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
}

// ---------------------------------------------------------------------------
// Relaunch hint
// ---------------------------------------------------------------------------

/**
 * The situation a hint speaks to; picks its first sentence and its verb.
 * `'occupied'` is an unidentified server answering at the session URL
 * ({@link DevServerDetection.occupied}), which is neither this project's dev
 * server nor a free address the launcher could use.
 */
type HintSituation =
  'attached' | 'running-without-preload' | 'unconfirmed' | 'occupied' | 'not-running' | 'generic';

/** Opening sentence of the hint for each situation. */
const HINT_CONSEQUENCES: Readonly<Record<HintSituation, string>> = Object.freeze({
  attached: "This project's dev server already runs with the Debug Generator preload.",
  'running-without-preload':
    "This project's dev server is running without the Debug Generator preload, so server and database spans cannot be captured.",
  unconfirmed:
    "Whether this project's dev server carries the Debug Generator preload could not be confirmed; without it, server and database spans cannot be captured.",
  occupied:
    "Another process answers at this project's dev-server address, not this project's dev server, so server and database spans cannot be captured.",
  'not-running':
    'No dev server with the Debug Generator preload is running for this project, so server and database spans cannot be captured.',
  generic:
    "Server and database spans cannot be captured until this project's dev server runs with the Debug Generator preload.",
});

/** The editor-command sentence for each situation. */
const HINT_ACTIONS: Readonly<Record<HintSituation, string>> = Object.freeze({
  attached: `If you restart it, run "${LAUNCH_DEV_SERVER_COMMAND_TITLE}" in VS Code, which keeps the preload attached`,
  'running-without-preload': `Stop it, then run "${LAUNCH_DEV_SERVER_COMMAND_TITLE}" in VS Code, which starts it with the preload and a fresh ingest credential`,
  unconfirmed: `If it lacks the preload, stop it, then run "${LAUNCH_DEV_SERVER_COMMAND_TITLE}" in VS Code, which starts it with the preload and a fresh ingest credential`,
  occupied: `Stop the process holding that address, or set debuggen.devServerUrl to this project's dev-server address, then run "${LAUNCH_DEV_SERVER_COMMAND_TITLE}" in VS Code, which starts it with the preload and a fresh ingest credential`,
  'not-running': `Run "${LAUNCH_DEV_SERVER_COMMAND_TITLE}" in VS Code, which starts it with the preload and a fresh ingest credential`,
  generic: `Run "${LAUNCH_DEV_SERVER_COMMAND_TITLE}" in VS Code, which starts it with the preload and a fresh ingest credential`,
});

/**
 * The one-line developer-facing hint for a missing (or to-be-kept) preload:
 * the consequence ("server and database spans cannot be captured"), the
 * token-free action (the editor's "Debug Generator: Launch Dev Server"
 * command) and, as the fallback, the exact relaunch command.
 *
 * Given a {@link DevServerDetection}, it speaks to that detection's situation
 * (running without the preload, not running, another process holding the
 * address, unconfirmed, attached) and quotes its `relaunchCommand` verbatim;
 * given a {@link RelaunchCommandInput}, it formats the command with
 * {@link formatRelaunchCommand} and speaks generically.
 * This is the string `src/instrumentation/readiness.ts` places in an
 * `UnavailableSignal.hint` (AAP §0.5.5).
 *
 * The result is a single line of at most `READINESS_HINT_MAX_LENGTH`
 * characters: when the full form would be longer (a very long project path),
 * it drops the explanatory parenthesis and then the manual command, keeping
 * the editor-command action, which never needs a path.
 */
export function buildRelaunchHint(input: DevServerDetection | RelaunchCommandInput): string {
  if ('relaunchCommand' in input) {
    return composeRelaunchHint(situationOf(input), input.relaunchCommand);
  }
  return composeRelaunchHint('generic', formatRelaunchCommand(input));
}

/**
 * Which hint situation a detection's facts describe. `occupied` is optional
 * in the facts, so a caller holding only the four older fields (for example a
 * detection `src/instrumentation/readiness.ts` re-situates) is read unchanged.
 */
function situationOf(
  facts: Pick<DevServerDetection, 'running' | 'preloadAttached' | 'preloadReason'> &
    Partial<Pick<DevServerDetection, 'occupied'>>,
): HintSituation {
  if (facts.preloadAttached) {
    return 'attached';
  }
  if (facts.occupied === true) {
    return 'occupied';
  }
  if (!facts.running) {
    return 'not-running';
  }
  return facts.preloadReason === 'no-server-agent-connection'
    ? 'running-without-preload'
    : 'unconfirmed';
}

/**
 * Compose the hint text, choosing the longest form that fits the hint limit.
 *
 * The one composer of every relaunch hint — {@link buildRelaunchHint}, a
 * detection's `relaunchHint` and the degraded detection's all come from here —
 * so the result is registered with `authorProductText` at this point of
 * composition. That registration is the proof a failure surface (a failed row,
 * `instrumentation.failed`, an HTTP refusal) later checks before it shows a
 * failure's hint verbatim: an adapter's own relaunch text, or any other hint
 * this function did not produce, never matches and is replaced by fixed copy
 * (CWE-209), while this exact command still reaches the developer (AAP §0.5.5).
 */
function composeRelaunchHint(situation: HintSituation, command: string): string {
  const consequence = HINT_CONSEQUENCES[situation];
  const action = HINT_ACTIONS[situation];

  const exported = [
    command.includes(RELAUNCH_PLACEHOLDERS.preloadUrl) ? 'DEBUGGEN_PRELOAD_URL' : undefined,
    command.includes(RELAUNCH_PLACEHOLDERS.ingestUrl) ? PRELOAD_ENV.ingestUrl : undefined,
    PRELOAD_ENV.token,
  ].filter((name): name is string => name !== undefined);
  const fillIn = [
    command.includes(RELAUNCH_PLACEHOLDERS.packageManager)
      ? `${RELAUNCH_PLACEHOLDERS.packageManager} with this project's package manager`
      : undefined,
    command.includes(RELAUNCH_PLACEHOLDERS.devScript)
      ? `${RELAUNCH_PLACEHOLDERS.devScript} with the script that starts its dev server`
      : undefined,
  ].filter((text): text is string => text !== undefined);

  const exportClause = ` after exporting ${joinWords(exported)}`;
  const credentialNote = ` (${PRELOAD_ENV.token} is a server-agent credential issued by the Debug Generator service)`;
  const fillInClause = fillIn.length === 0 ? '' : `, replacing ${joinWords(fillIn)}`;
  const manualIntro = situation === 'attached' ? 'or restart it by hand' : 'or start it by hand';

  const candidates = [
    `${consequence} ${action}, ${manualIntro}${exportClause}${credentialNote}${fillInClause}: ${command}`,
    `${consequence} ${action}, ${manualIntro}${exportClause}${fillInClause}: ${command}`,
    `${consequence} ${action}.`,
  ];

  return authorProductText(
    candidates.find(
      (candidate) =>
        candidate.length <= READINESS_HINT_MAX_LENGTH && !hasControlCharacter(candidate),
    ) ?? `${consequence} ${action}.`,
  );
}

/** "a", "a and b", "a, b and c". */
function joinWords(words: readonly string[]): string {
  if (words.length <= 1) {
    return words.join('');
  }
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1] ?? ''}`;
}

/**
 * One `UnavailableSignal` per planned preload-dependent signal when the
 * detection shows no preload attached — each with the detection's
 * `relaunchHint` as its hint, so every surface shows the same exact command.
 * Empty when the preload is attached. Only server signals are reported (a
 * browser-only signal in `signals` is ignored), each at most once, in the
 * order given. A detection with {@link DevServerDetection.occupied} is
 * reported as another process holding the dev-server address.
 *
 * @param detection The detection to report on; `occupied` is optional, so a
 *   caller holding only the other four fields compiles and reads unchanged.
 * @param signals The planned signals; defaults to {@link PRELOAD_DEPENDENT_SIGNALS}.
 */
export function buildPreloadUnavailableSignals(
  detection: Pick<
    DevServerDetection,
    'running' | 'preloadAttached' | 'preloadReason' | 'relaunchHint'
  > &
    Partial<Pick<DevServerDetection, 'occupied'>>,
  signals: readonly CaptureSignal[] = PRELOAD_DEPENDENT_SIGNALS,
): readonly UnavailableSignal[] {
  if (detection.preloadAttached) {
    return Object.freeze([]);
  }

  const serverSignals = new Set<CaptureSignal>(SERVER_CAPTURE_SIGNALS);
  // Registered as the product's own words, like the relaunch hint, so the
  // capture gate may quote it in a refusal ("Could not enable ‹signal›: …").
  const reason = authorProductText(preloadGapReason(situationOf(detection)));
  const reported = new Set<CaptureSignal>();
  const unavailable: UnavailableSignal[] = [];

  for (const signal of signals) {
    if (serverSignals.has(signal) && !reported.has(signal)) {
      reported.add(signal);
      unavailable.push({ signal, reason, hint: detection.relaunchHint });
    }
  }
  return Object.freeze(unavailable);
}

/** The `reason` fragment (read after "Could not enable ‹signal›: ") for a missing preload. */
function preloadGapReason(situation: HintSituation): string {
  switch (situation) {
    case 'running-without-preload':
      return 'no dev-server preload is attached for this project';
    case 'not-running':
      return 'no dev server with the preload is running for this project';
    case 'occupied':
      return 'another process holds the dev-server address for this project';
    case 'unconfirmed':
    case 'generic':
    case 'attached':
      return 'the dev-server preload could not be confirmed for this project';
    default:
      return assertNever(situation);
  }
}

// ---------------------------------------------------------------------------
// detectDevServer
// ---------------------------------------------------------------------------

/**
 * Answer, for one project: is this project's dev server running at the
 * session's URL (or does another process hold that address), does it carry
 * the preload, which package manager and script would start it, and what
 * exact command relaunches it instrumented.
 *
 * Steps, each of which degrades to a `notes` entry instead of failing:
 * 1. **Probe** `input.devServerUrl` with {@link probeDevServer}. No URL → no
 *    probe and `running: false`; a refused URL or no answer → a note.
 * 2. **Identity and preload**, from the probe and the injected
 *    {@link ServerAgentPresence} (queried once; no registry, or one that
 *    throws, is "unknown"):
 *    - `running` — a response arrived (any status) *and* it carried a
 *      framework signature; `identifiedBy` is then `'framework-signature'`.
 *      The registry plays no part in identity.
 *    - `occupied: true` — a response arrived without a signature, whatever the
 *      registry says; a note names the probed URL and status (never a header
 *      value) and, when a `server-agent` is connected for the project, says
 *      that agent's server may be on another address. `canLaunch` is `false`,
 *      because launching would collide with the process holding the address.
 *    - `preloadAttached` — `running` and a `server-agent` connection.
 *    - `preloadReason` — `'not-running'` whenever this project's dev server was
 *      not found answering (that is the fact, whatever the registry says),
 *      otherwise `'server-agent-connected'`, `'no-server-agent-connection'`,
 *      or `'unknown'` when no registry was injected or it failed.
 * 3. **Manifest and dev script** with {@link readTargetManifest} and
 *    {@link selectDevScript}.
 * 4. **Package manager**, by precedence: the injected `projectSummary` or
 *    `resolvePackageManager` (`'project-summary'`); the manifest's own
 *    `packageManager` field (`'manifest-field'`); code-analysis's lockfile and
 *    workspace-root detection (`'code-analysis'`); else `'unknown'` with a note.
 * 5. **Relaunch command and hint** with {@link formatRelaunchCommand} and the
 *    {@link buildRelaunchHint} wording for this situation.
 *
 * Never throws and never rejects: detection failure must not fail the session,
 * because capture proceeds with whichever signals are available (AAP §0.5.5).
 * Logs one `info` line under `subsystem: "dev-server"` — origin and pathname
 * only, never a query, a token or an environment value.
 *
 * @param input The project root and, when known, the session's dev-server URL.
 * @param deps Every collaborator is optional; see {@link DevServerDetectDeps}.
 */
export async function detectDevServer(
  input: DetectDevServerInput,
  deps: DevServerDetectDeps = {},
): Promise<DevServerDetection> {
  const logger = bindLogger(deps.logger);
  try {
    const detection = await runDetection(input, deps, logger);
    logSafely(() => {
      logger.info('Dev-server detection finished', {
        projectRoot: detection.projectRoot,
        devServerUrl: detection.devServerUrl,
        running: detection.running,
        identifiedBy: detection.identifiedBy,
        occupied: detection.occupied === true,
        preloadAttached: detection.preloadAttached,
        preloadReason: detection.preloadReason,
        packageManager: detection.packageManager,
        packageManagerSource: detection.packageManagerSource,
        devScript: detection.devScript?.name,
        canLaunch: detection.canLaunch,
        noteCount: detection.notes.length,
      });
    });
    return detection;
  } catch (error) {
    // Last resort. Every step above degrades on its own; this catches a
    // collaborator failing in a way no step anticipated, so the caller still
    // gets a usable, honest answer rather than an exception. The failure is
    // named by its closed class and code only: an unanticipated value's own
    // `name` and `message` are whatever it was built with, a path or a URL
    // included, and never enter the record.
    logSafely(() => {
      logger.warn('Dev-server detection failed unexpectedly; reporting a degraded result', {
        ...describeException(error),
      });
    });
    return degradedDetection(input);
  }
}

/** The body of {@link detectDevServer}; its steps are documented there. */
async function runDetection(
  input: DetectDevServerInput,
  deps: DevServerDetectDeps,
  logger: Logger,
): Promise<DevServerDetection> {
  const notes: string[] = [];
  const projectRoot = input.projectRoot;

  const probe = await probeSessionUrl(input.devServerUrl, deps, notes);
  const presence = observePreload(projectRoot, probe, deps.serverAgents, notes);

  const manifest = readManifestForDetection(projectRoot, deps, notes);
  const devScript = manifest === undefined ? undefined : selectDevScript(manifest);
  if (manifest !== undefined && devScript === undefined) {
    notes.push(
      'package.json declares no dev script: none is named "dev", none runs a framework dev command, and none starts with "dev".',
    );
  }
  if (manifest !== undefined && !manifest.hasNextDependency) {
    notes.push(
      'package.json does not list next as a dependency; server spans come from the Next.js tracer, so they may be unavailable.',
    );
  }

  const packageManager = resolvePackageManagerFor(projectRoot, manifest, deps, logger, notes);

  const relaunchCommand = formatRelaunchCommand({
    projectRoot,
    packageManager: packageManager.id,
    devScript,
    preloadUrl: preloadUrlFromPath(deps.preloadPath, notes),
    ingestUrl: ingestUrlFor(deps, notes),
  });
  const relaunchHint = composeRelaunchHint(situationOf(presence), relaunchCommand);

  return {
    projectRoot,
    ...(probe === undefined ? {} : { devServerUrl: probe.url, probe }),
    running: presence.running,
    ...(presence.identifiedBy === undefined ? {} : { identifiedBy: presence.identifiedBy }),
    ...(presence.occupied === undefined ? {} : { occupied: presence.occupied }),
    preloadAttached: presence.preloadAttached,
    preloadReason: presence.preloadReason,
    packageManager: packageManager.id,
    packageManagerSource: packageManager.source,
    ...(devScript === undefined ? {} : { devScript }),
    relaunchCommand,
    relaunchHint,
    // An occupied address is not launchable: a child bound to the same port
    // would fail to listen, or answer beside a process that is not this project's.
    canLaunch: !presence.running && presence.occupied !== true && devScript !== undefined,
    notes: Object.freeze([...notes]),
  };
}

/** Step 1: probe the session URL, if there is one. */
async function probeSessionUrl(
  devServerUrl: string | undefined,
  deps: DevServerDetectDeps,
  notes: string[],
): Promise<DevServerProbeResult | undefined> {
  const url = typeof devServerUrl === 'string' ? devServerUrl.trim() : '';
  if (url.length === 0) {
    notes.push('No dev-server URL is known for this session, so no probe was attempted.');
    return undefined;
  }

  const probed = await probeDevServer(url, deps);
  if (isErr(probed)) {
    notes.push(`The dev-server URL was not probed: ${probed.error.message}`);
    return undefined;
  }
  if (!probed.value.reachable) {
    const why = probed.value.error?.message ?? 'no HTTP response arrived.';
    notes.push(`No dev server answered at ${probed.value.url}: ${why}`);
  }
  return probed.value;
}

/** What step 2 establishes: whose server answered, and whether it carries the preload. */
type PreloadObservation = Pick<
  DevServerDetection,
  'running' | 'identifiedBy' | 'occupied' | 'preloadAttached' | 'preloadReason'
>;

/**
 * The registry's answer for a project: `true` only for a literal `true` (a
 * JavaScript port answering `1` is not evidence), `false` for any other value,
 * `'unknown'` when no registry was injected or it threw.
 */
type RegistryAnswer = boolean | 'unknown';

/**
 * Step 2: identity and preload presence.
 *
 * The answering server is this project's dev server only when the probe
 * matched a framework signature. The registry decides preload presence alone
 * and never identity: a `server-agent` connected for the project may belong to
 * a dev server listening on another port, so it cannot vouch for an unsigned
 * responder at this one. An unsigned answer is `occupied`, with a note that
 * names the probed URL and status and never a header value.
 */
function observePreload(
  projectRoot: string,
  probe: DevServerProbeResult | undefined,
  serverAgents: ServerAgentPresence | undefined,
  notes: string[],
): PreloadObservation {
  const connected = queryServerAgents(projectRoot, serverAgents, notes);
  const answer = probe?.reachable === true ? probe : undefined;
  const running = answer !== undefined && answer.framework !== undefined;

  if (!running) {
    if (answer !== undefined) {
      notes.push(occupiedNote(answer, connected));
      return {
        running: false,
        occupied: true,
        preloadAttached: false,
        preloadReason: 'not-running',
      };
    }
    if (connected === true) {
      notes.push(
        'A server-agent is connected for this project, but no dev server answered at the session URL; check that debuggen.devServerUrl names the dev server this project runs.',
      );
    }
    return { running: false, preloadAttached: false, preloadReason: 'not-running' };
  }

  if (connected === true) {
    return {
      running: true,
      identifiedBy: 'framework-signature',
      preloadAttached: true,
      preloadReason: 'server-agent-connected',
    };
  }

  if (connected === false) {
    notes.push(
      'The dev server is running, but no server-agent connection exists for this project: it was not started with the Debug Generator preload.',
    );
    return {
      running: true,
      identifiedBy: 'framework-signature',
      preloadAttached: false,
      preloadReason: 'no-server-agent-connection',
    };
  }

  if (serverAgents === undefined) {
    // A registry that threw has already said so in its own note.
    notes.push(
      'No server-agent registry was available, so whether the running dev server carries the preload is unknown.',
    );
  }
  return {
    running: true,
    identifiedBy: 'framework-signature',
    preloadAttached: false,
    preloadReason: 'unknown',
  };
}

/** Ask the registry once; a missing or throwing registry is `'unknown'` (the latter with a note). */
function queryServerAgents(
  projectRoot: string,
  serverAgents: ServerAgentPresence | undefined,
  notes: string[],
): RegistryAnswer {
  if (serverAgents === undefined) {
    return 'unknown';
  }
  try {
    return serverAgents.hasServerAgentForProject(projectRoot) === true;
  } catch {
    notes.push(
      'The server-agent registry could not be queried, so whether the dev server carries the preload is unknown.',
    );
    return 'unknown';
  }
}

/**
 * The note for an unsigned answer: fixed text plus the probed URL (origin and
 * pathname, as the probe recorded it) and the status only — never a header
 * value. When a `server-agent` is connected for the project, the note says so,
 * because the likeliest cause is then a session URL that names another
 * process while the agent's own dev server listens elsewhere.
 */
function occupiedNote(answer: DevServerProbeResult, connected: RegistryAnswer): string {
  const status = answer.status === undefined ? 'an HTTP response' : `HTTP ${answer.status}`;
  const unidentified = `Something answered at ${answer.url} with ${status}, but the response carries no Next.js signature, so it is not identifiable as this project's dev server and is treated as another process holding the address.`;
  return connected === true
    ? `${unidentified} A server-agent is connected for this project, but the process answering at that URL was not identified, so the agent's dev server may be listening at a different address; check that debuggen.devServerUrl names it.`
    : unidentified;
}

/** Step 3: the manifest, or a note explaining why there is none. */
function readManifestForDetection(
  projectRoot: string,
  deps: DevServerDetectDeps,
  notes: string[],
): TargetManifest | undefined {
  const manifest = readTargetManifest(projectRoot, deps);
  if (isErr(manifest)) {
    notes.push(`The project's package.json was not used: ${manifest.error.message}`);
    return undefined;
  }
  return manifest.value;
}

/** A package-manager answer and the route that produced it. */
interface PackageManagerAnswer {
  readonly id: PackageManagerId;
  readonly source: DevServerPackageManagerSource;
}

const UNKNOWN_PACKAGE_MANAGER: PackageManagerAnswer = Object.freeze({
  id: 'unknown',
  source: 'unknown',
});

/**
 * A probe that sees no files: passing it to code-analysis's detection isolates
 * the manifest's own `packageManager` field, which is how a `'manifest-field'`
 * answer is told apart from a lockfile answer without re-parsing the field here.
 */
const NO_FILES_PROBE: ProjectProbe = Object.freeze({
  fileExists: (): boolean => false,
  directoryExists: (): boolean => false,
});

/** Step 4: the package manager, by the documented precedence. */
function resolvePackageManagerFor(
  projectRoot: string,
  manifest: TargetManifest | undefined,
  deps: DevServerDetectDeps,
  logger: Logger,
  notes: string[],
): PackageManagerAnswer {
  const summarised = deps.projectSummary?.packageManager;
  if (isKnownPackageManager(summarised)) {
    return { id: summarised, source: 'project-summary' };
  }

  if (deps.resolvePackageManager !== undefined) {
    try {
      const resolved = deps.resolvePackageManager({
        projectRoot,
        ...(manifest === undefined ? {} : { manifest }),
      });
      if (isKnownPackageManager(resolved)) {
        return { id: resolved, source: 'project-summary' };
      }
    } catch {
      notes.push(
        'The injected package-manager resolver failed; project detection was used instead.',
      );
    }
  }

  if (typeof projectRoot !== 'string' || !isAbsolute(projectRoot)) {
    notes.push('The package manager was not detected because the project root is not absolute.');
    return UNKNOWN_PACKAGE_MANAGER;
  }

  try {
    const detected = detectThroughCodeAnalysis(projectRoot, manifest, logger);
    if (detected !== undefined) {
      return detected;
    }
  } catch {
    notes.push(
      'Package-manager detection failed, so the relaunch command leaves the package manager for you to fill in.',
    );
    return UNKNOWN_PACKAGE_MANAGER;
  }

  notes.push(
    'The package manager could not be determined (no packageManager field and no single lockfile), so the relaunch command leaves it for you to fill in.',
  );
  return UNKNOWN_PACKAGE_MANAGER;
}

/**
 * Package-manager detection reused from `@debuggen/code-analysis` — the
 * project's `packageManager` field, then its own lockfiles, then the
 * workspace root's field and lockfiles (a membership-checked monorepo root,
 * never merely the nearest ancestor with a lockfile). Mirrors how
 * `summarizeProject` wires the same detection, so the two cannot disagree.
 */
function detectThroughCodeAnalysis(
  projectRoot: string,
  manifest: TargetManifest | undefined,
  logger: Logger,
): PackageManagerAnswer | undefined {
  const evidence: CodeAnalysisManifest =
    manifest?.packageManagerField === undefined
      ? {}
      : { packageManager: manifest.packageManagerField };

  const declared = detectPackageManager(evidence, NO_FILES_PROBE);
  if (declared !== 'unknown') {
    return { id: declared, source: 'manifest-field' };
  }

  const workspace = findWorkspaceRoot(projectRoot, { logger });
  const fallback: WorkspacePackageManagerFallback | undefined =
    workspace === undefined
      ? undefined
      : {
          manifest: readCodeAnalysisManifest(workspace.root, logger),
          probe: createProjectProbe(workspace.root, logger),
        };

  const detected = detectPackageManager(
    evidence,
    createProjectProbe(projectRoot, logger),
    fallback,
  );
  return detected === 'unknown' ? undefined : { id: detected, source: 'code-analysis' };
}

/**
 * Whether a value is a package manager with a runner binary — a member of
 * code-analysis's `PACKAGE_MANAGERS` vocabulary other than `'unknown'`. Guards
 * injected answers, which a JavaScript caller could get wrong.
 */
function isKnownPackageManager(value: unknown): value is KnownPackageManagerId {
  return value !== 'unknown' && PACKAGE_MANAGERS.some((id) => id === value);
}

/** The preload's `file:` URL from an absolute path, or `undefined` with a note. */
function preloadUrlFromPath(preloadPath: string | undefined, notes: string[]): string | undefined {
  if (preloadPath === undefined) {
    return undefined;
  }
  if (typeof preloadPath !== 'string' || !isAbsolute(preloadPath)) {
    notes.push(
      'The preload path supplied to detection is not absolute, so the relaunch command references $DEBUGGEN_PRELOAD_URL instead.',
    );
    return undefined;
  }
  try {
    return pathToFileURL(preloadPath).href;
  } catch {
    notes.push(
      'The preload path could not be converted to a file URL, so the relaunch command references $DEBUGGEN_PRELOAD_URL instead.',
    );
    return undefined;
  }
}

/**
 * The full ingest endpoint: an injected `ingestUrl`, else `http://host:port`
 * from the service's config joined with the ingest route's path from the
 * protocol route table (IPv6 hosts bracketed) — the same composition the
 * launcher uses, so the command names the endpoint a launched child receives.
 */
function ingestUrlFor(deps: DevServerDetectDeps, notes: string[]): string | undefined {
  if (deps.ingestUrl !== undefined) {
    return deps.ingestUrl;
  }
  if (deps.config === undefined) {
    return undefined;
  }

  const { host, port } = deps.config;
  const authority = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  try {
    return new URL(buildPath('telemetry.event'), `http://${authority}:${port}`).href;
  } catch {
    notes.push(
      "The service's host and port do not form a valid ingest URL, so the relaunch command references $DEBUGGEN_INGEST_URL instead.",
    );
    return undefined;
  }
}

/** The result of a detection that failed unexpectedly: nothing assumed. */
function degradedDetection(input: DetectDevServerInput): DevServerDetection {
  const projectRoot = typeof input.projectRoot === 'string' ? input.projectRoot : '';
  const relaunchCommand = formatRelaunchCommand({ projectRoot, packageManager: 'unknown' });
  return {
    projectRoot,
    running: false,
    preloadAttached: false,
    preloadReason: 'unknown',
    packageManager: 'unknown',
    packageManagerSource: 'unknown',
    relaunchCommand,
    relaunchHint: composeRelaunchHint('generic', relaunchCommand),
    canLaunch: false,
    notes: Object.freeze([
      'Dev-server detection failed unexpectedly, so the dev server was treated as not running and its preload as unknown.',
    ]),
  };
}

/** Bind the module's subsystem to a parent logger, falling back to the no-op logger. */
function bindLogger(parent: Logger | undefined): Logger {
  try {
    return subsystemLogger(parent ?? noopLogger, LOG_SUBSYSTEM);
  } catch {
    return noopLogger;
  }
}

/** Run a log call; a failing logger never changes a detection's outcome. */
function logSafely(write: () => void): void {
  try {
    write();
  } catch {
    // Logging is diagnostic only: the detection is already computed and is
    // returned regardless.
    return;
  }
}
