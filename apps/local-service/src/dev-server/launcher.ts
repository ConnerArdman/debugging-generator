/**
 * The dev-server launcher: start the developer's own dev server **with the
 * Debug Generator telemetry preload attached and nothing else changed**, and
 * own each launched child's lifetime, credential and shutdown.
 *
 * ## Why a launcher exists
 *
 * Server-side spans — the incoming request, the route handler, outgoing
 * `fetch`, Prisma and `pg` queries — need a tracer provider *inside* the
 * dev-server process before the framework loads. The product supplies one as a
 * Node preload (`@debuggen/telemetry`'s `dist/node/register.mjs`) attached with
 * `NODE_OPTIONS=--import <file URL>` (AAP §0.1.1, §0.4.2). That is the whole
 * reason this module exists: **instrumentation here is purely environmental.**
 * Neither this file nor the preload writes a byte into the target project —
 * no `instrumentation.ts`, no config edit, no dependency — so the only project
 * files this product ever changes are the recorded, hash-checked patches of
 * `@debuggen/instrumentation` (AAP §0.5.1). This module writes nothing to
 * `$DEBUGGEN_HOME` either: credential persistence belongs to
 * `../server/auth.ts` and the store.
 *
 * ## The environment contract: a minimal environment plus four variables
 *
 * {@link buildDevServerEnv} does **not** copy the service's environment. A
 * launched child receives, in this order:
 *
 * 1. the service variables {@link isForwardedToDevServer} admits — the
 *    documented {@link DEV_SERVER_ENV_ALLOWLIST}: what the platform, Node and a
 *    package manager need to run (`PATH`, `HOME`, `TMPDIR`, the locale,
 *    `SystemRoot`, proxy and CA settings…), terminal and framework switches
 *    (`NODE_ENV`, `PORT`, every `NEXT_*` such as `NEXT_OTEL_VERBOSE`), the
 *    database variables the product's `.env.example` documents and the `pg`
 *    driver reads (`DATABASE_URL`, `PG*`), and `DEBUGGEN_LOG_LEVEL`, which the
 *    preload reads;
 * 2. the launch command's explicit `NAME=value` assignments that
 *    {@link DEV_SERVER_COMMAND_ENV_ALLOWLIST} admits — the dev server's own
 *    settings (`NODE_ENV`, `PORT`, `NEXT_TELEMETRY_DISABLED`,
 *    `NEXT_PUBLIC_*`, the database variables…) and a checked `NODE_OPTIONS`
 *    or `NODE_PATH` (whose directories {@link checkLaunchCommand} must also
 *    trust). Any other assignment refuses the launch before anything is
 *    minted or spawned ({@link parseLaunchCommand}): an `LD_PRELOAD`, a
 *    `NODE_OPTIONS=--require …`, a `PATH` or a `NEXT_PRIVATE_DEV_DIR` would
 *    run or serve code of the requester's choosing inside the child (CWE-78);
 * 3. the four keys below, set last, so nothing earlier can override them.
 *
 * Everything else is dropped: `ANTHROPIC_API_KEY`, every other `DEBUGGEN_*`
 * (`DEBUGGEN_HOME`, `DEBUGGEN_PROVIDER`, `DEBUGGEN_MODEL`, …), the editor's
 * `VSCODE_*` and `ELECTRON_*`, `npm_config_*`, cloud and source-control
 * credentials, and any variable not recognised. Service-only credentials
 * must never reach a target application and the dependencies it loads. A
 * developer gives the target app more variables the way the app expects them:
 * its own `.env` files, which Next.js loads itself. On Windows names compare
 * case-insensitively.
 *
 * | Variable | Value |
 * | --- | --- |
 * | `NODE_OPTIONS` | the launch command's assigned (checked) value, else the service's, **with** `--import <preload file URL>` appended — never replaced |
 * | `DEBUGGEN_INGEST_URL` | the **full** ingest endpoint, `http://<host>:<port>/telemetry/ingest` |
 * | `DEBUGGEN_TOKEN` | a `server-agent` credential scoped to this one project root |
 * | `DEBUGGEN_PROJECT_ROOT` | the absolute project root the credential is scoped to |
 *
 * The last three are exactly what `packages/telemetry/src/node/config.ts`
 * parses, and nothing else; with any of them absent the preload stays inert.
 * `DEBUGGEN_TOKEN` and `DEBUGGEN_INGEST_URL` are deliberately **absent from
 * `.env.example`** (AAP §0.3.4): they are per-launch wiring minted here, they
 * exist only in a child's environment, and a hand-set value is never valid.
 *
 * ⚠️ `DEBUGGEN_INGEST_URL` must be the **complete endpoint**, not a base URL:
 * the preload posts to it verbatim *and derives its `server-agent` WebSocket
 * control URL from that URL's origin* (no variable carries the control URL).
 * A base URL 404s every batch; a relative or non-loopback one leaves the
 * preload unable to arm, disarm or report. {@link resolveIngestUrl} composes it
 * from the protocol route table — never from a hand-written path.
 *
 * ## The credential
 *
 * Each launch mints a `server-agent` credential through the injected
 * {@link ServerAgentCredentialIssuer} (satisfied by `../server/auth.ts` through
 * {@link serverAgentCredentialIssuer}, AAP §0.5.6): a 32-byte CSPRNG token
 * stored only as a SHA-256 hash with `role: "server-agent"`, scoped to one
 * `projectRoot`, and **revoked when the launched process exits** — whichever
 * of the exit, `stop`, `stopForSession` or `stopAll` paths gets there first.
 * Revocation names that one credential: another credential of the same
 * project (a second child's, or one minted for a dev server the developer
 * started) keeps working.
 *
 * The credential is also a **lease**. It is issued with an expiry
 * ({@link DEFAULT_MANAGED_CREDENTIAL_LEASE_MS}) that the launcher renews while
 * the child runs, so the token never outlives its child by more than one lease
 * — not when the service crashes and a detached child survives it, and not
 * when the store refuses the revocation. A revocation that fails is retried
 * with backoff until it succeeds or the lease lapses, and until then `stop`
 * reports the cleanup as incomplete (`CLEANUP_PARTIAL`) instead of claiming a
 * clean stop. The token is a
 * capability: it lives in the child's environment and nowhere else in this
 * module's output — never in a log line, an error message, hint or details, a
 * {@link LaunchedDevServer} record, a detection, or any response other than the
 * credential route's own body. A dev server may echo its environment, which is
 * one reason its output never leaves this module (see "Child output" below).
 *
 * ## The credential route, and the CLI mirror
 *
 * `POST /dev-server/credential` ({@link DEV_SERVER_CREDENTIAL_PATH}) mints a
 * `server-agent` credential for a dev server the caller starts itself. This
 * service never observes that process's exit, so the credential is a
 * supervised lease instead ({@link DEFAULT_CLI_CREDENTIAL_LEASE_MS}): the
 * launcher renews it while the dev server's preload holds its `server-agent`
 * control connection, and revokes it
 * {@link CLI_CREDENTIAL_DISCONNECT_GRACE_MS} after that connection is gone,
 * at the end of its first lease when no preload ever connected with it, and
 * when the service shuts down; one nothing renews lapses within one lease.
 * It is the `devServer.credential` operation of `@debuggen/protocol`'s
 * route table, which owns its path, method and both body schemas: this module
 * reads the path and method off that row and re-exports the response schema,
 * and adds only the absolute-path check the Node-neutral protocol cannot make
 * ({@link devServerCredentialInputSchema}). `../server/routes/dev-server.ts`
 * answers the operation (editor role only — it is not auth-exempt) through
 * `../server/http.ts`'s table-driven registration and delegates to
 * {@link DevServerLauncher.issueCredential}, which owns the credential's scope
 * and lifetime; `../server/auth.ts` owns its role, storage and revocation.
 * `scripts/dev-instrumented.mjs` is the command-line mirror of this module
 * (its default mode asks this launcher to start the project through
 * `POST /dev-server/launch`, and it requests a credential through this route
 * with the editor credential).
 *
 * ## Launch, readiness and shutdown
 *
 * {@link DevServerLauncher.launch} validates the project root, reuses a child
 * it launched for the project, and otherwise asks `./detect.js` whether a dev
 * server already answers at the requested address — one it did not launch is
 * refused with the exact relaunch command rather than a second server fighting
 * for its port, because the preload is attributed only to its own children
 * ({@link DevServerLauncher.preloadServesAt}), and an address another process
 * holds — an answer detection could not identify as this project's server — is
 * refused before anything is minted or spawned — resolves the command (the
 * request's, or the package manager plus dev script detection selected) and
 * checks it before anything is minted: its `NAME=value` assignments against
 * {@link DEV_SERVER_COMMAND_ENV_ALLOWLIST}, and what it runs against
 * {@link checkLaunchCommand} — a package-manager run of one of the project's
 * dev-server scripts (a `package.json` script that runs `next dev`), `next
 * dev`, or the service's own Node running the project's
 * `node_modules/next/dist/bin/next dev`, each with only the Next.js dev
 * options {@link DEV_SERVER_ARGUMENT_ALLOWLIST} lists and no positional
 * argument, from `NODE_PATH` directories the service's user alone can write,
 * because `shell: false` decides how a program is spawned, never which one
 * (`sh -c '…'` would otherwise simply run `sh`). It then
 * mints the credential, spawns the child **without a shell option on any
 * platform** — on Windows `cmd.exe` is itself the executable, with a `/c` line
 * that refuses expansion and operator syntax instead of quoting around it
 * ({@link buildWindowsCommandInvocation}, checked before the credential is
 * minted) — digests its output (see "Child output" below), and waits, bounded
 * by the ready timeout, until the child is **verified**, never merely heard:
 *
 * 1. **Candidates.** A loopback URL the child prints is only a candidate, and
 *    only when the text immediately before it ends with a serving-address
 *    label: `Local:` or `url:` (Next.js, Vite, Nuxt, Astro), or `listening`,
 *    `listen`, `ready`, `started`, `serving`, `running` or `available`,
 *    optionally followed by `on`/`at` and a colon — as in
 *    `   - Local:   http://127.0.0.1:3000`, `ready - started server on
 *    0.0.0.0:3000, url: http://localhost:3000` or `Server listening on
 *    http://localhost:3000`. A link elsewhere on a line ("database is not
 *    ready; see http://localhost:4173/docs", "Can't reach database server at
 *    …") is never one ({@link announcedLoopbackUrls}). Every distinct
 *    `origin/` so labelled is kept in announcement order, the service's own
 *    port excluded, at most {@link MAX_READY_CANDIDATES} of them. The
 *    requested URL, when the caller supplied one, is tried after the
 *    candidates.
 * 2. **Probe.** Each verification round probes every current candidate (and
 *    the requested URL) concurrently, with a readiness probe timeout long
 *    enough for a cold `next dev` compiling its first request. A new
 *    candidate starts a round at once; otherwise rounds repeat every poll
 *    interval.
 * 3. **Ownership.** An answer (any HTTP status) is ready only when the
 *    operating system shows that **every** TCP listener on the answering
 *    port is held by the launched child or a process descended from it
 *    ({@link ListenerOwnership}, bounded by the readiness probe timeout):
 *    `/proc` on Linux, `lsof` and `ps` on macOS and other POSIX systems, one
 *    fixed PowerShell query on Windows. The first owned target in target
 *    order wins. A response header or a connected `server-agent` identifies
 *    nothing here: any Next.js server sends the same headers, and an agent's
 *    presence is per project, not per port. Nothing is ever ready without a
 *    probe that answered from the child's own listener.
 *
 * A child that exits, fails to spawn or outlives the ready timeout is
 * stopped; a timeout during which an address answered but was never shown to
 * be the child's own is reported as `ready-unverified` — with `ownership:
 * "other-process"` when another process held the port, `"unknown"` when the
 * lookup could not tell — distinct from `ready-timeout`.
 * Every failure is a typed `Err` with a developer-facing hint (AAP §0.5.5);
 * none leaves an orphan child, a pending timer or a live credential behind.
 * `stop` sends `SIGTERM` to the child's process group (a real POSIX spawn
 * leads its own group, so a framework's server worker is reached too) and
 * escalates to `SIGKILL` after a grace period; a child whose leader exits on
 * its own has its group reaped the same way. A group id is signalled directly
 * only while the leader is unreaped — its pid, hence the group id, cannot be
 * reused before then. After the leader exits, the id may already name an
 * unrelated process's group, so the launcher signals it only when a listing
 * taken immediately before ({@link ProcessGroupInspector}) still holds a
 * process it pinned in the group earlier — at spawn, at readiness and when a
 * stop begins — by pid and start time; a group that is gone, recycled or
 * cannot be listed is left alone for good (and logged, unless it is gone).
 * Where the inspector can answer synchronously (`/proc` on Linux,
 * {@link ProcessGroupInspector.confirm}), a pinned member of that listing is
 * confirmed again in the same synchronous step that sends the signal, and a
 * group none of whose pins still confirms is released as gone. What remains
 * is the width of that step — the confirming read and the `kill` system call
 * — because Node exposes no pidfd, so no pid-based signal is free of a final
 * syscall-width window; without `confirm` (a `ps`-based inspector) the window
 * runs from the listing to the signal.
 * `stopAll`/`dispose` are the first step of `../main.ts`'s graceful shutdown.
 *
 * ## Who owns a launched child
 *
 * A launch that names a session **spawns a session-owned child**: its
 * lifetime is tied to the sessions relying on it (AAP §0.7.1 Group 2). Every
 * later launch for the same project that names another session, and every
 * session created against that child's URL ({@link DevServerLauncher.acquireForSession},
 * a hold taken before the session exists and handed to it once it does),
 * joins its reference count; {@link DevServerLauncher.stopForSession} — called
 * when a session ends — stops it once the last of them has ended and no hold
 * is outstanding. A session that ends while its launch waits on another is
 * never added afterwards. A launch
 * that names no session spawns a **developer-owned child** that no session end
 * stops: it keeps serving with the inert preload attached (AAP §0.5.1) until
 * `stop`, the editor's deactivation or the service's shutdown. Reusing a
 * developer-owned child for a session does not transfer it to that session.
 * A launch for a session that has already ended is refused, because its child
 * would have no owner left to stop it.
 *
 * ## Child output: digested, never kept (CWE-532)
 *
 * A developer's dev server prints whatever its code and dependencies print:
 * source code frames, SQL with its literals, URLs with query values, props,
 * an echoed environment. None of that is this service's to keep, so **no line
 * of child output is ever logged (at any level), retained, or returned** — not
 * in a log record, an error message, hint or `details`, nor a
 * {@link LaunchedDevServer} record. Each line is read once, with terminal
 * control sequences stripped, for exactly three things — the first two kept
 * in the child's {@link DevServerOutputSummary}, the third on the child's
 * readiness state:
 *
 * - a line count per stream, and how many lines exceeded the inspected length;
 * - the closed set of {@link DevServerOutputDiagnostic} ids its fixed patterns
 *   recognise ({@link diagnoseOutputLine}) — a port in use, a missing module,
 *   a missing command, a permission error, a build error, running out of
 *   memory;
 * - the loopback addresses announced after a serving-address label — the
 *   readiness candidates, bounded and kept only as `origin/`.
 *
 * Startup failures turn the ids into fixed sentences and point the developer
 * at the dev script in a terminal for the full output; their `details.output`
 * and the ready, exited-before-ready, timeout, unverified and spawn-failure
 * log records carry the counts and ids alone, plus — for the timeout and
 * unverified cases — the candidates' count or loopback origins and the
 * ownership verdict, never text. The ownership lookups' own output is parsed
 * for process ids and dropped the same way: never logged, kept or returned.
 *
 * A child is reported stopped only once its exit has been observed. One still
 * running when its termination has run to the end — a refused or undelivered
 * signal, a process the platform will not end — is a **survivor**: its
 * credential is revoked (so its preload goes inert), it stays in the registry
 * as `failed` so {@link DevServerLauncher.list} shows it and the next stop,
 * launch or shutdown tries again, and it is reported to whoever asked — `stop`
 * answers an `Err` naming its pid, and `stopForSession`, `stopAll` and
 * `dispose` resolve a {@link DevServerTerminationReport} listing it. Its record
 * leaves the registry when its exit is finally observed.
 *
 * @example
 * ```ts
 * const launcher = createDevServerLauncher({
 *   config: { host: config.host, port: boundPort },
 *   logger,
 *   credentials: serverAgentCredentialIssuer(auth),
 *   parentEnv: env,
 * });
 * const launched = await launcher.launch({ projectRoot: '/home/dev/storefront', sessionId });
 * if (isOk(launched) && launched.value.managed) {
 *   // launched.value.devServerUrl, launched.value.pid
 * }
 * ```
 *
 * @module
 */

import { execFile, spawn as nodeSpawn } from 'node:child_process';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { readFile, readdir, readlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, isAbsolute as isNativeAbsolute, join, posix, win32 } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  HTTP_ROUTES,
  buildPath,
  describeZodIssues,
  devServerCredentialRequestSchema,
  devServerCredentialResponseSchema,
  type DevServerCredentialRequest,
  type DevServerCredentialResponse,
  type DevServerLaunchRequest,
  type DevServerLaunchResponse,
  type HttpOperationId,
} from '@debuggen/protocol';
import {
  DebuggenError,
  assertNever,
  err,
  isAbsolutePosix,
  isErr,
  isWindowsAbsolute,
  noopLogger,
  normalizePosix,
  nowEpochMs,
  ok,
  toPosix,
  type Logger,
  type Result,
} from '@debuggen/shared';
import { sha256Hex } from '@debuggen/shared/node';

import type { ServiceConfig } from '../config.js';
import {
  describeException,
  guardLogger,
  subsystemLogger,
  type ExceptionClass,
  type ExceptionDescription,
} from '../logging.js';
import {
  FRAMEWORK_DEV_CLIS,
  PRELOAD_DEPENDENT_SIGNALS,
  buildRelaunchHint,
  detectDevServer,
  packageManagerRunArgs,
  probeDevServer,
  type DevServerDetectDeps,
  type DevServerDetection,
  type ServerAgentPresence,
  type DevServerFramework,
  type DevServerProbeResult,
  type FrameworkDevCli,
} from './detect.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** The logger binding every line from this module carries (`subsystem`). */
const LOG_SUBSYSTEM = 'dev-server';

/**
 * The protocol operation whose route the preload posts to. Its path comes from
 * `@debuggen/protocol`'s `HTTP_ROUTES` through `buildPath`, never from a
 * hand-written literal, so a re-pathed route cannot leave the child posting to
 * a dead endpoint.
 */
const INGEST_OPERATION = 'telemetry.event' satisfies HttpOperationId;

/**
 * How long {@link DevServerLauncher.launch} waits for a spawned dev server to
 * answer, in milliseconds. A cold `next dev` compiles before it listens; a
 * minute covers a large project on a slow disk without making a broken command
 * look like a hang.
 */
export const DEFAULT_READY_TIMEOUT_MS = 60_000;

/**
 * How often readiness runs another verification round — re-probing every
 * candidate address and the requested URL — in milliseconds. A newly
 * announced candidate starts a round at once rather than waiting for this.
 */
export const DEFAULT_READY_POLL_INTERVAL_MS = 250;

/**
 * How long one readiness probe waits for an HTTP response, in milliseconds.
 *
 * Longer than detection's probe on purpose: a cold `next dev` compiles the
 * route on its first request before it answers, which can take seconds on a
 * large project. Never longer than the ready timeout itself (a longer value is
 * clamped to it), so one probe can never outlast the whole wait.
 */
export const DEFAULT_READY_PROBE_TIMEOUT_MS = 5_000;

/**
 * The most readiness candidates one launch keeps: distinct loopback origins
 * announced after a serving-address label. A dev server announces one or two
 * (`Local:` and perhaps an IPv6 or `127.0.0.1` twin); the bound keeps a child
 * that prints addresses in a loop from growing a round without limit.
 */
export const MAX_READY_CANDIDATES = 8;

/**
 * How long a stopping child has between `SIGTERM` and `SIGKILL`, in
 * milliseconds. Five seconds lets a framework flush and close its watchers.
 */
export const DEFAULT_STOP_GRACE_MS = 5_000;

/**
 * How long to wait for the `exit` event after `SIGKILL` before giving up on
 * observing it. `SIGKILL` cannot be ignored, so this only bounds a platform
 * that never reports the exit, or a signal that was never delivered; the
 * credential is revoked either way, and a child whose exit is still not
 * observed is reported as a survivor rather than as stopped.
 */
const KILL_CONFIRM_MS = 2_000;

/**
 * The longest one termination runs at the default settings, in milliseconds:
 * the {@link DEFAULT_STOP_GRACE_MS} after `SIGTERM`, then the bounded wait for
 * an exit after `SIGKILL`. A caller that awaits {@link DevServerLauncher.dispose}
 * under a bound of its own (the service shutdown) must allow at least this long,
 * or it abandons the wait before the report of a child that outlived its
 * termination arrives.
 */
export const DEFAULT_TERMINATION_BOUND_MS = DEFAULT_STOP_GRACE_MS + KILL_CONFIRM_MS;

/**
 * One lease of a credential minted through {@link DEV_SERVER_CREDENTIAL_PATH},
 * in milliseconds: five minutes.
 *
 * The caller starts that dev server itself, so this service never observes
 * its exit. What it observes is the preload's `server-agent` control
 * connection, which the preload holds for as long as the dev server runs. The
 * credential is therefore a supervised lease (AAP §0.5.6: a server-agent
 * credential expires when the launched process exits):
 *
 * - it is minted to expire one lease from now, and the launcher renews it to
 *   one lease from now at most every third of a lease — and only while a
 *   control connection authenticated with it is online;
 * - it is revoked {@link CLI_CREDENTIAL_DISCONNECT_GRACE_MS} after that
 *   connection is gone, and at the end of its first lease when no preload
 *   connected with it at all (without its control connection the preload
 *   receives no capture and ingests nothing);
 * - it is revoked when the service shuts down.
 *
 * A credential nothing renews any more — the service crashed, or its store
 * refused every renewal — stops authenticating within one lease. Without a
 * connection view ({@link DevServerLauncherDeps.serverAgentConnections})
 * nothing counts as connected, so the credential is revoked at the end of its
 * first lease.
 */
export const DEFAULT_CLI_CREDENTIAL_LEASE_MS = 5 * 60 * 1000;

/**
 * How often the launcher checks each {@link DEV_SERVER_CREDENTIAL_PATH}
 * credential's control connection, in milliseconds: every two seconds. A check
 * reads the connected-client view only; it reaches the store only to renew the
 * lease (at most every third of {@link DEFAULT_CLI_CREDENTIAL_LEASE_MS}) or to
 * revoke the credential.
 */
export const CLI_CREDENTIAL_CHECK_INTERVAL_MS = 2_000;

/**
 * How long a {@link DEV_SERVER_CREDENTIAL_PATH} credential outlives the loss of
 * its dev server's control connection, in milliseconds: twenty seconds. It
 * covers the preload reconnecting — a dev server restarting its worker, a
 * dropped socket — and bounds how long a credential copied out of an exited
 * dev server's environment keeps authenticating.
 */
export const CLI_CREDENTIAL_DISCONNECT_GRACE_MS = 20_000;

/**
 * The supervision of one {@link DEV_SERVER_CREDENTIAL_PATH} credential (see
 * {@link DEFAULT_CLI_CREDENTIAL_LEASE_MS}), from its issuance until it is
 * revoked or found gone.
 */
interface CliCredentialSupervision {
  /** The credential, its current expiry and the state of its invalidation. */
  readonly lease: CredentialLease;
  /**
   * When a control connection authenticated with the credential was last seen
   * online, in epoch milliseconds; `undefined` until one first is.
   */
  lastConnectedAt: number | undefined;
  /** Renewals that failed since the last one that succeeded; only the first of a run is logged. */
  renewFailures: number;
  /** The next check, while one is scheduled. */
  timer: ScheduledTimer | undefined;
}

/**
 * Lifetime of a launched child's credential lease, in milliseconds.
 *
 * The credential is revoked as soon as its child exits or is stopped; the
 * lease bounds what happens when that revocation cannot run — the service
 * crashed while a detached child survived, or the store refused the
 * revocation. The launcher renews the lease {@link LEASE_RENEWALS_PER_LEASE}
 * times per lease while the child runs, so a live dev server never loses
 * ingest, and a credential nothing renews any more stops authenticating within
 * fifteen minutes.
 */
export const DEFAULT_MANAGED_CREDENTIAL_LEASE_MS = 15 * 60 * 1000;

/**
 * How many renewals fall within one lease. Renewing every third of the lease
 * lets two consecutive renewals fail — a busy store, a slow disk — before the
 * lease lapses under a running child.
 */
export const LEASE_RENEWALS_PER_LEASE = 3;

/** Delay before the first retry of a failed revocation, in milliseconds. It doubles per attempt. */
export const REVOCATION_RETRY_INITIAL_MS = 1_000;

/** The longest delay between two revocation retries, in milliseconds. */
export const REVOCATION_RETRY_MAX_MS = 60_000;

/**
 * The longest prefix of one output line that is inspected for diagnostics and
 * for the serving address; a longer line is counted as truncated. The bound
 * keeps every pattern test linear in a small constant, whatever a child
 * prints. Nothing of the line is kept either way.
 */
const MAX_OUTPUT_LINE_LENGTH = 2_000;

/**
 * The longest unterminated output fragment held while waiting for a newline;
 * beyond it the fragment is emitted as a line, so a child that never prints a
 * newline cannot grow the buffer without bound.
 */
const MAX_PENDING_LINE_LENGTH = 8 * 1024;

/**
 * The closing sentence of a startup failure's hint whenever the child printed
 * anything: its output is not reproduced by this service, so the developer is
 * pointed at the one place it is visible in full.
 */
const FULL_OUTPUT_SENTENCE = 'Run the dev script in a terminal to read its full output.';

/**
 * A loopback URL a dev server prints — `http://localhost:3000`,
 * `http://127.0.0.1:5173`, `https://[::1]:8443`. A generic address shape, never
 * a framework banner string, so readiness works for any dev server; a
 * non-loopback "Network" address is deliberately not matched. Global, so every
 * address on a line is considered (see {@link announcedLoopbackUrls}).
 */
const LOOPBACK_URL_PATTERN = /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):\d{1,5}(?![\d])/gi;

/**
 * Every URL-shaped token of a line (`scheme://` up to the next whitespace).
 * Blanked — replaced by as many spaces, so positions are kept — before
 * {@link SERVING_ADDRESS_LABEL_PATTERN} reads the text in front of an
 * address, so a word inside an earlier address (`http://127.0.0.1:6379/ready
 * http://localhost:3000`) never labels the next one. Linear: one character
 * class, no nested quantifier.
 */
const URL_TOKEN_PATTERN = /\b[a-z][a-z\d+.-]*:\/\/\S*/gi;

/**
 * The serving-address label that must end the text immediately before a
 * loopback URL (trailing whitespace trimmed; at least one whitespace
 * character must separate the two) for that URL to be a readiness candidate:
 *
 * - `local:` or `url:` — Next.js 13+ and Vite (`- Local:`, `➜  Local:`), and
 *   the `url:` of Next.js 12's `ready - started server on …, url: …`;
 * - `listening`, `listen`, `ready`, `started`, `serving`, `running` or
 *   `available`, optionally followed by `on` or `at`, optionally by `:` —
 *   `Server listening on`, `Server running at`, `ready on`, `available at:`.
 *
 * Whole words, case-insensitively, so `local` never matches inside
 * "localhost" nor `url` inside "baseurl". A verb negated by `not` or `never`
 * right before it ("database is not ready: …") is no label. Anything else in
 * front of an address — "see", "at" after a noun, a bare link on an error
 * line — makes it no candidate, and neither does a label earlier on the line
 * than the text right before the URL (`…listening… see http://…`). A
 * candidate is still only a candidate; readiness verifies it.
 */
const SERVING_ADDRESS_LABEL_PATTERN =
  /(?:\b(?:local|url):|(?<!\b(?:not|never)\s{1,8})\b(?:listening|listen|ready|started|serving|running|available)(?:\s{1,16}(?:on|at))?:?)$/i;

/** The escape character that opens an ANSI control sequence. */
const ESCAPE_CODE = 0x1b;

/** The BEL character that may close an operating-system-command sequence. */
const BELL_CODE = 0x07;

/** Tokens a shell would treat as operators; without a shell they would be arguments. */
const SHELL_OPERATOR_TOKENS: ReadonlySet<string> = new Set([
  '&&',
  '||',
  '|',
  ';',
  '&',
  '>',
  '>>',
  '<',
  '<<',
  '2>',
  '2>&1',
]);

/** A leading `NAME=value` word of a command line: an environment assignment. */
const ENV_ASSIGNMENT_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** The highest TCP port. */
const MAX_TCP_PORT = 65_535;

/** How many ancestor directories the workspace preload candidate searches. */
const MAX_WORKSPACE_SEARCH_DEPTH = 8;

/**
 * How long one listener-ownership command (`lsof`, `ps`, PowerShell) may run
 * before it is killed and its answer read as "cannot tell", in milliseconds.
 * The launcher bounds a whole ownership check by the readiness probe timeout
 * besides; this keeps a hung command from outliving the check.
 */
export const DEFAULT_LISTENER_LOOKUP_TIMEOUT_MS = 3_000;

/** The most output one ownership command may print; more is killed and read as "cannot tell". */
const MAX_LOOKUP_OUTPUT_BYTES = 8 * 1024 * 1024;

/**
 * The largest process tree an ownership check walks. A dev server's tree is a
 * handful of processes; a bigger one (a fork bomb, a wrong root) is "cannot
 * tell" rather than an unbounded walk.
 */
const MAX_OWNERSHIP_TREE_SIZE = 4_096;

/** The most file descriptors an ownership check inspects across one tree on Linux. */
const MAX_INSPECTED_DESCRIPTORS = 65_536;

/** Where Linux exposes processes and socket tables. */
const PROC_ROOT = '/proc';

/** The Linux socket tables an ownership check reads: IPv4, then IPv6. */
const PROC_NET_TCP_TABLES: readonly string[] = Object.freeze([
  `${PROC_ROOT}/net/tcp`,
  `${PROC_ROOT}/net/tcp6`,
]);

/** The `st` column value of a TCP socket in the `LISTEN` state in `/proc/net/tcp*`. */
const PROC_TCP_LISTEN_STATE = '0A';

/**
 * A `local_address` of `/proc/net/tcp` (8 hex digits) or `/proc/net/tcp6`
 * (32), then `:` and the port in 4 hex digits.
 */
const PROC_LOCAL_ADDRESS_PATTERN = /^(?:[0-9A-F]{8}|[0-9A-F]{32}):([0-9A-F]{4})$/i;

/** What `readlink` shows for a socket descriptor under `/proc/<pid>/fd`. */
const PROC_SOCKET_LINK_PATTERN = /^socket:\[(\d{1,20})\]$/;

/** A decimal name under `/proc` (a pid, a tid, a descriptor number). */
const DECIMAL_NAME_PATTERN = /^\d{1,10}$/;

/** What PowerShell is resolved to when the service's environment names no usable `SystemRoot`. */
const DEFAULT_POWERSHELL = 'powershell.exe';

// ---------------------------------------------------------------------------
// The environment contract
// ---------------------------------------------------------------------------

/**
 * The four variables {@link buildDevServerEnv} sets in a launched child — the
 * whole of the instrumentation this module applies.
 *
 * `ingestUrl`, `token` and `projectRoot` name exactly the three variables
 * `packages/telemetry/src/node/config.ts` parses (and nothing else); with any
 * one absent the preload stays inert. `nodeOptions` is how the preload is
 * loaded at all. `DEBUGGEN_TOKEN` and `DEBUGGEN_INGEST_URL` are deliberately
 * kept **out of `.env.example`** (AAP §0.3.4): they exist only in a child's
 * environment, minted per launch. `./detect.ts` renders the relaunch command
 * from the same four names, so a developer's manual command and a launched
 * child carry the same wiring.
 */
export const PRELOAD_ENV_KEYS = Object.freeze({
  /** The full ingest endpoint; the preload derives its control socket from its origin. */
  ingestUrl: 'DEBUGGEN_INGEST_URL',
  /** The `server-agent` credential. Never logged, printed or persisted. */
  token: 'DEBUGGEN_TOKEN',
  /** The absolute project root the credential is scoped to. */
  projectRoot: 'DEBUGGEN_PROJECT_ROOT',
  /** Node's option list, **appended** with `--import <preload file URL>`. */
  nodeOptions: 'NODE_OPTIONS',
} as const);

/** One of the four variable names in {@link PRELOAD_ENV_KEYS}. */
export type PreloadEnvKey = (typeof PRELOAD_ENV_KEYS)[keyof typeof PRELOAD_ENV_KEYS];

/** An environment as the service holds it: `process.env`, or an injected record. */
export type ParentEnvironment = Readonly<Record<string, string | undefined>>;

/**
 * The Node option that loads the preload: `--import <file URL>`.
 *
 * Always a `file://` URL, never a bare path: `--import` resolves its argument
 * as an ES module specifier, where a bare absolute path is unreliable (a
 * Windows drive letter reads as a URL scheme) and a relative one resolves
 * against whatever directory the child starts in. `pathToFileURL`
 * percent-encodes spaces, quotes and backslashes, so the flag is a single
 * whitespace-free word that Node's `NODE_OPTIONS` splitter keeps intact.
 *
 * @param preloadPath Absolute path of `register.mjs`.
 * @returns `--import file:///…/register.mjs`.
 * @throws DebuggenError `CONFIG_INVALID` when the path is empty or relative — a
 * programmer error: {@link resolvePreloadPath} only ever yields absolute paths.
 *
 * @example
 * ```ts
 * buildPreloadImportFlag('/opt/debug gen/register.mjs');
 * // → '--import file:///opt/debug%20gen/register.mjs'
 * ```
 */
export function buildPreloadImportFlag(preloadPath: string): string {
  if (typeof preloadPath !== 'string' || !isAbsolutePath(preloadPath)) {
    throw new DebuggenError('CONFIG_INVALID', 'The telemetry preload path must be absolute.', {
      hint: 'Pass the absolute path resolvePreloadPath returned.',
      details: { reason: 'preload-path-not-absolute' },
    });
  }
  return `--import ${pathToFileURL(preloadPath).href}`;
}

/**
 * Append a flag to an inherited `NODE_OPTIONS` value — **never replace it**.
 *
 * A developer may already carry flags there (`--max-old-space-size`, their own
 * `--import` or `--require`); clobbering them would break their environment in
 * a way that looks like a bug in this tool. So:
 *
 * - existing flags are preserved verbatim and in order, and the flag is joined
 *   after them with a single space;
 * - `undefined`, empty and whitespace-only values count as empty, giving just
 *   the flag;
 * - the call is **idempotent**: when the identical flag is already present —
 *   as `--import <url>`, `--import=<url>` or with its value double-quoted — the
 *   input is returned unchanged;
 * - an unrelated `--import` of a different module is preserved, and the flag is
 *   appended after it.
 *
 * @param existing The inherited `NODE_OPTIONS`, if any.
 * @param flag The flag to add, normally {@link buildPreloadImportFlag}'s result.
 * @returns The combined option string.
 *
 * @example
 * ```ts
 * appendNodeOptions('--max-old-space-size=4096', '--import file:///p/register.mjs');
 * // → '--max-old-space-size=4096 --import file:///p/register.mjs'
 * ```
 */
export function appendNodeOptions(existing: string | undefined, flag: string): string {
  const trimmedFlag = flag.trim();
  const current = typeof existing === 'string' ? existing : '';
  if (current.trim().length === 0) {
    return trimmedFlag;
  }
  if (trimmedFlag.length === 0 || containsFlag(current, trimmedFlag)) {
    return current;
  }
  return `${current.trim()} ${trimmedFlag}`;
}

/**
 * Whether `options` already carries `flag`: its words as a contiguous run, or —
 * for a two-word `--name value` flag — the `--name=value` spelling. Surrounding
 * double quotes on a word are ignored, since Node accepts a quoted value.
 */
function containsFlag(options: string, flag: string): boolean {
  const words = options
    .split(/\s+/)
    .filter((word) => word.length > 0)
    .map(unquoteWord);
  const flagWords = flag
    .split(/\s+/)
    .filter((word) => word.length > 0)
    .map(unquoteWord);
  const [name, value] = flagWords;
  if (name === undefined) {
    return false;
  }

  for (let index = 0; index + flagWords.length <= words.length; index += 1) {
    if (flagWords.every((word, offset) => words[index + offset] === word)) {
      return true;
    }
  }
  return flagWords.length === 2 && value !== undefined && words.includes(`${name}=${value}`);
}

/** A word with one pair of surrounding double quotes removed. */
function unquoteWord(word: string): string {
  if (word.length >= 2 && word.startsWith('"') && word.endsWith('"')) {
    return word.slice(1, -1);
  }
  const equals = word.indexOf('=');
  if (equals > 0 && word.length > equals + 2 && word[equals + 1] === '"' && word.endsWith('"')) {
    return `${word.slice(0, equals + 1)}${word.slice(equals + 2, -1)}`;
  }
  return word;
}

/**
 * Where the service can be reached: its bound host and port, or an already
 * formed base URL (for a service behind a known address, and for tests).
 */
export type IngestUrlInput =
  | Pick<ServiceConfig, 'host' | 'port'>
  | { readonly host: string; readonly port: number }
  | { readonly baseUrl: string };

/**
 * The **absolute** ingest endpoint a launched child receives as
 * `DEBUGGEN_INGEST_URL`: `http://<host>:<port>` plus the path of the protocol's
 * `telemetry.event` operation, taken from `HTTP_ROUTES` through `buildPath`.
 *
 * - An IPv6 host is bracketed (`::1` → `[::1]`); an already bracketed one is kept.
 * - The port must be the port the service is **bound** to: `0` (the
 *   "ephemeral" configuration value) is refused, because a child cannot reach
 *   it.
 * - A `baseUrl` keeps its origin and any path prefix, drops query and fragment,
 *   and must not embed credentials; the join has exactly one slash.
 *
 * The result round-trips through `new URL(…)` unchanged. It is the same
 * composition `./detect.ts` uses for the relaunch command, so a manual relaunch
 * and a launched child name the same endpoint.
 *
 * @param input The service's address.
 * @returns e.g. `http://127.0.0.1:43117/telemetry/ingest`.
 * @throws DebuggenError `CONFIG_INVALID` for a host, port or base URL that
 * cannot form a reachable endpoint; the message never echoes a URL.
 */
export function resolveIngestUrl(input: IngestUrlInput): string {
  const path = buildPath(INGEST_OPERATION);
  const base =
    'baseUrl' in input ? baseOfUrl(input.baseUrl) : baseOfAddress(input.host, input.port);
  const joined = `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
  return new URL(joined).href;
}

/** `http://<authority>:<port>` from a host and a bound port. */
function baseOfAddress(host: string, port: number): string {
  const trimmed = typeof host === 'string' ? host.trim() : '';
  if (
    trimmed.length === 0 ||
    /\s/.test(trimmed) ||
    trimmed.includes('/') ||
    trimmed.includes('@')
  ) {
    throw ingestAddressError('invalid-host', 'The service host cannot form an ingest URL.');
  }
  if (!Number.isInteger(port) || port < 1 || port > MAX_TCP_PORT) {
    throw ingestAddressError(
      'port-not-bound',
      'The service port is not a bound TCP port, so a launched dev server could not reach it.',
    );
  }
  const authority = trimmed.includes(':') && !trimmed.startsWith('[') ? `[${trimmed}]` : trimmed;
  try {
    const url = new URL(`http://${authority}:${String(port)}`);
    return url.origin;
  } catch (cause) {
    throw ingestAddressError('invalid-host', 'The service host cannot form an ingest URL.', cause);
  }
}

/** Origin plus path prefix of a base URL, with query, fragment and trailing slashes dropped. */
function baseOfUrl(baseUrl: string): string {
  let url: URL;
  try {
    url = new URL(typeof baseUrl === 'string' ? baseUrl.trim() : '');
  } catch (cause) {
    throw ingestAddressError(
      'invalid-base-url',
      'The service base URL is not an absolute URL.',
      cause,
    );
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw ingestAddressError('invalid-base-url', 'The service base URL must use http: or https:.');
  }
  if (url.username !== '' || url.password !== '') {
    throw ingestAddressError(
      'invalid-base-url',
      'The service base URL must not embed credentials.',
    );
  }
  if (url.host.length === 0) {
    throw ingestAddressError('invalid-base-url', 'The service base URL has no host.');
  }
  return `${url.origin}${url.pathname}`;
}

/** The `CONFIG_INVALID` error of {@link resolveIngestUrl}; never echoes the input. */
function ingestAddressError(reason: string, message: string, cause?: unknown): DebuggenError {
  return new DebuggenError('CONFIG_INVALID', message, {
    hint: 'Launch dev servers only after the service is listening, and pass the host and bound port it listens on.',
    details: { reason },
    ...(cause === undefined ? {} : { cause }),
  });
}

/** The shape of {@link DEV_SERVER_ENV_ALLOWLIST}. */
export interface DevServerEnvAllowlist {
  /** Exact variable names, upper-case; compared case-insensitively on Windows. */
  readonly names: readonly string[];
  /** Name prefixes, upper-case; compared case-insensitively on Windows. */
  readonly prefixes: readonly string[];
  /**
   * Lower-case spellings also honoured on POSIX, where names are
   * case-sensitive and the proxy variables are conventionally lower-case.
   */
  readonly posixLowercaseNames: readonly string[];
}

/** The locale and time-zone variables: a program's language, message catalogue and clock. */
const LOCALE_NAMES = ['LANG', 'LANGUAGE', 'TZ'] as const;

/** What the platform needs to run a program: search path, identity, temp, locale. */
const PLATFORM_RUNTIME_NAMES = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'USERNAME',
  'SHELL',
  'TMPDIR',
  'TMP',
  'TEMP',
  ...LOCALE_NAMES,
] as const;

/** What Windows needs to run a program, a `.cmd` shim and `cmd.exe` itself. */
const WINDOWS_RUNTIME_NAMES = [
  'PATHEXT',
  'SYSTEMROOT',
  'SYSTEMDRIVE',
  'WINDIR',
  'COMSPEC',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMDATA',
  'ALLUSERSPROFILE',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'PROGRAMW6432',
  'COMMONPROGRAMFILES',
  'COMMONPROGRAMFILES(X86)',
  'COMMONPROGRAMW6432',
  'PUBLIC',
  'OS',
  'PROCESSOR_ARCHITECTURE',
  'NUMBER_OF_PROCESSORS',
  'COMPUTERNAME',
  'USERDOMAIN',
] as const;

/** The proxy variables, which package managers and `fetch` read in either casing. */
const PROXY_NAMES = ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY'] as const;

/** What Node and the package managers need to resolve, trust and install. */
const TOOLCHAIN_NAMES = [
  'NODE_ENV',
  'NODE_PATH',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  ...PROXY_NAMES,
  'PNPM_HOME',
  'VOLTA_HOME',
  'BUN_INSTALL',
] as const;

/** Terminal and colour switches a dev server's output honours. */
const TERMINAL_NAMES = ['TERM', 'COLORTERM', 'FORCE_COLOR', 'NO_COLOR', 'CI'] as const;

/** The dev server's own address and file-watching switches. */
const DEV_SERVER_NAMES = [
  'PORT',
  'HOST',
  'HOSTNAME',
  'WATCHPACK_POLLING',
  'CHOKIDAR_USEPOLLING',
] as const;

/**
 * The target's database variables: `DATABASE_URL` as the product's
 * `.env.example` documents it, and the connection variables the supported
 * `pg` driver reads.
 */
const DATABASE_NAMES = [
  'DATABASE_URL',
  'PGHOST',
  'PGPORT',
  'PGDATABASE',
  'PGUSER',
  'PGPASSWORD',
  'PGSSLMODE',
] as const;

/** Developer configuration shared with the preload, which reads its log level. */
const SHARED_DEVELOPER_NAMES = ['DEBUGGEN_LOG_LEVEL'] as const;

/**
 * The service variables a launched dev server inherits — the **whole** of
 * what passes from the service's environment into a target application
 * (see {@link isForwardedToDevServer}). A variable is forwarded when its name
 * is one of `names` or starts with one of `prefixes` — case-insensitively on
 * Windows — or, on POSIX, is one of `posixLowercaseNames`.
 *
 * - platform runtime: `PATH`, `HOME`, `USER`, `LOGNAME`, `USERNAME`, `SHELL`,
 *   `TMPDIR`, `TMP`, `TEMP`, `LANG`, `LANGUAGE`, `TZ`, and `LC_*`, `XDG_*`;
 * - Windows runtime: `PATHEXT`, `SYSTEMROOT`, `WINDIR`, `COMSPEC`,
 *   `USERPROFILE`, `APPDATA`, the `PROGRAMFILES` family and the other
 *   variables a `.cmd` shim or `cmd.exe` reads;
 * - Node and package managers: `NODE_ENV`, `NODE_PATH`, `NODE_EXTRA_CA_CERTS`,
 *   `SSL_CERT_FILE`, `SSL_CERT_DIR`, the proxy variables, `PNPM_HOME`,
 *   `VOLTA_HOME`, `BUN_INSTALL`, and `COREPACK_*`, `NVM_*`, `FNM_*`;
 * - terminal: `TERM`, `COLORTERM`, `FORCE_COLOR`, `NO_COLOR`, `CI`;
 * - dev server and framework: `PORT`, `HOST`, `HOSTNAME`, `WATCHPACK_POLLING`,
 *   `CHOKIDAR_USEPOLLING`, and `NEXT_*` (`NEXT_OTEL_VERBOSE`,
 *   `NEXT_TELEMETRY_DISABLED`, `NEXT_PUBLIC_*`);
 * - the target's database: `DATABASE_URL`, `PGHOST`, `PGPORT`, `PGDATABASE`,
 *   `PGUSER`, `PGPASSWORD`, `PGSSLMODE`;
 * - shared developer configuration: `DEBUGGEN_LOG_LEVEL`.
 *
 * Deliberately absent: `ANTHROPIC_API_KEY` and every other `DEBUGGEN_*`
 * (service-only configuration and credentials), `VSCODE_*` and `ELECTRON_*`
 * (the editor's), `npm_config_*` (a package manager re-derives its own), and
 * every cloud or source-control credential. Widening the list is a security
 * decision: a name added here reaches every dependency of every target app.
 */
export const DEV_SERVER_ENV_ALLOWLIST: DevServerEnvAllowlist = Object.freeze({
  names: Object.freeze([
    ...PLATFORM_RUNTIME_NAMES,
    ...WINDOWS_RUNTIME_NAMES,
    ...TOOLCHAIN_NAMES,
    ...TERMINAL_NAMES,
    ...DEV_SERVER_NAMES,
    ...DATABASE_NAMES,
    ...SHARED_DEVELOPER_NAMES,
  ]),
  prefixes: Object.freeze(['LC_', 'XDG_', 'COREPACK_', 'NVM_', 'FNM_', 'NEXT_']),
  posixLowercaseNames: Object.freeze(PROXY_NAMES.map((name) => name.toLowerCase())),
});

/** Membership over {@link DEV_SERVER_ENV_ALLOWLIST}'s exact names. */
const FORWARDED_NAME_SET: ReadonlySet<string> = new Set(DEV_SERVER_ENV_ALLOWLIST.names);

/** Membership over {@link DEV_SERVER_ENV_ALLOWLIST}'s POSIX lower-case spellings. */
const FORWARDED_POSIX_LOWERCASE_SET: ReadonlySet<string> = new Set(
  DEV_SERVER_ENV_ALLOWLIST.posixLowercaseNames,
);

/** The four {@link PRELOAD_ENV_KEYS} names, which are set rather than forwarded. */
const PRELOAD_KEY_SET: ReadonlySet<string> = new Set(Object.values(PRELOAD_ENV_KEYS));

/**
 * Whether a service variable is copied into a launched dev server's
 * environment: its name is on {@link DEV_SERVER_ENV_ALLOWLIST} — compared
 * case-insensitively on `win32`, exactly elsewhere. The four
 * {@link PRELOAD_ENV_KEYS} answer `false`: they are never copied as they are
 * (the inherited `NODE_OPTIONS` is the base the preload flag is appended to,
 * and the three `DEBUGGEN_*` wiring keys are always overwritten).
 *
 * @param name A variable name from the service's environment.
 * @param platform Whose name semantics apply. Default: this process's.
 * @returns `true` when {@link buildDevServerEnv} forwards it.
 *
 * @example
 * ```ts
 * isForwardedToDevServer('DATABASE_URL', 'linux');     // → true
 * isForwardedToDevServer('SystemRoot', 'win32');       // → true
 * isForwardedToDevServer('ANTHROPIC_API_KEY', 'linux'); // → false
 * ```
 */
export function isForwardedToDevServer(
  name: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (typeof name !== 'string' || name.length === 0) {
    return false;
  }
  const key = platform === 'win32' ? name.toUpperCase() : name;
  if (PRELOAD_KEY_SET.has(key)) {
    return false;
  }
  return (
    FORWARDED_NAME_SET.has(key) ||
    DEV_SERVER_ENV_ALLOWLIST.prefixes.some((prefix) => key.startsWith(prefix)) ||
    (platform !== 'win32' && FORWARDED_POSIX_LOWERCASE_SET.has(name))
  );
}

/** The shape of {@link DEV_SERVER_COMMAND_ENV_ALLOWLIST}. */
export interface DevServerCommandEnvAllowlist {
  /** Exact variable names a launch command may assign, upper-case; compared case-insensitively on Windows. */
  readonly names: readonly string[];
  /** Name prefixes a launch command may assign, upper-case; compared case-insensitively on Windows. */
  readonly prefixes: readonly string[];
  /**
   * Names a launch command may assign only with a value that passes that
   * name's own check: `NODE_OPTIONS` (see {@link LAUNCH_NODE_OPTIONS_ALLOWLIST})
   * and `NODE_PATH` (absolute `node_modules` directories only, each one the
   * service trusts — see {@link checkLaunchCommand}).
   */
  readonly valueCheckedNames: readonly string[];
}

/**
 * The variables a request's launch command may assign with a leading
 * `NAME=value` word — a **much narrower** list than
 * {@link DEV_SERVER_ENV_ALLOWLIST}, because an assignment arrives in a request
 * rather than from the service's own environment, and a variable that
 * changes what the platform, Node or a package manager loads (`LD_PRELOAD`,
 * `NODE_OPTIONS=--require …`, `BASH_ENV`, `npm_config_node_options`, `PATH`)
 * would run code of the requester's choosing inside the child despite
 * `shell: false` (CWE-78). A name is admitted when it is one of `names` or
 * starts with one of `prefixes` — case-insensitively on Windows, exactly
 * elsewhere — or is one of `valueCheckedNames` with a value that passes its
 * check ({@link checkLaunchAssignment}):
 *
 * - the dev server's own settings: `NODE_ENV`, `PORT`, `HOST`, `HOSTNAME`,
 *   `WATCHPACK_POLLING`, `CHOKIDAR_USEPOLLING`, `NEXT_TELEMETRY_DISABLED`,
 *   `NEXT_OTEL_VERBOSE`, and the application's public build-time values
 *   `NEXT_PUBLIC_*`;
 * - terminal and locale: `TERM`, `COLORTERM`, `FORCE_COLOR`, `NO_COLOR`,
 *   `CI`, `LANG`, `LANGUAGE`, `TZ`, and `LC_*`;
 * - the target's database: `DATABASE_URL`, `PGHOST`, `PGPORT`, `PGDATABASE`,
 *   `PGUSER`, `PGPASSWORD`, `PGSSLMODE`;
 * - shared developer configuration: `DEBUGGEN_LOG_LEVEL`;
 * - value-checked: `NODE_OPTIONS` (diagnostic and memory flags only, see
 *   {@link LAUNCH_NODE_OPTIONS_ALLOWLIST}) and `NODE_PATH` (absolute paths of
 *   `node_modules` directories only, and — checked by
 *   {@link checkLaunchCommand} — existing ones owned by the service's user
 *   that no one else can write).
 *
 * Deliberately absent, so a launch command assigning one is refused before
 * anything is minted or spawned: `PATH`, `HOME`, `SHELL`, `TMPDIR` and
 * `XDG_*` (what finds and configures executables), the Windows runtime
 * variables (`COMSPEC`, `SYSTEMROOT`, `PATHEXT` …), the proxy and CA/TLS
 * variables, the toolchain homes (`PNPM_HOME`, `VOLTA_HOME`, `BUN_INSTALL`,
 * `COREPACK_*`, `NVM_*`, `FNM_*`), every other `DEBUGGEN_*` — the three
 * wiring keys included, which the launcher alone sets — `npm_config_*`,
 * `LD_*` and `DYLD_*` (dynamic-loader injection), `BASH_ENV` and `ENV`
 * (shell start-up files), every other `NEXT_*` — Next.js's internal switches
 * redirect what it serves and where it reports: `NEXT_PRIVATE_DEV_DIR`
 * replaces the project directory `next dev` serves, `NEXT_TRACE_UPLOAD_FULL`
 * widens what `--experimental-upload-trace` sends off the machine,
 * `NEXT_DIST_DIR` moves the build output — and anything unrecognised.
 * Variables a target application reads for itself belong in the project's
 * own `.env` files, which Next.js loads without any help from this service.
 *
 * The service's **own** environment is judged by the wider
 * {@link DEV_SERVER_ENV_ALLOWLIST}, which still forwards every `NEXT_*`: those
 * values are the developer's, set before the service started, not a
 * request's. Widening this list is a security decision: every name added
 * here is one a request may set.
 */
export const DEV_SERVER_COMMAND_ENV_ALLOWLIST: DevServerCommandEnvAllowlist = Object.freeze({
  names: Object.freeze([
    'NODE_ENV',
    ...DEV_SERVER_NAMES,
    'NEXT_TELEMETRY_DISABLED',
    'NEXT_OTEL_VERBOSE',
    ...TERMINAL_NAMES,
    ...LOCALE_NAMES,
    ...DATABASE_NAMES,
    ...SHARED_DEVELOPER_NAMES,
  ]),
  prefixes: Object.freeze(['NEXT_PUBLIC_', 'LC_']),
  valueCheckedNames: Object.freeze([PRELOAD_ENV_KEYS.nodeOptions, 'NODE_PATH']),
});

/** The shape of {@link LAUNCH_NODE_OPTIONS_ALLOWLIST}. */
export interface LaunchNodeOptionsAllowlist {
  /** Flags that take no value, e.g. `--enable-source-maps`. */
  readonly booleanFlags: readonly string[];
  /**
   * Flags that take one value, as `--flag=value` or `--flag value`; the value
   * must match {@link LAUNCH_NODE_OPTIONS_ALLOWLIST}'s `valuePattern`.
   */
  readonly valuedFlags: readonly string[];
  /** What a valued flag's value must match: 1–64 characters of `A–Z a–z 0–9 . _ : + -`. */
  readonly valuePattern: RegExp;
}

/**
 * The only Node options an assigned `NODE_OPTIONS` may hold: diagnostics
 * (warnings, deprecations, source maps, uncaught-exception traces) and memory
 * or parser limits. Every flag that loads or evaluates code or opens a
 * debugger — `--require`/`-r`, `--import`, `--loader`,
 * `--experimental-loader`, `--inspect*`, `--eval`, `--openssl-config`,
 * `--env-file`, and every flag not listed — is refused, because the value
 * reaches the child's Node verbatim. The service appends its own preload
 * `--import` after the assigned value (see {@link appendNodeOptions}); an
 * empty value is allowed and clears an inherited `NODE_OPTIONS`.
 */
export const LAUNCH_NODE_OPTIONS_ALLOWLIST: LaunchNodeOptionsAllowlist = Object.freeze({
  booleanFlags: Object.freeze([
    '--enable-source-maps',
    '--no-deprecation',
    '--no-warnings',
    '--trace-warnings',
    '--trace-deprecation',
    '--trace-uncaught',
    '--trace-exit',
    '--throw-deprecation',
    '--pending-deprecation',
  ]),
  valuedFlags: Object.freeze([
    '--max-old-space-size',
    '--max-semi-space-size',
    '--max-http-header-size',
    '--stack-trace-limit',
    '--unhandled-rejections',
    '--dns-result-order',
    '--disable-warning',
  ]),
  valuePattern: /^[A-Za-z0-9._:+-]{1,64}$/,
});

/** Membership over {@link DEV_SERVER_COMMAND_ENV_ALLOWLIST}'s exact names. */
const LAUNCH_ASSIGNMENT_NAME_SET: ReadonlySet<string> = new Set(
  DEV_SERVER_COMMAND_ENV_ALLOWLIST.names,
);

/** Membership over {@link LAUNCH_NODE_OPTIONS_ALLOWLIST}'s boolean flags. */
const LAUNCH_BOOLEAN_FLAG_SET: ReadonlySet<string> = new Set(
  LAUNCH_NODE_OPTIONS_ALLOWLIST.booleanFlags,
);

/** Membership over {@link LAUNCH_NODE_OPTIONS_ALLOWLIST}'s valued flags. */
const LAUNCH_VALUED_FLAG_SET: ReadonlySet<string> = new Set(
  LAUNCH_NODE_OPTIONS_ALLOWLIST.valuedFlags,
);

/** The last path segment a `NODE_PATH` entry must name. */
const NODE_MODULES_SEGMENT = 'node_modules';

/** The variable whose directories Node searches for modules, as `NODE_PATH` spells it on every platform. */
const NODE_PATH_NAME = 'NODE_PATH';

/**
 * Why a launch command's `NAME=value` assignment is refused — the
 * `details.reason` of {@link parseLaunchCommand}'s refusal:
 *
 * - `'env-assignment-not-allowed'` — the name is not on
 *   {@link DEV_SERVER_COMMAND_ENV_ALLOWLIST};
 * - `'node-options-not-allowed'` — a `NODE_OPTIONS` value holding a word
 *   {@link LAUNCH_NODE_OPTIONS_ALLOWLIST} does not admit;
 * - `'node-path-not-allowed'` — a `NODE_PATH` value with an entry that is not
 *   an absolute path of a `node_modules` directory; {@link checkLaunchCommand}
 *   answers the same reason for an entry that is not a directory the service
 *   trusts ({@link isTrustedNodePathDirectory}).
 */
export type LaunchAssignmentRefusal =
  'env-assignment-not-allowed' | 'node-options-not-allowed' | 'node-path-not-allowed';

/**
 * Check one `NAME=value` assignment of a launch command against
 * {@link DEV_SERVER_COMMAND_ENV_ALLOWLIST}: the name must be on the list —
 * compared case-insensitively on `win32`, exactly elsewhere — and a
 * `NODE_OPTIONS` or `NODE_PATH` value must pass its own check:
 *
 * - `NODE_OPTIONS`: split on whitespace, every word is a
 *   {@link LAUNCH_NODE_OPTIONS_ALLOWLIST} boolean flag, or a valued flag as
 *   `--flag=value` or `--flag value` whose value matches its `valuePattern`
 *   (the separate value may not start with `-`); empty is allowed;
 * - `NODE_PATH`: split on `:` (`;` on Windows), every entry is non-empty,
 *   absolute for the platform, free of NUL, CR and LF, and its last segment is
 *   `node_modules`. This check is syntactic and reads no filesystem; that
 *   each entry is a directory only the service's user can write is
 *   {@link checkLaunchCommand}'s check.
 *
 * @param name The assigned variable name.
 * @param value The assigned value.
 * @param platform Whose name and path semantics apply. Default: this process's.
 * @returns `undefined` when the assignment is allowed, else why it is refused.
 *
 * @example
 * ```ts
 * checkLaunchAssignment('NEXT_TELEMETRY_DISABLED', '1', 'linux');           // → undefined
 * checkLaunchAssignment('LD_PRELOAD', '/tmp/x.so', 'linux');                // → 'env-assignment-not-allowed'
 * checkLaunchAssignment('NODE_OPTIONS', '--require=/tmp/x.js', 'linux');    // → 'node-options-not-allowed'
 * ```
 */
export function checkLaunchAssignment(
  name: string,
  value: string,
  platform: NodeJS.Platform = process.platform,
): LaunchAssignmentRefusal | undefined {
  if (typeof name !== 'string' || name.length === 0 || typeof value !== 'string') {
    return 'env-assignment-not-allowed';
  }
  const key = platform === 'win32' ? name.toUpperCase() : name;
  if (key === PRELOAD_ENV_KEYS.nodeOptions) {
    return isAllowedLaunchNodeOptions(value) ? undefined : 'node-options-not-allowed';
  }
  if (key === 'NODE_PATH') {
    return isAllowedLaunchNodePath(value, platform) ? undefined : 'node-path-not-allowed';
  }
  const listed =
    LAUNCH_ASSIGNMENT_NAME_SET.has(key) ||
    DEV_SERVER_COMMAND_ENV_ALLOWLIST.prefixes.some((prefix) => key.startsWith(prefix));
  return listed ? undefined : 'env-assignment-not-allowed';
}

/**
 * Whether a launch command may make the assignment `name=value`: exactly
 * when {@link checkLaunchAssignment} finds nothing to refuse.
 *
 * @param name The assigned variable name.
 * @param value The assigned value.
 * @param platform Whose name and path semantics apply. Default: this process's.
 * @returns `true` when the assignment reaches the child.
 */
export function isAllowedLaunchAssignment(
  name: string,
  value: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return checkLaunchAssignment(name, value, platform) === undefined;
}

/** Whether every word of an assigned `NODE_OPTIONS` is an allowlisted flag; see {@link checkLaunchAssignment}. */
function isAllowedLaunchNodeOptions(value: string): boolean {
  const words = value.split(/\s+/).filter((word) => word.length > 0);
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index] ?? '';
    if (LAUNCH_BOOLEAN_FLAG_SET.has(word)) {
      continue;
    }
    const equals = word.indexOf('=');
    if (equals > 0) {
      if (
        !LAUNCH_VALUED_FLAG_SET.has(word.slice(0, equals)) ||
        !LAUNCH_NODE_OPTIONS_ALLOWLIST.valuePattern.test(word.slice(equals + 1))
      ) {
        return false;
      }
      continue;
    }
    const next = words[index + 1];
    if (
      !LAUNCH_VALUED_FLAG_SET.has(word) ||
      next === undefined ||
      next.startsWith('-') ||
      !LAUNCH_NODE_OPTIONS_ALLOWLIST.valuePattern.test(next)
    ) {
      return false;
    }
    index += 1;
  }
  return true;
}

/** Whether every entry of an assigned `NODE_PATH` is an absolute `node_modules` directory. */
function isAllowedLaunchNodePath(value: string, platform: NodeJS.Platform): boolean {
  const windows = platform === 'win32';
  const entries = value.split(windows ? ';' : ':');
  return entries.every((entry) => {
    if (entry.length === 0 || /[\0\r\n]/.test(entry)) {
      return false;
    }
    if (windows ? !WINDOWS_ROOTED_PATH.test(entry) : !isAbsolutePosix(entry)) {
      return false;
    }
    const segments = entry.split(windows ? /[\\/]+/ : /\/+/).filter((part) => part.length > 0);
    const last = segments.at(-1) ?? '';
    return windows ? last.toLowerCase() === NODE_MODULES_SEGMENT : last === NODE_MODULES_SEGMENT;
  });
}

/** Input of {@link buildDevServerEnv}. */
export interface DevServerEnvInput {
  /**
   * The service's environment; read, never mutated. Only the variables
   * {@link isForwardedToDevServer} admits reach the child.
   */
  readonly parentEnv: ParentEnvironment;
  /**
   * The launch command's explicit `NAME=value` assignments
   * ({@link ParsedLaunchCommand.env}) — the dev-server settings the developer
   * approved. Every one must pass {@link checkLaunchAssignment}
   * ({@link DEV_SERVER_COMMAND_ENV_ALLOWLIST}); {@link parseLaunchCommand}
   * already refuses any other, and this function checks again rather than
   * trust its caller. Applied after the filtered parent, so an assigned
   * `NODE_OPTIONS` replaces the inherited one and is then appended to.
   * Default: none.
   */
  readonly launchEnv?: Readonly<Record<string, string>> | undefined;
  /** Absolute path of the project; becomes `DEBUGGEN_PROJECT_ROOT`. */
  readonly projectRoot: string;
  /** The full ingest endpoint from {@link resolveIngestUrl}. */
  readonly ingestUrl: string;
  /** The `server-agent` credential; becomes `DEBUGGEN_TOKEN` and nothing else. */
  readonly token: string;
  /** Absolute path of `register.mjs`; appended to `NODE_OPTIONS`. */
  readonly preloadPath: string;
  /**
   * The platform whose environment semantics apply. On `win32` variable names
   * are case-insensitive, so a differently cased `Node_Options` is folded into
   * the one `NODE_OPTIONS` key rather than duplicated. Default: this process's.
   */
  readonly platform?: NodeJS.Platform | undefined;
}

/**
 * The launched child's environment — a **minimal** one, never a copy of the
 * service's, built in three layers:
 *
 * 1. the `parentEnv` variables {@link isForwardedToDevServer} admits
 *    ({@link DEV_SERVER_ENV_ALLOWLIST}), byte for byte in their own spelling;
 * 2. `launchEnv`, the launch command's explicit `NAME=value` assignments —
 *    each one admitted by {@link checkLaunchAssignment}
 *    ({@link DEV_SERVER_COMMAND_ENV_ALLOWLIST}) — replacing a same-named
 *    parent variable;
 * 3. exactly the four {@link PRELOAD_ENV_KEYS}: `NODE_OPTIONS` — the assigned
 *    value, else the inherited one — appended with the preload's `--import`
 *    flag (see {@link appendNodeOptions}), and the three `DEBUGGEN_*` wiring
 *    keys assigned, overwriting any inherited value, because a stale
 *    credential must never reach the child.
 *
 * Every other service variable — `ANTHROPIC_API_KEY`, `DEBUGGEN_HOME`, the
 * editor's `VSCODE_*`, a cloud credential — is dropped, so service-only
 * credentials never reach the target app and its dependencies; a developer
 * gives the app more variables through its own `.env` files. On `win32` names
 * compare case-insensitively, so a `Path` or `Node_Options` is matched and
 * replaced rather than duplicated under a second spelling. Inputs are never
 * mutated, and `undefined` values are dropped, so the result is a clean
 * `Record<string, string>`.
 *
 * @param input The service environment, the launch assignments and the four values.
 * @returns A fresh environment object for `spawn`.
 * @throws DebuggenError `PROJECT_NOT_FOUND` for a relative project root, and
 * `CONFIG_INVALID` for an empty credential, a relative preload path, an
 * ingest endpoint that is not an absolute `http(s)` URL, or a `launchEnv`
 * assignment {@link checkLaunchAssignment} refuses (`details.reason:
 * "launch-env-not-allowed"`). No message, hint or detail ever carries the
 * credential, an assigned name or an assigned value.
 */
export function buildDevServerEnv(input: DevServerEnvInput): Record<string, string> {
  if (typeof input.projectRoot !== 'string' || !isAbsolutePath(input.projectRoot)) {
    throw new DebuggenError('PROJECT_NOT_FOUND', 'The dev-server project root must be absolute.', {
      hint: 'Pass the absolute path of the project folder.',
      details: { reason: 'project-root-not-absolute' },
    });
  }
  if (typeof input.token !== 'string' || input.token.trim().length === 0) {
    throw new DebuggenError(
      'CONFIG_INVALID',
      'A server-agent credential is required to launch an instrumented dev server.',
      { details: { reason: 'credential-missing' } },
    );
  }
  if (!isHttpUrl(input.ingestUrl)) {
    throw new DebuggenError(
      'CONFIG_INVALID',
      'The ingest endpoint for a launched dev server must be an absolute http(s) URL.',
      {
        hint: 'Build it with resolveIngestUrl from the service host and bound port.',
        details: { reason: 'ingest-url-invalid' },
      },
    );
  }
  const importFlag = buildPreloadImportFlag(input.preloadPath);
  const platform = input.platform ?? process.platform;
  const identity = (name: string): string => (platform === 'win32' ? name.toUpperCase() : name);
  // Defence in depth: the parser refuses these before a credential exists, but
  // an assignment that selects a loader or overrides wiring must never reach a
  // child whatever path built the input. Neither the name nor the value is
  // echoed, since either may carry an inline secret.
  for (const [name, value] of Object.entries(input.launchEnv ?? {})) {
    if (typeof value === 'string' && !isAllowedLaunchAssignment(name, value, platform)) {
      throw new DebuggenError(
        'CONFIG_INVALID',
        'The launch environment holds an assignment a dev-server launch may not make.',
        {
          hint: 'Assign only the variables DEV_SERVER_COMMAND_ENV_ALLOWLIST admits, as parseLaunchCommand checks them.',
          details: { reason: 'launch-env-not-allowed' },
        },
      );
    }
  }

  // One slot per variable identity (the upper-cased name on Windows), holding
  // the spelling that supplied the value: a later layer replaces an earlier
  // one instead of adding a second, differently cased key.
  const slots = new Map<string, readonly [string, string]>();
  let nodeOptions: string | undefined;

  // Layer 1: the service's variables on the allowlist; the first spelling wins.
  for (const [name, value] of Object.entries(input.parentEnv)) {
    if (typeof value !== 'string') {
      continue;
    }
    const id = identity(name);
    if (id === PRELOAD_ENV_KEYS.nodeOptions) {
      nodeOptions ??= value;
      continue;
    }
    if (slots.has(id) || !isForwardedToDevServer(name, platform)) {
      continue;
    }
    slots.set(id, [name, value]);
  }

  // Layer 2: the launch command's explicit assignments, each checked above.
  for (const [name, value] of Object.entries(input.launchEnv ?? {})) {
    if (typeof value !== 'string') {
      continue;
    }
    const id = identity(name);
    if (id === PRELOAD_ENV_KEYS.nodeOptions) {
      nodeOptions = value;
      continue;
    }
    slots.set(id, [name, value]);
  }

  // Layer 3: the wiring keys are never taken from either layer above (the
  // allowlist keeps them out of layer 2; this keeps the invariant local).
  for (const key of [
    PRELOAD_ENV_KEYS.ingestUrl,
    PRELOAD_ENV_KEYS.token,
    PRELOAD_ENV_KEYS.projectRoot,
  ]) {
    slots.delete(key);
  }

  // `Object.fromEntries` defines own data properties, so even a variable named
  // `__proto__` survives as data instead of being swallowed by a setter.
  const env: Record<string, string> = Object.fromEntries(slots.values());
  env[PRELOAD_ENV_KEYS.nodeOptions] = appendNodeOptions(nodeOptions, importFlag);
  env[PRELOAD_ENV_KEYS.ingestUrl] = input.ingestUrl;
  env[PRELOAD_ENV_KEYS.token] = input.token;
  env[PRELOAD_ENV_KEYS.projectRoot] = input.projectRoot;
  return env;
}

/** Whether a value parses as an absolute `http:` or `https:` URL without credentials. */
function isHttpUrl(value: unknown): boolean {
  if (typeof value !== 'string') {
    return false;
  }
  try {
    const url = new URL(value);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      url.host.length > 0 &&
      url.username === '' &&
      url.password === ''
    );
  } catch {
    return false;
  }
}

/**
 * Whether a path is absolute on this platform or on either path grammar:
 * POSIX (`/home/dev/app`), a Windows drive root (`C:\dev\app`) or UNC.
 */
function isAbsolutePath(value: string): boolean {
  if (value.length === 0 || /[\0\r\n]/.test(value)) {
    return false;
  }
  return isNativeAbsolute(value) || isAbsolutePosix(toPosix(value)) || isWindowsAbsolute(value);
}

// ---------------------------------------------------------------------------
// The credential route: POST /dev-server/credential
// ---------------------------------------------------------------------------

/**
 * The protocol operation of the credential route: `devServer.credential`, a
 * row of `@debuggen/protocol`'s `HTTP_ROUTES` like every other route of the
 * service. `satisfies HttpOperationId` keeps it a genuine table key, so a
 * renamed or removed row fails to compile here.
 */
const CREDENTIAL_OPERATION = 'devServer.credential' satisfies HttpOperationId;

/**
 * The path of `POST /dev-server/credential`, which mints a time-bounded
 * `server-agent` credential for a dev server the caller starts itself.
 *
 * Read off the operation's row of protocol's route table rather than restated,
 * so this module, `../server/routes/dev-server.ts` (which answers the
 * operation through `../server/http.ts`'s table-driven registration, behind
 * the bearer middleware with the **editor** role only) and every client that
 * builds the path with `buildPath` agree by construction. Kept as an export
 * for the launcher's own documentation and its suite.
 */
export const DEV_SERVER_CREDENTIAL_PATH = HTTP_ROUTES[CREDENTIAL_OPERATION].pattern;

/** The method of {@link DEV_SERVER_CREDENTIAL_PATH}, read off the same table row. */
export const DEV_SERVER_CREDENTIAL_METHOD = HTTP_ROUTES[CREDENTIAL_OPERATION].method;

/**
 * What {@link DevServerLauncher.issueCredential} accepts: protocol's
 * `devServerCredentialRequestSchema` — `{ projectRoot }`, strict, bounded —
 * with the one check the Node-neutral protocol package cannot make layered on
 * top: the root must be an absolute path on this host's grammar or on either
 * portable one. Every rejection is a constant sentence, so no submitted value
 * is ever echoed.
 *
 * Derived with `.extend` rather than written out, so the body's field set,
 * strictness and length bound stay protocol's single definition; only the
 * refinement is this module's. The route validates the wire body against
 * protocol's schema first (`parseHttpRequest`), and this schema is the
 * launcher's own guard for any caller.
 */
export const devServerCredentialInputSchema = devServerCredentialRequestSchema.extend({
  projectRoot: devServerCredentialRequestSchema.shape.projectRoot.refine(
    (value) => isAbsolutePath(value),
    { error: 'expected an absolute project root path' },
  ),
});

/**
 * The `POST /dev-server/credential` response body — `{ token, expiresAt }`,
 * the only body in the product that carries a `server-agent` token — as
 * protocol defines it. Re-exported, never restated, so the launcher's answer
 * is checked against exactly the schema a client parses it with.
 */
export { devServerCredentialResponseSchema } from '@debuggen/protocol';

/**
 * The `POST /dev-server/credential` request and response bodies, as protocol
 * infers them. The launcher's absolute-path refinement narrows no type, so
 * protocol's request type is also {@link DevServerLauncher.issueCredential}'s
 * input type.
 */
export type { DevServerCredentialRequest, DevServerCredentialResponse };

// ---------------------------------------------------------------------------
// Preload resolution
// ---------------------------------------------------------------------------

/** The build step that produces the preload; named in every "not found" hint. */
export const PRELOAD_BUILD_COMMAND = 'pnpm --filter @debuggen/telemetry build';

/** The published subpath of the preload, resolved through the package's `exports` map. */
export const PRELOAD_PACKAGE_SPECIFIER = '@debuggen/telemetry/node/register';

/**
 * The preload relative to the service bundle in the VSIX layout: the service
 * is `dist/service/main.js` and the preload `dist/telemetry/node/register.mjs`.
 */
export const PRELOAD_BUNDLED_RELATIVE_URL = '../telemetry/node/register.mjs';

/** The preload inside a monorepo checkout, relative to the repository root. */
export const PRELOAD_WORKSPACE_RELATIVE_PATH = 'packages/telemetry/dist/node/register.mjs';

/** Where a {@link PreloadCandidate} came from, in precedence order. */
export type PreloadCandidateSource = 'explicit' | 'bundled' | 'package' | 'workspace';

/** One place the preload may be. */
export interface PreloadCandidate {
  readonly source: PreloadCandidateSource;
  /** Absolute native path. */
  readonly path: string;
}

/** Options of {@link resolvePreloadPath}; every member is optional. */
export interface ResolvePreloadPathOptions {
  /**
   * An explicit path — how `../main.ts` passes the VSIX-resolved preload, or a
   * test passes a temporary file. Highest precedence; a relative value is
   * ignored (it would resolve against an arbitrary working directory).
   */
  readonly preloadPath?: string | undefined;
  /** The URL candidates are derived from. Default: this module's `import.meta.url`. */
  readonly moduleUrl?: string | undefined;
  /** Existence check. Default: `fs.statSync(path).isFile()`, false on any error. */
  readonly fileExists?: ((path: string) => boolean) | undefined;
  /**
   * Resolves a package specifier to an absolute path, or `undefined`. Default:
   * `import.meta.resolve` when the runtime provides it, else
   * `createRequire(moduleUrl).resolve`; a resolution failure is a miss.
   */
  readonly resolvePackage?: ((specifier: string) => string | undefined) | undefined;
  /**
   * Receives the default resolver's `debug` record when the ESM resolver fails
   * and the CommonJS one is tried, named by the failure's closed class and code
   * only. Guarded, so a failing logger never changes a resolution. Default: no
   * record.
   */
  readonly logger?: Logger | undefined;
}

/**
 * Every place the preload is looked for, in order, without touching the
 * filesystem:
 *
 * 1. `explicit` — {@link ResolvePreloadPathOptions.preloadPath}, when absolute;
 * 2. `bundled` — {@link PRELOAD_BUNDLED_RELATIVE_URL} beside the running
 *    service bundle (the VSIX layout);
 * 3. `package` — {@link PRELOAD_PACKAGE_SPECIFIER} through `@debuggen/telemetry`'s
 *    `exports` map (the workspace build);
 * 4. `workspace` — {@link PRELOAD_WORKSPACE_RELATIVE_PATH} under each ancestor
 *    of this module, nearest first (`tsx watch src/main.ts` in a checkout).
 *
 * Duplicate paths are listed once, at their first position.
 */
export function preloadPathCandidates(
  options: ResolvePreloadPathOptions = {},
): readonly PreloadCandidate[] {
  const candidates: PreloadCandidate[] = [];
  const seen = new Set<string>();
  const add = (source: PreloadCandidateSource, path: string | undefined): void => {
    if (path === undefined || !isAbsolutePath(path) || seen.has(path)) {
      return;
    }
    seen.add(path);
    candidates.push({ source, path });
  };

  const explicit = options.preloadPath?.trim();
  add('explicit', explicit === undefined || explicit.length === 0 ? undefined : explicit);

  const moduleUrl = options.moduleUrl ?? currentModuleUrl();
  const moduleDir = moduleUrl === undefined ? undefined : directoryOfModuleUrl(moduleUrl);

  if (moduleUrl !== undefined) {
    add('bundled', fileUrlToPathOrUndefined(PRELOAD_BUNDLED_RELATIVE_URL, moduleUrl));
  }

  const resolvePackage =
    options.resolvePackage ??
    defaultPackageResolver(moduleUrl, guardLogger(options.logger ?? noopLogger));
  add('package', safeResolve(resolvePackage, PRELOAD_PACKAGE_SPECIFIER));

  if (moduleDir !== undefined) {
    let directory = moduleDir;
    for (let depth = 0; depth < MAX_WORKSPACE_SEARCH_DEPTH; depth += 1) {
      add('workspace', join(directory, ...PRELOAD_WORKSPACE_RELATIVE_PATH.split('/')));
      const parent = dirname(directory);
      if (parent === directory) {
        break;
      }
      directory = parent;
    }
  }

  return Object.freeze(candidates);
}

/**
 * Find the telemetry preload (`register.mjs`) to attach with `--import`.
 *
 * `ServiceConfig` deliberately carries no preload path, so resolution lives
 * here and covers both layouts the service runs in — the VSIX's bundled
 * `dist/telemetry/node/register.mjs` and the workspace build of
 * `@debuggen/telemetry` — over the ordered list of {@link preloadPathCandidates}.
 * The first candidate the existence check confirms wins. Nothing is ever
 * written: a missing preload is reported, never fabricated.
 *
 * @param options See {@link ResolvePreloadPathOptions}.
 * @returns The absolute path, or `INSTRUMENTATION_UNAVAILABLE` whose hint names
 * {@link PRELOAD_BUILD_COMMAND} and the candidates tried, and whose details list
 * the server signals that stay unavailable without it.
 */
export function resolvePreloadPath(
  options: ResolvePreloadPathOptions = {},
): Result<string, DebuggenError> {
  const fileExists = options.fileExists ?? defaultFileExists;
  const candidates = preloadPathCandidates(options);

  for (const candidate of candidates) {
    if (checkPath(fileExists, candidate.path)) {
      return ok(candidate.path);
    }
  }

  const tried = candidates.map((candidate) => `${candidate.source}: ${toPosix(candidate.path)}`);
  return err(
    new DebuggenError(
      'INSTRUMENTATION_UNAVAILABLE',
      'The Debug Generator telemetry preload (register.mjs) was not found, so server and database spans cannot be captured.',
      {
        hint: `Build it with "${PRELOAD_BUILD_COMMAND}" (a fresh checkout builds it with "pnpm build"), then launch the dev server again. Looked in: ${tried.length === 0 ? 'no candidate locations' : tried.join('; ')}.`,
        details: {
          reason: 'preload-not-found',
          candidates: tried,
          unavailableSignals: [...PRELOAD_DEPENDENT_SIGNALS],
        },
      },
    ),
  );
}

/** This module's URL, or `undefined` where the runtime provides none (a CommonJS bundle). */
function currentModuleUrl(): string | undefined {
  try {
    const url: unknown = import.meta.url;
    return typeof url === 'string' && url.length > 0 ? url : undefined;
  } catch {
    return undefined;
  }
}

/** The directory of a `file:` module URL, or `undefined` for any other URL. */
function directoryOfModuleUrl(moduleUrl: string): string | undefined {
  const path = fileUrlToPathOrUndefined('.', moduleUrl);
  return path === undefined ? undefined : path.replace(/[\\/]+$/, '') || path;
}

/** A relative URL resolved against a `file:` base, as a native path; `undefined` on any failure. */
function fileUrlToPathOrUndefined(relative: string, base: string): string | undefined {
  try {
    const url = new URL(relative, base);
    return url.protocol === 'file:' ? fileURLToPath(url) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * How one attempt of Node's ESM resolver (`import.meta.resolve`) ended for the
 * default package resolver. Every outcome but `resolved` is the decision to
 * try the CommonJS resolver next:
 *
 * - `unsupported` — the runtime provides no `import.meta.resolve` (a CommonJS
 *   bundle, some test runners);
 * - `not-a-file` — it answered with something other than a `file:` URL, which
 *   names no preload on disk;
 * - `failed` — it threw, typically `ERR_MODULE_NOT_FOUND` in a layout where the
 *   package is not installed beside this module (the VSIX). Only the closed
 *   description of the failure is kept, so the record it produces quotes no
 *   path or specifier text from the resolver's message.
 */
type EsmResolution =
  | { readonly outcome: 'resolved'; readonly path: string }
  | { readonly outcome: 'unsupported' }
  | { readonly outcome: 'not-a-file' }
  | { readonly outcome: 'failed'; readonly failure: ExceptionDescription };

/** One attempt of Node's ESM resolver for `specifier`; never throws. */
function resolveThroughEsm(specifier: string): EsmResolution {
  const meta: { readonly resolve?: ((specifier: string) => unknown) | undefined } = import.meta;
  if (typeof meta.resolve !== 'function') {
    return { outcome: 'unsupported' };
  }
  try {
    const resolved = meta.resolve(specifier);
    return typeof resolved === 'string' && resolved.startsWith('file:')
      ? { outcome: 'resolved', path: fileURLToPath(resolved) }
      : { outcome: 'not-a-file' };
  } catch (error) {
    return { outcome: 'failed', failure: describeException(error) };
  }
}

/**
 * The default package resolver: `import.meta.resolve` when available (Node's
 * ESM resolver, honouring `exports`), else a `createRequire` rooted at this
 * module. Either may be missing under a bundler or test runner, which is why
 * both are feature-tested rather than assumed. An ESM resolver that threw is
 * reported to `logger` at `debug` before the CommonJS resolver is tried, so the
 * fallback is a recorded decision rather than a silent one.
 */
function defaultPackageResolver(
  moduleUrl: string | undefined,
  logger: Logger,
): (specifier: string) => string | undefined {
  return (specifier) => {
    const esm = resolveThroughEsm(specifier);
    if (esm.outcome === 'resolved') {
      return esm.path;
    }
    if (esm.outcome === 'failed') {
      logger.debug('The ESM resolver did not resolve the preload package; trying CommonJS', {
        specifier,
        ...esm.failure,
      });
    }
    if (moduleUrl === undefined) {
      return undefined;
    }
    try {
      return createRequire(moduleUrl).resolve(specifier);
    } catch {
      return undefined;
    }
  };
}

/** Run a resolver, treating a throw or a non-string as a miss. */
function safeResolve(
  resolver: (specifier: string) => string | undefined,
  specifier: string,
): string | undefined {
  try {
    const resolved = resolver(specifier);
    return typeof resolved === 'string' && resolved.length > 0 ? resolved : undefined;
  } catch {
    return undefined;
  }
}

/** Run an injected existence check; a throw counts as "does not exist". */
function checkPath(check: (path: string) => boolean, path: string): boolean {
  try {
    return check(path);
  } catch {
    return false;
  }
}

/** The default existence check: a regular file at `path`. */
function defaultFileExists(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** The default directory check: a directory at `path`. */
function defaultDirectoryExists(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Command lines
// ---------------------------------------------------------------------------

/** One word of a command line, and whether any part of it was quoted. */
interface CommandWord {
  readonly text: string;
  readonly quoted: boolean;
}

/**
 * Split a command line into words — a deliberately **minimal** tokenizer, so a
 * launch never needs a shell on POSIX:
 *
 * - unquoted whitespace separates words;
 * - `'…'` is literal, exactly as in a POSIX shell;
 * - `"…"` is literal except that a backslash escapes `"`, `\`, `$` and `` ` ``;
 * - outside quotes, a backslash makes the next character literal;
 * - adjacent quoted and unquoted parts join one word (`a"b c"` → `ab c`), and
 *   `''` or `""` is an empty word.
 *
 * Nothing is expanded: no `$VAR`, no glob, no `~`, no command substitution.
 *
 * @param command The command line.
 * @returns The words, or `DEV_SERVER_LAUNCH_FAILED` for an empty line, an
 * unterminated quote or a trailing backslash. The error never echoes the
 * command, which may carry an inline secret.
 */
export function splitCommandLine(command: string): Result<readonly string[], DebuggenError> {
  const words = tokenizeCommand(command);
  return isErr(words) ? words : ok(Object.freeze(words.value.map((word) => word.text)));
}

/** The tokenizer behind {@link splitCommandLine}, keeping each word's quoting. */
function tokenizeCommand(command: string): Result<CommandWord[], DebuggenError> {
  const words: CommandWord[] = [];
  let current = '';
  let quoted = false;
  let inWord = false;
  let quote: "'" | '"' | undefined;
  const characters = Array.from(typeof command === 'string' ? command : '');

  for (let index = 0; index < characters.length; index += 1) {
    const character = characters[index] ?? '';
    if (quote === "'") {
      if (character === "'") {
        quote = undefined;
      } else {
        current += character;
      }
      continue;
    }
    if (quote === '"') {
      if (character === '"') {
        quote = undefined;
      } else if (character === '\\' && isDoubleQuoteEscapable(characters[index + 1])) {
        current += characters[index + 1] ?? '';
        index += 1;
      } else {
        current += character;
      }
      continue;
    }
    if (/\s/.test(character)) {
      if (inWord) {
        words.push({ text: current, quoted });
        current = '';
        quoted = false;
        inWord = false;
      }
      continue;
    }
    inWord = true;
    if (character === "'" || character === '"') {
      quote = character;
      quoted = true;
    } else if (character === '\\') {
      const next = characters[index + 1];
      if (next === undefined) {
        return err(
          commandError('trailing-backslash', 'The dev-server command ends with a backslash.'),
        );
      }
      current += next;
      quoted = true;
      index += 1;
    } else {
      current += character;
    }
  }

  if (quote !== undefined) {
    return err(
      commandError('unterminated-quote', 'The dev-server command has an unterminated quote.'),
    );
  }
  if (inWord) {
    words.push({ text: current, quoted });
  }
  if (words.length === 0) {
    return err(commandError('empty-command', 'The dev-server command is empty.'));
  }
  return ok(words);
}

/** Characters a backslash escapes inside double quotes, as in a POSIX shell. */
function isDoubleQuoteEscapable(character: string | undefined): boolean {
  return character === '"' || character === '\\' || character === '$' || character === '`';
}

/** A launch command resolved into what `spawn` receives. */
export interface ParsedLaunchCommand {
  /** The executable. */
  readonly file: string;
  /**
   * Its arguments: passed to `spawn` as an array on POSIX; on Windows quoted
   * word by word into one checked `cmd.exe /c` line by
   * {@link buildWindowsCommandInvocation}. Never re-joined into a shell string.
   */
  readonly args: readonly string[];
  /**
   * Leading `NAME=value` assignments (`NODE_ENV=development next dev`): the
   * {@link DevServerEnvInput.launchEnv} of the child. Each one passed
   * {@link checkLaunchAssignment} ({@link DEV_SERVER_COMMAND_ENV_ALLOWLIST});
   * they are applied before the preload variables, so an assigned
   * `NODE_OPTIONS` is appended to, and no `DEBUGGEN_*` wiring key can be among
   * them.
   */
  readonly env: Readonly<Record<string, string>>;
}

/**
 * Parse a request's `command` with {@link splitCommandLine}: leading
 * environment assignments are separated out, the next word is the executable,
 * and the rest are its arguments. Refused, each before anything is minted or
 * spawned:
 *
 * - an unquoted shell operator (`&&`, `|`, `;`, `>` …) — `shell-operator`:
 *   without a shell it would silently become an argument, so a command that
 *   needs one belongs in a `package.json` script;
 * - an assignment {@link checkLaunchAssignment} refuses —
 *   `env-assignment-not-allowed` for a name off
 *   {@link DEV_SERVER_COMMAND_ENV_ALLOWLIST} (`LD_PRELOAD`, `PATH`,
 *   `DEBUGGEN_TOKEN` …), `node-options-not-allowed` for a `NODE_OPTIONS` that
 *   would load or evaluate code (`--require`, `--import`, `--inspect` …),
 *   `node-path-not-allowed` for a `NODE_PATH` entry that is not an absolute
 *   `node_modules` directory. `details.position` is the assignment's 1-based
 *   word index; neither its name nor its value is echoed.
 *
 * Which executable may run, and whether an assigned `NODE_PATH` names only
 * trusted directories, is {@link checkLaunchCommand}'s decision, made on the
 * parsed result.
 *
 * @param command The request's command line.
 * @param platform Whose variable-name and path semantics the assignments are
 * checked under. Default: this process's.
 * @returns The parsed command, or `DEV_SERVER_LAUNCH_FAILED` with the fix as its hint.
 *
 * @example
 * ```ts
 * parseLaunchCommand('NEXT_TELEMETRY_DISABLED=1 pnpm run dev', 'linux');
 * // → ok({ file: 'pnpm', args: ['run', 'dev'], env: { NEXT_TELEMETRY_DISABLED: '1' } })
 * parseLaunchCommand('LD_PRELOAD=/tmp/x.so pnpm run dev', 'linux');
 * // → err(… details: { reason: 'env-assignment-not-allowed', position: 1 })
 * ```
 */
export function parseLaunchCommand(
  command: string,
  platform: NodeJS.Platform = process.platform,
): Result<ParsedLaunchCommand, DebuggenError> {
  const tokenized = tokenizeCommand(command);
  if (isErr(tokenized)) {
    return tokenized;
  }
  const words = tokenized.value;

  if (words.some((word) => !word.quoted && SHELL_OPERATOR_TOKENS.has(word.text))) {
    return err(
      commandError(
        'shell-operator',
        'The dev-server command uses a shell operator, which is not interpreted: the command runs without a shell.',
      ),
    );
  }

  const env: [string, string][] = [];
  let index = 0;
  for (; index < words.length; index += 1) {
    const word = words[index];
    if (word === undefined || !ENV_ASSIGNMENT_PATTERN.test(word.text)) {
      break;
    }
    const equals = word.text.indexOf('=');
    const name = word.text.slice(0, equals);
    const value = word.text.slice(equals + 1);
    const refusal = checkLaunchAssignment(name, value, platform);
    if (refusal !== undefined) {
      return err(assignmentError(refusal, index + 1));
    }
    env.push([name, value]);
  }

  const file = words[index]?.text;
  if (file === undefined || file.length === 0) {
    return err(commandError('no-executable', 'The dev-server command names no executable to run.'));
  }
  return ok(
    Object.freeze({
      file,
      args: Object.freeze(words.slice(index + 1).map((word) => word.text)),
      env: Object.freeze(Object.fromEntries(env)),
    }),
  );
}

/**
 * The hint of every command refusal that has no more specific one: the forms
 * {@link checkLaunchCommand} accepts, and where anything else belongs.
 */
const COMMAND_FORMS_HINT =
  'Pass one of the accepted forms — a package-manager run of one of the project\'s dev-server scripts ("pnpm run dev --port 4174", "npm run dev -- --port 4174", "yarn dev --port 4174", "bun run dev"), "next dev" with its port, hostname and bundler options, or Node running the project\'s node_modules/next/dist/bin/next dev — where quotes are honoured and nothing is expanded; or omit the command to use the dev script detected from package.json. Anything else belongs in a package.json script that runs next dev.';

/** A refusal of a request's command; the command itself is never echoed. */
function commandError(
  reason: string,
  message: string,
  hint: string = COMMAND_FORMS_HINT,
  details: Readonly<Record<string, string | number>> = {},
): DebuggenError {
  return new DebuggenError('DEV_SERVER_LAUNCH_FAILED', message, {
    hint,
    details: { reason, ...details },
  });
}

/** The fixed message and hint of each {@link LaunchAssignmentRefusal}; none echoes the assignment. */
const ASSIGNMENT_REFUSALS: Readonly<
  Record<LaunchAssignmentRefusal, { readonly message: string; readonly hint: string }>
> = Object.freeze({
  'env-assignment-not-allowed': Object.freeze({
    message: 'The dev-server command assigns an environment variable a launch command may not set.',
    hint: `A launch command may assign only ${[
      ...DEV_SERVER_COMMAND_ENV_ALLOWLIST.names,
      ...DEV_SERVER_COMMAND_ENV_ALLOWLIST.prefixes.map((prefix) => `${prefix}*`),
    ].join(
      ', ',
    )}, and a checked NODE_OPTIONS or NODE_PATH. Put any other variable the app needs in the project's own .env files, which Next.js loads itself.`,
  }),
  'node-options-not-allowed': Object.freeze({
    message:
      "The dev-server command's NODE_OPTIONS assignment holds an option a launch command may not pass.",
    hint: `An assigned NODE_OPTIONS may hold only ${[
      ...LAUNCH_NODE_OPTIONS_ALLOWLIST.booleanFlags,
      ...LAUNCH_NODE_OPTIONS_ALLOWLIST.valuedFlags.map((flag) => `${flag}=<value>`),
    ].join(
      ', ',
    )}. Flags that load or evaluate code or open a debugger are refused; the service attaches its own telemetry preload.`,
  }),
  'node-path-not-allowed': Object.freeze({
    message:
      "The dev-server command's NODE_PATH assignment is not a list of absolute node_modules directories.",
    hint: "Assign NODE_PATH only absolute paths of node_modules directories, separated by ':' (';' on Windows).",
  }),
});

/** The refusal of the assignment at 1-based word `position`; names the position, never the word. */
function assignmentError(refusal: LaunchAssignmentRefusal, position: number): DebuggenError {
  const { message, hint } = ASSIGNMENT_REFUSALS[refusal];
  return commandError(refusal, message, hint, { position });
}

// ---------------------------------------------------------------------------
// Which command may run: the dev-server command policy (CWE-78)
// ---------------------------------------------------------------------------

/** The package managers whose script runner a launch command may name, by bare binary. */
const PACKAGE_MANAGER_BINARIES: ReadonlySet<string> = new Set(['pnpm', 'npm', 'yarn', 'bun']);

/**
 * Yarn's own commands. `yarn <name>` runs a script only when `<name>` is not
 * one of these — `yarn install`, `yarn dlx`, `yarn exec` or `yarn node` run
 * Yarn itself — so a bare `yarn <name>` is a script run for every other name.
 */
const YARN_BUILTIN_COMMANDS: ReadonlySet<string> = new Set([
  'add',
  'audit',
  'bin',
  'cache',
  'config',
  'create',
  'dlx',
  'exec',
  'global',
  'info',
  'init',
  'install',
  'link',
  'node',
  'npm',
  'pack',
  'patch',
  'plugin',
  'publish',
  'rebuild',
  'remove',
  'run',
  'set',
  'unlink',
  'unplug',
  'up',
  'upgrade',
  'version',
  'why',
  'workspace',
  'workspaces',
]);

/**
 * The word that ends npm's own options and hands the rest to the script. npm
 * requires it before any dev-server option; pnpm, Yarn and Bun would pass it
 * to the script verbatim, so for them it is refused.
 */
const END_OF_OPTIONS = '--';

/** One valued option of {@link DEV_SERVER_ARGUMENT_ALLOWLIST}. */
export interface DevServerValuedOption {
  /** The long spelling, accepted as `--flag value` and `--flag=value`: `--port`. */
  readonly long: string;
  /** The short spelling, accepted as `-f value` only: `-p`. */
  readonly short: string;
  /** What the value is, as the refusal hint names it: `port 1-65535`. */
  readonly valueName: string;
  /** What the whole value must match. A separate value may also never start with `-`. */
  readonly valuePattern: RegExp;
}

/** The shape of {@link DEV_SERVER_ARGUMENT_ALLOWLIST}. */
export interface DevServerArgumentAllowlist {
  /** Options that take no value, matched as whole words: `--turbopack`. */
  readonly booleanOptions: readonly string[];
  /** Options that take exactly one value, each with the value's pattern. */
  readonly valuedOptions: readonly DevServerValuedOption[];
}

/**
 * A TCP port in canonical decimal, `1`–`65535`: no sign, no leading zero, no
 * `0` — exactly what `next dev --port` binds without reinterpretation.
 */
const TCP_PORT_PATTERN =
  /^(?:[1-9]\d{0,3}|[1-5]\d{4}|6[0-4]\d{3}|65[0-4]\d{2}|655[0-2]\d|6553[0-5])$/;

/**
 * The **only** arguments a launch command may hand the dev server — the
 * `next dev` options that choose where it listens and which bundler it
 * uses, and nothing else — applied to every accepted form: after `dev` in
 * `next dev …` and in Node running `…/node_modules/next/dist/bin/next dev …`,
 * and after the script in a package-manager run (after npm's `--`):
 *
 * - valued: `-p`/`--port` (a TCP port, `1`–`65535`) and `-H`/`--hostname`
 *   (a loopback host only: `localhost`, `127.0.0.1`, `::1` or `[::1]`), as
 *   `--flag value` or `--flag=value`, and the short spelling as `-p value`
 *   only;
 * - boolean: `--turbo`, `--turbopack`, `--webpack`, `--disable-source-maps`,
 *   `--no-server-fast-refresh`.
 *
 * The hostname is loopback-only because the service, its credentials and the
 * extension's host permissions are loopback-only: an instrumented dev server
 * bound to another interface would serve the developer's app, with its
 * telemetry hooks armed, to other machines.
 *
 * **No positional argument is accepted at all**: `next dev <directory>`
 * serves whatever directory it names, so `next dev /home/dev/private` or
 * `pnpm run dev /elsewhere` would serve — and hand the preload's credential
 * to — a tree outside the project. Every other option is refused, among them
 * `--inspect` (a debugger any local process can attach to),
 * `--experimental-upload-trace` (sends the debugging trace, which Next.js
 * documents as sensitive, to any URL), `--experimental-https` (downloads the
 * `mkcert` binary from the network, runs it and installs a local certificate
 * authority into the user's trust stores), `--experimental-https-key`/`-cert`/
 * `-ca` (read files the request names), `--experimental-cpu-prof`,
 * `--internal-trace`, `--experimental-next-config-strip-types`, every Node
 * loader or eval flag (`-e`, `-r`, `--require`, `--import`), `--` and any
 * shell syntax. Widening this list is a security decision: every option added
 * here is one a request may pass to a process holding a live credential.
 */
export const DEV_SERVER_ARGUMENT_ALLOWLIST: DevServerArgumentAllowlist = Object.freeze({
  booleanOptions: Object.freeze([
    '--turbo',
    '--turbopack',
    '--webpack',
    '--disable-source-maps',
    '--no-server-fast-refresh',
  ]),
  valuedOptions: Object.freeze([
    Object.freeze({
      long: '--port',
      short: '-p',
      valueName: 'port 1-65535',
      valuePattern: TCP_PORT_PATTERN,
    }),
    Object.freeze({
      long: '--hostname',
      short: '-H',
      valueName: 'loopback host: localhost, 127.0.0.1 or ::1',
      valuePattern: /^(?:localhost|127\.0\.0\.1|::1|\[::1\])$/,
    }),
  ]),
});

/** Membership over {@link DEV_SERVER_ARGUMENT_ALLOWLIST}'s boolean options. */
const DEV_SERVER_BOOLEAN_OPTION_SET: ReadonlySet<string> = new Set(
  DEV_SERVER_ARGUMENT_ALLOWLIST.booleanOptions,
);

/** {@link DEV_SERVER_ARGUMENT_ALLOWLIST}'s valued options by long spelling. */
const DEV_SERVER_LONG_OPTIONS: ReadonlyMap<string, DevServerValuedOption> = new Map(
  DEV_SERVER_ARGUMENT_ALLOWLIST.valuedOptions.map((option) => [option.long, option]),
);

/** {@link DEV_SERVER_ARGUMENT_ALLOWLIST}'s valued options by short spelling. */
const DEV_SERVER_SHORT_OPTIONS: ReadonlyMap<string, DevServerValuedOption> = new Map(
  DEV_SERVER_ARGUMENT_ALLOWLIST.valuedOptions.map((option) => [option.short, option]),
);

/** How {@link checkLaunchCommand} accepted a command. */
export type LaunchCommandForm = 'package-script' | 'framework-cli' | 'node-framework-cli';

/** What {@link checkLaunchCommand} answers for a command it accepts. */
export interface AcceptedLaunchCommand {
  /**
   * `'package-script'` — `pnpm|npm|bun run <script>`, `npm run-script
   * <script>`, `yarn [run] <script>`; `'framework-cli'` — `next dev`;
   * `'node-framework-cli'` — Node running `…/node_modules/next/dist/bin/next dev`.
   */
  readonly form: LaunchCommandForm;
  /** The `package.json` script a `'package-script'` run starts; absent for the other forms. */
  readonly script?: string;
}

/**
 * Why {@link checkLaunchCommand} refused a command — its `details.reason`:
 *
 * - `'executable-not-allowed'` — the executable, or what it is asked to do,
 *   is none of the accepted forms: a shell, `env`, `npx`/`pnpx`/`bunx`,
 *   `pnpm exec`/`dlx`, a Yarn built-in, an interpreter, any other binary, or a
 *   framework CLI run without its dev subcommand;
 * - `'script-not-declared'` — a package-manager run names no script, or one
 *   that is not among the project's dev-server scripts (`context.scripts`):
 *   undeclared, declared but not starting a dev server (`deploy`, `lint`,
 *   `postinstall`), or the manifest could not be read;
 * - `'argument-not-allowed'` — an argument is not on
 *   {@link DEV_SERVER_ARGUMENT_ALLOWLIST} (a positional such as a directory,
 *   an unlisted option, a valued option without a valid value), a
 *   package-manager option precedes the script, npm is handed an argument
 *   before its `--`, or pnpm, Yarn or Bun is handed `--`; `details.argument`
 *   is its 1-based index after the executable;
 * - `'dev-cli-untrusted'` — Node is asked to run something other than a
 *   trusted `node_modules/next/dist/bin/next` (a Node option, another script,
 *   a missing file, or one another user could have written).
 */
export type LaunchCommandRefusal =
  'executable-not-allowed' | 'script-not-declared' | 'argument-not-allowed' | 'dev-cli-untrusted';

/** What {@link checkLaunchCommand} judges a parsed command against. */
export interface LaunchCommandContext {
  /**
   * The project root as the caller gave it, in its native spelling: the
   * child's working directory, and what a relative framework-CLI path
   * resolves against.
   */
  readonly projectRoot: string;
  /**
   * The only scripts a package-manager run may start: the names of the
   * project's dev-server scripts ({@link DevServerDetection.devServerScripts}
   * — the selected dev script and every script that runs `next dev`), never
   * every script `package.json` declares; `undefined` when the manifest was
   * not read, which admits no package-manager run at all.
   */
  readonly scripts: readonly string[] | undefined;
  /** Whose executable-name and path semantics apply. Default: this process's. */
  readonly platform?: NodeJS.Platform | undefined;
  /**
   * The Node that runs this service — the only absolute executable a command
   * may name, compared by real path. Default: `process.execPath`.
   */
  readonly nodeExecutablePath?: string | undefined;
  /**
   * Whether the framework-CLI script Node is asked to run is a file the
   * service trusts to execute. Default: {@link isTrustedDevCliFile}.
   */
  readonly isTrustedFile?: ((path: string) => boolean) | undefined;
  /**
   * Whether a directory an assigned `NODE_PATH` names is one the service
   * trusts the child to load modules from. Default:
   * {@link isTrustedNodePathDirectory}.
   */
  readonly isTrustedDirectory?: ((path: string) => boolean) | undefined;
  /**
   * The canonical path of an executable, or `undefined` when it cannot be
   * resolved. Default: `fs.realpathSync.native`.
   */
  readonly realpath?: ((path: string) => string | undefined) | undefined;
}

/**
 * What {@link checkLaunchCommand} judges: the executable and its arguments,
 * and — when the command came from {@link parseLaunchCommand} — its leading
 * `NAME=value` assignments, whose `NODE_PATH` directories must be trusted.
 */
export type CheckedLaunchCommand = Pick<ParsedLaunchCommand, 'file' | 'args'> & {
  readonly env?: ParsedLaunchCommand['env'] | undefined;
};

/**
 * Decide whether a parsed launch command may run at all — **which program
 * starts**, the half of CWE-78 that `spawn(…, { shell: false })` does not
 * cover: with no shell option, `sh -c 'curl … | sh'` still runs, because `sh`
 * is simply the executable. Exactly three forms are accepted, and nothing is
 * configurable to widen them:
 *
 * 1. **A package-manager run of a dev-server script** — bare `pnpm`, `npm`,
 *    `yarn` or `bun`, then `run <script>` (npm also `run-script <script>`),
 *    or `yarn <script>` for a name that is no Yarn built-in (the form
 *    `./detect.ts`'s `packageManagerRunArgs` produces). No package-manager
 *    option may precede the script, and the script must be one of
 *    `context.scripts` — the project's dev-server scripts, never merely any
 *    script `package.json` declares (`deploy`, `db:reset`, `postinstall`).
 *    After the script come dev-server options, and how depends on the
 *    runner: **npm** reads every option before `--` as its own
 *    configuration (`--node-options=…`), so it takes nothing before `--` and
 *    the options only after it (`npm run dev -- --port 4174`); **pnpm, Yarn
 *    and Bun** hand every word after the script to it verbatim — `--`
 *    included, which Next.js would then read as the end of its options,
 *    turning `--port` into a directory — so they take the options directly
 *    and refuse `--` (`pnpm run dev --port 4174`).
 * 2. **The framework's dev CLI** — bare `next` (see `FRAMEWORK_DEV_CLIS`),
 *    its `dev` subcommand, then dev-server options.
 * 3. **Node running the framework's dev CLI** — bare `node` (on Windows also
 *    `node.exe`, case-insensitively) or an absolute path whose real path is
 *    the service's own Node; then, with no Node option before it, a script
 *    resolved against the project root whose path ends in
 *    `/node_modules/next/dist/bin/next` and that `context.isTrustedFile`
 *    accepts; then `dev` and dev-server options.
 *
 * In every form the dev-server options are only those
 * {@link DEV_SERVER_ARGUMENT_ALLOWLIST} lists — where the server listens and
 * which bundler it uses — and **no positional argument** is accepted, since
 * `next dev <directory>` would serve a tree outside the project. Anything a
 * developer needs beyond these forms belongs in a `package.json` script that
 * runs `next dev`, which form 1 then runs. Executable names compare
 * case-insensitively on Windows; script names and arguments always exactly.
 *
 * When the command carries its assignments (`parsed.env`), an assigned
 * `NODE_PATH` must also name only directories the service trusts: each entry
 * is absolute, ends in `node_modules` (as {@link checkLaunchAssignment}
 * already checked) and passes `context.isTrustedDirectory` — by default an
 * existing directory, symlinks followed, owned by the service's user and
 * writable by neither its group nor anyone else. Otherwise the reason is
 * `'node-path-not-allowed'`. A `NODE_PATH` the service inherited from its
 * own environment is the developer's and is not judged here.
 *
 * **The trust boundary.** Together with {@link isTrustedDevCliFile}, this is
 * what the service defends: a request can make the child run only code that
 * is already owned by the service's own user and writable by no one else —
 * the project's dependencies, the service's own Node. It does not defend
 * against that same user, who can write such a file and already has code
 * execution as that user, so a file only they can write is not a boundary
 * this service claims.
 *
 * @param parsed The executable, its arguments and, optionally, its
 * assignments, as {@link parseLaunchCommand} split them.
 * @param context The project, its dev-server scripts and the checks' collaborators.
 * @returns The accepted form (and, for a script run, the script), or
 * `DEV_SERVER_LAUNCH_FAILED` with a {@link LaunchCommandRefusal} reason (or
 * `'node-path-not-allowed'`) and a hint naming the fix. Nothing the command
 * holds is echoed.
 *
 * @example
 * ```ts
 * checkLaunchCommand({ file: 'pnpm', args: ['run', 'dev'] }, { projectRoot, scripts: ['dev'] });
 * // → ok({ form: 'package-script', script: 'dev' })
 * checkLaunchCommand({ file: 'sh', args: ['-c', 'curl … | sh'] }, { projectRoot, scripts: ['dev'] });
 * // → err(… details: { reason: 'executable-not-allowed' })
 * checkLaunchCommand(
 *   { file: 'next', args: ['dev'], env: { NODE_PATH: '/tmp/planted/node_modules' } },
 *   { projectRoot, scripts: ['dev'] },
 * );
 * // → err(… details: { reason: 'node-path-not-allowed' }) unless that directory is trusted
 * ```
 */
export function checkLaunchCommand(
  parsed: CheckedLaunchCommand,
  context: LaunchCommandContext,
): Result<AcceptedLaunchCommand, DebuggenError> {
  const platform = context.platform ?? process.platform;
  const accepted = checkLaunchExecutable(parsed, context, platform);
  if (isErr(accepted)) {
    return accepted;
  }
  return hasTrustedNodePath(parsed.env, context, platform)
    ? accepted
    : err(untrustedNodePathError());
}

/** Which program {@link checkLaunchCommand} would start, judged on the executable and its arguments. */
function checkLaunchExecutable(
  parsed: CheckedLaunchCommand,
  context: LaunchCommandContext,
  platform: NodeJS.Platform,
): Result<AcceptedLaunchCommand, DebuggenError> {
  const file = typeof parsed.file === 'string' ? parsed.file : '';
  const args = parsed.args;
  const bare = platform === 'win32' ? file.toLowerCase() : file;

  if (PACKAGE_MANAGER_BINARIES.has(bare)) {
    return checkPackageScriptRun(bare, args, context.scripts);
  }
  const cli = FRAMEWORK_DEV_CLIS.find((entry) => entry.binary === bare);
  if (cli !== undefined) {
    if (args[0] !== cli.subcommand) {
      return err(commandPolicyError('executable-not-allowed'));
    }
    const refused = firstRefusedDevServerArgument(args, 1);
    return refused === undefined
      ? ok(Object.freeze({ form: 'framework-cli' }))
      : err(commandPolicyError('argument-not-allowed', refused));
  }
  if (isServiceNode(file, platform, context)) {
    return checkNodeFrameworkCliRun(args, context, platform);
  }
  return err(commandPolicyError('executable-not-allowed'));
}

/**
 * Whether every `NODE_PATH` assignment among `env` — matched
 * case-insensitively on Windows — passes the syntactic check of
 * {@link checkLaunchAssignment} and names only directories
 * `context.isTrustedDirectory` accepts. No assignment is trivially trusted.
 */
function hasTrustedNodePath(
  env: ParsedLaunchCommand['env'] | undefined,
  context: LaunchCommandContext,
  platform: NodeJS.Platform,
): boolean {
  if (env === undefined) {
    return true;
  }
  const windows = platform === 'win32';
  const trusted = context.isTrustedDirectory ?? isTrustedNodePathDirectory;
  for (const [name, value] of Object.entries(env)) {
    if ((windows ? name.toUpperCase() : name) !== NODE_PATH_NAME) {
      continue;
    }
    if (typeof value !== 'string' || !isAllowedLaunchNodePath(value, platform)) {
      return false;
    }
    const entries = value.split(windows ? ';' : ':');
    if (!entries.every((entry) => answersTrue(() => trusted(entry)))) {
      return false;
    }
  }
  return true;
}

/**
 * The refusal of a syntactically valid `NODE_PATH` that names a directory the
 * service does not trust — fixed text; the path is never echoed.
 */
function untrustedNodePathError(): DebuggenError {
  return commandError(
    'node-path-not-allowed',
    "The dev-server command's NODE_PATH assignment names a directory the service does not trust to load modules from.",
    "Assign NODE_PATH only existing node_modules directories owned by the service's user that neither its group nor anyone else can write; reinstall the dependencies there if the directory is missing or writable by others.",
  );
}

/**
 * Whether a filesystem entry, as `statSync` reported it, could only have been
 * written by the service's own user: on POSIX it is owned by this process's
 * uid and neither its group nor anyone else may write it (`(mode & 0o022) ===
 * 0`). Windows has no POSIX owner or mode bits to compare, so there the
 * existence and kind checks of the callers are the whole of the check.
 */
function isWritableOnlyByServiceUser(stats: {
  readonly uid: number;
  readonly mode: number;
}): boolean {
  if (process.platform === 'win32' || typeof process.getuid !== 'function') {
    return true;
  }
  return stats.uid === process.getuid() && (stats.mode & 0o022) === 0;
}

/**
 * The default trust check of a framework-CLI script Node is asked to run:
 * the path, symlinks followed, is a regular file — and on POSIX one owned by
 * the service's own user that neither its group nor anyone else may write
 * (`(mode & 0o022) === 0`), so no other account can have planted or edited
 * the code the dev server would run. A path that cannot be read is untrusted.
 *
 * This is the trust boundary {@link checkLaunchCommand} states: a request can
 * run only code already owned by the service's user and writable by no one
 * else. A file that same user can write is not a boundary this service
 * defends — whoever can write it already runs code as that user.
 *
 * @param path The resolved, absolute path of the script.
 * @returns `true` when the file may run.
 */
export function isTrustedDevCliFile(path: string): boolean {
  try {
    const stats = statSync(path);
    return stats.isFile() && isWritableOnlyByServiceUser(stats);
  } catch {
    return false;
  }
}

/**
 * The default trust check of a directory an assigned `NODE_PATH` names: the
 * path, symlinks followed, is an existing directory — and on POSIX one owned
 * by the service's own user that neither its group nor anyone else may write,
 * so no other account can add or replace a module the child would resolve
 * from it. A missing path, a file, or one that cannot be read is untrusted.
 * The same trust boundary as {@link isTrustedDevCliFile} applies.
 *
 * @param path An absolute `NODE_PATH` entry.
 * @returns `true` when the child may load modules from it.
 *
 * @example
 * ```ts
 * isTrustedNodePathDirectory('/home/dev/storefront/node_modules'); // → true when this user owns it, mode 0755
 * isTrustedNodePathDirectory('/tmp/planted/node_modules');         // → false when missing or mode 0777
 * ```
 */
export function isTrustedNodePathDirectory(path: string): boolean {
  try {
    const stats = statSync(path);
    return stats.isDirectory() && isWritableOnlyByServiceUser(stats);
  } catch {
    return false;
  }
}

/** Form 1 of {@link checkLaunchCommand}: a package-manager run of a dev-server script. */
function checkPackageScriptRun(
  manager: string,
  args: readonly string[],
  scripts: readonly string[] | undefined,
): Result<AcceptedLaunchCommand, DebuggenError> {
  const first = args[0];
  if (first === undefined) {
    return err(commandPolicyError('script-not-declared'));
  }
  if (first.startsWith('-')) {
    // A package-manager option (`--filter`, `-C`, `--node-options`) before the script.
    return err(commandPolicyError('argument-not-allowed', 1));
  }
  let scriptIndex: number;
  if (first === 'run' || (manager === 'npm' && first === 'run-script')) {
    scriptIndex = 1;
  } else if (manager === 'yarn' && !YARN_BUILTIN_COMMANDS.has(first)) {
    scriptIndex = 0;
  } else {
    // `pnpm exec`, `pnpm dlx`, `npm install`, `yarn install`, `bun x` …
    return err(commandPolicyError('executable-not-allowed'));
  }

  const script = args[scriptIndex];
  if (script === undefined) {
    return err(commandPolicyError('script-not-declared'));
  }
  if (script.startsWith('-')) {
    return err(commandPolicyError('argument-not-allowed', scriptIndex + 1));
  }
  if (scripts === undefined || !scripts.includes(script)) {
    return err(commandPolicyError('script-not-declared'));
  }

  let optionsStart = scriptIndex + 1;
  if (manager === 'npm' && optionsStart < args.length) {
    // npm reads an option before `--` as its own configuration and hands a
    // bare word to the script as a positional, so nothing but `--` may follow
    // the script directly; the dev-server options come after it.
    if (args[optionsStart] !== END_OF_OPTIONS) {
      return err(commandPolicyError('argument-not-allowed', optionsStart + 1));
    }
    optionsStart += 1;
  }
  // pnpm, Yarn and Bun pass every word after the script through verbatim, so
  // a `--` among them would reach Next.js, which the allowlist refuses; for
  // npm a second `--` is refused the same way.
  const refused = firstRefusedDevServerArgument(args, optionsStart);
  return refused === undefined
    ? ok(Object.freeze({ form: 'package-script', script }))
    : err(commandPolicyError('argument-not-allowed', refused));
}

/** Form 3 of {@link checkLaunchCommand}: the service's Node running a trusted framework CLI. */
function checkNodeFrameworkCliRun(
  args: readonly string[],
  context: LaunchCommandContext,
  platform: NodeJS.Platform,
): Result<AcceptedLaunchCommand, DebuggenError> {
  const script = args[0];
  if (script === undefined || script.startsWith('-') || /[\0\r\n]/.test(script)) {
    return err(commandPolicyError('dev-cli-untrusted'));
  }
  const resolved = (platform === 'win32' ? win32 : posix).resolve(context.projectRoot, script);
  const cli = FRAMEWORK_DEV_CLIS.find((entry) => isFrameworkBinPath(resolved, entry, platform));
  const trusted = context.isTrustedFile ?? isTrustedDevCliFile;
  if (cli === undefined || !answersTrue(() => trusted(resolved))) {
    return err(commandPolicyError('dev-cli-untrusted'));
  }
  if (args[1] !== cli.subcommand) {
    return err(commandPolicyError('executable-not-allowed'));
  }
  const refused = firstRefusedDevServerArgument(args, 2);
  return refused === undefined
    ? ok(Object.freeze({ form: 'node-framework-cli' }))
    : err(commandPolicyError('argument-not-allowed', refused));
}

/**
 * Whether an executable is the service's own Node: bare `node` (on Windows
 * also `node.exe`, case-insensitively), or an absolute path whose real path
 * is the real path of `context.nodeExecutablePath`.
 */
function isServiceNode(
  file: string,
  platform: NodeJS.Platform,
  context: LaunchCommandContext,
): boolean {
  const windows = platform === 'win32';
  const bare = windows ? file.toLowerCase() : file;
  if (bare === 'node' || (windows && bare === 'node.exe')) {
    return true;
  }
  if (windows ? !WINDOWS_ROOTED_PATH.test(file) : !isAbsolutePosix(file)) {
    return false;
  }
  const realpath = context.realpath ?? defaultRealpath;
  const candidate = realpathOrUndefined(realpath, file);
  const service = realpathOrUndefined(realpath, context.nodeExecutablePath ?? process.execPath);
  if (candidate === undefined || service === undefined) {
    return false;
  }
  return windows ? candidate.toLowerCase() === service.toLowerCase() : candidate === service;
}

/** Whether a resolved path names `entry`'s package binary under a `node_modules` directory. */
function isFrameworkBinPath(
  resolved: string,
  entry: FrameworkDevCli,
  platform: NodeJS.Platform,
): boolean {
  const suffix = `/node_modules/${entry.packageBin}`;
  return platform === 'win32'
    ? toPosix(resolved).toLowerCase().endsWith(suffix.toLowerCase())
    : resolved.endsWith(suffix);
}

/**
 * Walk `args` from index `start` against {@link DEV_SERVER_ARGUMENT_ALLOWLIST}
 * and answer the 1-based index (after the executable) of the first word it
 * does not admit, or `undefined` when every word is admitted:
 *
 * - a boolean option is admitted as the whole word (`--turbopack`; never
 *   `--turbopack=1`);
 * - a valued option is admitted as `--long=value`, or as `--long value` or
 *   `-s value` where the separate value does not start with `-`, the value
 *   matching the option's `valuePattern`; the refused index is the value's
 *   when the value is wrong, the option's when it has none;
 * - every other word — a positional, `--`, an unlisted option, `-p=4173` — is
 *   refused where it stands.
 *
 * The walk mirrors how Next.js's option parser consumes the same words, so
 * no word it would read as an option value can slip past as something else.
 */
function firstRefusedDevServerArgument(args: readonly string[], start: number): number | undefined {
  for (let index = start; index < args.length; index += 1) {
    const word = args[index] ?? '';
    if (DEV_SERVER_BOOLEAN_OPTION_SET.has(word)) {
      continue;
    }
    const equals = word.indexOf('=');
    if (word.startsWith('--') && equals > 2) {
      const option = DEV_SERVER_LONG_OPTIONS.get(word.slice(0, equals));
      if (option === undefined || !option.valuePattern.test(word.slice(equals + 1))) {
        return index + 1;
      }
      continue;
    }
    const option = DEV_SERVER_LONG_OPTIONS.get(word) ?? DEV_SERVER_SHORT_OPTIONS.get(word);
    if (option === undefined) {
      return index + 1;
    }
    const value = args[index + 1];
    if (value === undefined) {
      return index + 1;
    }
    if (value.startsWith('-') || !option.valuePattern.test(value)) {
      return index + 2;
    }
    index += 1;
  }
  return undefined;
}

/** A path's real path through an injected resolver that may throw or answer anything. */
function realpathOrUndefined(
  realpath: (path: string) => string | undefined,
  path: string,
): string | undefined {
  try {
    const resolved: unknown = realpath(path);
    return typeof resolved === 'string' && resolved.length > 0 ? resolved : undefined;
  } catch {
    return undefined;
  }
}

/** Whether an injected predicate answered a literal `true`; a throw is `false`. */
function answersTrue(predicate: () => unknown): boolean {
  try {
    return predicate() === true;
  } catch {
    return false;
  }
}

/** The default real-path resolver: `fs.realpathSync.native`, `undefined` for any failure. */
function defaultRealpath(path: string): string | undefined {
  try {
    return realpathSync.native(path);
  } catch {
    return undefined;
  }
}

/** The fixed message and hint of each {@link LaunchCommandRefusal}; none echoes the command. */
const COMMAND_POLICY_REFUSALS: Readonly<
  Record<LaunchCommandRefusal, { readonly message: string; readonly hint: string }>
> = Object.freeze({
  'executable-not-allowed': Object.freeze({
    message:
      'The dev-server command does not start a dev server in a form the service runs: shells, env, npx, package-manager exec and arbitrary programs are refused.',
    hint: COMMAND_FORMS_HINT,
  }),
  'script-not-declared': Object.freeze({
    message:
      "The dev-server command runs no script that is one of this project's dev-server scripts, so it was not started.",
    hint: "A package-manager run may start only one of the project's dev-server scripts: the detected dev script or another package.json script that runs next dev — never a script such as deploy, lint or postinstall. Run one of them, add the command you need as a script that runs next dev and run that, or omit the command to use the detected dev script.",
  }),
  'argument-not-allowed': Object.freeze({
    message: 'The dev-server command passes an argument the service does not hand a dev server.',
    hint: `After the dev command, only these Next.js dev options are passed: ${[
      ...DEV_SERVER_ARGUMENT_ALLOWLIST.valuedOptions.map(
        (option) => `${option.short}/${option.long} <${option.valueName}>`,
      ),
      ...DEV_SERVER_ARGUMENT_ALLOWLIST.booleanOptions,
    ].join(
      ', ',
    )}. A positional argument such as a project directory, every other option and any shell syntax are refused, and no package-manager option may precede the script. npm takes the options only after -- ("npm run dev -- --port 4174"); pnpm, yarn and bun take them directly after the script, without -- ("pnpm run dev --port 4174"). Move anything else into a package.json script that runs next dev.`,
  }),
  'dev-cli-untrusted': Object.freeze({
    message:
      "The dev-server command runs Node with something other than the project's own framework dev CLI.",
    hint: `Node may run only ${FRAMEWORK_DEV_CLIS.map(
      (entry) => `node_modules/${entry.packageBin} ${entry.subcommand}`,
    ).join(
      ' or ',
    )}, with no Node option before it, from a regular file owned by the service's user that no one else can write. Pass Node options through an assigned NODE_OPTIONS, reinstall the project's dependencies if that file is missing or writable by others, or launch the package.json dev script instead.`,
  }),
});

/**
 * The refusal of a command by {@link checkLaunchCommand}: fixed text, and for
 * an argument its 1-based index after the executable — never the word.
 */
function commandPolicyError(refusal: LaunchCommandRefusal, argument?: number): DebuggenError {
  const { message, hint } = COMMAND_POLICY_REFUSALS[refusal];
  return commandError(refusal, message, hint, argument === undefined ? {} : { argument });
}

// ---------------------------------------------------------------------------
// Windows: cmd.exe as the executable, expansion syntax refused
// ---------------------------------------------------------------------------

/**
 * Characters `cmd.exe` expands or interprets **even inside double quotes**, or
 * that would end or break a quoted word: `%` and `!` (variable expansion —
 * `%DEBUGGEN_TOKEN%` would expand to the child's freshly minted credential),
 * `"` (ends the quoted word), `^ & | < >` (escape, command chaining, pipes,
 * redirection), and every C0 control and DEL (a CR or LF ends the command
 * line). The same set is what a `.cmd` shim such as `pnpm.cmd` would re-parse
 * through `%*`, so refusing it also closes that second parse. The controls are
 * checked by code point in {@link hasWindowsShellMetacharacter}.
 */
const WINDOWS_SHELL_METACHARACTERS: ReadonlySet<string> = new Set([
  '%',
  '!',
  '"',
  '^',
  '&',
  '|',
  '<',
  '>',
]);

/** The DEL control character. */
const DELETE_CODE = 0x7f;

/** Whether a word holds a {@link WINDOWS_SHELL_METACHARACTERS} member, a C0 control or DEL. */
function hasWindowsShellMetacharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (
      code < 0x20 ||
      code === DELETE_CODE ||
      WINDOWS_SHELL_METACHARACTERS.has(value.charAt(index))
    ) {
      return true;
    }
  }
  return false;
}

/** A drive-rooted (`C:\…`) or UNC (`\\server\share\…`) Windows path. */
const WINDOWS_ROOTED_PATH = /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+)/;

/** What `cmd.exe` is resolved to when the service's environment names no usable one. */
const DEFAULT_COMSPEC = 'cmd.exe';

/** Input of {@link buildWindowsCommandInvocation}. */
export interface WindowsCommandInput {
  /** The executable the developer's command names (`pnpm`, `node`, `C:\…\node.exe`). */
  readonly file: string;
  /** Its arguments, as {@link parseLaunchCommand} or the dev-script derivation produced them. */
  readonly args: readonly string[];
  /** The `cmd.exe` to run, from {@link resolveWindowsComSpec} — never from the request. */
  readonly comSpec: string;
}

/** What `spawn` receives on Windows: `cmd.exe` itself and its `/d /s /c` arguments. */
export interface WindowsCommandInvocation {
  /** The executable: the `comSpec` input. */
  readonly command: string;
  /** `['/d', '/s', '/c', '"<quoted words>"']`, to be passed with `windowsVerbatimArguments: true`. */
  readonly args: readonly string[];
}

/**
 * Build the Windows invocation of a dev-server command **without a shell
 * option**: `cmd.exe` is spawned as the executable (it is what resolves
 * `pnpm` → `pnpm.cmd` through `PATHEXT`), with the one command line Node
 * itself would build for `shell: true` — `/d /s /c "<line>"` — except that the
 * words are quoted here and anything `cmd.exe` would expand or interpret is
 * refused instead of being passed through (CWE-78).
 *
 * - Every word is refused when it contains `%`, `!`, `"`, `^`, `&`, `|`, `<`,
 *   `>` or a C0 control / DEL (CR, LF, NUL…): quoting does not stop `cmd.exe`
 *   from expanding `%VAR%` or `!VAR!`, so no escaping scheme is attempted.
 * - Spaces and parentheses are allowed: `C:\Program Files (x86)\…` works.
 * - Each word becomes `"` + the word with its trailing backslashes doubled +
 *   `"` — the MSVCRT rule that keeps a trailing `\` from escaping the closing
 *   quote — and the words are joined with single spaces. `/s` makes `cmd.exe`
 *   strip exactly the outer pair of quotes, so the program receives the words
 *   byte for byte.
 * - `/d` skips `AutoRun` commands from the registry.
 *
 * The result must be spawned with `shell: false` and
 * `windowsVerbatimArguments: true`, so Node does not quote the `/c` line a
 * second time.
 *
 * @param input The executable, its arguments and the `cmd.exe` to run.
 * @returns The invocation, or `DEV_SERVER_LAUNCH_FAILED` with
 * `details.reason: "windows-shell-metacharacter"`, whose message names only the
 * position ("the executable", "argument N") — never the word, which may carry
 * an inline secret.
 *
 * @example
 * ```ts
 * buildWindowsCommandInvocation({
 *   file: 'pnpm',
 *   args: ['run', 'dev'],
 *   comSpec: 'C:\\Windows\\System32\\cmd.exe',
 * });
 * // → ok({ command: 'C:\\Windows\\System32\\cmd.exe',
 * //        args: ['/d', '/s', '/c', '""pnpm" "run" "dev""'] })
 * ```
 */
export function buildWindowsCommandInvocation(
  input: WindowsCommandInput,
): Result<WindowsCommandInvocation, DebuggenError> {
  const words = [input.file, ...input.args];
  for (const [index, word] of words.entries()) {
    if (typeof word !== 'string' || hasWindowsShellMetacharacter(word)) {
      return err(windowsMetacharacterError(index));
    }
  }
  if (input.file.length === 0) {
    return err(commandError('no-executable', 'The dev-server command names no executable to run.'));
  }
  const line = words.map(quoteWindowsWord).join(' ');
  return ok(
    Object.freeze({
      command: input.comSpec,
      args: Object.freeze(['/d', '/s', '/c', `"${line}"`]),
    }),
  );
}

/** One word, double-quoted for the MSVCRT argument parser; it holds no `"` by then. */
function quoteWindowsWord(word: string): string {
  const trailing = /\\+$/.exec(word)?.[0] ?? '';
  return `"${word}${trailing}"`;
}

/** The refusal of a word `cmd.exe` would interpret; names the position, never the word. */
function windowsMetacharacterError(index: number): DebuggenError {
  const position = index === 0 ? 'the executable' : `argument ${String(index)}`;
  return new DebuggenError(
    'DEV_SERVER_LAUNCH_FAILED',
    `The dev-server command cannot run on Windows: ${position} contains a character cmd.exe would interpret.`,
    {
      hint: 'cmd.exe expands %VAR% and !VAR! and interprets ^ & | < > and double quotes, even inside quotes. Remove those characters from the command, or move the command into a package.json script and launch that.',
      details: {
        reason: 'windows-shell-metacharacter',
        position: index === 0 ? 'executable' : 'argument',
        ...(index === 0 ? {} : { argument: index }),
      },
    },
  );
}

/**
 * The `cmd.exe` a Windows launch runs, from the **service's own** environment
 * (never from a request's `NAME=value` assignments, which only reach the
 * child):
 *
 * 1. `ComSpec` (looked up case-insensitively), when it is a rooted Windows
 *    path whose file name is `cmd.exe`, case-insensitively;
 * 2. else `<SystemRoot>\System32\cmd.exe`, when `SystemRoot` is rooted;
 * 3. else `cmd.exe`, resolved by the system search path.
 *
 * A candidate containing whitespace or a {@link buildWindowsCommandInvocation}
 * metacharacter is skipped too: Node places the executable unquoted at the
 * head of a verbatim command line, where either would change how `cmd.exe`
 * reads the rest.
 *
 * @param env The service's environment.
 * @returns An absolute `cmd.exe` path, or `cmd.exe`.
 */
export function resolveWindowsComSpec(env: ParentEnvironment): string {
  const comSpec = windowsEnvValue(env, 'COMSPEC')?.trim();
  if (
    comSpec !== undefined &&
    isSafeWindowsExecutablePath(comSpec) &&
    (comSpec.split(/[\\/]/).pop() ?? '').toLowerCase() === 'cmd.exe'
  ) {
    return comSpec;
  }
  const systemRoot = windowsEnvValue(env, 'SYSTEMROOT')
    ?.trim()
    .replace(/[\\/]+$/, '');
  if (systemRoot !== undefined && isSafeWindowsExecutablePath(`${systemRoot}\\`)) {
    return `${systemRoot}\\System32\\cmd.exe`;
  }
  return DEFAULT_COMSPEC;
}

/** A rooted Windows path free of whitespace and of every refused metacharacter. */
function isSafeWindowsExecutablePath(value: string): boolean {
  return (
    WINDOWS_ROOTED_PATH.test(value) && !/\s/.test(value) && !hasWindowsShellMetacharacter(value)
  );
}

/** A variable's value on Windows, where names are case-insensitive; the first spelling wins. */
function windowsEnvValue(env: ParentEnvironment, upperName: string): string | undefined {
  for (const [name, value] of Object.entries(env)) {
    if (typeof value === 'string' && name.toUpperCase() === upperName) {
      return value;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Injected ports
// ---------------------------------------------------------------------------

/** A value, or a promise of one: a port may be synchronous or asynchronous. */
export type MaybePromise<T> = T | Promise<T>;

/** A freshly issued `server-agent` credential, as the issuer returns it. */
export interface ServerAgentCredential {
  /** The plaintext token — the one place it exists besides the child's environment. */
  readonly token: string;
  /** The issuer's handle for the credential, when it has one. Not secret. */
  readonly credentialId?: string | undefined;
  /** Epoch milliseconds after which the credential is refused, when it expires. */
  readonly expiresAt?: number | undefined;
}

/** What {@link ServerAgentCredentialIssuer.issue} is asked for. */
export interface ServerAgentCredentialIssueInput {
  /** The one absolute project root the credential may ingest for. */
  readonly projectRoot: string;
  /**
   * The expiry in epoch milliseconds. Always set by this launcher: the first
   * lease of a launched child ({@link DEFAULT_MANAGED_CREDENTIAL_LEASE_MS},
   * renewed while the child runs), or the first lease of a credential for
   * {@link DEV_SERVER_CREDENTIAL_PATH} ({@link DEFAULT_CLI_CREDENTIAL_LEASE_MS},
   * renewed while its dev server's control connection is online).
   */
  readonly expiresAt?: number | undefined;
  /**
   * `true` for a launched child's credential: a lease this service holds and
   * renews while the child runs, which the access boundary revokes on the next
   * start if this service crashed. Absent for a
   * {@link DEV_SERVER_CREDENTIAL_PATH} credential, which belongs to a dev
   * server the developer started: the launcher renews and revokes it while it
   * runs, and after a crash of this service it lapses within one
   * {@link DEFAULT_CLI_CREDENTIAL_LEASE_MS}.
   */
  readonly lease?: boolean | undefined;
}

/** What {@link ServerAgentCredentialIssuer.revoke} is told to revoke. */
export interface ServerAgentCredentialRevokeInput {
  /** The project root the credential was scoped to. */
  readonly projectRoot: string;
  /** The credential itself — what identifies the one credential to revoke. */
  readonly token: string;
  /** The issuer's handle, when {@link ServerAgentCredential.credentialId} carried one. */
  readonly credentialId?: string | undefined;
}

/** What {@link ServerAgentCredentialIssuer.renew} is asked to extend. */
export interface ServerAgentCredentialRenewInput extends ServerAgentCredentialRevokeInput {
  /** The lease's new expiry, in epoch milliseconds. */
  readonly expiresAt: number;
}

/**
 * The access boundary's credential operations, as the launcher needs them —
 * satisfied by `../server/auth.ts` through {@link serverAgentCredentialIssuer}.
 *
 * The implementation must honour AAP §0.5.6: a 32-byte CSPRNG token, stored
 * **only** as its SHA-256 hash in the `credentials` table with
 * `role: "server-agent"` and a scope of exactly that one `projectRoot`; ingest
 * is accepted only for that credential's project; and the credential stops
 * working when {@link revoke} is called (the launched process exited) or its
 * `expiresAt` passes.
 *
 * - `revoke` invalidates **exactly the credential it is handed** — never every
 *   credential of the project. It resolves to anything but an `Err` result
 *   once the credential no longer authenticates (including "it was already
 *   gone"); a `revoke` that throws, rejects or returns an `Err` is retried by
 *   the launcher with backoff until it succeeds or the lease lapses.
 * - `renew` extends a live, expiring credential's expiry: `ok(true)` when it
 *   did, `ok(false)` when the credential no longer exists (revoked or rotated
 *   away) — which the launcher takes as final — and an `Err` for a failure the
 *   next renewal retries. It must never revive a lapsed or revoked credential.
 */
export interface ServerAgentCredentialIssuer {
  issue(
    input: ServerAgentCredentialIssueInput,
  ): MaybePromise<Result<ServerAgentCredential, DebuggenError>>;
  renew(input: ServerAgentCredentialRenewInput): MaybePromise<Result<boolean, DebuggenError>>;
  revoke(input: ServerAgentCredentialRevokeInput): MaybePromise<unknown>;
}

/**
 * The access boundary's server-agent credential operations, declared here as
 * the consumer's port: `../server/auth.ts`'s `AuthService` satisfies it
 * structurally, so this module needs no import from the server layer.
 */
export interface ServerAgentCredentialAuthority {
  /** Mints a credential scoped to one project, optionally with an expiry. */
  issueServerAgentCredential(request: {
    readonly projectRoot: string;
    readonly expiresAt?: number | undefined;
    readonly lease?: boolean | undefined;
  }): Result<{ readonly token: string; readonly expiresAt?: number }, DebuggenError>;
  /** Extends one live, expiring credential; `false` when it no longer exists. */
  renewServerAgentCredential(token: string, expiresAt: number): Result<boolean, DebuggenError>;
  /** Revokes exactly one credential; `false` when it was already gone. */
  revokeServerAgentCredential(token: string): Result<boolean, DebuggenError>;
}

/**
 * The launcher's {@link ServerAgentCredentialIssuer} over the access boundary —
 * the adapter `../main.ts` wires.
 *
 * Every operation is keyed by the credential's own token, never by its
 * project: when one launched child exits, the credentials of every other dev
 * server of the same project stay valid. Revoking a whole project's
 * credentials is reserved for rotation and project teardown.
 *
 * @param authority The access boundary (`AuthService`).
 * @returns The credential port for {@link createDevServerLauncher}.
 *
 * @example
 * ```ts
 * const launcher = createDevServerLauncher({ config, logger, credentials: serverAgentCredentialIssuer(auth) });
 * ```
 */
export function serverAgentCredentialIssuer(
  authority: ServerAgentCredentialAuthority,
): ServerAgentCredentialIssuer {
  return Object.freeze({
    issue: (input: ServerAgentCredentialIssueInput) =>
      authority.issueServerAgentCredential({
        projectRoot: input.projectRoot,
        expiresAt: input.expiresAt,
        ...(input.lease === true ? { lease: true } : {}),
      }),
    renew: (input: ServerAgentCredentialRenewInput) =>
      authority.renewServerAgentCredential(input.token, input.expiresAt),
    revoke: (input: ServerAgentCredentialRevokeInput) =>
      authority.revokeServerAgentCredential(input.token),
  });
}

/**
 * One connected `server-agent`, as {@link addressedServerAgentPresence} reads
 * it. The client registry's snapshot (`../server/clients.ts`'s
 * `RegisteredClient`) satisfies it structurally.
 */
export interface ServerAgentConnectionView {
  /** Whether the connection is up now. */
  readonly online: boolean;
  /** When the connection was opened, in epoch milliseconds. */
  readonly connectedAt: number;
  /** When the connection last delivered a frame, in epoch milliseconds. */
  readonly lastSeenAt?: number | undefined;
  /** The project root the connection's credential is scoped to. */
  readonly projectRoot?: string | undefined;
  /** The credential the connection authenticated with, by its SHA-256 digest. */
  readonly principal: { readonly tokenHash: string };
}

/** The connected `server-agent`s of a project — the client registry in production. */
export interface ServerAgentConnectionSource {
  /** Every online `server-agent` connection of the project. */
  serverAgentsForProject(projectRoot: string): readonly ServerAgentConnectionView[];
}

/**
 * Preload presence for one dev-server address: whether a `server-agent` of the
 * project may be the preload of the process answering there, and the most
 * recent such connection. Structurally the readiness gate's
 * `ServerAgentReadinessSource`.
 */
export interface AddressedServerAgentPresence {
  hasServerAgentForProject(projectRoot: string): boolean;
  serverAgentForProject(projectRoot: string): Result<ServerAgentConnectionView, DebuggenError>;
}

/**
 * The connected preloads of a project that may belong to the process at one
 * dev-server address — the readiness gate's evidence for a session.
 *
 * A connection this launcher places at another address
 * ({@link DevServerLauncher.addressOfCredential}: the preload of a dev server
 * the service launched on another port) is no evidence for this one, so a
 * plain dev server on a second port of the same project is not reported
 * traced by it, and readiness carries the relaunch command (AAP §0.5.5). A
 * connection the service cannot place at any address — a
 * `POST /dev-server/credential` token of a dev server the developer started —
 * still counts, because readiness is defined by the project's connection (AAP
 * §0.7.1 Group 2) and the service has nothing to set against it. Without an
 * address, every online connection of the project counts.
 *
 * @param source The connected server agents (the client registry).
 * @param launcher Where the service's own children's credentials serve.
 * @param devServerUrl The session's dev-server address, when it has one.
 * @returns The presence for that address.
 */
export function addressedServerAgentPresence(
  source: ServerAgentConnectionSource,
  launcher: Pick<DevServerLauncher, 'addressOfCredential'>,
  devServerUrl: string | undefined,
): AddressedServerAgentPresence {
  const wanted = urlOrigin(devServerUrl);
  const servesHere = (connection: ServerAgentConnectionView): boolean => {
    if (wanted === undefined) {
      return true;
    }
    const placed = launcher.addressOfCredential(connection.principal.tokenHash);
    return placed === undefined || urlOrigin(placed) === wanted;
  };
  const candidates = (projectRoot: string): readonly ServerAgentConnectionView[] =>
    source
      .serverAgentsForProject(projectRoot)
      .filter((connection) => connection.online && servesHere(connection));
  return Object.freeze({
    hasServerAgentForProject: (projectRoot: string): boolean => candidates(projectRoot).length > 0,
    serverAgentForProject: (
      projectRoot: string,
    ): Result<ServerAgentConnectionView, DebuggenError> => {
      const latest = candidates(projectRoot).reduce<ServerAgentConnectionView | undefined>(
        (best, connection) =>
          best === undefined || connection.connectedAt >= best.connectedAt ? connection : best,
        undefined,
      );
      if (latest !== undefined) {
        return ok(latest);
      }
      return err(
        new DebuggenError(
          'SERVER_AGENT_NOT_READY',
          wanted === undefined
            ? 'No dev-server agent is connected for this project.'
            : "No dev-server agent is connected for the session's dev-server address.",
          {
            hint: 'Launch the dev server from Debug Generator so its Node preload can connect, then try again.',
            details: {
              reason: wanted === undefined ? 'no-server-agent' : 'no-server-agent-at-address',
            },
          },
        ),
      );
    },
  });
}

/** The slice of a readable stream the launcher reads. */
export interface ReadableLike {
  on(event: 'data', listener: (chunk: unknown) => void): unknown;
  on(event: 'end', listener: () => void): unknown;
}

/** The slice of a `ChildProcess` the launcher uses. */
export interface ChildProcessLike {
  /** The process id; `undefined` when the spawn failed (e.g. `ENOENT`). */
  readonly pid?: number | undefined;
  /** The exit code once exited, else `null`. */
  readonly exitCode: number | null;
  readonly stdout: ReadableLike | null;
  readonly stderr: ReadableLike | null;
  on(
    event: 'exit',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}

/** The options the launcher spawns every child with. */
export interface SpawnOptionsLike {
  /** The project root. */
  readonly cwd: string;
  /** From {@link buildDevServerEnv}. */
  readonly env: Readonly<Record<string, string>>;
  /** No stdin; stdout and stderr piped to the launcher, which digests and drops them. */
  readonly stdio: readonly ['ignore', 'pipe', 'pipe'];
  /**
   * Never a shell, on any platform. On Windows `cmd.exe` is the spawned
   * executable itself (it resolves `.cmd` shims), with the command line
   * {@link buildWindowsCommandInvocation} built and checked.
   */
  readonly shell: false;
  /**
   * `true` exactly for the Windows `cmd.exe` invocation, whose `/c` line is
   * already quoted and must reach `cmd.exe` as built; `false` everywhere else,
   * so Node quotes each argument itself.
   */
  readonly windowsVerbatimArguments: boolean;
  /** Always `true`: no console window on Windows. */
  readonly windowsHide: boolean;
  /**
   * `true` exactly when the launcher signals process groups (a real POSIX
   * spawn, or an injected {@link SignalProcessGroup}): the child then leads its
   * own group, so a stop reaches the whole tree — a package-manager runner, its
   * shell and the framework's server worker — rather than orphaning a
   * grandchild that keeps the port and the old code. The service stays the
   * owner either way: every child is stopped by `stop`, `stopForSession` or the
   * shutdown's `stopAll`. `false` on Windows, where it would open a console.
   */
  readonly detached: boolean;
}

/** `child_process.spawn`, narrowed. The seam that lets tests assert a launch without running one. */
export type SpawnLike = (
  command: string,
  args: readonly string[],
  options: SpawnOptionsLike,
) => ChildProcessLike;

/**
 * Send a signal to the process group led by `pid`, throwing an `ESRCH` error
 * when the group is gone, as `process.kill` does. Default:
 * `process.kill(-pid, signal)`. The launcher sends real signals only: `0`
 * would say that *some* group of that id exists, never whose, so group
 * membership after a leader's exit comes from a {@link ProcessGroupInspector}.
 */
export type SignalProcessGroup = (pid: number, signal: NodeJS.Signals | 0) => void;

/** An opaque timer handle. */
export type TimerHandle = unknown;

/** `setTimeout`, narrowed; injectable so a test drives time. */
export type SetTimeoutLike = (callback: () => void, ms: number) => TimerHandle;

/** `clearTimeout`, narrowed. */
export type ClearTimeoutLike = (handle: TimerHandle) => void;

/**
 * The detection collaborators the launcher forwards to `./detect.ts` —
 * everything except what the launcher itself decides (`config`, `logger`,
 * `preloadPath`, `ingestUrl`, `now`).
 */
export type LauncherDetectDeps = Pick<
  DevServerDetectDeps,
  | 'serverAgents'
  | 'fetchImpl'
  | 'readManifest'
  | 'resolvePackageManager'
  | 'projectSummary'
  | 'probeTimeoutMs'
>;

/** Collaborators of {@link createDevServerLauncher}. Only the first three are required. */
/**
 * The connected-client view the launcher attributes preload evidence with:
 * which credentials currently authenticate an online `server-agent`
 * connection. Satisfied in `../main.ts` over the client registry, which keeps
 * each connection's credential digest (never the token).
 */
export interface ServerAgentConnections {
  /**
   * Whether an online `server-agent` connection authenticated with the
   * credential whose SHA-256 hex digest is `tokenHash`.
   */
  isCredentialConnected(tokenHash: string): boolean;
}

export interface DevServerLauncherDeps {
  /**
   * The service's address. `port` must be the **bound** port — with a
   * configured port of `0`, pass the port the listener reported — because it
   * becomes the child's ingest endpoint and control-socket origin.
   */
  readonly config: Pick<ServiceConfig, 'host' | 'port'>;
  /** Parent logger; lines are bound to `subsystem: "dev-server"`. */
  readonly logger: Logger;
  /** Mints and revokes `server-agent` credentials. */
  readonly credentials: ServerAgentCredentialIssuer;
  /**
   * The service's environment. It is **never handed to a child whole**: only
   * the variables {@link isForwardedToDevServer} admits reach a launched dev
   * server (see {@link buildDevServerEnv}), so service-only credentials such
   * as `ANTHROPIC_API_KEY` stay in the service. It is also where a Windows
   * launch finds its `cmd.exe` ({@link resolveWindowsComSpec}). `../main.ts`
   * passes the same environment it handed `loadServiceConfig`, which keeps
   * this module free of `process.env` reads; absent, the service process's own
   * environment is read.
   */
  readonly parentEnv?: ParentEnvironment | undefined;
  /** Default: `child_process.spawn`. */
  readonly spawnImpl?: SpawnLike | undefined;
  /**
   * Default: `process.kill(-pid, signal)`, for a real POSIX spawn only. The
   * launcher signals a child's group directly only while the child (its
   * leader) is unreaped; after it exits, only a group
   * {@link DevServerLauncherDeps.processGroupInspector} verified.
   */
  readonly signalProcessGroup?: SignalProcessGroup | undefined;
  /**
   * Who is in a child's process group, so that after the leader exits the
   * launcher signals the group only while it holds a process the launcher
   * saw in it before — never a bare, possibly recycled, group id. Default:
   * {@link createProcessGroupInspector} over the service's environment when
   * the default spawn and signaller are in use (a real POSIX spawn); an
   * inspector that cannot tell whenever `spawnImpl` or `signalProcessGroup`
   * is injected without one, so a test's fake pid is never looked up on the
   * host — and a group that cannot be verified is never signalled. An
   * inspector with `confirm` is also asked, synchronously, right before each
   * such signal, and a group it does not confirm is not signalled.
   */
  readonly processGroupInspector?: ProcessGroupInspector | undefined;
  /** Default: `./detect.ts`'s {@link detectDevServer}. */
  readonly detect?: typeof detectDevServer | undefined;
  /** Default: `./detect.ts`'s {@link probeDevServer}. */
  readonly probe?: typeof probeDevServer | undefined;
  /**
   * Forwarded to detection: fetch, manifest reader… Readiness reuses
   * `fetchImpl` for its probes (see
   * {@link DevServerLauncherDeps.readyProbeTimeoutMs} for their timeout;
   * `probeTimeoutMs` here bounds detection's probe only). Its `serverAgents`
   * is not used by a launch: preload evidence for a probed address comes from
   * {@link DevServerLauncher.preloadServesAt} alone, and readiness never treats
   * a connected `server-agent` as the launched child, because an agent is
   * connected per project, not per port, and says nothing about which process
   * answers a probe.
   */
  readonly detectDeps?: LauncherDetectDeps | undefined;
  /**
   * Whether a launched child's own `server-agent` connection is online, by the
   * SHA-256 digest of its credential — the client registry in production.
   * Absent, a serving child counts as preloaded by construction (it was
   * spawned with `--import <preload>`); present, only once its preload has
   * actually connected.
   */
  readonly serverAgentConnections?: ServerAgentConnections | undefined;
  /**
   * Which processes hold the TCP listener a readiness probe was answered on —
   * the identity readiness is decided by: a target is ready only when
   * `ownsListener(child pid, port)` is `true`. Default:
   * {@link createListenerOwnership} for {@link DevServerLauncherDeps.platform}
   * over {@link DevServerLauncherDeps.parentEnv}. A test that spawns fake
   * children injects one that answers for them.
   */
  readonly listenerOwnership?: ListenerOwnership | undefined;
  /**
   * The Node that runs this service: the only absolute executable a launch
   * command may name ({@link checkLaunchCommand}, compared by real path).
   * Default: `process.execPath`.
   */
  readonly nodeExecutablePath?: string | undefined;
  /**
   * Whether the framework-CLI script a launch command runs with Node is a
   * file the service trusts to execute. Default: {@link isTrustedDevCliFile}.
   */
  readonly isTrustedDevCli?: ((path: string) => boolean) | undefined;
  /**
   * Whether a directory a launch command's `NODE_PATH` assignment names is
   * one the service trusts the child to load modules from. Default:
   * {@link isTrustedNodePathDirectory}.
   */
  readonly isTrustedDevDirectory?: ((path: string) => boolean) | undefined;
  /**
   * The canonical path of an executable a launch command names, or
   * `undefined` when it cannot be resolved. Default: `fs.realpathSync.native`.
   */
  readonly realpath?: ((path: string) => string | undefined) | undefined;
  /** Existence check for preload candidates. Default: a regular file at the path. */
  readonly fileExists?: ((path: string) => boolean) | undefined;
  /** Existence check for a project root. Default: a directory at the path. */
  readonly directoryExists?: ((path: string) => boolean) | undefined;
  /** Explicit preload path; see {@link resolvePreloadPath}. */
  readonly preloadPath?: string | undefined;
  /** Options for preload resolution other than the path and existence check. */
  readonly preloadResolution?:
    Pick<ResolvePreloadPathOptions, 'moduleUrl' | 'resolvePackage'> | undefined;
  /** Default: this process's platform. */
  readonly platform?: NodeJS.Platform | undefined;
  /** Clock in epoch milliseconds. Default: `nowEpochMs`. */
  readonly now?: (() => number) | undefined;
  /** Default {@link DEFAULT_READY_TIMEOUT_MS}. */
  readonly readyTimeoutMs?: number | undefined;
  /** Default {@link DEFAULT_READY_POLL_INTERVAL_MS}. */
  readonly readyPollIntervalMs?: number | undefined;
  /**
   * How long each readiness probe waits for an HTTP response. Default
   * {@link DEFAULT_READY_PROBE_TIMEOUT_MS}; a non-positive or non-finite
   * value takes the default, and a value above the ready timeout is clamped
   * to it.
   */
  readonly readyProbeTimeoutMs?: number | undefined;
  /** Default {@link DEFAULT_STOP_GRACE_MS}. */
  readonly stopGraceMs?: number | undefined;
  /** Default {@link DEFAULT_CLI_CREDENTIAL_LEASE_MS}. */
  readonly cliCredentialLeaseMs?: number | undefined;
  /** Default {@link CLI_CREDENTIAL_CHECK_INTERVAL_MS}. */
  readonly cliCredentialCheckIntervalMs?: number | undefined;
  /** Default {@link CLI_CREDENTIAL_DISCONNECT_GRACE_MS}. */
  readonly cliCredentialDisconnectGraceMs?: number | undefined;
  /** Default {@link DEFAULT_MANAGED_CREDENTIAL_LEASE_MS}. */
  readonly managedCredentialLeaseMs?: number | undefined;
  /** Default: the global `setTimeout`. */
  readonly setTimeoutImpl?: SetTimeoutLike | undefined;
  /** Default: the global `clearTimeout`. */
  readonly clearTimeoutImpl?: ClearTimeoutLike | undefined;
}

// ---------------------------------------------------------------------------
// Records and the launcher API
// ---------------------------------------------------------------------------

/**
 * Where a launched child is in its life. `failed` covers a start that did not
 * reach `ready` and a child that outlived its termination (a survivor, see
 * {@link DevServerSurvivor}); either way its credential is revoked, so a
 * `failed` child is never serving with a live preload.
 */
export type LaunchedDevServerStatus = 'starting' | 'ready' | 'stopping' | 'exited' | 'failed';

/**
 * One dev server this service launched. Plain frozen data, safe to log and to
 * send: it **never** carries the credential, the environment or a command's
 * arguments.
 */
export interface LaunchedDevServer {
  /** The absolute project root, normalised POSIX — the registry key. */
  readonly projectRoot: string;
  /** Where it serves, once known. */
  readonly devServerUrl?: string;
  readonly pid: number;
  /** The session that launched it, when one did — which makes it session-owned. */
  readonly sessionId?: string;
  /**
   * Every session currently relying on a session-owned child; it is stopped
   * when the last one ends. Always empty for a developer-owned child (launched
   * with no session), which no session end stops.
   */
  readonly sessionIds: readonly string[];
  /** The issuer's credential handle, when it returned one. */
  readonly credentialId?: string;
  /** Epoch milliseconds of the spawn. */
  readonly startedAt: number;
  readonly status: LaunchedDevServerStatus;
  /** The executable's name (no arguments). */
  readonly command: string;
  /**
   * The `package.json` script it runs, when it runs one: the detected dev
   * script, or the script a request's package-manager run named.
   */
  readonly script?: string;
}

/**
 * A hold on a launched dev server for a session being created; see
 * {@link DevServerLauncher.acquireForSession}. Exactly one of `commit` and
 * `release` takes effect; later calls do nothing.
 */
export interface DevServerHold {
  /** Where the held dev server serves. */
  readonly devServerUrl: string;
  /** Whether the child is session-owned, so the hold keeps it running. */
  readonly sessionOwned: boolean;
  /**
   * The session exists: it joins the owners of a session-owned child.
   *
   * @returns `true` when the session now holds the child; `false` for a
   *   developer-owned child, a child that stopped meanwhile, or a session that
   *   has already ended — in which case a session-owned child nothing else
   *   relies on is stopped.
   */
  commit(sessionId: string): boolean;
  /**
   * The session was not created: give the hold up, stopping a session-owned
   * child nothing else relies on any more.
   */
  release(): Promise<void>;
}

/** Input of {@link DevServerLauncher.launch}: the protocol request plus session context. */
export type DevServerLaunchInput = Omit<DevServerLaunchRequest, 'sessionId'> & {
  /**
   * The session the child's lifetime is tied to; see
   * {@link DevServerLauncher.stopForSession}. A spawn for a session is
   * session-owned; reusing a session-owned child adds this session to it.
   */
  readonly sessionId?: string | undefined;
  /**
   * The session's dev-server URL, probed first (a server already answering
   * there is reused or refused) and, after a spawn, probed for readiness after
   * the child's announced candidates — ready, like them, only once every
   * listener on its port is held by the launched child's process tree.
   */
  readonly devServerUrl?: string | undefined;
};

/** A dev server this launcher started (now, or earlier for the same project). */
export interface ManagedDevServerLaunch extends DevServerLaunchResponse {
  readonly managed: true;
  /** `true` when an existing child was returned instead of spawning a new one. */
  readonly alreadyRunning: boolean;
  /** The detection that preceded the spawn, when this call ran one. */
  readonly detection?: DevServerDetection;
}

/**
 * A dev server that already answers at the session's URL and that detection
 * reported **with** the preload attached, which this launch did not reuse.
 * Nothing was spawned, and the service owns no process for it — so there is no
 * `pid`, and `stop` does not touch it.
 *
 * A launch attributes a preload only through
 * {@link DevServerLauncher.preloadServesAt} — a child this launcher started,
 * which a launch reuses before it detects anything — so with the default
 * detection this result does not occur: a process the service did not start is
 * refused with the relaunch command instead. It remains in the union for an
 * injected detection that knows better.
 */
export interface ExternalDevServerLaunch {
  readonly managed: false;
  readonly alreadyRunning: true;
  readonly devServerUrl: string;
  readonly detection: DevServerDetection;
}

/** The success payload of {@link DevServerLauncher.launch}. */
export type DevServerLaunchResult = ManagedDevServerLaunch | ExternalDevServerLaunch;

/**
 * The protocol's `POST /dev-server/launch` body for a launch result:
 * `{ devServerUrl, pid }` for a managed server. `undefined` for an external
 * one, whose process the service does not own — the protocol's `pid` names a
 * process the stop route can end. With the default detection a launch is
 * always managed or refused (see {@link ExternalDevServerLaunch}).
 */
export function toDevServerLaunchResponse(
  result: DevServerLaunchResult,
): DevServerLaunchResponse | undefined {
  return result.managed ? { devServerUrl: result.devServerUrl, pid: result.pid } : undefined;
}

/** Input of {@link DevServerLauncher.stop}: at least one selector. */
export interface DevServerStopInput {
  /** The project whose launched dev server to stop (the protocol's stop request). */
  readonly projectRoot?: string | undefined;
  /** A launched child's pid. Only children this launcher started can match. */
  readonly pid?: number | undefined;
  /** Stop every child this session launched or relies on. */
  readonly sessionId?: string | undefined;
}

/**
 * A signal a launched child's termination could not deliver: `child.kill`
 * threw, named by the throw's closed class and code from `describeException`
 * (never its message, which names a pid and a platform detail only a debugger
 * needs), or returned `false`, Node's answer for a signal it did not deliver.
 */
export interface DevServerSignalFailure {
  readonly signal: NodeJS.Signals;
  /** `threw` — `kill` raised; `not-delivered` — `kill` returned `false`. */
  readonly refusal: 'threw' | 'not-delivered';
  /** The throw's label in the closed exception taxonomy; absent for `not-delivered`. */
  readonly errorClass?: ExceptionClass;
  /** The throw's closed-vocabulary code (`ESRCH`, `EPERM`), when it carried one. */
  readonly errorCode?: string;
}

/**
 * A launched dev server still running after its termination ran to the end —
 * `SIGTERM`, the grace period, `SIGKILL` (on Windows, the process-tree
 * backstop too) and the bounded wait for an exit — with no exit observed. Its
 * credential is revoked; it stays listed as `failed` until it exits, and the
 * next stop, launch or shutdown tries to end it again. Closed fields only.
 */
export interface DevServerSurvivor {
  /** The absolute project root, normalised POSIX. */
  readonly projectRoot: string;
  readonly pid: number;
  /** Signal deliveries refused across every termination attempt on this child. */
  readonly signalFailures: number;
  /** The most recent refused delivery, when there was one. */
  readonly lastSignalFailure?: DevServerSignalFailure;
}

/**
 * What {@link DevServerLauncher.stopForSession}, {@link DevServerLauncher.stopAll}
 * and {@link DevServerLauncher.dispose} resolve once their terminations ran.
 */
export interface DevServerTerminationReport {
  /** The children the call terminated that are still running; empty when every one stopped. */
  readonly survivors: readonly DevServerSurvivor[];
}

/** The dev-server launcher. Every method is safe to call concurrently; none throws. */
export interface DevServerLauncher {
  /**
   * Make sure the project's dev server runs with the preload: reuse one this
   * launcher started, refuse one it did not start that already answers at the
   * requested address (with the relaunch command), refuse an address another
   * process holds, or spawn one and wait until an address it announced (or the
   * requested URL) answers from a listener that child's process tree holds.
   * A child of this project that outlived an earlier stop is terminated once
   * more first; when it survives again the launch is refused with the same
   * `survived-termination` error {@link DevServerLauncher.stop} answers, so no
   * second server is started beside it and its record is never replaced.
   */
  launch(request: DevServerLaunchInput): Promise<Result<DevServerLaunchResult, DebuggenError>>;
  /**
   * Stop launched children matching the input (`SIGTERM`, then `SIGKILL` after
   * the grace period) and revoke their credentials. `stopped: false` — a
   * success — when nothing matched. A matched child still running afterwards
   * is an `Err` rather than `stopped: true`: `DEV_SERVER_LAUNCH_FAILED` with
   * `details.reason: 'survived-termination'`, its `pid`, every surviving pid
   * (`pids`) and the refused deliveries (`signalFailures`). Serves
   * `POST /dev-server/stop`.
   *
   * A stop is not reported clean while a credential of a matched child — or
   * of an earlier child of the same project whose revocation failed — still
   * authenticates: that is a `CLEANUP_PARTIAL` failure (reason
   * `credential-revocation-pending`), and each later stop retries the
   * revocation before answering.
   */
  stop(input: DevServerStopInput): Promise<Result<{ readonly stopped: boolean }, DebuggenError>>;
  /**
   * Mint a `server-agent` credential for a dev server the caller starts
   * itself — the logic behind {@link DEV_SERVER_CREDENTIAL_PATH}. The route
   * authorises (editor role and project scope); this validates, mints and
   * supervises. Runs synchronously from its entry to the issuer's `issue`.
   *
   * The credential is a lease of {@link DEFAULT_CLI_CREDENTIAL_LEASE_MS}: the
   * answer's `expiresAt` is the end of the first lease. The launcher renews it
   * while a `server-agent` control connection authenticated with it is online
   * ({@link DevServerLauncherDeps.serverAgentConnections}), revokes it
   * {@link CLI_CREDENTIAL_DISCONNECT_GRACE_MS} after that connection is gone —
   * the dev server exited — or at the end of the first lease when no preload
   * ever connected with it, and revokes it on {@link dispose}. {@link stop},
   * {@link stopForSession} and {@link stopAll} never touch it: this service did
   * not start its dev server.
   */
  issueCredential(
    input: DevServerCredentialRequest,
  ): Promise<Result<DevServerCredentialResponse, DebuggenError>>;
  /**
   * The session ended: release its hold on every session-owned child, stopping
   * each one no other session relies on and revoking its credential, and
   * cancel a launch for it still in flight. Developer-owned children are never
   * touched. Never rejects; `stopped` counts the children it stopped, and a
   * `CLEANUP_PARTIAL` failure says a stopped child's credential could not be
   * revoked yet (it is retried, and lapses with its lease at the latest; see
   * {@link whenReleased}). A released child still running after its whole
   * termination ladder is a survivor: the answer is then the
   * `survived-termination` failure {@link DevServerLauncher.stop} gives.
   */
  stopForSession(sessionId: string): Promise<Result<{ readonly stopped: number }, DebuggenError>>;
  /**
   * Resolves once every credential of the children {@link stopForSession}
   * stopped for `sessionId` no longer authenticates — at once when none was
   * pending. Never rejects; it stays pending for a credential nothing could
   * invalidate before shutdown (which then lapses with its lease).
   */
  whenReleased(sessionId: string): Promise<void>;
  /**
   * Holds the project's serving launched dev server for a session about to be
   * created — atomically with reading its URL — so no other session's end can
   * stop it before the new session exists.
   *
   * @returns The hold, or `undefined` when no launched dev server serves the
   *   project. For a developer-owned child the hold is trivial: no session end
   *   stops that child anyway.
   */
  acquireForSession(projectRoot: string): DevServerHold | undefined;
  /**
   * Whether the telemetry preload is attributable to the dev server answering
   * at `devServerUrl` for the project: only a child this launcher started for
   * exactly that project, serving at that URL's origin, whose own credential's
   * `server-agent` connection is online (see
   * {@link DevServerLauncherDeps.serverAgentConnections}). A reachable address
   * plus some connected agent of the project is not evidence — a plain dev
   * server on another port of the same project would pass that test — so any
   * process this service did not start is `false`: untraced, and reported with
   * the relaunch command.
   */
  preloadServesAt(projectRoot: string, devServerUrl: string): boolean;
  /**
   * Where the launched child whose credential has the SHA-256 digest
   * `tokenHash` serves (or last served), or `undefined` when the credential is
   * not one of this launcher's children's — a credential the service cannot
   * place at any address.
   */
  addressOfCredential(tokenHash: string): string | undefined;
  /**
   * Stop every launched child, a survivor of an earlier stop included.
   * Idempotent; never throws.
   *
   * @returns The children still running afterwards.
   */
  stopAll(): Promise<DevServerTerminationReport>;
  /**
   * Stop everything and refuse further launches. Idempotent — every call
   * returns the same promise — and never throws.
   *
   * @returns Every launched child still running once the final sweep and the
   * process-group reapers have finished: what the service shutdown reports.
   */
  dispose(): Promise<DevServerTerminationReport>;
  /** A snapshot of every launched child, survivors included (as `failed`). */
  list(): readonly LaunchedDevServer[];
}

// ---------------------------------------------------------------------------
// Child output: control-sequence stripping, line splitting, the output digest
// ---------------------------------------------------------------------------

/**
 * Remove terminal control sequences from a line: ANSI CSI (`ESC [ … final`),
 * OSC (`ESC ] … BEL` or `ESC ] … ESC \`), two-character escapes, carriage
 * returns and other C0 controls except tab. Dev servers colour their output;
 * the diagnostic patterns and the URL matcher want the text.
 */
function stripControlSequences(text: string): string {
  let result = '';
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code === ESCAPE_CODE) {
      const next = text[index + 1];
      if (next === '[') {
        let end = index + 2;
        while (end < text.length) {
          const final = text.charCodeAt(end);
          if (final >= 0x40 && final <= 0x7e) {
            break;
          }
          end += 1;
        }
        index = end;
      } else if (next === ']') {
        let end = index + 2;
        while (end < text.length) {
          const terminator = text.charCodeAt(end);
          if (terminator === BELL_CODE) {
            break;
          }
          if (terminator === ESCAPE_CODE && text[end + 1] === '\\') {
            end += 1;
            break;
          }
          end += 1;
        }
        index = end;
      } else {
        index += 1;
      }
      continue;
    }
    if (code < 0x20 && code !== 0x09) {
      continue;
    }
    if (code === 0x7f) {
      continue;
    }
    result += text.charAt(index);
  }
  return result;
}

/** Splits a byte or text stream into lines, holding at most one bounded partial line. */
class LineSplitter {
  readonly #decoder = new TextDecoder('utf-8');
  #pending = '';

  /** The complete lines a chunk finished. */
  push(chunk: unknown): string[] {
    let text: string;
    if (typeof chunk === 'string') {
      text = chunk;
    } else if (chunk instanceof Uint8Array) {
      text = this.#decoder.decode(chunk, { stream: true });
    } else {
      return [];
    }
    const parts = `${this.#pending}${text}`.split('\n');
    this.#pending = parts.pop() ?? '';
    if (this.#pending.length > MAX_PENDING_LINE_LENGTH) {
      parts.push(this.#pending);
      this.#pending = '';
    }
    return parts;
  }

  /** The unterminated remainder, once the stream is finished. */
  flush(): string[] {
    const rest = `${this.#pending}${this.#decoder.decode()}`;
    this.#pending = '';
    return rest.length === 0 ? [] : [rest];
  }
}

/**
 * A problem a dev server's output reported, from a closed vocabulary. Each id
 * is recognised by fixed patterns ({@link diagnoseOutputLine}) and rendered as
 * one fixed sentence in a startup failure's hint — the only form in which
 * anything a child printed reaches an error or a log record.
 */
export type DevServerOutputDiagnostic =
  | 'port-in-use'
  | 'module-not-found'
  | 'command-not-found'
  | 'permission-denied'
  | 'build-error'
  | 'out-of-memory';

/** Every {@link DevServerOutputDiagnostic}, in the order summaries and hints list them. */
export const DEV_SERVER_OUTPUT_DIAGNOSTICS: readonly DevServerOutputDiagnostic[] = Object.freeze([
  'port-in-use',
  'module-not-found',
  'command-not-found',
  'permission-denied',
  'build-error',
  'out-of-memory',
]);

/**
 * The fixed patterns behind each diagnostic, tested against the
 * control-stripped, length-bounded line. Error codes are matched
 * case-sensitively (they are printed that way); phrases case-insensitively.
 * Every pattern is anchored on word boundaries and free of nested
 * quantifiers, so a test is linear in the bounded line length.
 */
const OUTPUT_DIAGNOSTIC_PATTERNS: Readonly<Record<DevServerOutputDiagnostic, readonly RegExp[]>> =
  Object.freeze({
    'port-in-use': [
      /\bEADDRINUSE\b/,
      /\baddress already in use\b/i,
      /\bport \d{1,5} is (?:already )?in use\b/i,
    ],
    'module-not-found': [
      /\bCannot find module\b/i,
      /\bMODULE_NOT_FOUND\b/,
      /\bERR_MODULE_NOT_FOUND\b/,
      /\bModule not found\b/i,
    ],
    'command-not-found': [
      /\bcommand not found\b/i,
      /\bis not recognized as an internal or external command\b/i,
    ],
    'permission-denied': [/\bEACCES\b/, /\bEPERM\b/, /\bpermission denied\b/i],
    'build-error': [/\bFailed to compile\b/i, /\bSyntaxError\b/, /\bType error:/i],
    'out-of-memory': [/\bheap out of memory\b/i, /\bENOMEM\b/],
  });

/** The fixed hint sentence each diagnostic renders as. Never composed from output. */
const OUTPUT_DIAGNOSTIC_SENTENCES: Readonly<Record<DevServerOutputDiagnostic, string>> =
  Object.freeze({
    'port-in-use': 'Its output reported that the port is already in use.',
    'module-not-found': 'Its output reported a module that could not be found.',
    'command-not-found': 'Its output reported a command that could not be found.',
    'permission-denied': 'Its output reported that permission was denied.',
    'build-error': 'Its output reported a build error.',
    'out-of-memory': 'Its output reported that it ran out of memory.',
  });

/**
 * What a child's output is reduced to: counts and diagnostic ids, never a
 * character of what it printed. The ready, exited-before-ready, timeout and
 * spawn-failure log records carry the whole summary; a startup failure's
 * `details.output` carries `stdoutLines`, `stderrLines` and `diagnostics`.
 */
export interface DevServerOutputSummary {
  /** Non-blank lines the child printed on stdout. */
  readonly stdoutLines: number;
  /** Non-blank lines the child printed on stderr. */
  readonly stderrLines: number;
  /** Lines longer than the inspected prefix; only that prefix was inspected. */
  readonly truncatedLines: number;
  /** Each diagnostic recognised, once, in {@link DEV_SERVER_OUTPUT_DIAGNOSTICS} order. */
  readonly diagnostics: readonly DevServerOutputDiagnostic[];
}

/** One output line as it is inspected: control sequences stripped, length bounded. */
interface NormalizedOutputLine {
  /** At most {@link MAX_OUTPUT_LINE_LENGTH} characters of text. Never stored. */
  readonly text: string;
  /** Whether the line was longer than what `text` holds. */
  readonly truncated: boolean;
}

/**
 * The inspected form of a raw output line, or `undefined` for a blank one —
 * blank lines are neither counted nor inspected.
 */
function normalizeOutputLine(raw: string): NormalizedOutputLine | undefined {
  const cleaned = stripControlSequences(raw).trimEnd();
  if (cleaned.trim().length === 0) {
    return undefined;
  }
  return cleaned.length > MAX_OUTPUT_LINE_LENGTH
    ? { text: cleaned.slice(0, MAX_OUTPUT_LINE_LENGTH), truncated: true }
    : { text: cleaned, truncated: false };
}

/** The diagnostics `text` matches, skipping ids already known, in vocabulary order. */
function matchDiagnostics(
  text: string,
  known: ReadonlySet<DevServerOutputDiagnostic>,
): DevServerOutputDiagnostic[] {
  return DEV_SERVER_OUTPUT_DIAGNOSTICS.filter(
    (id) => !known.has(id) && OUTPUT_DIAGNOSTIC_PATTERNS[id].some((pattern) => pattern.test(text)),
  );
}

/**
 * The diagnostics one output line reports, by the fixed patterns of the closed
 * {@link DevServerOutputDiagnostic} vocabulary. Terminal control sequences are
 * stripped first, and only the first {@link MAX_OUTPUT_LINE_LENGTH} characters
 * are inspected. Pure: the line is neither kept nor logged.
 *
 * @param line One raw output line.
 * @returns The ids it matches, in {@link DEV_SERVER_OUTPUT_DIAGNOSTICS} order; empty for none.
 *
 * @example
 * ```ts
 * diagnoseOutputLine('Error: listen EADDRINUSE: address already in use :::4173');
 * // → ['port-in-use']
 * ```
 */
export function diagnoseOutputLine(line: string): readonly DevServerOutputDiagnostic[] {
  const normalized = typeof line === 'string' ? normalizeOutputLine(line) : undefined;
  return Object.freeze(
    normalized === undefined ? [] : matchDiagnostics(normalized.text, new Set()),
  );
}

/**
 * One child's output, reduced line by line to a {@link DevServerOutputSummary}
 * as it arrives. It holds counters and a set of ids — no text — so its size is
 * constant however much the child prints.
 */
class OutputDigest {
  #stdoutLines = 0;
  #stderrLines = 0;
  #truncatedLines = 0;
  readonly #diagnostics = new Set<DevServerOutputDiagnostic>();

  /** Count and classify one normalized line; the line itself is not retained. */
  record(stream: 'stdout' | 'stderr', line: NormalizedOutputLine): void {
    if (stream === 'stdout') {
      this.#stdoutLines += 1;
    } else {
      this.#stderrLines += 1;
    }
    if (line.truncated) {
      this.#truncatedLines += 1;
    }
    for (const id of matchDiagnostics(line.text, this.#diagnostics)) {
      this.#diagnostics.add(id);
    }
  }

  /** A frozen snapshot of the counts and ids so far. */
  summary(): DevServerOutputSummary {
    return Object.freeze({
      stdoutLines: this.#stdoutLines,
      stderrLines: this.#stderrLines,
      truncatedLines: this.#truncatedLines,
      diagnostics: Object.freeze(
        DEV_SERVER_OUTPUT_DIAGNOSTICS.filter((id) => this.#diagnostics.has(id)),
      ),
    });
  }
}

/** The summary of a child that printed nothing — or never ran. */
const EMPTY_OUTPUT_SUMMARY: DevServerOutputSummary = new OutputDigest().summary();

/**
 * The readiness candidates one normalized output line announces: every
 * distinct loopback URL on it that a serving-address label introduces
 * ({@link isServingAddressLabelled}), as `origin/`, in the order printed. A
 * loopback URL anywhere else on the line is not a candidate, and the
 * service's own port never is.
 *
 * @example
 * ```ts
 * announcedLoopbackUrls('  - Local:   http://localhost:3000', 43117); // → ['http://localhost:3000/']
 * announcedLoopbackUrls('database is not ready; see http://localhost:4173/docs', 43117); // → []
 * ```
 */
function announcedLoopbackUrls(line: string, servicePort: number): string[] {
  // Same length as `line`, with every URL token blanked, so the text in
  // front of a match is read at the match's own index.
  const masked = line.replace(URL_TOKEN_PATTERN, (token) => ' '.repeat(token.length));
  const origins: string[] = [];
  for (const match of line.matchAll(LOOPBACK_URL_PATTERN)) {
    if (!isServingAddressLabelled(masked.slice(0, match.index))) {
      continue;
    }
    let url: URL;
    try {
      url = new URL(match[0]);
    } catch {
      continue;
    }
    const port = Number(url.port);
    const origin = `${url.origin}/`;
    // The service's own port is never the dev server's: a child that echoes
    // its environment prints the ingest endpoint, and the preload may log it.
    if (
      Number.isInteger(port) &&
      port >= 1 &&
      port <= MAX_TCP_PORT &&
      port !== servicePort &&
      !origins.includes(origin)
    ) {
      origins.push(origin);
    }
  }
  return origins;
}

/**
 * Whether the text in front of a loopback URL (with earlier URL tokens
 * blanked) ends with a serving-address label
 * ({@link SERVING_ADDRESS_LABEL_PATTERN}) followed by whitespace.
 */
function isServingAddressLabelled(before: string): boolean {
  const label = before.trimEnd();
  return label.length < before.length && SERVING_ADDRESS_LABEL_PATTERN.test(label);
}

// ---------------------------------------------------------------------------
// Listener ownership: which process tree holds a TCP port
// ---------------------------------------------------------------------------

/**
 * The operating system's answer to "is the listener on this port held by the
 * process this launch started?" — the identity readiness is decided by (see
 * {@link DevServerLauncherDeps.listenerOwnership}).
 *
 * {@link ListenerOwnership.ownsListener} resolves:
 *
 * - `true` — at least one TCP socket in the `LISTEN` state exists on `port`
 *   (any local address, IPv4 or IPv6) and **every** such socket is held by a
 *   process in the process tree rooted at `rootPid`, the root included;
 * - `false` — at least one listener on `port` is held by a process outside
 *   that tree, or no listener on `port` is visible although the operating
 *   system's view is available;
 * - `undefined` — it cannot be determined: the platform has no supported
 *   lookup, or the lookup failed, timed out, was denied or printed something
 *   unexpected.
 *
 * "Every" is deliberate: a second process bound to the same port (the other
 * address family, or `SO_REUSEPORT`) could be the one a probe reached, so a
 * port shared with anything outside the tree is not the child's. An
 * implementation never rejects, never throws and never logs what a lookup
 * printed. {@link createListenerOwnership} is the default.
 */
export interface ListenerOwnership {
  /**
   * @param rootPid The launched child's pid: the root of the tree that must hold the port.
   * @param port The TCP port a readiness probe was answered on, `1`–`65535`.
   */
  ownsListener(rootPid: number, port: number): Promise<boolean | undefined>;
}

/**
 * The read-only filesystem calls the Linux lookup makes, each rejecting with
 * an errno-coded error (`ENOENT`, `ESRCH`, `EACCES`…) the way `node:fs`
 * does. Injectable so a test can model a kernel without
 * `/proc/<pid>/task/<tid>/children`, a denied descriptor table or a
 * malformed socket table.
 */
export interface ListenerOwnershipFs {
  /** The whole file as UTF-8 text. */
  readFile(path: string): Promise<string>;
  /** The names in a directory. */
  readdir(path: string): Promise<readonly string[]>;
  /** A symbolic link's target. */
  readlink(path: string): Promise<string>;
}

/** What one ownership command reported. */
export interface ListenerOwnershipCommandOutcome {
  /**
   * The exit status; `null` when the command did not exit on its own — it
   * failed to start, was killed, or exceeded its output bound.
   */
  readonly exitCode: number | null;
  /** Standard output as UTF-8 text. Parsed for process ids only; never logged or kept. */
  readonly stdout: string;
  /** Whether the command was killed for outliving its timeout. */
  readonly timedOut: boolean;
}

/** How an ownership command is run. */
export interface ListenerOwnershipCommandOptions {
  /** Kill the command after this many milliseconds. */
  readonly timeoutMs: number;
  /** The environment it runs with: the service's own, never a child's. */
  readonly env: Readonly<Record<string, string>>;
}

/**
 * Run one fixed lookup command **without a shell** (`execFile` semantics,
 * `shell: false`, `windowsHide: true`, the timeout enforced) and report how it
 * ended. It resolves for a command that fails to start, too. The default runs
 * `node:child_process`'s `execFile` with a bounded output buffer.
 */
export type ListenerOwnershipRunCommand = (
  file: string,
  args: readonly string[],
  options: ListenerOwnershipCommandOptions,
) => Promise<ListenerOwnershipCommandOutcome>;

/** Options of {@link createListenerOwnership}; every member optional. */
export interface ListenerOwnershipOptions {
  /** Which lookup to use. Default: this process's platform. */
  readonly platform?: NodeJS.Platform | undefined;
  /** The Linux lookup's filesystem. Default: `node:fs/promises`. */
  readonly fs?: ListenerOwnershipFs | undefined;
  /** How the macOS, POSIX and Windows lookups run their commands. Default: `execFile`. */
  readonly runCommand?: ListenerOwnershipRunCommand | undefined;
  /**
   * The service's environment: what the commands run with, and where Windows
   * finds `SystemRoot` for PowerShell. Default: this process's environment.
   */
  readonly env?: ParentEnvironment | undefined;
  /** Each command's timeout. Default {@link DEFAULT_LISTENER_LOOKUP_TIMEOUT_MS}. */
  readonly commandTimeoutMs?: number | undefined;
}

/** One platform's lookup over validated arguments; a throw reads as `undefined`. */
type OwnershipLookup = (rootPid: number, port: number) => Promise<boolean | undefined>;

/** The two commands the `lsof` lookup runs. */
interface LsofLookupCommands {
  readonly lsof: string;
  readonly ps: string;
}

/** macOS: both tools at their fixed system locations, whatever the service's `PATH`. */
const DARWIN_LOOKUP_COMMANDS: LsofLookupCommands = Object.freeze({
  lsof: '/usr/sbin/lsof',
  ps: '/bin/ps',
});

/** Other POSIX systems, whose tools live in different places: found on the service's `PATH`. */
const POSIX_LOOKUP_COMMANDS: LsofLookupCommands = Object.freeze({ lsof: 'lsof', ps: 'ps' });

/**
 * Create the default {@link ListenerOwnership} for a platform.
 *
 * - **Linux** (and Android): `/proc` alone, no command. The `LISTEN` sockets
 *   on the port come from `/proc/net/tcp` and `/proc/net/tcp6` (state `0A`,
 *   the port in the `local_address` column, the socket inode in the tenth);
 *   the tree is walked through `/proc/<pid>/task/<tid>/children`, or — on a
 *   kernel without that file — by reading every `/proc/<pid>/stat` for its
 *   parent pid (the field after the **last** `)`, since a command name may
 *   hold one); a listener is held in the tree when a tree process has a
 *   descriptor linking to `socket:[<inode>]`. A tree process whose
 *   descriptors cannot be read makes a listener not found there
 *   "cannot tell" rather than "another process".
 * - **macOS and other POSIX systems**: `lsof -nP -iTCP:<port> -sTCP:LISTEN
 *   -Fp` for the holders (`p<pid>` lines; exit status 1 with no output means
 *   no listener) and `ps -A -o pid= -o ppid=` for the tree. Without
 *   privileges `lsof` may not see another user's processes, so a listener
 *   only such a process holds can go unseen there.
 * - **Windows**: one fixed PowerShell invocation (`powershell.exe` from the
 *   service's `SystemRoot`, under the rules {@link resolveWindowsComSpec}
 *   applies, else from the search path; `-NoProfile -NonInteractive
 *   -Command`) printing the `OwningProcess` of `Get-NetTCPConnection -State
 *   Listen -LocalPort <port>` and every `ProcessId ParentProcessId` pair of
 *   `Get-CimInstance Win32_Process`. Windows reuses process ids, so a parent
 *   id can name a newer process than the one that started the child.
 *
 * Every command runs through `execFile` semantics — no shell, no window, a
 * timeout — and only a validated integer (the port, `1`–`65535`) is ever
 * interpolated into one. Output in any shape other than the expected one, a
 * non-zero exit (other than `lsof`'s empty 1), a timeout or any failure is
 * `undefined`. Nothing is logged; command output is parsed for process ids
 * and dropped.
 *
 * @param options Platform, filesystem, command runner and environment; all optional.
 * @returns The ownership port. It holds no resources between calls.
 *
 * @example
 * ```ts
 * const ownership = createListenerOwnership({ env: process.env });
 * await ownership.ownsListener(child.pid, 3000); // → true once the child listens on 3000
 * ```
 */
export function createListenerOwnership(options: ListenerOwnershipOptions = {}): ListenerOwnership {
  const lookup = ownershipLookupFor(options);
  return Object.freeze({
    ownsListener: async (rootPid: number, port: number): Promise<boolean | undefined> => {
      if (validPid(rootPid) === undefined || !isTcpPort(port)) {
        return undefined;
      }
      try {
        const verdict: unknown = await lookup(rootPid, port);
        return verdict === true || verdict === false ? verdict : undefined;
      } catch {
        // A lookup that fails in a way it did not anticipate cannot tell.
        return undefined;
      }
    },
  });
}

/** The lookup for the configured platform. */
function ownershipLookupFor(options: ListenerOwnershipOptions): OwnershipLookup {
  const platform = options.platform ?? process.platform;
  const run = options.runCommand ?? defaultRunCommand;
  const timeoutMs = positiveOr(options.commandTimeoutMs, DEFAULT_LISTENER_LOOKUP_TIMEOUT_MS);
  const commandOptions = (): ListenerOwnershipCommandOptions => ({
    timeoutMs,
    env: lookupEnvironment(options.env ?? process.env, platform),
  });
  switch (platform) {
    case 'linux':
    case 'android': {
      const fs = options.fs ?? defaultOwnershipFs;
      return (rootPid, port) => procOwnership(fs, rootPid, port);
    }
    case 'win32':
      return (rootPid, port) =>
        windowsOwnership(
          run,
          resolveWindowsPowerShell(options.env ?? process.env),
          commandOptions(),
          rootPid,
          port,
        );
    default: {
      const commands = platform === 'darwin' ? DARWIN_LOOKUP_COMMANDS : POSIX_LOOKUP_COMMANDS;
      return (rootPid, port) => lsofOwnership(run, commands, commandOptions(), rootPid, port);
    }
  }
}

/** Whether a value is a TCP port number, `1`–`65535`. */
function isTcpPort(port: unknown): port is number {
  return typeof port === 'number' && Number.isInteger(port) && port >= 1 && port <= MAX_TCP_PORT;
}

/** Whether a filesystem error means the process, thread or descriptor is gone. */
function isVanished(error: unknown): boolean {
  const code = errnoCodeOf(error);
  return code === 'ENOENT' || code === 'ESRCH';
}

/**
 * The process tree rooted at `rootPid` over a pid → parent-pid table: the
 * root and every descendant. Empty when the root is not in the table (it has
 * exited, so nothing is in its tree); `undefined` beyond
 * {@link MAX_OWNERSHIP_TREE_SIZE}.
 */
function processTreeOf(
  rootPid: number,
  parents: ReadonlyMap<number, number>,
): ReadonlySet<number> | undefined {
  if (!parents.has(rootPid)) {
    return new Set();
  }
  const children = new Map<number, number[]>();
  for (const [pid, parent] of parents) {
    if (pid !== parent) {
      const siblings = children.get(parent);
      if (siblings === undefined) {
        children.set(parent, [pid]);
      } else {
        siblings.push(pid);
      }
    }
  }
  const tree = new Set<number>([rootPid]);
  const queue = [rootPid];
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    for (const child of children.get(next) ?? []) {
      if (!tree.has(child)) {
        tree.add(child);
        if (tree.size > MAX_OWNERSHIP_TREE_SIZE) {
          return undefined;
        }
        queue.push(child);
      }
    }
  }
  return tree;
}

// Linux: /proc --------------------------------------------------------------

/** The Linux lookup; see {@link createListenerOwnership}. */
async function procOwnership(
  fs: ListenerOwnershipFs,
  rootPid: number,
  port: number,
): Promise<boolean | undefined> {
  const listeners = await procListenerInodes(fs, port);
  if (listeners === undefined) {
    return undefined;
  }
  if (listeners.size === 0) {
    return false;
  }
  const tree = await procProcessTree(fs, rootPid);
  if (tree === undefined) {
    return undefined;
  }
  const held = await procSocketInodes(fs, tree);
  if ([...listeners].every((inode) => held.inodes.has(inode))) {
    return true;
  }
  // A listener no readable tree process holds is another process's — unless
  // part of the tree could not be read, where it may be hiding.
  return held.complete ? false : undefined;
}

/**
 * The inodes of every `LISTEN` socket on `port` in both socket tables. A
 * table that does not exist (that address family is disabled) holds none;
 * `undefined` when neither exists, one cannot be read, or one is malformed.
 */
async function procListenerInodes(
  fs: ListenerOwnershipFs,
  port: number,
): Promise<ReadonlySet<string> | undefined> {
  const inodes = new Set<string>();
  let tablesRead = 0;
  for (const table of PROC_NET_TCP_TABLES) {
    let text: string;
    try {
      text = await fs.readFile(table);
    } catch (error) {
      if (errnoCodeOf(error) === 'ENOENT') {
        continue;
      }
      return undefined;
    }
    const found = listenerInodesOf(text, port);
    if (found === undefined) {
      return undefined;
    }
    for (const inode of found) {
      inodes.add(inode);
    }
    tablesRead += 1;
  }
  return tablesRead === 0 ? undefined : inodes;
}

/**
 * The inodes of the `LISTEN` sockets on `port` in one `/proc/net/tcp*` table,
 * or `undefined` when the table is not in the kernel's shape: a header naming
 * `local_address` and `inode`, then rows of at least ten columns with a
 * hexadecimal address and state and a decimal inode. A listening row with
 * inode `0` cannot be attributed to any process, so it is `undefined` too.
 */
function listenerInodesOf(text: string, port: number): string[] | undefined {
  const [header = '', ...rows] = text.split('\n');
  if (!/\blocal_address\b/.test(header) || !/\binode\b/.test(header)) {
    return undefined;
  }
  const inodes: string[] = [];
  for (const row of rows) {
    const fields = row.trim().split(/\s+/);
    if (fields.length === 1 && fields[0] === '') {
      continue;
    }
    const [, local = '', , state = '', , , , , , inode = ''] = fields;
    const portHex = PROC_LOCAL_ADDRESS_PATTERN.exec(local)?.[1];
    if (portHex === undefined || !/^[0-9A-F]{2}$/i.test(state) || !/^\d{1,20}$/.test(inode)) {
      return undefined;
    }
    if (state.toUpperCase() !== PROC_TCP_LISTEN_STATE || Number.parseInt(portHex, 16) !== port) {
      continue;
    }
    if (/^0+$/.test(inode)) {
      return undefined;
    }
    inodes.push(inode);
  }
  return inodes;
}

/**
 * The process tree rooted at `rootPid`: through the kernel's
 * `/proc/<pid>/task/<tid>/children` lists when the root's main thread offers
 * one, else from every process's parent pid. Empty when the root has exited;
 * `undefined` when `/proc` cannot be read or the tree is too large.
 */
async function procProcessTree(
  fs: ListenerOwnershipFs,
  rootPid: number,
): Promise<ReadonlySet<number> | undefined> {
  let leader: readonly string[];
  try {
    leader = await fs.readdir(`${PROC_ROOT}/${String(rootPid)}/task/${String(rootPid)}`);
  } catch (error) {
    return isVanished(error) ? new Set() : undefined;
  }
  if (!leader.includes('children')) {
    return procTreeFromStat(fs, rootPid);
  }
  const tree = new Set<number>([rootPid]);
  const queue = [rootPid];
  for (let pid = queue.shift(); pid !== undefined; pid = queue.shift()) {
    const children = await procChildrenOf(fs, pid);
    if (children === undefined) {
      return undefined;
    }
    for (const child of children) {
      if (!tree.has(child)) {
        tree.add(child);
        if (tree.size > MAX_OWNERSHIP_TREE_SIZE) {
          return undefined;
        }
        queue.push(child);
      }
    }
  }
  return tree;
}

/**
 * The children of every thread of `pid`, from `/proc/<pid>/task/<tid>/children`.
 * A process or thread that exits meanwhile has none; `undefined` for any other
 * failure or a list that is not decimal pids.
 */
async function procChildrenOf(fs: ListenerOwnershipFs, pid: number): Promise<number[] | undefined> {
  let threads: readonly string[];
  try {
    threads = await fs.readdir(`${PROC_ROOT}/${String(pid)}/task`);
  } catch (error) {
    return isVanished(error) ? [] : undefined;
  }
  const children: number[] = [];
  for (const thread of threads.filter((name) => DECIMAL_NAME_PATTERN.test(name))) {
    let list: string;
    try {
      list = await fs.readFile(`${PROC_ROOT}/${String(pid)}/task/${thread}/children`);
    } catch (error) {
      if (isVanished(error)) {
        continue;
      }
      return undefined;
    }
    for (const word of list.split(/\s+/)) {
      if (word.length === 0) {
        continue;
      }
      const child = DECIMAL_NAME_PATTERN.test(word) ? validPid(Number(word)) : undefined;
      if (child === undefined) {
        return undefined;
      }
      children.push(child);
    }
  }
  return children;
}

/**
 * The process tree from every `/proc/<pid>/stat`'s parent pid, for a kernel
 * without the `children` lists. A process that exits meanwhile is skipped.
 */
async function procTreeFromStat(
  fs: ListenerOwnershipFs,
  rootPid: number,
): Promise<ReadonlySet<number> | undefined> {
  let names: readonly string[];
  try {
    names = await fs.readdir(PROC_ROOT);
  } catch {
    return undefined;
  }
  const parents = new Map<number, number>();
  for (const name of names) {
    const pid = DECIMAL_NAME_PATTERN.test(name) ? validPid(Number(name)) : undefined;
    if (pid === undefined) {
      continue;
    }
    let stat: string;
    try {
      stat = await fs.readFile(`${PROC_ROOT}/${String(pid)}/stat`);
    } catch (error) {
      if (isVanished(error)) {
        continue;
      }
      return undefined;
    }
    const parent = parentPidOfStat(stat);
    if (parent === undefined) {
      return undefined;
    }
    parents.set(pid, parent);
  }
  return processTreeOf(rootPid, parents);
}

/**
 * The parent pid in a `/proc/<pid>/stat` line: the second field after the
 * **last** `)`, because the command name before it is parenthesised and may
 * itself contain `)` or spaces. `0` for a process the kernel started.
 */
function parentPidOfStat(stat: string): number | undefined {
  const close = stat.lastIndexOf(')');
  if (close < 0) {
    return undefined;
  }
  const parent = stat
    .slice(close + 1)
    .trim()
    .split(/\s+/)[1];
  return parent !== undefined && DECIMAL_NAME_PATTERN.test(parent) ? Number(parent) : undefined;
}

/** The socket inodes a tree holds, and whether every tree process's descriptors could be read. */
interface HeldSockets {
  readonly inodes: ReadonlySet<string>;
  readonly complete: boolean;
}

/** One descriptor's link target, or a note that it could not be read. */
type DescriptorLink = { readonly target: string } | { readonly unreadable: true } | undefined;

/**
 * The socket inodes the tree's processes hold, from `readlink` of every
 * `/proc/<pid>/fd/<n>`. A process or descriptor that disappears meanwhile
 * holds nothing; one that cannot be read (or a tree past
 * {@link MAX_INSPECTED_DESCRIPTORS}) makes the answer incomplete.
 */
async function procSocketInodes(
  fs: ListenerOwnershipFs,
  tree: ReadonlySet<number>,
): Promise<HeldSockets> {
  const inodes = new Set<string>();
  let complete = true;
  let inspected = 0;
  for (const pid of tree) {
    const directory = `${PROC_ROOT}/${String(pid)}/fd`;
    let descriptors: readonly string[];
    try {
      descriptors = (await fs.readdir(directory)).filter((name) => DECIMAL_NAME_PATTERN.test(name));
    } catch (error) {
      complete &&= isVanished(error);
      continue;
    }
    if (inspected + descriptors.length > MAX_INSPECTED_DESCRIPTORS) {
      complete = false;
      break;
    }
    inspected += descriptors.length;
    const links = await Promise.all(
      descriptors.map(async (descriptor): Promise<DescriptorLink> => {
        try {
          return { target: await fs.readlink(`${directory}/${descriptor}`) };
        } catch (error) {
          return isVanished(error) ? undefined : { unreadable: true };
        }
      }),
    );
    for (const link of links) {
      if (link === undefined) {
        continue;
      }
      if ('unreadable' in link) {
        complete = false;
        continue;
      }
      const inode = PROC_SOCKET_LINK_PATTERN.exec(link.target)?.[1];
      if (inode !== undefined) {
        inodes.add(inode);
      }
    }
  }
  return { inodes, complete };
}

// macOS and other POSIX systems: lsof and ps -----------------------------------

/** The `lsof` lookup; see {@link createListenerOwnership}. */
async function lsofOwnership(
  run: ListenerOwnershipRunCommand,
  commands: LsofLookupCommands,
  options: ListenerOwnershipCommandOptions,
  rootPid: number,
  port: number,
): Promise<boolean | undefined> {
  const listing = await runLookup(
    run,
    commands.lsof,
    ['-nP', `-iTCP:${String(port)}`, '-sTCP:LISTEN', '-Fp'],
    options,
  );
  if (listing === undefined) {
    return undefined;
  }
  if (listing.exitCode === 1 && listing.stdout.trim().length === 0) {
    // lsof's "nothing matched": the port has no listener.
    return false;
  }
  if (listing.exitCode !== 0) {
    return undefined;
  }
  const holders = lsofPidsOf(listing.stdout);
  if (holders === undefined || holders.length === 0) {
    return undefined;
  }
  const table = await runLookup(run, commands.ps, ['-A', '-o', 'pid=', '-o', 'ppid='], options);
  if (table === undefined || table.exitCode !== 0) {
    return undefined;
  }
  const parents = psParentsOf(table.stdout);
  const tree = parents === undefined ? undefined : processTreeOf(rootPid, parents);
  return tree === undefined ? undefined : holders.every((pid) => tree.has(pid));
}

/**
 * The pids of `lsof -Fp` output: one `p<pid>` line per process, possibly
 * followed by `f<descriptor>` lines. `undefined` for any other line.
 */
function lsofPidsOf(stdout: string): number[] | undefined {
  const pids: number[] = [];
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0 || /^f\S*$/.test(line)) {
      continue;
    }
    const digits = /^p(\d{1,10})$/.exec(line)?.[1];
    const pid = digits === undefined ? undefined : validPid(Number(digits));
    if (pid === undefined) {
      return undefined;
    }
    if (!pids.includes(pid)) {
      pids.push(pid);
    }
  }
  return pids;
}

/** The pid → parent-pid table of `ps -A -o pid= -o ppid=`; `undefined` for any other line or none. */
function psParentsOf(stdout: string): ReadonlyMap<number, number> | undefined {
  const parents = new Map<number, number>();
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0) {
      continue;
    }
    const match = /^(\d{1,10})\s+(\d{1,10})$/.exec(line);
    if (match === null) {
      return undefined;
    }
    parents.set(Number(match[1]), Number(match[2]));
  }
  return parents.size === 0 ? undefined : parents;
}

// Windows: one fixed PowerShell query ------------------------------------------

/** The Windows lookup; see {@link createListenerOwnership}. */
async function windowsOwnership(
  run: ListenerOwnershipRunCommand,
  powerShell: string,
  options: ListenerOwnershipCommandOptions,
  rootPid: number,
  port: number,
): Promise<boolean | undefined> {
  const outcome = await runLookup(
    run,
    powerShell,
    ['-NoProfile', '-NonInteractive', '-Command', windowsOwnershipScript(port)],
    options,
  );
  if (outcome === undefined || outcome.exitCode !== 0) {
    return undefined;
  }
  const listing = windowsListingOf(outcome.stdout);
  if (listing === undefined) {
    return undefined;
  }
  if (listing.listeners.length === 0) {
    return false;
  }
  const tree = processTreeOf(rootPid, listing.parents);
  return tree === undefined ? undefined : listing.listeners.every((pid) => tree.has(pid));
}

/**
 * The PowerShell script: `L <pid>` for each listener's owning process on
 * `port` (none found is no error), `P <pid> <parent pid>` for every process,
 * then `END`, so a script cut short is recognisable. Any other failure stops
 * it with a non-zero exit. `port` is a validated integer, the only value ever
 * interpolated.
 */
function windowsOwnershipScript(port: number): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    `Get-NetTCPConnection -State Listen -LocalPort ${String(port)} -ErrorAction SilentlyContinue | ForEach-Object { 'L ' + $_.OwningProcess }`,
    "Get-CimInstance -ClassName Win32_Process | ForEach-Object { 'P ' + $_.ProcessId + ' ' + $_.ParentProcessId }",
    "'END'",
  ].join('; ');
}

/** The listeners and the process table of the script's output; `undefined` unless it is exactly that shape. */
function windowsListingOf(
  stdout: string,
):
  | { readonly listeners: readonly number[]; readonly parents: ReadonlyMap<number, number> }
  | undefined {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.pop() !== 'END') {
    return undefined;
  }
  const listeners: number[] = [];
  const parents = new Map<number, number>();
  for (const line of lines) {
    const listener = /^L (\d{1,10})$/.exec(line);
    if (listener !== null) {
      listeners.push(Number(listener[1]));
      continue;
    }
    const process = /^P (\d{1,10}) (\d{1,10})$/.exec(line);
    if (process === null) {
      return undefined;
    }
    parents.set(Number(process[1]), Number(process[2]));
  }
  return parents.size === 0 ? undefined : { listeners, parents };
}

/**
 * `powershell.exe` from the **service's own** environment: under
 * `<SystemRoot>\System32\WindowsPowerShell\v1.0\` when `SystemRoot` is a
 * rooted path free of whitespace and of every metacharacter
 * {@link resolveWindowsComSpec} refuses, else `powershell.exe` from the
 * system search path.
 */
function resolveWindowsPowerShell(env: ParentEnvironment): string {
  const systemRoot = windowsEnvValue(env, 'SYSTEMROOT')
    ?.trim()
    .replace(/[\\/]+$/, '');
  if (systemRoot !== undefined && isSafeWindowsExecutablePath(`${systemRoot}\\`)) {
    return `${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
  }
  return DEFAULT_POWERSHELL;
}

/**
 * Run one lookup command and read its outcome defensively (it crosses a
 * port): `undefined` for a timeout, a malformed outcome or oversized output;
 * otherwise the exit code (`null` when it did not exit on its own) and stdout.
 */
async function runLookup(
  run: ListenerOwnershipRunCommand,
  file: string,
  args: readonly string[],
  options: ListenerOwnershipCommandOptions,
): Promise<{ readonly exitCode: number | null; readonly stdout: string } | undefined> {
  const outcome: unknown = await run(file, args, options);
  if (typeof outcome !== 'object' || outcome === null) {
    return undefined;
  }
  const stdout: unknown = 'stdout' in outcome ? outcome.stdout : undefined;
  const exitCode: unknown = 'exitCode' in outcome ? outcome.exitCode : undefined;
  const timedOut: unknown = 'timedOut' in outcome ? outcome.timedOut : undefined;
  if (timedOut === true || typeof stdout !== 'string' || stdout.length > MAX_LOOKUP_OUTPUT_BYTES) {
    return undefined;
  }
  return {
    exitCode: typeof exitCode === 'number' && Number.isInteger(exitCode) ? exitCode : null,
    stdout,
  };
}

// ---------------------------------------------------------------------------
// Process-group identity: which processes a group id names right now
// ---------------------------------------------------------------------------

/**
 * One live process as a {@link ProcessGroupInspector} reports it. The pair
 * (`pid`, `startToken`) identifies a process across time: a recycled pid
 * belongs to a process that started later, so its token differs.
 */
export interface ProcessIdentity {
  /** The process id. */
  readonly pid: number;
  /** The id of the process group it belongs to. */
  readonly pgid: number;
  /**
   * When the process started, as the operating system records it — opaque,
   * compared for equality only: the `starttime` field of `/proc/<pid>/stat`
   * (clock ticks since boot, typically 1/100 s) on Linux, `ps`'s `lstart`
   * (to the second) elsewhere. Two processes share a token only when the
   * same pid is handed out again within one tick (or second) of the first
   * one's start — which sequential pid allocation cannot do: the counter
   * must wrap the whole pid space first.
   */
  readonly startToken: string;
}

/**
 * The live members of a process group. The launcher asks after a launched
 * child's leader has exited, when a bare group id no longer proves whose
 * group it is: the kernel may have handed the id to an unrelated process
 * ({@link DevServerLauncherDeps.processGroupInspector}).
 */
export interface ProcessGroupInspector {
  /**
   * Every live (non-zombie) process whose process group id is `pgid`, or
   * `undefined` when the operating system could not tell. Never rejects,
   * never throws and never logs what a lookup read.
   *
   * @param pgid The process group id: the launched child's pid.
   */
  members(pgid: number): Promise<readonly ProcessIdentity[] | undefined>;
  /**
   * Confirm, **synchronously**, that one process is still exactly the one
   * `identity` describes: `true` — that pid exists, is not a zombie, is in
   * process group `identity.pgid` and has `identity.startToken`; `false` —
   * it is not (gone, a zombie, in another group, or another process on a
   * recycled pid); `undefined` — the operating system could not tell. Never
   * throws and never logs what it read.
   *
   * Synchronous by contract: the launcher calls it immediately before a
   * group signal, with no `await` in between, so nothing else in the service
   * runs between the answer and the delivery. Optional: an inspector that
   * could only answer by blocking the event loop (a `ps` command) omits it,
   * and the launcher then relies on the listing alone.
   *
   * @param identity A member the launcher pinned in the child's group.
   */
  confirm?(identity: ProcessIdentity): boolean | undefined;
}

/**
 * Options of {@link createProcessGroupInspector}: those of
 * {@link ListenerOwnershipOptions} — `platform`, the Linux `fs`, the `ps`
 * command runner, the environment `ps` runs with, and its timeout — plus the
 * synchronous reader of the Linux `confirm`.
 */
export interface ProcessGroupInspectorOptions extends ListenerOwnershipOptions {
  /**
   * Read a whole file synchronously as UTF-8 text, throwing an errno-coded
   * error (`ENOENT`, `ESRCH`, `EACCES`…) the way `node:fs` does: how the
   * Linux {@link ProcessGroupInspector.confirm} reads `/proc/<pid>/stat`.
   * Default: `fs.readFileSync(path, 'utf8')`.
   */
  readonly readFileSync?: ((path: string) => string) | undefined;
}

/** The `ps` arguments that print every process's pid, group, state and start time, headerless. */
const PS_GROUP_ARGS: readonly string[] = Object.freeze([
  '-A',
  '-o',
  'pid=',
  '-o',
  'pgid=',
  '-o',
  'stat=',
  '-o',
  'lstart=',
]);

/** One `ps` row of {@link PS_GROUP_ARGS}: pid, pgid, state, then the start time to the end of the line. */
const PS_GROUP_ROW = /^\s*(\d{1,10})\s+(\d{1,10})\s+(\S+)\s+(\S.*?)\s*$/;

/** The field index (after the command name's last `)`) of a `/proc/<pid>/stat` line's state. */
const STAT_STATE_FIELD = 0;

/** The field index of the process group id, after the last `)`. */
const STAT_PGRP_FIELD = 2;

/** The field index of the start time (clock ticks since boot), after the last `)`. */
const STAT_STARTTIME_FIELD = 19;

/** A start token's longest accepted length; anything longer is a malformed answer. */
const MAX_START_TOKEN_LENGTH = 256;

/** The inspector a launcher uses when it may not look at the host's processes: it cannot tell. */
const UNVERIFIABLE_GROUP_INSPECTOR: ProcessGroupInspector = Object.freeze({
  members: (): Promise<readonly ProcessIdentity[] | undefined> => Promise.resolve(undefined),
});

/**
 * Create the default {@link ProcessGroupInspector} for a platform.
 *
 * - **Linux** (and Android): `/proc` alone, no command. Every
 *   `/proc/<pid>/stat` is read and split after the **last** `)` — the command
 *   name before it is parenthesised and may hold `)` or spaces — for the state
 *   (field 0), the process group (field 2) and the start time (field 19).
 *   Zombies (`Z`) and dead entries (`X`) are no members, and a process that
 *   vanishes mid-listing is skipped; any other read failure, or a line in any
 *   other shape, is `undefined`. `confirm` reads the one
 *   `/proc/<pid>/stat` synchronously through `options.readFileSync` and
 *   parses it the same way: a missing process (`ENOENT`, `ESRCH`) is
 *   `false`, any other failure or shape `undefined`.
 * - **macOS and other POSIX systems**: `ps -A -o pid= -o pgid= -o stat= -o
 *   lstart=` (`/bin/ps` on macOS, `ps` on the service's `PATH` elsewhere),
 *   through `execFile` semantics with the lookup environment and timeout of
 *   {@link createListenerOwnership}; `lstart`, whitespace collapsed, is the
 *   start token, and a state starting with `Z` is no member. A non-zero exit,
 *   a timeout or any row in another shape is `undefined`. There is no
 *   `confirm`: a synchronous `ps` would block the service's event loop.
 * - **Windows**: `undefined` and no `confirm` — there are no process groups
 *   to verify.
 *
 * Only the validated group id is compared against; nothing is interpolated
 * into a command, and nothing a lookup read is logged or kept.
 *
 * @param options Platform, filesystem, synchronous reader, command runner and
 * environment; all optional.
 * @returns The inspector. It holds no resources between calls.
 *
 * @example
 * ```ts
 * const inspector = createProcessGroupInspector({ env: process.env });
 * await inspector.members(child.pid); // → [{ pid, pgid, startToken }, …] or undefined
 * inspector.confirm?.(pinned);        // → true while that very process is still in the group (Linux)
 * ```
 */
export function createProcessGroupInspector(
  options: ProcessGroupInspectorOptions = {},
): ProcessGroupInspector {
  const platform = options.platform ?? process.platform;
  const list = groupListingFor(options, platform);
  const confirm = groupConfirmationFor(options, platform);
  return Object.freeze({
    members: async (pgid: number): Promise<readonly ProcessIdentity[] | undefined> => {
      if (validPid(pgid) === undefined || list === undefined) {
        return undefined;
      }
      try {
        const members = await list(pgid);
        return members === undefined ? undefined : Object.freeze(members);
      } catch {
        // A listing that fails in a way it did not anticipate cannot tell.
        return undefined;
      }
    },
    ...(confirm === undefined ? {} : { confirm }),
  });
}

/**
 * The synchronous confirmation for the configured platform: `/proc` on Linux
 * and Android, none elsewhere (see {@link createProcessGroupInspector}).
 */
function groupConfirmationFor(
  options: ProcessGroupInspectorOptions,
  platform: NodeJS.Platform,
): ((identity: ProcessIdentity) => boolean | undefined) | undefined {
  if (platform !== 'linux' && platform !== 'android') {
    return undefined;
  }
  const read = options.readFileSync ?? defaultReadFileSync;
  return (identity) => {
    try {
      return procConfirmsIdentity(read, identity);
    } catch {
      // A confirmation that fails in a way it did not anticipate cannot tell.
      return undefined;
    }
  };
}

/**
 * Linux: whether `/proc/<pid>/stat` still shows `identity` — the same pid,
 * alive (no `Z` or `X` state), in the same group, with the same start time.
 * `false` when the process is gone; `undefined` for an identity that is no
 * identity, or a read or line the kernel would not produce.
 */
function procConfirmsIdentity(
  read: (path: string) => string,
  identity: ProcessIdentity,
): boolean | undefined {
  const pid = validPid(identity.pid);
  const pgid = validPid(identity.pgid);
  if (pid === undefined || pgid === undefined || typeof identity.startToken !== 'string') {
    return undefined;
  }
  let stat: unknown;
  try {
    stat = read(`${PROC_ROOT}/${String(pid)}/stat`);
  } catch (error) {
    return isVanished(error) ? false : undefined;
  }
  const entry = typeof stat === 'string' ? groupEntryOfStat(stat) : undefined;
  if (entry === undefined) {
    return undefined;
  }
  return (
    entry.state !== 'Z' &&
    entry.state !== 'X' &&
    entry.pgid === pgid &&
    entry.startToken === identity.startToken
  );
}

/** One platform's group listing over a validated group id; `undefined` where there is none. */
type GroupListing = (pgid: number) => Promise<ProcessIdentity[] | undefined>;

/** The listing for the configured platform, or `undefined` on Windows. */
function groupListingFor(
  options: ProcessGroupInspectorOptions,
  platform: NodeJS.Platform,
): GroupListing | undefined {
  switch (platform) {
    case 'linux':
    case 'android': {
      const fs = options.fs ?? defaultOwnershipFs;
      return (pgid) => procGroupMembers(fs, pgid);
    }
    case 'win32':
      return undefined;
    default: {
      const run = options.runCommand ?? defaultRunCommand;
      const ps = platform === 'darwin' ? DARWIN_LOOKUP_COMMANDS.ps : POSIX_LOOKUP_COMMANDS.ps;
      const commandOptions: ListenerOwnershipCommandOptions = {
        timeoutMs: positiveOr(options.commandTimeoutMs, DEFAULT_LISTENER_LOOKUP_TIMEOUT_MS),
        env: lookupEnvironment(options.env ?? process.env, platform),
      };
      return (pgid) => psGroupMembers(run, ps, commandOptions, pgid);
    }
  }
}

/** Linux: the members of `pgid` from every `/proc/<pid>/stat`. */
async function procGroupMembers(
  fs: ListenerOwnershipFs,
  pgid: number,
): Promise<ProcessIdentity[] | undefined> {
  let names: readonly string[];
  try {
    names = await fs.readdir(PROC_ROOT);
  } catch {
    return undefined;
  }
  const members: ProcessIdentity[] = [];
  for (const name of names) {
    const pid = DECIMAL_NAME_PATTERN.test(name) ? validPid(Number(name)) : undefined;
    if (pid === undefined) {
      continue;
    }
    let stat: string;
    try {
      stat = await fs.readFile(`${PROC_ROOT}/${String(pid)}/stat`);
    } catch (error) {
      if (isVanished(error)) {
        continue;
      }
      return undefined;
    }
    const entry = groupEntryOfStat(stat);
    if (entry === undefined) {
      return undefined;
    }
    if (entry.pgid === pgid && entry.state !== 'Z' && entry.state !== 'X') {
      members.push({ pid, pgid, startToken: entry.startToken });
    }
  }
  return members;
}

/**
 * The state, group and start time in a `/proc/<pid>/stat` line, read after
 * the **last** `)`; `undefined` for a line in any other shape.
 */
function groupEntryOfStat(
  stat: string,
): { readonly state: string; readonly pgid: number; readonly startToken: string } | undefined {
  const close = stat.lastIndexOf(')');
  if (close < 0) {
    return undefined;
  }
  const fields = stat
    .slice(close + 1)
    .trim()
    .split(/\s+/);
  const state = fields[STAT_STATE_FIELD];
  const pgrp = fields[STAT_PGRP_FIELD];
  const start = fields[STAT_STARTTIME_FIELD];
  if (
    state === undefined ||
    !/^[A-Za-z]$/.test(state) ||
    pgrp === undefined ||
    !DECIMAL_NAME_PATTERN.test(pgrp) ||
    start === undefined ||
    !/^\d{1,20}$/.test(start)
  ) {
    return undefined;
  }
  return { state, pgid: Number(pgrp), startToken: start };
}

/** macOS and other POSIX systems: the members of `pgid` from one `ps` listing. */
async function psGroupMembers(
  run: ListenerOwnershipRunCommand,
  ps: string,
  options: ListenerOwnershipCommandOptions,
  pgid: number,
): Promise<ProcessIdentity[] | undefined> {
  const outcome = await runLookup(run, ps, PS_GROUP_ARGS, options);
  if (outcome === undefined || outcome.exitCode !== 0) {
    return undefined;
  }
  const members: ProcessIdentity[] = [];
  for (const line of outcome.stdout.split(/\r?\n/)) {
    if (line.trim().length === 0) {
      continue;
    }
    const row = PS_GROUP_ROW.exec(line);
    const pid = validPid(Number(row?.[1]));
    const group = validPid(Number(row?.[2]));
    const state = row?.[3];
    const startToken = row?.[4]?.replace(/\s+/g, ' ');
    if (
      pid === undefined ||
      group === undefined ||
      state === undefined ||
      startToken === undefined ||
      startToken.length > MAX_START_TOKEN_LENGTH
    ) {
      return undefined;
    }
    if (group === pgid && !state.startsWith('Z')) {
      members.push({ pid, pgid, startToken });
    }
  }
  return members;
}

/**
 * The members of an inspector's answer that identify processes of group
 * `pgid` — each field validated, since the answer crosses a port — or
 * `undefined` for an answer that is no listing at all.
 */
function groupMembersOf(answer: unknown, pgid: number): readonly ProcessIdentity[] | undefined {
  if (!Array.isArray(answer)) {
    return undefined;
  }
  const members: ProcessIdentity[] = [];
  for (const entry of answer as readonly unknown[]) {
    if (typeof entry !== 'object' || entry === null) {
      return undefined;
    }
    const pid = validPid('pid' in entry ? entry.pid : undefined);
    const group = validPid('pgid' in entry ? entry.pgid : undefined);
    const startToken: unknown = 'startToken' in entry ? entry.startToken : undefined;
    if (
      pid === undefined ||
      group === undefined ||
      typeof startToken !== 'string' ||
      startToken.length === 0 ||
      startToken.length > MAX_START_TOKEN_LENGTH
    ) {
      return undefined;
    }
    if (group === pgid) {
      members.push({ pid, pgid, startToken });
    }
  }
  return members;
}

// ---------------------------------------------------------------------------
// Launched-child state
// ---------------------------------------------------------------------------

/**
 * Why an address that answered was not confirmed as the launched child's —
 * the `details.ownership` of a `ready-unverified` failure:
 *
 * - `'other-process'` — the operating system showed a listener on its port
 *   held by a process outside the child's process tree (or none at all);
 * - `'unknown'` — the ownership lookup could not tell (unsupported, failed,
 *   timed out or denied).
 *
 * When both occurred during one wait, `'other-process'` is reported.
 */
export type DevServerUnverifiedOwnership = 'other-process' | 'unknown';

/**
 * How a readiness wait ended. `timeout` means no address answered in time;
 * `unverified` means one or more did, but none was ever shown to be held by
 * the launched child's process tree before the deadline.
 */
type ReadyOutcome =
  | {
      readonly kind: 'ready';
      readonly url: string;
      /** The framework signature the ready answer carried, logged for information only. */
      readonly framework?: DevServerFramework | undefined;
    }
  | {
      readonly kind: 'exited';
      readonly code: number | null;
      readonly signal: NodeJS.Signals | null;
    }
  | { readonly kind: 'spawn-error'; readonly errorCode: string | undefined }
  | { readonly kind: 'timeout' }
  | {
      readonly kind: 'unverified';
      /** The `origin/` of every address that answered unconfirmed, in probe order. */
      readonly origins: readonly string[];
      /** Whether any of them was announced by the child (rather than only requested). */
      readonly announced: boolean;
      /** Why none was confirmed; see {@link DevServerUnverifiedOwnership}. */
      readonly ownership: DevServerUnverifiedOwnership;
    };

/**
 * A lifecycle event a readiness wait listens for. `url` means the child
 * announced a new readiness candidate, which starts a verification round.
 */
type ChildEvent =
  | { readonly kind: 'exit'; readonly code: number | null; readonly signal: NodeJS.Signals | null }
  | { readonly kind: 'spawn-error'; readonly errorCode: string | undefined }
  | { readonly kind: 'url' };

/** A scheduled timer, boxed so "none pending" (`undefined`) stays distinct from any handle. */
interface ScheduledTimer {
  readonly handle: TimerHandle;
}

/**
 * One issued `server-agent` credential and the state of its invalidation.
 *
 * The plaintext token is held **until a revocation succeeds** (or the lease
 * lapses), because it is what names the credential to revoke: a failed
 * attempt is not memoised, so the next attempt — a retry, a later stop, the
 * shutdown sweep — can still reach the store. Only one attempt runs at a time.
 * The token never leaves this object except as the argument of the issuer's
 * own `renew` and `revoke`.
 */
class CredentialLease {
  readonly projectRoot: string;
  readonly credentialId: string | undefined;
  /**
   * The SHA-256 hex digest of the token — what the access boundary stores and
   * a connection's principal carries, so a connected preload can be matched
   * to the child it belongs to. Kept after the token itself is dropped.
   */
  readonly tokenHash: string;
  /** When the credential stops authenticating on its own, in epoch milliseconds. */
  expiresAt: number;
  /** Set once revocation was asked for; renewal stops for good. */
  releaseRequested = false;
  /** The pending renewal, while the child runs. */
  renewalTimer: ScheduledTimer | undefined;
  /** The pending revocation retry, after a failed attempt. */
  retryTimer: ScheduledTimer | undefined;
  /** The delay before the next revocation retry, in milliseconds. */
  retryDelayMs = REVOCATION_RETRY_INITIAL_MS;

  #token: string | undefined;
  #attempt: Promise<boolean> | undefined;
  #invalidated = false;
  #markSettled: () => void = () => undefined;

  /**
   * Resolves once the credential no longer authenticates — revoked, or its
   * lease lapsed. Never rejects; it stays pending for a credential nothing
   * could invalidate before shutdown, which lapses with its lease on its own.
   */
  readonly settled: Promise<void> = new Promise<void>((resolve) => {
    this.#markSettled = resolve;
  });

  constructor(init: {
    readonly projectRoot: string;
    readonly token: string;
    readonly credentialId: string | undefined;
    readonly expiresAt: number;
  }) {
    this.projectRoot = init.projectRoot;
    this.credentialId = init.credentialId;
    this.expiresAt = init.expiresAt;
    this.tokenHash = sha256Hex(init.token);
    this.#token = init.token;
  }

  /** Whether the credential no longer authenticates: revoked, or its lease lapsed. */
  get invalidated(): boolean {
    return this.#invalidated;
  }

  /** The renewal input for a new expiry, or `undefined` once the credential is gone. */
  renewInput(expiresAt: number): ServerAgentCredentialRenewInput | undefined {
    const token = this.#token;
    if (token === undefined || this.#invalidated) {
      return undefined;
    }
    return {
      projectRoot: this.projectRoot,
      token,
      expiresAt,
      ...(this.credentialId === undefined ? {} : { credentialId: this.credentialId }),
    };
  }

  /**
   * Revoke the credential, sharing an attempt already in flight. Resolves
   * `true` once it no longer authenticates; `false` leaves the token held so a
   * later call tries again.
   */
  revoke(revoke: (input: ServerAgentCredentialRevokeInput) => Promise<boolean>): Promise<boolean> {
    if (this.#invalidated) {
      return Promise.resolve(true);
    }
    const token = this.#token;
    if (token === undefined) {
      return Promise.resolve(true);
    }
    this.#attempt ??= revoke({
      projectRoot: this.projectRoot,
      token,
      ...(this.credentialId === undefined ? {} : { credentialId: this.credentialId }),
    }).then((revoked) => {
      this.#attempt = undefined;
      if (revoked) {
        this.#invalidate();
      }
      return revoked;
    });
    return this.#attempt;
  }

  /** The lease passed its expiry: the credential is refused by the access boundary on its own. */
  lapse(): void {
    this.#invalidate();
  }

  #invalidate(): void {
    this.#invalidated = true;
    this.#token = undefined;
    this.#markSettled();
  }
}

/** One address a verification round probes. */
interface ReadyTarget {
  /** The URL probed: a candidate's `origin/`, or the requested URL. */
  readonly url: string;
  /** `true` for an announced candidate, `false` for the requested URL. */
  readonly announced: boolean;
}

/**
 * How one termination of a child ended — what every stop path reads, so none
 * of them can report a child as stopped whose exit was never observed.
 *
 * - `not-running` — nothing live to signal: the child had already exited, or
 *   never got a pid.
 * - `stopped` — its exit was observed; `escalated` when that took `SIGKILL`.
 * - `survived` — the whole ladder ran and no exit was observed; see
 *   {@link DevServerSurvivor}.
 */
type TerminationOutcome =
  | { readonly kind: 'not-running' }
  | { readonly kind: 'stopped'; readonly escalated: boolean }
  | { readonly kind: 'survived'; readonly survivor: DevServerSurvivor };

/** The outcome of a termination that found nothing live to signal. */
const NOT_RUNNING: TerminationOutcome = Object.freeze({ kind: 'not-running' });

/** The report of a stop path after which nothing it terminated is still running. */
const NO_SURVIVORS: DevServerTerminationReport = Object.freeze({ survivors: Object.freeze([]) });

/** A list with at least one member. */
type NonEmptyList<T> = readonly [T, ...T[]];

/** Everything the launcher tracks about one child. The credential is private to it. */
class ChildState {
  readonly key: string;
  readonly child: ChildProcessLike;
  readonly pid: number | undefined;
  readonly startedAt: number;
  readonly command: string;
  readonly script: string | undefined;
  readonly launchSessionId: string | undefined;
  /**
   * Whether the child was spawned for a session. Only a session-owned child
   * gains owners on reuse and is stopped when its last owning session ends.
   */
  readonly sessionOwned: boolean;
  readonly sessionIds = new Set<string>();
  /**
   * The holds taken by {@link DevServerLauncher.acquireForSession} for
   * sessions still being created. A session-owned child is not stopped while
   * one is outstanding, even when every owning session has ended.
   */
  readonly holds = new Set<number>();
  /** Counts and diagnostic ids of the child's output — never its text. */
  readonly output = new OutputDigest();
  readonly lease: CredentialLease;
  readonly exited: Promise<void>;

  status: LaunchedDevServerStatus = 'starting';
  devServerUrl: string | undefined;
  /**
   * Readiness candidates: the distinct loopback `origin/`s the child announced
   * after a serving-address label, in announcement order, the service's port
   * excluded, at most {@link MAX_READY_CANDIDATES}. Candidates only — none is
   * ready until a probe answers there and every listener on its port is held
   * by this child's process tree. The first is kept for a timeout's
   * diagnostics.
   */
  readonly readyCandidates: string[] = [];
  hasExited = false;
  exitCode: number | null = null;
  exitSignal: NodeJS.Signals | null = null;
  stopRequested = false;
  /**
   * The termination in progress, shared by every concurrent stop path. Cleared
   * when it ends `survived`, so the next stop, launch or shutdown runs the
   * ladder again instead of re-reading a stale outcome.
   */
  terminating: Promise<TerminationOutcome> | undefined;
  /**
   * Set once a termination ran to the end without observing the exit. The
   * child then stays registered (listed, retried, reported) until its exit is
   * observed, which removes it.
   */
  survivedTermination = false;
  listener: ((event: ChildEvent) => void) | undefined;
  /**
   * Signal deliveries `child.kill` refused, and the last refusal's signal and
   * closed description — carried into the stop's own record and into a
   * survivor's report, so whoever reads a termination learns that it ran with
   * a signal undelivered.
   */
  signalFailures = 0;
  lastSignalFailure: DevServerSignalFailure | undefined;
  /**
   * The members of the child's process group the launcher has verified, as
   * pid → start token ({@link ProcessIdentity}): taken from listings made
   * while the leader was unreaped, or that held a member already pinned. A
   * listing after the leader exited is the child's group only when it still
   * holds one of these, which a recycled group id cannot.
   */
  readonly groupPins = new Map<number, string>();
  /**
   * Set once the group is no longer the launcher's to signal after the
   * leader's exit — it was gone, held no pinned member (a recycled id), or
   * could not be listed. Nothing is sent to the group id again.
   */
  groupReleased = false;

  #markExited: () => void = () => undefined;

  constructor(init: {
    readonly key: string;
    readonly child: ChildProcessLike;
    readonly startedAt: number;
    readonly command: string;
    readonly script: string | undefined;
    readonly sessionId: string | undefined;
    readonly lease: CredentialLease;
    readonly devServerUrl: string | undefined;
  }) {
    this.key = init.key;
    this.child = init.child;
    this.pid = validPid(init.child.pid);
    this.startedAt = init.startedAt;
    this.command = init.command;
    this.script = init.script;
    this.launchSessionId = init.sessionId;
    this.sessionOwned = init.sessionId !== undefined;
    if (init.sessionId !== undefined) {
      this.sessionIds.add(init.sessionId);
    }
    this.lease = init.lease;
    this.devServerUrl = init.devServerUrl;
    this.exited = new Promise<void>((resolve) => {
      this.#markExited = resolve;
    });
  }

  /** Record the exit and wake every waiter; idempotent. */
  noteExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.hasExited) {
      return;
    }
    this.hasExited = true;
    this.exitCode = code;
    this.exitSignal = signal;
    if (this.status !== 'failed') {
      this.status = 'exited';
    }
    this.#markExited();
  }

  /** The public, credential-free record; `undefined` for a child that never got a pid. */
  snapshot(): LaunchedDevServer | undefined {
    const pid = this.pid;
    if (pid === undefined) {
      return undefined;
    }
    return Object.freeze({
      projectRoot: this.key,
      ...(this.devServerUrl === undefined ? {} : { devServerUrl: this.devServerUrl }),
      pid,
      ...(this.launchSessionId === undefined ? {} : { sessionId: this.launchSessionId }),
      sessionIds: Object.freeze([...this.sessionIds]),
      ...(this.lease.credentialId === undefined ? {} : { credentialId: this.lease.credentialId }),
      startedAt: this.startedAt,
      status: this.status,
      command: this.command,
      ...(this.script === undefined ? {} : { script: this.script }),
    });
  }

  /**
   * The survivor record of a child that outlived its termination — closed
   * fields only — or `undefined` when it is not one (never outlived a
   * termination, has since exited, or never got a pid).
   */
  survivor(): DevServerSurvivor | undefined {
    const pid = this.pid;
    if (pid === undefined || !this.survivedTermination || this.hasExited) {
      return undefined;
    }
    return this.survivorRecord(pid);
  }

  /** This child's survivor record under `pid`, as it stands now. */
  survivorRecord(pid: number): DevServerSurvivor {
    return Object.freeze({
      projectRoot: this.key,
      pid,
      signalFailures: this.signalFailures,
      ...(this.lastSignalFailure === undefined
        ? {}
        : { lastSignalFailure: this.lastSignalFailure }),
    });
  }
}

/** Whether a child is ready and serving: neither stopping nor exited. */
function isServing(state: ChildState): boolean {
  return state.status === 'ready' && !state.hasExited;
}

/** Whether no session and no pending session creation relies on a child any more. */
function isUnowned(state: ChildState): boolean {
  return state.sessionIds.size === 0 && state.holds.size === 0;
}

/** A process id when it is a positive integer, else `undefined`. */
function validPid(pid: unknown): number | undefined {
  return typeof pid === 'number' && Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

/** A positive finite number, or the fallback. */
function positiveOr(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Whether a port's return value is a failed `Result`. */
function isErrResult(value: unknown): boolean {
  return typeof value === 'object' && value !== null && 'ok' in value && value.ok === false;
}

/** Whether a port's return value is a successful `Result` carrying exactly `expected`. */
function isOkResultOf(value: unknown, expected: boolean): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    'ok' in value &&
    value.ok === true &&
    'value' in value &&
    value.value === expected
  );
}

/** Let a Node timer stop holding the event loop open; any other handle is left alone. */
function unrefTimer(handle: TimerHandle): void {
  if (isNodeTimeout(handle)) {
    handle.unref();
  }
}

/** The errno-style `code` of a caught value, when it has a plausible one. */
function errnoCodeOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return undefined;
  }
  const code = error.code;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : undefined;
}

/** The binary's own name, for a log line: the last path segment of the executable. */
function executableName(file: string): string {
  return file.split(/[\\/]/).pop() ?? file;
}

/** The project root in the two spellings the launcher needs, validated. */
interface ProjectRootForms {
  /** As the caller gave it (trimmed), for `cwd` and for detection. */
  readonly native: string;
  /** Normalised POSIX: the registry key, the credential scope and `DEBUGGEN_PROJECT_ROOT`. */
  readonly key: string;
}

/** Validate a project root's shape (and, when a check is given, its existence as a directory). */
function projectRootForms(
  value: unknown,
  directoryExists?: (path: string) => boolean,
): Result<ProjectRootForms, DebuggenError> {
  const native = typeof value === 'string' ? value.trim() : '';
  if (native.length === 0 || !isAbsolutePath(native)) {
    return err(
      new DebuggenError(
        'PROJECT_NOT_FOUND',
        'The dev-server project root must be an absolute path.',
        {
          hint: 'Open the project folder in VS Code and launch the dev server from there, or pass its absolute path.',
          details: { reason: 'project-root-not-absolute' },
        },
      ),
    );
  }
  if (directoryExists !== undefined) {
    if (!checkPath(directoryExists, native)) {
      return err(
        new DebuggenError(
          'PROJECT_NOT_FOUND',
          'The dev-server project root is not an existing directory.',
          {
            hint: 'Check that the project folder still exists and is readable, then launch the dev server again.',
            details: { reason: 'project-root-not-a-directory', projectRoot: toPosix(native) },
          },
        ),
      );
    }
  }
  return ok({ native, key: normalizePosix(toPosix(native)) });
}

// ---------------------------------------------------------------------------
// createDevServerLauncher
// ---------------------------------------------------------------------------

/** Settings resolved once at construction. */
interface LauncherSettings {
  readonly readyTimeoutMs: number;
  readonly pollIntervalMs: number;
  /** Each readiness probe's timeout; never above {@link LauncherSettings.readyTimeoutMs}. */
  readonly readyProbeTimeoutMs: number;
  readonly stopGraceMs: number;
  /** One lease of a {@link DEV_SERVER_CREDENTIAL_PATH} credential. */
  readonly cliCredentialLeaseMs: number;
  /** How often each {@link DEV_SERVER_CREDENTIAL_PATH} credential is checked. */
  readonly cliCredentialCheckIntervalMs: number;
  /** How long such a credential outlives its dev server's control connection. */
  readonly cliCredentialDisconnectGraceMs: number;
  readonly leaseMs: number;
}

/** A snapshot of the cancellation state a launch started under. */
interface LaunchTicket {
  readonly key: string;
  readonly sessionId: string | undefined;
  readonly globalGeneration: number;
  readonly keyGeneration: number;
}

/** How often a stopping process group is re-checked for survivors, in milliseconds. */
const GROUP_POLL_INTERVAL_MS = 100;

/**
 * Whose a child's process group is, per one listing (see the launcher's
 * `#pinGroup`): `'verified'` — still the child's, with members; `'gone'` —
 * nothing holds the id; `'foreign'` — only processes never seen in it hold
 * it, after the leader exited; `'unknown'` — it could not be listed.
 */
type GroupVerdict = 'verified' | 'gone' | 'foreign' | 'unknown';

/**
 * One listing of a child's process group: its {@link GroupVerdict}, and — for
 * a `'verified'` listing only — the members it held, every one of them
 * pinned by the listing itself (see the launcher's `#pinGroup`).
 */
interface GroupReading {
  readonly verdict: GroupVerdict;
  readonly members: readonly ProcessIdentity[];
}

/** A reading with no members to act on: the verdict alone. */
function groupReading(verdict: Exclude<GroupVerdict, 'verified'>): GroupReading {
  return { verdict, members: [] };
}

/** How a bounded wait ended: whether its condition held, and after how long. */
interface WaitOutcome {
  readonly met: boolean;
  /** The sum of the timer delays waited, in milliseconds. */
  readonly elapsedMs: number;
}

/** How many ended session ids are remembered, so a launch still in flight for one is refused. */
const MAX_ENDED_SESSIONS = 1_024;

/**
 * Create the service's dev-server launcher.
 *
 * @param deps Collaborators; see {@link DevServerLauncherDeps}.
 * @returns The launcher. It owns no resources until {@link DevServerLauncher.launch} spawns one.
 */
export function createDevServerLauncher(deps: DevServerLauncherDeps): DevServerLauncher {
  return new DevServerLauncherImpl(deps);
}

class DevServerLauncherImpl implements DevServerLauncher {
  readonly #deps: DevServerLauncherDeps;
  readonly #parentLogger: Logger;
  readonly #logger: Logger;
  readonly #settings: LauncherSettings;
  readonly #platform: NodeJS.Platform;
  readonly #spawn: SpawnLike;
  readonly #signalGroup: SignalProcessGroup | undefined;
  readonly #groupInspector: ProcessGroupInspector;
  readonly #detect: typeof detectDevServer;
  readonly #probe: typeof probeDevServer;
  readonly #ownership: ListenerOwnership;
  readonly #now: () => number;
  readonly #setTimeout: SetTimeoutLike;
  readonly #clearTimeout: ClearTimeoutLike;

  readonly #registry = new Map<string, ChildState>();
  readonly #inflight = new Map<string, Promise<Result<DevServerLaunchResult, DebuggenError>>>();
  readonly #keyGenerations = new Map<string, number>();
  readonly #endedSessions = new Set<string>();
  readonly #reapers = new Set<Promise<void>>();
  /** Credentials whose revocation failed and is being retried, until invalidated. */
  readonly #pendingRevocations = new Set<CredentialLease>();
  /**
   * Per ended session, the credentials of its stopped children that still
   * authenticate, and the promise of their invalidation — until it happens.
   * A repeated {@link DevServerLauncher.stopForSession} reports (and retries)
   * them again rather than answering clean.
   */
  readonly #sessionReleases = new Map<
    string,
    { readonly leases: ReadonlySet<CredentialLease>; readonly settled: Promise<void> }
  >();
  /** The last hold id {@link DevServerLauncher.acquireForSession} handed out. */
  #holdCounter = 0;
  #globalGeneration = 0;
  #disposed = false;
  #disposing: Promise<DevServerTerminationReport> | undefined;

  constructor(deps: DevServerLauncherDeps) {
    this.#deps = deps;
    // Guarded once, here, rather than wrapped per call: every record this
    // launcher writes — and every record detection and probing write through
    // the same parent — is best-effort diagnostics written on launch and
    // termination paths, so a logger that throws must neither change an
    // outcome nor vanish. `guardLogger` gives both: none of its methods (nor
    // its children's) throw, and a failed write is counted and announced
    // through the shared, rate-limited fallback notice. It is idempotent, so a
    // logger the service already guarded keeps its own policy.
    this.#parentLogger = guardLogger(deps.logger);
    this.#logger = subsystemLogger(this.#parentLogger, LOG_SUBSYSTEM);
    this.#platform = deps.platform ?? process.platform;
    this.#spawn = deps.spawnImpl ?? defaultSpawn;
    // Process groups are a property of a real POSIX spawn: with the default
    // spawn the child leads its own group and a stop signals the whole tree;
    // an injected spawn (a test's fake child) gets group signalling only when
    // it injects the signaller too, so no fake pid is ever signalled for real.
    const realGroups =
      deps.signalProcessGroup === undefined &&
      deps.spawnImpl === undefined &&
      this.#platform !== 'win32';
    this.#signalGroup =
      deps.signalProcessGroup ??
      (deps.spawnImpl === undefined && this.#platform !== 'win32'
        ? defaultSignalProcessGroup
        : undefined);
    // The host's process table is read only for the host's own children: an
    // injected spawn or signaller without an inspector gets one that cannot
    // tell, so a group is signalled after its leader exits only when verified.
    this.#groupInspector =
      deps.processGroupInspector ??
      (realGroups
        ? createProcessGroupInspector({
            platform: this.#platform,
            env: deps.parentEnv ?? process.env,
          })
        : UNVERIFIABLE_GROUP_INSPECTOR);
    this.#detect = deps.detect ?? detectDevServer;
    this.#probe = deps.probe ?? probeDevServer;
    this.#ownership =
      deps.listenerOwnership ??
      createListenerOwnership({ platform: this.#platform, env: deps.parentEnv ?? process.env });
    this.#now = deps.now ?? nowEpochMs;
    this.#setTimeout = deps.setTimeoutImpl ?? defaultSetTimeout;
    this.#clearTimeout = deps.clearTimeoutImpl ?? defaultClearTimeout;
    const readyTimeoutMs = positiveOr(deps.readyTimeoutMs, DEFAULT_READY_TIMEOUT_MS);
    this.#settings = {
      readyTimeoutMs,
      pollIntervalMs: positiveOr(deps.readyPollIntervalMs, DEFAULT_READY_POLL_INTERVAL_MS),
      readyProbeTimeoutMs: Math.min(
        positiveOr(deps.readyProbeTimeoutMs, DEFAULT_READY_PROBE_TIMEOUT_MS),
        readyTimeoutMs,
      ),
      stopGraceMs: positiveOr(deps.stopGraceMs, DEFAULT_STOP_GRACE_MS),
      cliCredentialLeaseMs: positiveOr(deps.cliCredentialLeaseMs, DEFAULT_CLI_CREDENTIAL_LEASE_MS),
      cliCredentialCheckIntervalMs: positiveOr(
        deps.cliCredentialCheckIntervalMs,
        CLI_CREDENTIAL_CHECK_INTERVAL_MS,
      ),
      cliCredentialDisconnectGraceMs: positiveOr(
        deps.cliCredentialDisconnectGraceMs,
        CLI_CREDENTIAL_DISCONNECT_GRACE_MS,
      ),
      leaseMs: positiveOr(deps.managedCredentialLeaseMs, DEFAULT_MANAGED_CREDENTIAL_LEASE_MS),
    };
  }

  // -------------------------------------------------------------------------
  // launch
  // -------------------------------------------------------------------------

  async launch(
    request: DevServerLaunchInput,
  ): Promise<Result<DevServerLaunchResult, DebuggenError>> {
    try {
      if (this.#disposed) {
        return err(shutdownError());
      }
      const root = projectRootForms(
        request.projectRoot,
        this.#deps.directoryExists ?? defaultDirectoryExists,
      );
      if (isErr(root)) {
        return root;
      }
      const sessionId = nonEmpty(request.sessionId);
      if (sessionId !== undefined && this.#endedSessions.has(sessionId)) {
        // A child tied to an ended session would have no owner left to stop it.
        return err(cancelledError());
      }

      // The session may end while this launch waits on another one; a child
      // must never be tied to it after that (it would have no owner left).
      const endedMeanwhile = (): boolean =>
        sessionId !== undefined && this.#endedSessions.has(sessionId);

      const existing = this.#registry.get(root.value.key);
      if (existing?.status === 'stopping') {
        await existing.terminating;
        if (endedMeanwhile()) {
          return err(cancelledError());
        }
      }
      if (existing?.survivor() !== undefined) {
        // A child that outlived an earlier stop still holds this project, and
        // likely its port. Try once more before starting another; while it
        // lives, its record must not be replaced by a new child's, or nothing
        // would list, retry or report it again.
        const retried = await this.#terminate(existing, 'relaunch');
        if (retried.kind === 'survived') {
          return err(survivedTerminationError([retried.survivor]));
        }
      }
      const reused = existing === undefined ? undefined : this.#reusable(existing, sessionId);
      if (reused !== undefined) {
        return ok(reused);
      }

      const pending = this.#inflight.get(root.value.key);
      if (pending !== undefined) {
        const outcome = await pending;
        if (endedMeanwhile()) {
          return err(cancelledError());
        }
        if (isErr(outcome) || !outcome.value.managed) {
          return outcome;
        }
        const joined = this.#registry.get(root.value.key);
        return ok(
          (joined === undefined ? undefined : this.#reusable(joined, sessionId)) ?? outcome.value,
        );
      }

      const fresh = this.#launchFresh(root.value, request, sessionId);
      this.#inflight.set(root.value.key, fresh);
      try {
        return await fresh;
      } finally {
        if (this.#inflight.get(root.value.key) === fresh) {
          this.#inflight.delete(root.value.key);
        }
      }
    } catch (error) {
      this.#log('error', 'The dev-server launch failed unexpectedly', {
        errorCode: errnoCodeOf(error),
      });
      return err(
        new DebuggenError('DEV_SERVER_LAUNCH_FAILED', 'The dev server could not be launched.', {
          hint: 'The service log holds the reason. Launch the dev server again, or start it by hand with the relaunch command.',
          details: { reason: 'unexpected-failure' },
          cause: error,
        }),
      );
    }
  }

  /**
   * A ready child reused for another caller — or `undefined` when the child is
   * not (or no longer) ready to be reused. A session-owned child records the
   * caller's session among its owners; a developer-owned child stays the
   * developer's, so reusing it for a session never lets that session's end
   * stop it.
   */
  #reusable(state: ChildState, sessionId: string | undefined): ManagedDevServerLaunch | undefined {
    const pid = state.pid;
    const devServerUrl = state.devServerUrl;
    if (!isServing(state) || pid === undefined || devServerUrl === undefined) {
      return undefined;
    }
    if (sessionId !== undefined && state.sessionOwned) {
      state.sessionIds.add(sessionId);
    }
    return Object.freeze({ managed: true, alreadyRunning: true, devServerUrl, pid });
  }

  async #launchFresh(
    root: ProjectRootForms,
    request: DevServerLaunchInput,
    sessionId: string | undefined,
  ): Promise<Result<DevServerLaunchResult, DebuggenError>> {
    const ticket = this.#ticket(root.key, sessionId);

    // The address the child reports to must be the service's bound address.
    let ingestUrl: string;
    try {
      ingestUrl = resolveIngestUrl(this.#deps.config);
    } catch (error) {
      return err(DebuggenError.from(error, 'CONFIG_INVALID'));
    }

    const preload = resolvePreloadPath({
      preloadPath: this.#deps.preloadPath,
      fileExists: this.#deps.fileExists,
      moduleUrl: this.#deps.preloadResolution?.moduleUrl,
      resolvePackage: this.#deps.preloadResolution?.resolvePackage,
      logger: this.#logger,
    });
    if (isErr(preload)) {
      this.#log('warn', 'The telemetry preload was not found; no dev server was launched', {
        projectRoot: root.key,
      });
      return preload;
    }
    const preloadPath = preload.value;

    // Detection first: never spawn a second server where one already answers.
    // Preload evidence is about the probed address, never the project: some
    // connected agent of the project says nothing about the process answering
    // there (a plain server on another port would pass), so only a child this
    // launcher started, serving at that address, counts.
    const requestedUrl = nonEmpty(request.devServerUrl);
    const serverAgents: ServerAgentPresence = Object.freeze({
      hasServerAgentForProject: (projectRoot: string): boolean =>
        requestedUrl !== undefined && this.preloadServesAt(projectRoot, requestedUrl),
    });
    const detection = await this.#detect(
      { projectRoot: root.native, devServerUrl: requestedUrl },
      {
        ...this.#deps.detectDeps,
        serverAgents,
        config: this.#deps.config,
        logger: this.#parentLogger,
        preloadPath,
        ingestUrl,
        now: this.#now,
      },
    );
    if (detection.running) {
      if (detection.preloadAttached) {
        const devServerUrl = detection.devServerUrl ?? requestedUrl;
        if (devServerUrl === undefined) {
          return err(
            new DebuggenError(
              'DEV_SERVER_UNAVAILABLE',
              'A dev server was reported running for this project, but not at an address the service knows, so it was neither reused nor duplicated.',
              {
                hint: 'Set debuggen.devServerUrl to the local address the dev server prints, then launch again.',
                details: { reason: 'running-without-address' },
              },
            ),
          );
        }
        this.#log('info', 'A dev server with the preload already runs; nothing was launched', {
          projectRoot: root.key,
          devServerUrl,
        });
        return ok(Object.freeze({ managed: false, alreadyRunning: true, devServerUrl, detection }));
      }
      return err(
        new DebuggenError(
          'SERVER_AGENT_NOT_READY',
          "A dev server already answers at this project's address, but it is not one the Debug Generator service launched, so no preload can be attributed to it and a second one was not started on its port.",
          {
            hint: buildRelaunchHint(detection),
            details: {
              reason: 'running-without-preload',
              preloadReason: detection.preloadReason,
              ...(detection.devServerUrl === undefined
                ? {}
                : { devServerUrl: detection.devServerUrl }),
              unavailableSignals: [...PRELOAD_DEPENDENT_SIGNALS],
            },
          },
        ),
      );
    }
    // Something answers at the session URL but is not this project's dev
    // server (its answer carried no framework signature — a server-agent
    // connected for the project does not vouch for whatever holds this
    // address). A child started now would fight that process for the port,
    // or answer beside it; nothing is minted and nothing is spawned.
    if (detection.occupied === true) {
      const devServerUrl = detection.devServerUrl ?? detection.probe?.url;
      const status = detection.probe?.status;
      this.#log('warn', 'Another process answers at the dev-server address; nothing was launched', {
        projectRoot: root.key,
        ...(devServerUrl === undefined ? {} : { devServerUrl }),
        ...(status === undefined ? {} : { status }),
      });
      return err(
        new DebuggenError(
          'DEV_SERVER_UNAVAILABLE',
          "Another process answers at this project's dev-server address and was not identified as this project's dev server, so no dev server was started there.",
          {
            hint: detection.relaunchHint,
            details: {
              reason: 'address-occupied',
              ...(devServerUrl === undefined ? {} : { devServerUrl }),
              ...(status === undefined ? {} : { status }),
            },
          },
        ),
      );
    }

    const command = this.#resolveCommand(request.command, root, detection);
    if (isErr(command)) {
      return command;
    }
    // Checked before the credential exists: a command cmd.exe would expand or
    // interpret mints nothing and spawns nothing.
    const invocation = this.#invocationFor(command.value);
    if (isErr(invocation)) {
      return invocation;
    }
    if (this.#isCancelled(ticket)) {
      return err(cancelledError());
    }

    // The credential: minted before the spawn, never handed to anything but the
    // child — and a lease from the first moment, so even a crash between here
    // and the child's exit cannot leave it valid for longer than one lease.
    const requestedExpiry = Math.floor(this.#now() + this.#settings.leaseMs);
    const credential = await this.#issue({
      projectRoot: root.key,
      expiresAt: requestedExpiry,
      lease: true,
    });
    if (isErr(credential)) {
      return err(
        new DebuggenError(
          'DEV_SERVER_LAUNCH_FAILED',
          'An ingest credential for the dev server could not be issued, so no dev server was launched.',
          {
            hint: 'The service log holds the reason. Restart the Debug Generator service, then launch the dev server again.',
            details: { reason: 'credential-unavailable', causeCode: credential.error.code },
            cause: credential.error,
          },
        ),
      );
    }
    const { token } = credential.value;
    const lease = new CredentialLease({
      projectRoot: root.key,
      token,
      credentialId: nonEmpty(credential.value.credentialId),
      expiresAt: credential.value.expiresAt ?? requestedExpiry,
    });
    const revokeUnused = async (): Promise<void> => {
      await this.#releaseCredential(lease);
    };

    if (this.#isCancelled(ticket)) {
      await revokeUnused();
      return err(cancelledError());
    }

    let env: Record<string, string>;
    try {
      env = buildDevServerEnv({
        parentEnv: this.#deps.parentEnv ?? process.env,
        launchEnv: command.value.env,
        projectRoot: root.key,
        ingestUrl,
        token,
        preloadPath,
        platform: this.#platform,
      });
    } catch (error) {
      await revokeUnused();
      return err(DebuggenError.from(error, 'CONFIG_INVALID'));
    }

    let child: ChildProcessLike;
    const startedAt = this.#now();
    try {
      child = this.#spawn(invocation.value.command, invocation.value.args, {
        cwd: root.native,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
        windowsVerbatimArguments: invocation.value.windowsVerbatimArguments,
        windowsHide: true,
        detached: this.#signalGroup !== undefined,
      });
    } catch (error) {
      await revokeUnused();
      return err(
        this.#spawnFailed(
          root.key,
          command.value.file,
          errnoCodeOf(error),
          EMPTY_OUTPUT_SUMMARY,
          error,
        ),
      );
    }

    const state = new ChildState({
      key: root.key,
      child,
      startedAt,
      command: executableName(command.value.file),
      script: command.value.script,
      sessionId,
      lease,
      devServerUrl: requestedUrl,
    });
    this.#attach(state);

    if (state.pid === undefined) {
      // A spawn with no pid failed (`ENOENT`, `EACCES`); the `error` event says why.
      const outcome = await this.#waitForReady(state, undefined);
      await this.#releaseCredential(lease);
      const errorCode = outcome.kind === 'spawn-error' ? outcome.errorCode : undefined;
      return err(
        this.#spawnFailed(root.key, command.value.file, errorCode, state.output.summary()),
      );
    }

    this.#registry.set(root.key, state);
    // The child is alive: keep its lease from lapsing under it.
    this.#scheduleRenewal(lease);
    // …and pin its process group while the leader is unreaped, so the group
    // can still be told apart from a recycled id once the leader exits.
    this.#pinGroupInBackground(state);
    this.#log('info', 'Spawned a dev server with the telemetry preload attached', {
      projectRoot: root.key,
      pid: state.pid,
      command: state.command,
      ...(state.script === undefined ? {} : { script: state.script }),
      ...(sessionId === undefined ? {} : { sessionId }),
    });

    if (this.#isCancelled(ticket)) {
      const termination = await this.#terminate(state, 'cancelled');
      return err(
        termination.kind === 'survived'
          ? survivedTerminationError([termination.survivor])
          : cancelledError(),
      );
    }

    const outcome = await this.#waitForReady(state, requestedUrl);
    if (outcome.kind === 'ready' && !state.stopRequested && !state.hasExited) {
      state.status = 'ready';
      state.devServerUrl = outcome.url;
      // A ready framework has started its server workers: pin them too.
      this.#pinGroupInBackground(state);
      this.#log('info', 'The launched dev server is ready', {
        projectRoot: root.key,
        pid: state.pid,
        devServerUrl: outcome.url,
        // The listener's owner, not a header, identified it; a signature the
        // answer carried is recorded for information only.
        identifiedBy: 'launched-child',
        ...(outcome.framework === undefined ? {} : { framework: outcome.framework }),
        startupMs: Math.max(0, this.#now() - startedAt),
        output: state.output.summary(),
      });
      return ok(
        Object.freeze({
          managed: true,
          alreadyRunning: false,
          devServerUrl: outcome.url,
          pid: state.pid,
          detection,
        }),
      );
    }

    return err(await this.#failStartup(state, outcome, command.value.file));
  }

  /**
   * Clean up after a failed start and describe why it failed — or, when the
   * child outlived the stop that cleanup ran, that it is still running: then
   * it stays registered, and the start's own cause (which would claim it was
   * stopped) gives way to the survivor error.
   */
  async #failStartup(
    state: ChildState,
    outcome: ReadyOutcome,
    file: string,
  ): Promise<DebuggenError> {
    const stopped = state.stopRequested;
    state.status = 'failed';
    const termination = state.hasExited
      ? NOT_RUNNING
      : await this.#terminate(state, terminationReasonOf(outcome));
    await this.#releaseCredential(state.lease);
    if (termination.kind === 'survived') {
      return survivedTerminationError([termination.survivor]);
    }
    this.#forget(state);

    const output = state.output.summary();
    if (stopped) {
      return cancelledError();
    }
    const timeoutSeconds = String(Math.round(this.#settings.readyTimeoutMs / 1000));
    switch (outcome.kind) {
      case 'timeout': {
        const firstCandidate = state.readyCandidates[0];
        this.#log('warn', 'The launched dev server did not become ready in time; it was stopped', {
          projectRoot: state.key,
          pid: state.pid,
          timeoutMs: this.#settings.readyTimeoutMs,
          candidateCount: state.readyCandidates.length,
          output,
        });
        return new DebuggenError(
          'DEV_SERVER_UNAVAILABLE',
          `The dev server did not answer within ${timeoutSeconds} s of starting, so it was stopped.`,
          {
            hint: withOutputDigest(
              'It never announced a local address that answered. If it prints its address late, or at a non-loopback address, set debuggen.devServerUrl to its local address and launch again.',
              output,
            ),
            details: {
              reason: 'ready-timeout',
              timeoutMs: this.#settings.readyTimeoutMs,
              ...(firstCandidate === undefined ? {} : { lastSeenUrl: firstCandidate }),
              output: outputDetails(output),
            },
          },
        );
      }
      case 'unverified': {
        this.#log(
          'warn',
          'The launched dev server answered but was never identified; it was stopped',
          {
            projectRoot: state.key,
            pid: state.pid,
            timeoutMs: this.#settings.readyTimeoutMs,
            candidates: [...outcome.origins],
            ownership: outcome.ownership,
            output,
          },
        );
        const where = outcome.announced
          ? "The dev server's announced address"
          : "The session's dev-server address";
        const otherProcess = outcome.ownership === 'other-process';
        return new DebuggenError(
          'DEV_SERVER_UNAVAILABLE',
          otherProcess
            ? `${where} answered within ${timeoutSeconds} s, but the process listening there is not the dev server this launch started, so the launched dev server was stopped.`
            : `${where} answered within ${timeoutSeconds} s, but the service could not determine which process listens there, so the launched dev server was stopped.`,
          {
            // Fixed text only: nothing the child or a lookup printed.
            hint: withOutputDigest(
              otherProcess
                ? 'Another process answers at that address. Stop it, or change the port the dev server listens on, then launch the dev server again.'
                : 'The service could not determine which process listens at that address. Start the dev server yourself with the Debug Generator preload, then set debuggen.devServerUrl to its local address.',
              output,
            ),
            details: {
              reason: 'ready-unverified',
              timeoutMs: this.#settings.readyTimeoutMs,
              candidates: [...outcome.origins],
              ownership: outcome.ownership,
              output: outputDetails(output),
            },
          },
        );
      }
      case 'spawn-error':
        return this.#spawnFailed(state.key, file, outcome.errorCode, output);
      case 'exited':
      case 'ready':
        this.#log('warn', 'The launched dev server exited before it was ready', {
          projectRoot: state.key,
          pid: state.pid,
          exitCode: state.exitCode,
          signal: state.exitSignal,
          output,
        });
        return new DebuggenError(
          'DEV_SERVER_LAUNCH_FAILED',
          state.exitCode === null
            ? `The dev server stopped${state.exitSignal === null ? '' : ` (${state.exitSignal})`} before it was ready.`
            : `The dev server exited with code ${String(state.exitCode)} before it was ready.`,
          {
            hint: withOutputDigest(
              'Fix the problem that stopped it (a missing dependency, a port in use, a build error), then launch the dev server again.',
              output,
            ),
            details: {
              reason: 'exited-before-ready',
              exitCode: state.exitCode,
              signal: state.exitSignal,
              output: outputDetails(output),
            },
          },
        );
      default:
        return assertNever(outcome);
    }
  }

  /**
   * Log a command that could not be started — the executable's name, the
   * errno code and the output summary, never an argument or a line — and
   * describe it as {@link spawnFailedError}.
   */
  #spawnFailed(
    projectRoot: string,
    file: string,
    errorCode: string | undefined,
    output: DevServerOutputSummary,
    cause?: unknown,
  ): DebuggenError {
    this.#log('warn', 'The dev-server command could not be started', {
      projectRoot,
      command: executableName(file),
      errorCode,
      output,
    });
    return spawnFailedError(file, errorCode, output, cause);
  }

  /**
   * What `spawn` receives for a resolved command. POSIX: the executable and
   * its argument array, directly. Windows: `cmd.exe` from the service's own
   * environment ({@link resolveWindowsComSpec}) with the checked `/d /s /c`
   * line of {@link buildWindowsCommandInvocation}, or its refusal.
   */
  #invocationFor(command: ResolvedCommand): Result<SpawnInvocation, DebuggenError> {
    if (this.#platform !== 'win32') {
      return ok({ command: command.file, args: command.args, windowsVerbatimArguments: false });
    }
    const built = buildWindowsCommandInvocation({
      file: command.file,
      args: command.args,
      comSpec: resolveWindowsComSpec(this.#deps.parentEnv ?? process.env),
    });
    return isErr(built) ? built : ok({ ...built.value, windowsVerbatimArguments: true });
  }

  /**
   * The command to spawn: the request's, or the package manager plus the
   * detected dev script — either way parsed and checked against the
   * dev-server command policy ({@link parseLaunchCommand}'s assignment
   * allowlist, then {@link checkLaunchCommand}, which is handed the parsed
   * assignments so an assigned `NODE_PATH` is judged too) before anything is
   * minted, so a shell, an interpreter, a script that starts no dev server,
   * a loader or modules from an untrusted directory never start. A
   * package-manager run records the script it starts.
   */
  #resolveCommand(
    requested: string | undefined,
    root: ProjectRootForms,
    detection: DevServerDetection,
  ): Result<ResolvedCommand, DebuggenError> {
    const policy: LaunchCommandContext = {
      projectRoot: root.native,
      scripts: detection.devServerScripts,
      platform: this.#platform,
      nodeExecutablePath: this.#deps.nodeExecutablePath ?? process.execPath,
      isTrustedFile: this.#deps.isTrustedDevCli ?? isTrustedDevCliFile,
      isTrustedDirectory: this.#deps.isTrustedDevDirectory ?? isTrustedNodePathDirectory,
      realpath: this.#deps.realpath,
    };
    if (requested !== undefined && requested.trim().length > 0) {
      const parsed = parseLaunchCommand(requested, this.#platform);
      if (isErr(parsed)) {
        return parsed;
      }
      const accepted = checkLaunchCommand(parsed.value, policy);
      return isErr(accepted) ? accepted : ok({ ...parsed.value, script: accepted.value.script });
    }

    const script = detection.devScript?.name;
    const runArgs =
      script === undefined ? undefined : packageManagerRunArgs(detection.packageManager, script);
    const [file, ...args] = runArgs ?? [];
    if (file === undefined) {
      return err(
        new DebuggenError(
          'DEV_SERVER_LAUNCH_FAILED',
          script === undefined
            ? "No dev script was found in this project's package.json, so the dev server could not be launched."
            : "This project's package manager could not be determined, so its dev script could not be run.",
          {
            hint: buildRelaunchHint(detection),
            details: {
              reason: script === undefined ? 'no-dev-script' : 'unknown-package-manager',
              packageManager: detection.packageManager,
              ...(script === undefined ? {} : { devScript: script }),
              notes: [...detection.notes],
            },
          },
        ),
      );
    }
    // The derived run is checked like a request's: a selected script whose
    // name a runner reads as its own command (`yarn install`) or option is
    // refused rather than handed to the package manager. Detection selected
    // the script from the manifest itself, so it counts as a dev-server
    // script even when the detection carries no script list.
    const accepted = checkLaunchCommand(
      { file, args },
      {
        ...policy,
        scripts: detection.devServerScripts ?? (script === undefined ? undefined : [script]),
      },
    );
    return isErr(accepted) ? accepted : ok({ file, args, env: {}, script });
  }

  // -------------------------------------------------------------------------
  // Child supervision
  // -------------------------------------------------------------------------

  /** Wire a spawned child's streams and lifecycle events to its state. */
  #attach(state: ChildState): void {
    const { child } = state;
    const pipe = (stream: ReadableLike | null, name: 'stdout' | 'stderr'): void => {
      if (stream === null) {
        return;
      }
      const splitter = new LineSplitter();
      stream.on('data', (chunk) => {
        for (const line of splitter.push(chunk)) {
          this.#recordOutput(state, name, line);
        }
      });
      // A stream that ends mid-line still owes its last fragment.
      stream.on('end', () => {
        for (const line of splitter.flush()) {
          this.#recordOutput(state, name, line);
        }
      });
    };
    pipe(child.stdout, 'stdout');
    pipe(child.stderr, 'stderr');

    child.on('exit', (code, signal) => {
      this.#handleExit(state, code, signal);
    });
    child.on('error', (error) => {
      this.#handleError(state, error);
    });
  }

  /**
   * One output line: counted and classified into the child's digest, and —
   * when it is an address announcement — mined for readiness candidates
   * ({@link announcedLoopbackUrls}): each new loopback `origin/` is appended,
   * up to {@link MAX_READY_CANDIDATES}, and wakes the readiness wait for a
   * verification round. A candidate is never readiness by itself. The line is
   * then dropped — it is never logged, kept or returned (CWE-532), because a
   * developer's dev server prints source frames, SQL literals, query values
   * and echoed environment.
   */
  #recordOutput(state: ChildState, stream: 'stdout' | 'stderr', raw: string): void {
    const line = normalizeOutputLine(raw);
    if (line === undefined) {
      return;
    }
    state.output.record(stream, line);
    if (state.readyCandidates.length >= MAX_READY_CANDIDATES) {
      return;
    }
    let added = false;
    for (const origin of announcedLoopbackUrls(line.text, this.#deps.config.port)) {
      if (
        state.readyCandidates.length < MAX_READY_CANDIDATES &&
        !state.readyCandidates.includes(origin)
      ) {
        state.readyCandidates.push(origin);
        added = true;
      }
    }
    if (added) {
      state.listener?.({ kind: 'url' });
    }
  }

  #handleExit(state: ChildState, code: number | null, signal: NodeJS.Signals | null): void {
    if (state.hasExited) {
      return;
    }
    const wasStopping = state.stopRequested;
    state.noteExit(code, signal);
    state.listener?.({ kind: 'exit', code, signal });
    this.#log('info', 'A launched dev server exited', {
      projectRoot: state.key,
      pid: state.pid,
      exitCode: code,
      signal,
      requested: wasStopping,
    });
    // AAP §0.5.6: the credential expires when the launched process exits.
    void this.#releaseCredential(state.lease);
    if (!wasStopping || state.survivedTermination) {
      // The leader is gone; anything it left in its group (a framework's
      // server worker) would keep the port and the old code. Reap it — for a
      // survivor too, whose stop finished before its leader did.
      this.#track(this.#reapGroup(state));
    }
    if (state.survivedTermination) {
      // A survivor was kept registered only so it stayed listed, retried and
      // reported while it ran; now that its exit is observed, nothing is left
      // to stop, so its record goes.
      this.#forget(state);
      return;
    }
    // The record stays listed, marked `exited`, until a new launch for the
    // project replaces it or a stop removes it.
  }

  #handleError(state: ChildState, error: Error): void {
    const errorCode = errnoCodeOf(error);
    if (state.pid === undefined) {
      // No pid means the spawn itself failed (`ENOENT`, `EACCES`): Node
      // reports that through `error` alone, with no `exit` to follow.
      state.status = 'failed';
      state.noteExit(null, null);
      state.listener?.({ kind: 'spawn-error', errorCode });
      void this.#releaseCredential(state.lease);
      this.#forget(state);
      return;
    }
    // An error on a running child is a failed signal delivery; the child's
    // own exit, when it comes, still drives cleanup.
    this.#log('warn', 'A launched dev server reported an error', {
      projectRoot: state.key,
      pid: state.pid,
      errorCode,
    });
  }

  /**
   * Wait until the child is **verified** ready, exits, fails to spawn, or the
   * ready timeout passes — whichever is first. Readiness runs in three steps,
   * and printed text alone never satisfies it:
   *
   * 1. **Candidates → targets.** Each verification round probes the child's
   *    readiness candidates ({@link ChildState.readyCandidates}, the loopback
   *    origins it announced after a serving-address label) in announcement
   *    order, then the requested `devServerUrl` last (skipped when it is one
   *    of the candidates). A target the probe refuses (not loopback) is
   *    dropped for the rest of the wait.
   * 2. **Probe.** All targets are probed concurrently, each bounded by the
   *    readiness probe timeout. A round starts at once, again whenever the
   *    child announces a new candidate (a round in flight is followed
   *    immediately by another), and every poll interval while there is
   *    anything to probe.
   * 3. **Ownership.** For every target that answered (any HTTP status), the
   *    {@link ListenerOwnership} port is asked — once per distinct port, the
   *    port taken from the URL (explicit, else 80/443 by scheme), each ask
   *    bounded by the readiness probe timeout (`#ownershipOf`) —
   *    whether every listener on that port is held by the child's process
   *    tree. The first target in target order whose port it confirms is
   *    ready. A port it denies is remembered as `'other-process'`, one it
   *    cannot tell about as `'unknown'`, so a deadline reached after such an
   *    answer becomes the `unverified` outcome (`'other-process'` when both
   *    occurred) rather than `timeout`. Neither a framework signature nor a
   *    connected `server-agent` makes a target ready.
   *
   * Settling clears the poll and deadline timers, releases every ownership
   * ask still pending (with its bound timer) and detaches the listener, so no
   * timer is left pending; a probe or lookup still in flight is ignored when
   * it returns.
   *
   * @param state The child being waited on.
   * @param requestedUrl The session's dev-server URL, when the caller supplied one.
   */
  #waitForReady(state: ChildState, requestedUrl: string | undefined): Promise<ReadyOutcome> {
    return new Promise<ReadyOutcome>((resolve) => {
      let settled = false;
      let verifying = false;
      let roundRequested = false;
      let fallbackUrl = requestedUrl;
      /** Targets the probe refused to probe; never tried again in this wait. */
      const refused = new Set<string>();
      /** `origin/` of each address that answered unconfirmed → whether it was announced. */
      const unverified = new Map<string, boolean>();
      /** Which unconfirmed verdicts occurred; `'other-process'` outranks `'unknown'`. */
      const verdicts = new Set<DevServerUnverifiedOwnership>();
      /** Releases each ownership ask still pending, clearing its bound timer. */
      const pendingOwnership = new Set<() => void>();
      // Holders rather than bare handles: a handle is opaque, and `undefined`
      // may be a legitimate one from an injected timer.
      const timers: {
        poll?: { readonly handle: TimerHandle } | undefined;
        deadline?: { readonly handle: TimerHandle } | undefined;
      } = {};

      const finish = (outcome: ReadyOutcome): void => {
        if (settled) {
          return;
        }
        settled = true;
        state.listener = undefined;
        if (timers.poll !== undefined) {
          this.#clearTimeout(timers.poll.handle);
          timers.poll = undefined;
        }
        if (timers.deadline !== undefined) {
          this.#clearTimeout(timers.deadline.handle);
          timers.deadline = undefined;
        }
        for (const release of [...pendingOwnership]) {
          release();
        }
        resolve(outcome);
      };

      const schedule = (): void => {
        if (settled || timers.poll !== undefined) {
          return;
        }
        timers.poll = {
          handle: this.#setTimeout(() => {
            timers.poll = undefined;
            void verify();
          }, this.#settings.pollIntervalMs),
        };
      };

      const targets = (): ReadyTarget[] =>
        readyTargetsOf(state.readyCandidates, fallbackUrl, refused);

      /** One round over `current`: the ready target it confirmed, or `undefined`. */
      const runRound = async (
        current: readonly ReadyTarget[],
      ): Promise<{ readonly url: string; readonly framework?: DevServerFramework } | undefined> => {
        const answers = await Promise.all(current.map((target) => this.#probeForReady(target.url)));
        if (settled) {
          return undefined;
        }
        const answered: {
          readonly url: string;
          readonly announced: boolean;
          readonly port: number | undefined;
          readonly framework?: DevServerFramework;
        }[] = [];
        current.forEach((target, index) => {
          const answer = answers[index];
          if (answer === undefined) {
            // The probe threw: no answer this round; the next round retries.
            return;
          }
          if (isErr(answer)) {
            // A URL the probe may not probe (not loopback): drop it for good.
            refused.add(target.url);
            if (!target.announced) {
              fallbackUrl = undefined;
            }
            return;
          }
          if (answer.value.reachable !== true) {
            return;
          }
          // A candidate is recorded in its announced `origin/` form; the
          // requested URL in the probe's origin-and-pathname form.
          const url = target.announced ? target.url : answer.value.url;
          const framework = answer.value.framework;
          answered.push({
            url,
            announced: target.announced,
            port: listeningPortOf(url),
            ...(framework === undefined ? {} : { framework }),
          });
        });
        if (answered.length === 0) {
          return undefined;
        }
        // One ask per distinct port, concurrently; a port the URL does not
        // yield (it always does for a probed http(s) URL) cannot be verified.
        const ports = [
          ...new Set(answered.flatMap(({ port }) => (port === undefined ? [] : [port]))),
        ];
        const owners = new Map<number, boolean | undefined>(
          await Promise.all(
            ports.map(
              async (port) =>
                [port, await this.#ownershipOf(state, port, pendingOwnership)] as const,
            ),
          ),
        );
        if (settled) {
          return undefined;
        }
        const owned = answered.find(({ port }) => port !== undefined && owners.get(port) === true);
        if (owned !== undefined) {
          return owned.framework === undefined
            ? { url: owned.url }
            : { url: owned.url, framework: owned.framework };
        }
        for (const { url, announced, port } of answered) {
          const origin = originFormOf(url);
          unverified.set(origin, unverified.get(origin) === true || announced);
          verdicts.add(
            port !== undefined && owners.get(port) === false ? 'other-process' : 'unknown',
          );
        }
        return undefined;
      };

      const verify = async (): Promise<void> => {
        if (settled) {
          return;
        }
        if (verifying) {
          // A new candidate arrived mid-round: run another round right after.
          roundRequested = true;
          return;
        }
        verifying = true;
        try {
          do {
            roundRequested = false;
            const current = targets();
            if (current.length === 0) {
              break;
            }
            const ready = await runRound(current);
            if (ready !== undefined) {
              finish({ kind: 'ready', ...ready });
              return;
            }
          } while (roundRequested && !settled);
        } catch (error) {
          // A round that fails in a way nothing above anticipated is no
          // answer; the next round (or the deadline) still decides.
          this.#log('warn', 'A dev-server readiness round failed unexpectedly', {
            projectRoot: state.key,
            pid: state.pid,
            errorCode: errnoCodeOf(error),
          });
        } finally {
          verifying = false;
        }
        if (!settled && targets().length > 0) {
          schedule();
        }
      };

      if (state.hasExited) {
        finish(
          state.status === 'failed'
            ? { kind: 'spawn-error', errorCode: undefined }
            : { kind: 'exited', code: state.exitCode, signal: state.exitSignal },
        );
        return;
      }

      state.listener = (event) => {
        switch (event.kind) {
          case 'exit':
            finish({ kind: 'exited', code: event.code, signal: event.signal });
            return;
          case 'spawn-error':
            finish({ kind: 'spawn-error', errorCode: event.errorCode });
            return;
          case 'url':
            // A new candidate: verify it now rather than at the next poll.
            void verify();
            return;
          default:
            assertNever(event);
        }
      };
      timers.deadline = {
        handle: this.#setTimeout(() => {
          finish(
            unverified.size === 0
              ? { kind: 'timeout' }
              : {
                  kind: 'unverified',
                  origins: Object.freeze([...unverified.keys()]),
                  announced: [...unverified.values()].some((announced) => announced),
                  ownership: verdicts.has('other-process') ? 'other-process' : 'unknown',
                },
          );
        }, this.#settings.readyTimeoutMs),
      };
      void verify();
    });
  }

  /**
   * Ask the {@link ListenerOwnership} port whether every listener on `port`
   * is held by this child's process tree, bounded by the readiness probe
   * timeout. `undefined` — cannot tell — for a child without a pid, a port
   * that throws, rejects or answers anything but a boolean, an ask that
   * outlives the bound, and an ask the wait releases by settling first
   * (`pending` holds its release until it completes).
   *
   * @param state The child whose pid roots the tree.
   * @param port The port the probe was answered on.
   * @param pending The wait's releases; this ask's is added, and removed on completion.
   */
  #ownershipOf(
    state: ChildState,
    port: number,
    pending: Set<() => void>,
  ): Promise<boolean | undefined> {
    const pid = state.pid;
    if (pid === undefined) {
      return Promise.resolve(undefined);
    }
    return new Promise<boolean | undefined>((settle) => {
      const ask: { done: boolean; bound?: { readonly handle: TimerHandle } | undefined } = {
        done: false,
      };
      const complete = (verdict: unknown): void => {
        if (ask.done) {
          return;
        }
        ask.done = true;
        pending.delete(release);
        if (ask.bound !== undefined) {
          this.#clearTimeout(ask.bound.handle);
          ask.bound = undefined;
        }
        settle(verdict === true || verdict === false ? verdict : undefined);
      };
      const release = (): void => {
        complete(undefined);
      };
      pending.add(release);
      ask.bound = { handle: this.#setTimeout(release, this.#settings.readyProbeTimeoutMs) };
      let answer: Promise<boolean | undefined>;
      try {
        answer = this.#ownership.ownsListener(pid, port);
      } catch {
        release();
        return;
      }
      void Promise.resolve(answer).then(complete, release);
    });
  }

  /**
   * Probe one readiness target with the readiness probe timeout. A probe that
   * throws (an injected one misbehaving) is reported as no answer, which the
   * round treats like a refused connection.
   */
  async #probeForReady(
    url: string,
  ): Promise<Result<DevServerProbeResult, DebuggenError> | undefined> {
    try {
      return await this.#probe(url, {
        fetchImpl: this.#deps.detectDeps?.fetchImpl,
        probeTimeoutMs: this.#settings.readyProbeTimeoutMs,
        logger: this.#parentLogger,
        now: this.#now,
      });
    } catch {
      return undefined;
    }
  }

  /**
   * Stop a child: its process group's members are pinned while the leader is
   * unreaped, then `SIGTERM` goes to the group (when group signalling is on,
   * else to the child); once the grace period passes with the leader still
   * alive, or a verified member of its group left after it exited, `SIGKILL`
   * follows — to the group directly while the leader is unreaped, else only
   * to a group {@link #signalExitedGroup} verified. The credential is
   * revoked whatever the outcome. The registry entry is removed once the exit
   * is observed; a child that outlived the whole ladder is kept (see
   * {@link DevServerSurvivor}). Shared by every stop path, so concurrent
   * callers await one termination; one that ended `survived` is not reused,
   * so the next caller runs the ladder again.
   *
   * Never rejects: a termination that throws — a defect, since every step is
   * guarded — is accounted for by {@link #terminationFailed} rather than left
   * for a caller to drop.
   *
   * @returns How the termination ended.
   */
  #terminate(state: ChildState, reason: string): Promise<TerminationOutcome> {
    const running = state.terminating;
    if (running !== undefined) {
      return running;
    }
    const termination: Promise<TerminationOutcome> = this.#runTermination(state, reason)
      .catch((error: unknown) => this.#terminationFailed(state, reason, error))
      .then((outcome) => {
        if (outcome.kind === 'survived' && state.terminating === termination) {
          state.terminating = undefined;
        }
        return outcome;
      });
    state.terminating = termination;
    return termination;
  }

  async #runTermination(state: ChildState, reason: string): Promise<TerminationOutcome> {
    state.stopRequested = true;
    const pid = state.pid;
    if (pid === undefined || state.hasExited) {
      await this.#releaseCredential(state.lease);
      this.#forget(state);
      if (pid !== undefined) {
        await this.#reapGroup(state);
      }
      return NOT_RUNNING;
    }

    if (state.status !== 'failed') {
      state.status = 'stopping';
    }
    if (this.#signalGroup !== undefined) {
      // Pin the group's members while the leader is still unreaped: once it
      // exits on SIGTERM, only a pinned member proves the group is its own.
      await this.#pinGroup(state);
    }
    if (state.hasExited) {
      // The leader exited while its group was being listed: from here on the
      // group is signalled only as verified.
      await this.#signalExitedGroup(state, 'SIGTERM');
    } else {
      // Synchronously, as the leader is unreaped: the direct group signal is
      // safe, and nothing else runs between the decision and the delivery.
      this.#sendSignal(state, 'SIGTERM');
    }
    // The leader first, then whatever it left in its group, within one grace.
    const grace = this.#settings.stopGraceMs;
    const leader = await this.#waitUntil(() => state.hasExited, grace);
    let graceful = leader.met;
    if (graceful && this.#signalGroup !== undefined) {
      const drained = await this.#waitUntilAsync(
        () => this.#groupDrained(state),
        grace - leader.elapsedMs,
      );
      graceful = drained.met;
    }
    let escalated = false;
    if (!graceful) {
      escalated = true;
      if (state.hasExited) {
        // A verified member outlived the grace; the leader is gone, so its
        // group is signalled only as verified again, right now.
        await this.#signalExitedGroup(state, 'SIGKILL');
      } else {
        this.#sendSignal(state, 'SIGKILL');
        if (this.#platform === 'win32') {
          this.#killWindowsTree(state, pid);
        }
      }
      await this.#waitUntil(() => state.hasExited, KILL_CONFIRM_MS);
    }

    // Revoked whatever the outcome: a child that outlived its stop keeps
    // running, but its preload can no longer ingest or hold a control socket.
    await this.#releaseCredential(state.lease);
    if (!state.hasExited) {
      return this.#survived(state, pid, reason, escalated);
    }
    this.#forget(state);
    // The termination's own record carries any undelivered signal, so the
    // shutdown or session-end path that awaited it reads, in one line, both
    // how the child ended and whether a kill was refused along the way.
    this.#log('info', 'Stopped a launched dev server', {
      projectRoot: state.key,
      pid,
      reason,
      escalated,
      exitObserved: true,
      signalFailures: state.signalFailures,
      ...(state.lastSignalFailure === undefined
        ? {}
        : { lastSignalFailure: state.lastSignalFailure }),
    });
    return { kind: 'stopped', escalated };
  }

  /**
   * Account for a child still running when its termination ran to the end:
   * marked `failed` (its credential is already revoked) and kept registered,
   * so it stays listed, is retried by the next stop, launch or shutdown, and
   * leaves the registry only when its exit is observed. Logged at `error`
   * under closed fields — the pid, the reason, the refused deliveries — never
   * a refusal's own text.
   */
  #survived(
    state: ChildState,
    pid: number,
    reason: string,
    escalated: boolean,
  ): TerminationOutcome {
    state.status = 'failed';
    state.survivedTermination = true;
    this.#log('error', 'A launched dev server did not stop', {
      projectRoot: state.key,
      pid,
      reason,
      escalated,
      exitObserved: false,
      signalFailures: state.signalFailures,
      ...(state.lastSignalFailure === undefined
        ? {}
        : { lastSignalFailure: state.lastSignalFailure }),
    });
    return { kind: 'survived', survivor: state.survivorRecord(pid) };
  }

  /**
   * A termination that threw. Every step of {@link #runTermination} is
   * guarded, so this is a defect, and it is reported as one — at `error`,
   * by the throw's closed class and code — while the child is still
   * accounted for: its credential revoked, and a child whose exit was not
   * observed reported as a survivor rather than dropped or called stopped.
   */
  async #terminationFailed(
    state: ChildState,
    reason: string,
    error: unknown,
  ): Promise<TerminationOutcome> {
    this.#log('error', 'Stopping a launched dev server failed unexpectedly', {
      projectRoot: state.key,
      pid: state.pid,
      reason,
      ...describeException(error),
    });
    await this.#releaseCredential(state.lease);
    const pid = state.pid;
    if (pid === undefined || state.hasExited) {
      this.#forget(state);
      return pid === undefined ? NOT_RUNNING : { kind: 'stopped', escalated: false };
    }
    return this.#survived(state, pid, reason, false);
  }

  /**
   * After the leader exited on its own, end whatever it left in its process
   * group — as verified by {@link #signalExitedGroup}, never by a bare group
   * id: `SIGTERM`, then, when a verified member is still there once the grace
   * period passes, `SIGKILL`. A group that is gone, recycled or cannot be
   * listed is not signalled at all.
   */
  async #reapGroup(state: ChildState): Promise<void> {
    if (this.#signalGroup === undefined || state.pid === undefined) {
      return;
    }
    if (!(await this.#signalExitedGroup(state, 'SIGTERM'))) {
      return;
    }
    const drained = await this.#waitUntilAsync(
      () => this.#groupDrained(state),
      this.#settings.stopGraceMs,
    );
    if (!drained.met) {
      await this.#signalExitedGroup(state, 'SIGKILL');
    }
  }

  /**
   * Signal a child whose leader is still unreaped: its process group when
   * group signalling is on — safe exactly now, because an unreaped leader
   * keeps its pid, so no other process can lead a group of that id — else,
   * or when the group cannot be signalled, the child alone. After the exit
   * this sends nothing; {@link #signalExitedGroup} is the only way to reach
   * the group then.
   */
  #sendSignal(state: ChildState, signal: NodeJS.Signals): void {
    if (state.hasExited) {
      return;
    }
    const pid = state.pid;
    if (pid !== undefined && this.#signalGroup !== undefined) {
      try {
        this.#signalGroup(pid, signal);
        return;
      } catch {
        // The group could not be signalled (the child has not led one yet,
        // or may not be signalled that way): the child alone, below.
      }
    }
    // Delivery can fail — `kill` throws, or answers `false` for a signal
    // Node did not deliver (a process that vanished without an exit event,
    // or one this account may not signal). Not fatal to the stop, because
    // the escalation step or the exit handler follows; but recorded, never
    // swallowed, and a child that is still running when the ladder ends is
    // reported as a survivor.
    try {
      if (!state.child.kill(signal)) {
        this.#noteSignalFailure(state, { signal, refusal: 'not-delivered' });
      }
    } catch (error) {
      this.#noteSignalFailure(state, { signal, refusal: 'threw', ...describeException(error) });
    }
  }

  /**
   * Signal the process group of a child whose leader has exited, only once
   * {@link #pinGroup} has verified — immediately before — that the group
   * still holds a process pinned in it earlier. A group that is gone, holds
   * no pinned member (its id was recycled) or cannot be listed is released:
   * never signalled again, and — unless it is simply gone — logged once.
   *
   * The listing is asynchronous, so the service may run other work before it
   * answers. When the inspector can also answer synchronously
   * ({@link ProcessGroupInspector.confirm}, on Linux), a pinned member of that
   * listing is confirmed once more **in the same synchronous step that
   * delivers the signal** — no `await` in between — and a group none of whose
   * listed pins still confirms is released silently, as gone. Without
   * `confirm` the listing alone stands.
   *
   * What remains is the width of that final step: were the confirmed member
   * to exit and an unrelated process to take over its group id between the
   * confirming read and the `kill` system call, that process would be
   * signalled. Node exposes no pidfd, so no pid-based signal is free of such
   * a syscall-width window; confirmation shrinks it from the leader's whole
   * lifetime after exit — and then from an asynchronous listing — to two
   * adjacent system calls.
   *
   * @returns Whether the signal was sent.
   */
  async #signalExitedGroup(state: ChildState, signal: NodeJS.Signals): Promise<boolean> {
    const pid = state.pid;
    const signalGroup = this.#signalGroup;
    if (pid === undefined || signalGroup === undefined || state.groupReleased) {
      return false;
    }
    const reading = await this.#pinGroup(state);
    if (reading.verdict !== 'verified') {
      this.#releaseGroup(state, reading.verdict);
      return false;
    }
    // From here to the signal nothing awaits: the confirmation and the
    // delivery run in one synchronous step.
    if (!this.#confirmsPinnedMember(state, reading.members)) {
      this.#releaseGroup(state, 'gone');
      return false;
    }
    try {
      signalGroup(pid, signal);
      return true;
    } catch (error) {
      if (errnoCodeOf(error) === 'ESRCH') {
        this.#releaseGroup(state, 'gone');
      } else {
        this.#noteSignalFailure(state, { signal, refusal: 'threw', ...describeException(error) });
      }
      return false;
    }
  }

  /**
   * Whether nothing verified is left in a child's group to wait for: the
   * group is gone, or it is released because it could not be verified
   * (which is logged). `false` while a verified member remains.
   */
  async #groupDrained(state: ChildState): Promise<boolean> {
    if (state.groupReleased) {
      return true;
    }
    const { verdict } = await this.#pinGroup(state);
    if (verdict === 'verified') {
      return false;
    }
    this.#releaseGroup(state, verdict);
    return true;
  }

  /**
   * Whether the group inspector confirms, synchronously and right now, that a
   * member pinned in the listing just taken is still that very process in the
   * child's group ({@link ProcessGroupInspector.confirm}). Asks the listed
   * members whose (pid, start token) pair is pinned, in listing order, until
   * one answers `true`. An inspector without `confirm` leaves the listing's
   * verdict standing (`true`); one whose every answer is `false` or cannot
   * tell, or that throws, does not confirm (`false`).
   */
  #confirmsPinnedMember(state: ChildState, members: readonly ProcessIdentity[]): boolean {
    const inspector = this.#groupInspector;
    if (typeof inspector.confirm !== 'function') {
      return true;
    }
    for (const member of members) {
      if (state.groupPins.get(member.pid) !== member.startToken) {
        continue;
      }
      let answer: unknown;
      try {
        // Called as a method, so an inspector object keeps its `this`.
        answer = inspector.confirm(member);
      } catch {
        answer = undefined;
      }
      if (answer === true) {
        return true;
      }
    }
    return false;
  }

  /**
   * List the child's process group and decide whose it is.
   *
   * A listing is **trusted** when the leader was unreaped both before and
   * after it — Node reports `exit` in the same step that reaps the child, so
   * the leader held its pid, and with it the group id, throughout — or when
   * it holds a pinned (pid, start token) pair, a process that was in the
   * child's group before and still is, which a recycled id cannot hold. A
   * trusted listing's members are pinned.
   *
   * @returns The {@link GroupReading}: `'verified'` — a trusted listing with
   * members, which the reading carries; `'gone'` — no process has the group
   * id; `'foreign'` — processes do, none of them pinned, and the leader has
   * exited (a recycled id); `'unknown'` — the group could not be listed.
   */
  async #pinGroup(state: ChildState): Promise<GroupReading> {
    const pid = state.pid;
    if (pid === undefined || this.#signalGroup === undefined) {
      return groupReading('unknown');
    }
    const unreapedBefore = !state.hasExited;
    let answer: unknown;
    try {
      answer = await this.#groupInspector.members(pid);
    } catch {
      answer = undefined;
    }
    const members = groupMembersOf(answer, pid);
    if (members === undefined) {
      return groupReading('unknown');
    }
    const unreapedThroughout = unreapedBefore && !state.hasExited;
    const holdsPinned = members.some(
      (member) => state.groupPins.get(member.pid) === member.startToken,
    );
    if (!unreapedThroughout && !holdsPinned) {
      return groupReading(members.length === 0 ? 'gone' : 'foreign');
    }
    for (const member of members) {
      if (state.groupPins.size < MAX_OWNERSHIP_TREE_SIZE || state.groupPins.has(member.pid)) {
        state.groupPins.set(member.pid, member.startToken);
      }
    }
    return members.length === 0 ? groupReading('gone') : { verdict: 'verified', members };
  }

  /** Pin a live child's group without holding up the caller; `dispose` awaits it. */
  #pinGroupInBackground(state: ChildState): void {
    if (this.#signalGroup === undefined || state.pid === undefined) {
      return;
    }
    this.#track(this.#pinGroup(state).then(() => undefined));
  }

  /**
   * Stop signalling a child's group for good. A group that could not be
   * verified is logged once, under closed fields — the project, the pid and
   * the verdict — so a worker left running is explained, never hidden.
   */
  #releaseGroup(state: ChildState, verdict: Exclude<GroupVerdict, 'verified'>): void {
    if (state.groupReleased) {
      return;
    }
    state.groupReleased = true;
    if (verdict === 'gone') {
      return;
    }
    this.#log(
      'warn',
      "A launched dev server's process group could not be verified after its leader exited, so it is not signalled",
      { projectRoot: state.key, pid: state.pid, verdict },
    );
  }

  /**
   * Account for a signal `child.kill` refused: counted on the child state, so
   * the termination's record and a survivor's report carry it to the stop,
   * session-end or shutdown path that awaited it, and logged now under the
   * refusal's closed class and code — never its message, which names a pid
   * and a platform detail only a debugger needs.
   */
  #noteSignalFailure(state: ChildState, failure: DevServerSignalFailure): void {
    state.signalFailures += 1;
    state.lastSignalFailure = failure;
    this.#log('warn', 'A signal could not be delivered to a launched dev server', {
      projectRoot: state.key,
      pid: state.pid,
      ...failure,
    });
  }

  /**
   * End a process tree on Windows, where there are no process groups to signal.
   *
   * The tree-wide backstop behind `child.kill('SIGKILL')`, which already ran:
   * a `taskkill` that cannot start — synchronously, or through the `error`
   * event a missing binary produces — leaves the stop to the bounded exit wait
   * that follows, so its failure is reported under its closed class and code
   * rather than raised or dropped. It runs only while the child is unreaped:
   * `taskkill /pid` of an exited child's id could end a process that reused it.
   */
  #killWindowsTree(state: ChildState, pid: number): void {
    if (state.hasExited) {
      return;
    }
    const backstopFailed = (error: unknown): void => {
      this.#log('warn', 'The Windows process-tree backstop could not run', {
        projectRoot: state.key,
        pid,
        ...describeException(error),
      });
    };
    try {
      const killer = this.#spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
        cwd: process.cwd(),
        env: stringEnvironment(this.#deps.parentEnv ?? process.env),
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
        windowsVerbatimArguments: false,
        windowsHide: true,
        detached: false,
      });
      killer.on('error', backstopFailed);
    } catch (error) {
      backstopFailed(error);
    }
  }

  /**
   * Resolve `met: true` as soon as `condition` holds, or `met: false` once
   * `timeoutMs` has elapsed, with the time waited either way. Elapsed time is
   * the sum of the timer delays, so the bound holds under an injected timer
   * and a frozen clock alike.
   */
  #waitUntil(condition: () => boolean, timeoutMs: number): Promise<WaitOutcome> {
    if (condition()) {
      return Promise.resolve({ met: true, elapsedMs: 0 });
    }
    return new Promise<WaitOutcome>((resolve) => {
      let elapsed = 0;
      const step = (): void => {
        const delay = Math.max(1, Math.min(GROUP_POLL_INTERVAL_MS, timeoutMs - elapsed));
        this.#setTimeout(() => {
          elapsed += delay;
          if (condition()) {
            resolve({ met: true, elapsedMs: elapsed });
          } else if (elapsed >= timeoutMs) {
            resolve({ met: false, elapsedMs: elapsed });
          } else {
            step();
          }
        }, delay);
      };
      step();
    });
  }

  /**
   * {@link #waitUntil} for a condition that must itself wait — a process-group
   * listing. The same injected timer paces it, every
   * {@link GROUP_POLL_INTERVAL_MS} at most, and only the timer delays count
   * towards `timeoutMs`; a bound already spent (`timeoutMs <= 0`) checks once.
   * A condition that rejects counts as not met.
   */
  async #waitUntilAsync(
    condition: () => Promise<boolean>,
    timeoutMs: number,
  ): Promise<WaitOutcome> {
    const holds = async (): Promise<boolean> => {
      try {
        return await condition();
      } catch {
        return false;
      }
    };
    if (await holds()) {
      return { met: true, elapsedMs: 0 };
    }
    let elapsed = 0;
    while (elapsed < timeoutMs) {
      const delay = Math.max(1, Math.min(GROUP_POLL_INTERVAL_MS, timeoutMs - elapsed));
      await new Promise<void>((resolve) => {
        this.#setTimeout(resolve, delay);
      });
      elapsed += delay;
      if (await holds()) {
        return { met: true, elapsedMs: elapsed };
      }
    }
    return { met: false, elapsedMs: elapsed };
  }

  /** Remove a state from the registry, if it is still the one registered for its project. */
  #forget(state: ChildState): void {
    if (this.#registry.get(state.key) === state) {
      this.#registry.delete(state.key);
    }
  }

  /** Keep a background reaper reachable so `dispose` can await it. */
  #track(task: Promise<void>): void {
    const tracked = task.catch(() => undefined);
    this.#reapers.add(tracked);
    void tracked.then(() => {
      this.#reapers.delete(tracked);
    });
  }

  // -------------------------------------------------------------------------
  // stop, sessions, shutdown
  // -------------------------------------------------------------------------

  async stop(
    input: DevServerStopInput,
  ): Promise<Result<{ readonly stopped: boolean }, DebuggenError>> {
    try {
      const projectRoot = input.projectRoot;
      const pid = input.pid;
      const sessionId = nonEmpty(input.sessionId);
      if (projectRoot === undefined && pid === undefined && sessionId === undefined) {
        return err(
          new DebuggenError('PROJECT_NOT_FOUND', 'A dev-server stop request must name a project.', {
            hint: 'Pass the project root whose launched dev server should stop.',
            details: { reason: 'no-selector' },
          }),
        );
      }

      let key: string | undefined;
      let inflight: Promise<unknown> | undefined;
      if (projectRoot !== undefined) {
        const root = projectRootForms(projectRoot);
        if (isErr(root)) {
          return root;
        }
        key = root.value.key;
        if (pid === undefined && sessionId === undefined) {
          // Cancels a launch for this project that has not spawned yet.
          this.#keyGenerations.set(key, (this.#keyGenerations.get(key) ?? 0) + 1);
          inflight = this.#inflight.get(key);
        }
      }

      const selected = (state: ChildState): boolean =>
        (key === undefined || state.key === key) &&
        (pid === undefined || state.pid === pid) &&
        (sessionId === undefined || state.sessionIds.has(sessionId));
      const matches = [...this.#registry.values()].filter(selected);
      // The credentials of the project's earlier children whose revocation
      // failed, taken before this stop adds its own: each is tried again here.
      const matchedLeases = new Set(matches.map((state) => state.lease));
      const earlier = [...this.#pendingRevocations].filter(
        (lease) => key !== undefined && lease.projectRoot === key && !matchedLeases.has(lease),
      );
      const outcomes = await Promise.all(
        matches.map((state) => this.#terminate(state, 'stop-requested')),
      );
      if (inflight !== undefined) {
        await inflight;
      }

      // A matched child that outlived its termination — or one a launch this
      // stop cancelled had already spawned — is still registered under the
      // same selectors. Either is still running, so this is not a stop.
      const [survivor, ...others] = this.#reportOf(
        [...this.#registry.values()].filter(selected),
      ).survivors;
      if (survivor !== undefined) {
        return err(survivedTerminationError([survivor, ...others]));
      }

      // A stop is clean only once no credential of the project still
      // authenticates: the matched children's, and the earlier ones.
      await Promise.all(earlier.map((lease) => this.#releaseCredential(lease)));
      const pending = [...matchedLeases, ...earlier].filter((lease) => !lease.invalidated);
      if (pending.length > 0) {
        return err(revocationPendingError(pending));
      }
      return ok({
        stopped: inflight !== undefined || outcomes.some((outcome) => outcome.kind === 'stopped'),
      });
    } catch (error) {
      this.#log('error', 'Stopping a launched dev server failed unexpectedly', {
        errorCode: errnoCodeOf(error),
      });
      return err(
        new DebuggenError(
          'DEV_SERVER_LAUNCH_FAILED',
          'The launched dev server could not be stopped.',
          {
            hint: 'The service log holds the reason. Stop the dev server from its terminal, or restart the Debug Generator service.',
            details: { reason: 'unexpected-failure' },
            cause: error,
          },
        ),
      );
    }
  }

  async stopForSession(
    sessionId: string,
  ): Promise<Result<{ readonly stopped: number }, DebuggenError>> {
    const id = nonEmpty(sessionId);
    if (id === undefined) {
      return ok({ stopped: 0 });
    }
    this.#rememberEndedSession(id);
    const released: ChildState[] = [];
    for (const state of this.#registry.values()) {
      // Only a session-owned child has owners; a developer-owned one keeps
      // serving after every session ends (AAP §0.5.1). A hold for a session
      // still being created keeps it too.
      if (state.sessionOwned && state.sessionIds.delete(id) && isUnowned(state)) {
        released.push(state);
      }
    }
    // The credentials an earlier call for this session could not revoke are
    // tried again now, and still count: a repeated end is not answered clean
    // while one of them authenticates.
    const earlier = [...(this.#sessionReleases.get(id)?.leases ?? [])];
    await Promise.allSettled([
      ...released.map((state) => this.#terminate(state, 'session-ended')),
      ...earlier.map((lease) => this.#releaseCredential(lease)),
    ]);
    // A released child that outlived its whole termination ladder is still
    // running: reported to the caller, never counted as stopped.
    const [survivor, ...others] = this.#reportOf(released).survivors;
    const stopped = released.length - (survivor === undefined ? 0 : others.length + 1);
    if (stopped > 0) {
      this.#log('info', 'Stopped the dev servers of an ended session', {
        sessionId: id,
        stopped,
      });
    }
    const pending = [...new Set([...earlier, ...released.map((state) => state.lease)])].filter(
      (lease) => !lease.invalidated,
    );
    if (pending.length === 0) {
      this.#sessionReleases.delete(id);
      return survivor === undefined
        ? ok({ stopped })
        : err(survivedTerminationError([survivor, ...others]));
    }
    // Remembered until every pending credential is invalidated, so the
    // session's cleanup report can be completed then (see `whenReleased`).
    const settled = Promise.all(pending.map((lease) => lease.settled)).then(() => undefined);
    const entry = Object.freeze({ leases: new Set(pending), settled });
    this.#sessionReleases.set(id, entry);
    void settled.then(() => {
      if (this.#sessionReleases.get(id) === entry) {
        this.#sessionReleases.delete(id);
      }
    });
    return err(
      survivor === undefined
        ? revocationPendingError(pending)
        : survivedTerminationError([survivor, ...others]),
    );
  }

  whenReleased(sessionId: string): Promise<void> {
    return this.#sessionReleases.get(sessionId)?.settled ?? Promise.resolve();
  }

  acquireForSession(projectRoot: string): DevServerHold | undefined {
    const root = projectRootForms(projectRoot);
    if (isErr(root)) {
      return undefined;
    }
    const state = this.#registry.get(root.value.key);
    const devServerUrl = state?.devServerUrl;
    if (state === undefined || !isServing(state) || devServerUrl === undefined) {
      return undefined;
    }
    this.#holdCounter += 1;
    const holdId = this.#holdCounter;
    if (state.sessionOwned) {
      state.holds.add(holdId);
    }
    let settled = false;
    /** Ends the hold exactly once; `false` when it had already ended. */
    const settle = (): boolean => {
      if (settled) {
        return false;
      }
      settled = true;
      state.holds.delete(holdId);
      return true;
    };

    return Object.freeze({
      devServerUrl,
      sessionOwned: state.sessionOwned,
      commit: (sessionId: string): boolean => {
        if (!settle() || !state.sessionOwned) {
          return false;
        }
        const id = nonEmpty(sessionId);
        if (id === undefined || this.#endedSessions.has(id) || !isServing(state)) {
          void this.#stopIfUnowned(state);
          return false;
        }
        state.sessionIds.add(id);
        this.#log('info', 'A session joined the owners of a launched dev server', {
          projectRoot: state.key,
          pid: state.pid,
          sessionId: id,
          owners: state.sessionIds.size,
        });
        return true;
      },
      release: async (): Promise<void> => {
        if (settle()) {
          await this.#stopIfUnowned(state);
        }
      },
    });
  }

  preloadServesAt(projectRoot: string, devServerUrl: string): boolean {
    try {
      const wanted = urlOrigin(devServerUrl);
      const root = projectRootForms(projectRoot);
      if (wanted === undefined || isErr(root)) {
        return false;
      }
      const state = this.#registry.get(root.value.key);
      if (
        state === undefined ||
        !isServing(state) ||
        state.lease.invalidated ||
        urlOrigin(state.devServerUrl) !== wanted
      ) {
        return false;
      }
      const connections = this.#deps.serverAgentConnections;
      return connections === undefined || connections.isCredentialConnected(state.lease.tokenHash);
    } catch (error) {
      // The connection view failed: no evidence, so no preload is attributed.
      this.#log('warn', 'Preload attribution could not read the connected server agents', {
        errorCode: errnoCodeOf(error),
      });
      return false;
    }
  }

  addressOfCredential(tokenHash: string): string | undefined {
    for (const state of this.#registry.values()) {
      if (state.lease.tokenHash === tokenHash) {
        return state.devServerUrl;
      }
    }
    return undefined;
  }

  /**
   * Stops a session-owned child that no session and no hold relies on any
   * more — the end of a hold whose session was never created, or whose
   * session ended before the hold was handed over.
   */
  async #stopIfUnowned(state: ChildState): Promise<void> {
    if (!state.sessionOwned || !isUnowned(state) || this.#registry.get(state.key) !== state) {
      return;
    }
    await this.#terminate(state, 'session-ended');
  }

  stopAll(): Promise<DevServerTerminationReport> {
    return this.#sweep(() => true);
  }

  dispose(): Promise<DevServerTerminationReport> {
    this.#disposing ??= this.#runDispose();
    return this.#disposing;
  }

  async #runDispose(): Promise<DevServerTerminationReport> {
    this.#disposed = true;
    await this.stopAll();
    // A launch that was between its credential and its spawn sees the bumped
    // generation and stops its own child; wait for it, then sweep once more —
    // past a child that already outlived a full ladder in the first sweep: it
    // is reported below, not signalled for another round that the shutdown's
    // bound on this step was never sized to cover.
    await Promise.allSettled([...this.#inflight.values()]);
    await this.#sweep((state) => !state.survivedTermination);
    await Promise.allSettled([...this.#reapers]);

    // Nothing supervises a credential route lease after this, so each one is
    // revoked now: the dev server the developer started keeps running, and its
    // preload goes inert like a launched child's would.
    await this.#releaseCliLeases();

    // The last chance to revoke what earlier attempts could not: no retry is
    // scheduled after this, and whatever is still pending lapses with its lease.
    const pending = [...this.#pendingRevocations];
    await Promise.allSettled(pending.map((lease) => this.#releaseCredential(lease)));
    for (const lease of this.#pendingRevocations) {
      this.#clearTimer(lease.retryTimer);
      lease.retryTimer = undefined;
      this.#log(
        'warn',
        'A server-agent credential could not be revoked before shutdown; it lapses with its lease',
        {
          projectRoot: lease.projectRoot,
          expiresAt: lease.expiresAt,
        },
      );
    }
    this.#pendingRevocations.clear();
    return this.#reportOf(this.#registry.values());
  }

  /**
   * Bump the global generation — so a launch that has not spawned yet cancels
   * itself — and terminate every registered child `include` admits.
   */
  #sweep(include: (state: ChildState) => boolean): Promise<DevServerTerminationReport> {
    this.#globalGeneration += 1;
    return this.#terminateAll([...this.#registry.values()].filter(include), 'shutdown');
  }

  /** Terminate `states` concurrently, then report those still running. */
  async #terminateAll(
    states: readonly ChildState[],
    reason: string,
  ): Promise<DevServerTerminationReport> {
    await Promise.all(states.map((state) => this.#terminate(state, reason)));
    return this.#reportOf(states);
  }

  /**
   * The report over `states`: each one that outlived a termination and whose
   * exit is still unobserved — read at the moment of reporting, so a survivor
   * that has since exited is not reported as running.
   */
  #reportOf(states: Iterable<ChildState>): DevServerTerminationReport {
    const survivors: DevServerSurvivor[] = [];
    for (const state of states) {
      const survivor = state.survivor();
      if (survivor !== undefined) {
        survivors.push(survivor);
      }
    }
    return survivors.length === 0
      ? NO_SURVIVORS
      : Object.freeze({ survivors: Object.freeze(survivors) });
  }

  list(): readonly LaunchedDevServer[] {
    const records: LaunchedDevServer[] = [];
    for (const state of this.#registry.values()) {
      const record = state.snapshot();
      if (record !== undefined) {
        records.push(record);
      }
    }
    return Object.freeze(records);
  }

  // -------------------------------------------------------------------------
  // The credential route's logic
  // -------------------------------------------------------------------------

  async issueCredential(
    input: DevServerCredentialRequest,
  ): Promise<Result<DevServerCredentialResponse, DebuggenError>> {
    const parsed = devServerCredentialInputSchema.safeParse(input);
    if (!parsed.success) {
      return err(
        new DebuggenError(
          'PROJECT_NOT_FOUND',
          `The credential request is invalid: ${describeZodIssues(parsed.error.issues)}`,
          {
            hint: 'Send { "projectRoot": "<absolute path of the project>" }.',
            details: { reason: 'invalid-credential-request' },
          },
        ),
      );
    }
    if (this.#disposed) {
      return err(shutdownError());
    }

    const projectRoot = normalizePosix(toPosix(parsed.data.projectRoot.trim()));
    // The first lease. Not flagged `lease: true`: that marks a launched child's
    // credential, which a restarted service revokes as an orphan; this one is
    // bounded by its supervision below and, after a crash, by this expiry.
    const requestedExpiry = Math.floor(this.#now() + this.#settings.cliCredentialLeaseMs);
    const issued = await this.#issue({ projectRoot, expiresAt: requestedExpiry });
    if (isErr(issued)) {
      return issued;
    }

    const body = devServerCredentialResponseSchema.safeParse({
      token: issued.value.token,
      expiresAt: issued.value.expiresAt ?? requestedExpiry,
    });
    if (!body.success) {
      // Never handed out, so revoked at once — and retried like every other
      // credential until it no longer authenticates. The issuer's own expiry is
      // what failed the schema, so the requested one bounds the retries.
      await this.#releaseCredential(
        new CredentialLease({
          projectRoot,
          token: issued.value.token,
          credentialId: nonEmpty(issued.value.credentialId),
          expiresAt: requestedExpiry,
        }),
      );
      return err(
        new DebuggenError(
          'INTERNAL',
          'The issued credential did not match the credential response schema.',
          {
            hint: 'Restart the Debug Generator service and request the credential again.',
            details: { reason: 'credential-response-invalid' },
          },
        ),
      );
    }

    const lease = new CredentialLease({
      projectRoot,
      token: issued.value.token,
      credentialId: nonEmpty(issued.value.credentialId),
      expiresAt: body.data.expiresAt,
    });
    if (this.#disposed) {
      // The shutdown began while the issuer answered: its release of the
      // supervised leases may already have run, so nothing would renew or
      // revoke this one. It is revoked instead of handed out.
      await this.#releaseCredential(lease);
      return err(shutdownError());
    }
    this.#superviseCliLease(lease);
    this.#log(
      'info',
      'Issued a server-agent credential for a dev server started outside the service',
      {
        projectRoot,
        expiresAt: body.data.expiresAt,
      },
    );
    return ok(body.data);
  }

  /**
   * The {@link DEV_SERVER_CREDENTIAL_PATH} credentials under supervision (see
   * {@link DEFAULT_CLI_CREDENTIAL_LEASE_MS}), each until it is revoked or found
   * gone. `stop`, `stopForSession` and `stopAll` never read it: this service
   * did not start those dev servers. {@link DevServerLauncher.dispose} revokes
   * every one still here.
   */
  readonly #cliLeases = new Map<CredentialLease, CliCredentialSupervision>();

  /** Start supervising a credential route lease; its first check runs one check interval from now. */
  #superviseCliLease(lease: CredentialLease): void {
    const supervision: CliCredentialSupervision = {
      lease,
      lastConnectedAt: undefined,
      renewFailures: 0,
      timer: undefined,
    };
    this.#cliLeases.set(lease, supervision);
    this.#scheduleCliLeaseCheck(supervision);
  }

  /**
   * Schedule the next check of a credential route lease. Nothing is scheduled
   * once the credential is being released or is gone, or after `dispose`
   * began — the shutdown releases every supervised lease itself.
   */
  #scheduleCliLeaseCheck(supervision: CliCredentialSupervision): void {
    const { lease } = supervision;
    if (this.#disposed || lease.releaseRequested || lease.invalidated) {
      return;
    }
    supervision.timer = this.#backgroundTimer(() => {
      supervision.timer = undefined;
      void this.#checkCliLease(supervision);
    }, this.#settings.cliCredentialCheckIntervalMs);
  }

  /**
   * One check of a credential route lease, then the next one scheduled — so
   * two checks of one lease never overlap, however long a renewal takes:
   *
   * - **Connected** (an online control connection authenticated with it): the
   *   connection is recorded, and the lease is renewed to one lease from now
   *   once at most two thirds of a lease remain — every
   *   {@link LEASE_RENEWALS_PER_LEASE}th of a lease, so two consecutive
   *   renewals may fail before it lapses under a running dev server.
   * - **Disconnected** after it had connected: revoked once the connection has
   *   been gone for the disconnect grace — the dev server exited.
   * - **Never connected**: revoked at the end of its first lease.
   * - **Lease over** whatever the connection (every renewal failed): revoked,
   *   or found lapsed.
   *
   * A connection view that is absent or throws counts as not connected.
   */
  async #checkCliLease(supervision: CliCredentialSupervision): Promise<void> {
    const { lease } = supervision;
    if (this.#disposed) {
      return;
    }
    if (lease.releaseRequested || lease.invalidated) {
      this.#forgetCliLease(supervision);
      return;
    }
    try {
      const now = this.#now();
      const leaseMs = this.#settings.cliCredentialLeaseMs;
      const renewEveryMs = Math.max(1, Math.floor(leaseMs / LEASE_RENEWALS_PER_LEASE));
      if (this.#isCliCredentialConnected(lease)) {
        supervision.lastConnectedAt = now;
        if (lease.expiresAt - now <= leaseMs - renewEveryMs) {
          const supervised = await this.#renewCliLease(supervision, now);
          // The renewal may have awaited the issuer: a shutdown that began
          // meanwhile releases this lease itself.
          if (!supervised || this.#disposed || lease.releaseRequested) {
            return;
          }
        }
      } else if (
        supervision.lastConnectedAt !== undefined &&
        now - supervision.lastConnectedAt >= this.#settings.cliCredentialDisconnectGraceMs
      ) {
        await this.#endCliLease(supervision, 'disconnected');
        return;
      }
      if (this.#now() >= lease.expiresAt) {
        await this.#endCliLease(
          supervision,
          supervision.lastConnectedAt === undefined ? 'never-connected' : 'lease-over',
        );
        return;
      }
    } catch (error) {
      this.#log(
        'warn',
        'Checking the credential lease of a dev server started outside the service failed; it is checked again',
        { projectRoot: lease.projectRoot, errorCode: errnoCodeOf(error) },
      );
    }
    this.#scheduleCliLeaseCheck(supervision);
  }

  /**
   * Whether an online `server-agent` control connection authenticated with
   * the lease's credential. `false` without a connection view, and when the
   * view throws (logged): no evidence of a running dev server.
   */
  #isCliCredentialConnected(lease: CredentialLease): boolean {
    const connections = this.#deps.serverAgentConnections;
    if (connections === undefined) {
      return false;
    }
    try {
      return connections.isCredentialConnected(lease.tokenHash);
    } catch (error) {
      this.#log(
        'warn',
        'Credential lease supervision could not read the connected server agents; the dev server counts as disconnected',
        { projectRoot: lease.projectRoot, errorCode: errnoCodeOf(error) },
      );
      return false;
    }
  }

  /**
   * Extend a credential route lease to one lease from `now`, with the outcome
   * handling a launched child's renewal has: `ok(true)` extends it; `ok(false)`
   * — revoked or rotated away — is final, so supervision ends without a
   * revocation; an `Err` or a throw is retried at the next check, and only
   * the first failure of a run is logged.
   *
   * @returns Whether the lease is still supervised.
   */
  async #renewCliLease(supervision: CliCredentialSupervision, now: number): Promise<boolean> {
    const { lease } = supervision;
    const expiresAt = Math.floor(now + this.#settings.cliCredentialLeaseMs);
    const input = lease.renewInput(expiresAt);
    if (input === undefined) {
      this.#forgetCliLease(supervision);
      return false;
    }

    let outcome: 'renewed' | 'gone' | 'failed';
    try {
      const result: unknown = await this.#deps.credentials.renew(input);
      outcome = isOkResultOf(result, true)
        ? 'renewed'
        : isOkResultOf(result, false)
          ? 'gone'
          : 'failed';
    } catch {
      outcome = 'failed';
    }

    if (outcome === 'renewed') {
      lease.expiresAt = Math.max(lease.expiresAt, expiresAt);
      supervision.renewFailures = 0;
      return true;
    }
    if (outcome === 'gone') {
      lease.lapse();
      this.#forgetCliLease(supervision);
      this.#log(
        'warn',
        "A dev server's server-agent credential no longer exists (revoked or rotated); its telemetry is refused until a new credential is requested",
        { projectRoot: lease.projectRoot },
      );
      return false;
    }
    supervision.renewFailures += 1;
    if (supervision.renewFailures === 1) {
      this.#log(
        'warn',
        'Renewing the credential lease of a dev server started outside the service failed; it is retried at every check',
        { projectRoot: lease.projectRoot, expiresAt: lease.expiresAt },
      );
    }
    return true;
  }

  /**
   * End a credential route lease: stop supervising it and revoke it through
   * {@link #releaseCredential}, whose retries take over a revocation the store
   * refuses until it succeeds or the lease lapses.
   */
  async #endCliLease(
    supervision: CliCredentialSupervision,
    cause: 'disconnected' | 'never-connected' | 'lease-over',
  ): Promise<void> {
    this.#forgetCliLease(supervision);
    const released = await this.#releaseCredential(supervision.lease);
    const because =
      cause === 'disconnected'
        ? 'its dev server disconnected'
        : cause === 'never-connected'
          ? 'no dev server connected with it during its first lease'
          : 'its lease ended without a renewal';
    this.#log(
      'info',
      `The server-agent credential of a dev server started outside the service is revoked: ${because}`,
      { projectRoot: supervision.lease.projectRoot, revocationPending: !released },
    );
  }

  /** Stop supervising a credential route lease: its check timer is cleared and it is forgotten. */
  #forgetCliLease(supervision: CliCredentialSupervision): void {
    this.#clearTimer(supervision.timer);
    supervision.timer = undefined;
    this.#cliLeases.delete(supervision.lease);
  }

  /**
   * Revoke every supervised credential route lease — the shutdown's step. A
   * revocation the store refuses joins the pending revocations, which the
   * shutdown's last sweep tries once more.
   */
  async #releaseCliLeases(): Promise<void> {
    const supervised = [...this.#cliLeases.values()];
    for (const supervision of supervised) {
      this.#forgetCliLease(supervision);
    }
    await Promise.allSettled(
      supervised.map((supervision) => this.#releaseCredential(supervision.lease)),
    );
  }

  // -------------------------------------------------------------------------
  // Ports, cancellation and logging
  // -------------------------------------------------------------------------

  /** Ask the issuer for a credential; any throw or malformed answer becomes a typed `Err`. */
  async #issue(
    input: ServerAgentCredentialIssueInput,
  ): Promise<Result<ServerAgentCredential, DebuggenError>> {
    let result: Result<ServerAgentCredential, DebuggenError>;
    try {
      result = await this.#deps.credentials.issue(input);
    } catch (error) {
      this.#log('error', 'Issuing a server-agent credential failed', {
        projectRoot: input.projectRoot,
        errorCode: errnoCodeOf(error),
      });
      return err(
        new DebuggenError('STORE_ERROR', 'A server-agent credential could not be issued.', {
          hint: 'The service log holds the reason. Restart the Debug Generator service and try again.',
          details: { reason: 'credential-issue-failed' },
          cause: error,
        }),
      );
    }
    if (isErr(result)) {
      this.#log('warn', 'The access boundary refused to issue a server-agent credential', {
        projectRoot: input.projectRoot,
        code: result.error.code,
      });
      return result;
    }
    const token: unknown = result.value.token;
    if (typeof token !== 'string' || token.trim().length === 0) {
      return err(
        new DebuggenError(
          'INTERNAL',
          'The access boundary issued an empty server-agent credential.',
          {
            hint: 'Restart the Debug Generator service and try again.',
            details: { reason: 'credential-empty' },
          },
        ),
      );
    }
    return result;
  }

  /**
   * One revocation attempt through the issuer. Never throws, and logs (without
   * the token) when it could not revoke.
   *
   * @returns `true` once the credential no longer authenticates.
   */
  async #revoke(input: ServerAgentCredentialRevokeInput): Promise<boolean> {
    try {
      const outcome = await this.#deps.credentials.revoke(input);
      if (isErrResult(outcome)) {
        this.#log('warn', 'A server-agent credential could not be revoked; it will be retried', {
          projectRoot: input.projectRoot,
        });
        return false;
      }
      return true;
    } catch (error) {
      this.#log('warn', 'Revoking a server-agent credential failed; it will be retried', {
        projectRoot: input.projectRoot,
        errorCode: errnoCodeOf(error),
      });
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // Credential leases: renewal while a child runs, revocation until it holds
  // -------------------------------------------------------------------------

  /**
   * Invalidate a credential: stop renewing its lease and revoke it. A
   * revocation that fails is retried in the background with backoff until it
   * succeeds or the lease lapses, so the credential stops authenticating
   * within one lease whatever the store does. Shared by every path that ends
   * a child (exit, stop, session end, shutdown, a failed start) and by an
   * unused credential; concurrent callers share one attempt.
   *
   * @returns `true` once the credential no longer authenticates; `false` while
   *   its revocation is still pending.
   */
  async #releaseCredential(lease: CredentialLease): Promise<boolean> {
    lease.releaseRequested = true;
    this.#clearTimer(lease.renewalTimer);
    lease.renewalTimer = undefined;

    const revoked = await lease.revoke((input) => this.#revoke(input));
    if (revoked) {
      this.#settleRevocation(lease);
      return true;
    }
    if (this.#now() >= lease.expiresAt) {
      // The access boundary refuses an expired credential on its own.
      lease.lapse();
      this.#settleRevocation(lease);
      this.#log('info', 'A server-agent credential whose revocation failed has lapsed', {
        projectRoot: lease.projectRoot,
      });
      return true;
    }
    this.#scheduleRevocationRetry(lease);
    return false;
  }

  /** A credential no longer authenticates: forget its retry. */
  #settleRevocation(lease: CredentialLease): void {
    this.#clearTimer(lease.retryTimer);
    lease.retryTimer = undefined;
    this.#pendingRevocations.delete(lease);
  }

  /**
   * Retry a failed revocation after the lease's current backoff (doubling from
   * {@link REVOCATION_RETRY_INITIAL_MS} to {@link REVOCATION_RETRY_MAX_MS}),
   * never later than the lease's expiry — the attempt at the expiry either
   * revokes the credential or finds it lapsed. After `dispose` nothing is
   * scheduled: the shutdown sweep made the last attempt, and the lease bounds
   * the rest.
   */
  #scheduleRevocationRetry(lease: CredentialLease): void {
    this.#pendingRevocations.add(lease);
    if (lease.retryTimer !== undefined || this.#disposed) {
      return;
    }
    const untilLapse = Math.max(1, lease.expiresAt - this.#now());
    const delay = Math.min(lease.retryDelayMs, untilLapse);
    lease.retryDelayMs = Math.min(lease.retryDelayMs * 2, REVOCATION_RETRY_MAX_MS);
    lease.retryTimer = this.#backgroundTimer(() => {
      lease.retryTimer = undefined;
      void this.#releaseCredential(lease);
    }, delay);
  }

  /**
   * Schedule the next renewal of a running child's lease, a
   * {@link LEASE_RENEWALS_PER_LEASE}th of the lease from now. Nothing is
   * scheduled once the credential is being released or is gone.
   */
  #scheduleRenewal(lease: CredentialLease): void {
    if (lease.releaseRequested || lease.invalidated || this.#disposed) {
      return;
    }
    const interval = Math.max(1, Math.floor(this.#settings.leaseMs / LEASE_RENEWALS_PER_LEASE));
    lease.renewalTimer = this.#backgroundTimer(() => {
      lease.renewalTimer = undefined;
      void this.#renew(lease);
    }, interval);
  }

  /**
   * Extend a running child's lease by one lease from now. A failed renewal is
   * logged and retried at the next interval — two may fail before the lease
   * lapses. A credential the access boundary no longer holds (revoked, or
   * rotated away with every other credential) is final: renewal stops and the
   * child's telemetry is refused until the dev server is launched again.
   */
  async #renew(lease: CredentialLease): Promise<void> {
    if (lease.releaseRequested) {
      return;
    }
    const expiresAt = Math.floor(this.#now() + this.#settings.leaseMs);
    const input = lease.renewInput(expiresAt);
    if (input === undefined) {
      return;
    }

    let outcome: 'renewed' | 'gone' | 'failed';
    try {
      const result: unknown = await this.#deps.credentials.renew(input);
      outcome = isOkResultOf(result, true)
        ? 'renewed'
        : isOkResultOf(result, false)
          ? 'gone'
          : 'failed';
    } catch {
      outcome = 'failed';
    }

    if (outcome === 'renewed') {
      lease.expiresAt = Math.max(lease.expiresAt, expiresAt);
    } else if (outcome === 'gone') {
      lease.lapse();
      this.#log(
        'warn',
        "A launched dev server's credential no longer exists (revoked or rotated); its telemetry is refused until the dev server is launched again",
        { projectRoot: lease.projectRoot },
      );
      return;
    } else {
      this.#log('warn', "Renewing a launched dev server's credential lease failed; it is retried", {
        projectRoot: lease.projectRoot,
        expiresAt: lease.expiresAt,
      });
    }
    this.#scheduleRenewal(lease);
  }

  /** A timer that never keeps the service process alive on its own. */
  #backgroundTimer(callback: () => void, ms: number): ScheduledTimer {
    const handle = this.#setTimeout(callback, ms);
    unrefTimer(handle);
    return { handle };
  }

  /** Cancel a timer this launcher scheduled, when there is one. */
  #clearTimer(timer: ScheduledTimer | undefined): void {
    if (timer !== undefined) {
      this.#clearTimeout(timer.handle);
    }
  }

  #ticket(key: string, sessionId: string | undefined): LaunchTicket {
    return {
      key,
      sessionId,
      globalGeneration: this.#globalGeneration,
      keyGeneration: this.#keyGenerations.get(key) ?? 0,
    };
  }

  /** Whether a stop, a shutdown or the end of the launching session overtook a launch. */
  #isCancelled(ticket: LaunchTicket): boolean {
    return (
      this.#disposed ||
      this.#globalGeneration !== ticket.globalGeneration ||
      (this.#keyGenerations.get(ticket.key) ?? 0) !== ticket.keyGeneration ||
      (ticket.sessionId !== undefined && this.#endedSessions.has(ticket.sessionId))
    );
  }

  #rememberEndedSession(sessionId: string): void {
    this.#endedSessions.add(sessionId);
    if (this.#endedSessions.size > MAX_ENDED_SESSIONS) {
      const oldest = this.#endedSessions.values().next();
      if (oldest.done !== true) {
        this.#endedSessions.delete(oldest.value);
      }
    }
  }

  /**
   * Log through the subsystem logger. Best-effort by construction, with no
   * local `catch`: the logger was guarded when the launcher was built, so a
   * failing write never throws into a launch or a stop and is counted and
   * announced by the guard's fallback notice instead of being dropped unseen.
   */
  #log(level: 'info' | 'warn' | 'error', message: string, fields: Record<string, unknown>): void {
    this.#logger[level](message, fields);
  }
}

// ---------------------------------------------------------------------------
// Module helpers
// ---------------------------------------------------------------------------

/** A command resolved for `spawn`, with the script it came from, if any. */
interface ResolvedCommand extends ParsedLaunchCommand {
  /**
   * The `package.json` script a package-manager run starts — the detected dev
   * script, or the one a request's accepted `pnpm run <script>` names;
   * `undefined` for the framework-CLI forms.
   */
  readonly script: string | undefined;
}

/** Exactly what one launch hands `spawn`: executable, arguments and quoting mode. */
interface SpawnInvocation {
  readonly command: string;
  readonly args: readonly string[];
  /** `true` only for the pre-quoted Windows `cmd.exe` line. */
  readonly windowsVerbatimArguments: boolean;
}

/** A trimmed non-empty string, or `undefined`. */
function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed.length === 0 ? undefined : trimmed;
}

/**
 * The origin of a dev-server URL, or `undefined` when there is none or it does
 * not parse. Two spellings of one dev server (`http://127.0.0.1:3000` and
 * `http://127.0.0.1:3000/`) have one origin, which is also what a tab binds by.
 */
function urlOrigin(url: string | undefined): string | undefined {
  const value = nonEmpty(url);
  if (value === undefined) {
    return undefined;
  }
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
}

/**
 * The targets of one readiness round: every candidate not refused, in
 * announcement order, then the requested URL — unless it was refused, or it
 * names exactly a candidate (compared in the probe's origin-and-pathname
 * form), which is then probed once, as the candidate.
 */
function readyTargetsOf(
  candidates: readonly string[],
  requestedUrl: string | undefined,
  refused: ReadonlySet<string>,
): ReadyTarget[] {
  const targets: ReadyTarget[] = candidates
    .filter((url) => !refused.has(url))
    .map((url) => ({ url, announced: true }));
  if (
    requestedUrl !== undefined &&
    !refused.has(requestedUrl) &&
    !candidates.includes(probeFormOf(requestedUrl) ?? requestedUrl)
  ) {
    targets.push({ url: requestedUrl, announced: false });
  }
  return targets;
}

/** A URL as the probe records it — origin and pathname — or `undefined` when it does not parse. */
function probeFormOf(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return undefined;
  }
}

/** A URL reduced to `origin/`, the only form readiness diagnostics carry; the input when it does not parse. */
function originFormOf(url: string): string {
  try {
    return `${new URL(url).origin}/`;
  } catch {
    return url;
  }
}

/**
 * The TCP port an `http:`/`https:` URL is served on: its explicit port, else
 * `80` or `443` by scheme; `undefined` for anything else or a URL that does
 * not parse.
 */
function listeningPortOf(url: string): number | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  const port =
    parsed.port !== ''
      ? Number(parsed.port)
      : parsed.protocol === 'http:'
        ? 80
        : parsed.protocol === 'https:'
          ? 443
          : undefined;
  return isTcpPort(port) ? port : undefined;
}

/** The `reason` a failed start's termination is logged with. */
function terminationReasonOf(outcome: ReadyOutcome): string {
  switch (outcome.kind) {
    case 'timeout':
      return 'ready-timeout';
    case 'unverified':
      return 'ready-unverified';
    case 'ready':
    case 'exited':
    case 'spawn-error':
      return 'startup-failed';
    default:
      return assertNever(outcome);
  }
}

/** An environment's string-valued entries. */
function stringEnvironment(env: ParentEnvironment): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
}

/**
 * The environment a listener-ownership lookup tool (`lsof`, `ps`,
 * PowerShell) runs with: only the service variables
 * {@link isForwardedToDevServer} admits — the platform runtime, toolchain and
 * terminal names such a tool may read — so a service credential such as
 * `ANTHROPIC_API_KEY` never reaches another process just to ask which one
 * holds a port.
 */
function lookupEnvironment(
  env: ParentEnvironment,
  platform: NodeJS.Platform,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter(
      (entry): entry is [string, string] =>
        typeof entry[1] === 'string' && isForwardedToDevServer(entry[0], platform),
    ),
  );
}

/** The refusal of a launch or credential after {@link DevServerLauncher.dispose}. */
function shutdownError(): DebuggenError {
  return new DebuggenError(
    'DEV_SERVER_LAUNCH_FAILED',
    'The Debug Generator service is shutting down, so no dev server was launched.',
    {
      hint: 'Start the Debug Generator service again, then launch the dev server.',
      details: { reason: 'shutting-down' },
    },
  );
}

/** A launch overtaken by a stop, the end of its session or a shutdown. */
function cancelledError(): DebuggenError {
  return new DebuggenError(
    'DEV_SERVER_LAUNCH_FAILED',
    'The dev-server launch was cancelled: it was stopped, its session ended or the service is shutting down.',
    {
      hint: 'Launch the dev server again when you need it.',
      details: { reason: 'cancelled' },
    },
  );
}

/**
 * A stop that ended its children but could not yet revoke every credential
 * they held. Reported as incomplete cleanup rather than a clean stop; the
 * revocation keeps being retried, and each credential lapses with its lease at
 * the latest — the moment named in the hint.
 */
function revocationPendingError(pending: readonly CredentialLease[]): DebuggenError {
  const lapsesAt = Math.max(...pending.map((lease) => lease.expiresAt));
  return new DebuggenError(
    'CLEANUP_PARTIAL',
    'The dev server was stopped, but its ingest credential could not be revoked yet.',
    {
      hint: `Debug Generator keeps retrying the revocation; the credential stops working on its own by ${new Date(lapsesAt).toISOString()} at the latest. The service log holds the reason.`,
      details: { reason: 'credential-revocation-pending', pending: pending.length, lapsesAt },
    },
  );
}

/**
 * A stop, a relaunch or a failed start that ended with launched dev servers
 * still running (see {@link DevServerSurvivor}). Fixed product copy; the hint
 * names only the pids, and `details` carries closed fields: `reason`, the
 * first survivor's `pid`, every surviving pid (`pids`) and the refused signal
 * deliveries summed across them (`signalFailures`).
 */
function survivedTerminationError(survivors: NonEmptyList<DevServerSurvivor>): DebuggenError {
  const [first] = survivors;
  const pids = survivors.map((survivor) => survivor.pid);
  const signalFailures = survivors.reduce((sum, survivor) => sum + survivor.signalFailures, 0);
  const named = pids.map((pid) => String(pid)).join(', ');
  return new DebuggenError('DEV_SERVER_LAUNCH_FAILED', 'The launched dev server did not stop.', {
    hint: `The dev server (pid ${named}) was still running after the service sent it SIGTERM and then SIGKILL. End it from its terminal or the system's process manager; until it exits the service lists it and tries to stop it again on the next stop, launch or shutdown.`,
    details: { reason: 'survived-termination', pid: first.pid, pids, signalFailures },
  });
}

/** A command that could not be started at all. */
function spawnFailedError(
  file: string,
  errorCode: string | undefined,
  output: DevServerOutputSummary,
  cause?: unknown,
): DebuggenError {
  const name = executableName(file);
  const hint =
    errorCode === 'ENOENT'
      ? `"${name}" was not found on the PATH the service passes to the dev server. Install it, or launch with an explicit command that names an installed executable.`
      : errorCode === 'EACCES'
        ? `"${name}" is not executable. Check its permissions, or launch with a different command.`
        : 'The service log holds the reason. Check the command, or start the dev server by hand with the relaunch command.';
  return new DebuggenError(
    'DEV_SERVER_LAUNCH_FAILED',
    `The dev-server command "${name}" could not be started.`,
    {
      hint: withOutputDigest(hint, output),
      details: {
        reason: 'spawn-failed',
        ...(errorCode === undefined ? {} : { errorCode }),
        output: outputDetails(output),
      },
      ...(cause === undefined ? {} : { cause }),
    },
  );
}

/**
 * A startup failure's hint: the constant hint, then one fixed sentence per
 * diagnostic the child's output reported, then — when it printed anything —
 * {@link FULL_OUTPUT_SENTENCE}. Nothing the child printed is quoted, so the
 * hint is safe to forward to an editor notification verbatim.
 */
function withOutputDigest(hint: string, output: DevServerOutputSummary): string {
  const sentences = output.diagnostics.map((id) => OUTPUT_DIAGNOSTIC_SENTENCES[id]);
  if (output.stdoutLines + output.stderrLines > 0) {
    sentences.push(FULL_OUTPUT_SENTENCE);
  }
  return sentences.length === 0 ? hint : `${hint} ${sentences.join(' ')}`;
}

/**
 * The `details.output` of a startup failure: the per-stream line counts and
 * the diagnostic ids — exactly these three keys, and no character of output.
 */
function outputDetails(output: DevServerOutputSummary): {
  readonly stdoutLines: number;
  readonly stderrLines: number;
  readonly diagnostics: DevServerOutputDiagnostic[];
} {
  return {
    stdoutLines: output.stdoutLines,
    stderrLines: output.stderrLines,
    diagnostics: [...output.diagnostics],
  };
}

/**
 * The default {@link SpawnLike}: `child_process.spawn` with the fixed stdio
 * layout, never a shell (which also keeps clear of Node's DEP0190 for
 * arguments passed with `shell: true`), and the verbatim-argument mode the
 * launcher chose.
 */
const defaultSpawn: SpawnLike = (command, args, options) =>
  nodeSpawn(command, [...args], {
    cwd: options.cwd,
    env: { ...options.env },
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
    windowsVerbatimArguments: options.windowsVerbatimArguments,
    windowsHide: options.windowsHide,
    detached: options.detached,
  });

/** The default {@link ListenerOwnershipFs}: `node:fs/promises`, text as UTF-8. */
const defaultOwnershipFs: ListenerOwnershipFs = Object.freeze({
  readFile: (path: string): Promise<string> => readFile(path, 'utf8'),
  readdir: (path: string): Promise<readonly string[]> => readdir(path),
  readlink: (path: string): Promise<string> => readlink(path),
});

/** The default synchronous reader of {@link ProcessGroupInspectorOptions}: `fs.readFileSync` as UTF-8. */
function defaultReadFileSync(path: string): string {
  return readFileSync(path, 'utf8');
}

/**
 * The default {@link ListenerOwnershipRunCommand}: `execFile` with no shell,
 * no window, the timeout (then `SIGKILL`) and a bounded output buffer. It
 * always resolves: a command that cannot start, is killed or overflows its
 * buffer reports `exitCode: null`. Its output is handed to the parser only.
 */
const defaultRunCommand: ListenerOwnershipRunCommand = (file, args, options) =>
  new Promise<ListenerOwnershipCommandOutcome>((resolve) => {
    try {
      execFile(
        file,
        [...args],
        {
          shell: false,
          windowsHide: true,
          timeout: options.timeoutMs,
          killSignal: 'SIGKILL',
          maxBuffer: MAX_LOOKUP_OUTPUT_BYTES,
          env: { ...options.env },
          encoding: 'utf8',
        },
        (error, stdout) => {
          const text = typeof stdout === 'string' ? stdout : '';
          if (error === null) {
            resolve({ exitCode: 0, stdout: text, timedOut: false });
            return;
          }
          resolve({
            exitCode: typeof error.code === 'number' ? error.code : null,
            stdout: text,
            timedOut: error.killed === true,
          });
        },
      );
    } catch {
      // execFile throws synchronously only for invalid arguments; that is
      // a lookup that could not run.
      resolve({ exitCode: null, stdout: '', timedOut: false });
    }
  });

/** The default {@link SignalProcessGroup}: a negative pid addresses the group. */
const defaultSignalProcessGroup: SignalProcessGroup = (pid, signal) => {
  process.kill(-pid, signal);
};

/** The default timers. */
const defaultSetTimeout: SetTimeoutLike = (callback, ms) => setTimeout(callback, ms);
const defaultClearTimeout: ClearTimeoutLike = (handle) => {
  if (isNodeTimeout(handle)) {
    clearTimeout(handle);
  }
};

/** Whether a handle is a Node timer, as the default {@link SetTimeoutLike} returns. */
function isNodeTimeout(handle: unknown): handle is NodeJS.Timeout {
  return (
    typeof handle === 'object' &&
    handle !== null &&
    'hasRef' in handle &&
    'refresh' in handle &&
    typeof handle.refresh === 'function'
  );
}
