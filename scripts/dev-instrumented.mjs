#!/usr/bin/env node
/**
 * dev-instrumented — start a development server with the Node telemetry
 * preload attached, from the command line.
 *
 * The product path for this is the local service's own launcher,
 * `apps/local-service/src/dev-server/launcher.ts` (with
 * `src/dev-server/detect.ts`): a session asks the service to start the target
 * project, the service detects an already-running server, reads the target's
 * package manager and scripts, spawns it with the preload, mints the
 * process-scoped credential and ties the child's lifetime to the session.
 *
 * This script is the *CLI equivalent* of that launcher for a developer who
 * wants the instrumented dev server from a terminal — and nothing more. It has
 * two modes:
 *
 *   default          ask the service to launch the project through its own
 *                    launcher (`POST /dev-server/launch`), report the dev
 *                    server URL and pid it answers with, and stay in the
 *                    foreground so Ctrl-C stops that server again
 *                    (`POST /dev-server/stop`). The service owns that process
 *                    and the server-agent credential it mints for it, and
 *                    revokes the credential when the process exits.
 *   --spawn-local    spawn the project's own `dev` script from this terminal
 *                    with the preload attached and a server-agent credential
 *                    the service minted for it: this command asks
 *                    `POST /dev-server/credential` for one scoped to the
 *                    project root, authorised by the editor credential, and
 *                    hands it to the child as `DEBUGGEN_TOKEN`.
 *                    The mode therefore needs the running service and
 *                    `$DEBUGGEN_HOME/auth.json`, and any failure to obtain the
 *                    credential stops the command before anything is spawned —
 *                    without one the preload stays inert and records nothing
 *                    (`packages/telemetry/src/node/config.ts`), so starting the
 *                    server anyway would only look instrumented. Once the
 *                    dev server has exited — on its own, through a forwarded
 *                    Ctrl-C or SIGTERM, or because it could not be started —
 *                    this command releases the credential
 *                    (`POST /credentials/release`); the service supervises it
 *                    as a lease as well, and revokes it shortly after the dev
 *                    server exits when that release does not happen
 *                    (WHY THE CREDENTIAL MATTERS below).
 *
 * `--detach` returns as soon as the service has reported the launch instead of
 * waiting for Ctrl-C, and `--stop` stops a dev server the service launched for
 * the project — the two halves of the default mode, available separately for
 * scripts and for a terminal that has since been closed.
 *
 * ROUTES — THE CONTRACT IS NOT NEGOTIABLE HERE: this file is a *caller*. The
 * routes it may use are the ones the service defines, and
 * {@link SERVICE_ROUTES} is the whole list, every one of them a row of the
 * protocol's route table (`HTTP_ROUTES` in `packages/protocol/src/http.ts`):
 * `GET /health`, `POST /dev-server/launch`, `POST /dev-server/stop`,
 * `POST /dev-server/credential` (which the service's launcher reads off that
 * row as `DEV_SERVER_CREDENTIAL_PATH` in
 * `apps/local-service/src/dev-server/launcher.ts`, and
 * `apps/local-service/src/server/routes/dev-server.ts` registers), and
 * `POST /credentials/release` (operation `credentials.release`, editor
 * credential required). There is
 * deliberately no route-name guessing, no probe list and no environment
 * override that points at a different path: a caller that invents an endpoint
 * the service does not define cannot work against the specified service, and
 * an override would only hide that. A new route is added to its definer first
 * and named here second — in that order.
 *
 * SERVICE IDENTITY — PROVED BEFORE ANY CREDENTIAL IS SENT: any local process
 * can listen on the service's port and answer `GET /health` with a 200, so a
 * 2xx says nothing about who is listening. Every mode therefore sends the
 * health probe with a fresh random challenge
 * ({@link SERVICE_IDENTITY_CHALLENGE_HEADER}) and requires the answer to carry
 * an HMAC-SHA256 proof, keyed by the editor credential, over that challenge and
 * the `host:port` the listener is bound to
 * ({@link SERVICE_IDENTITY_PROOF_HEADER}, {@link SERVICE_IDENTITY_ENDPOINT_HEADER},
 * {@link computeServiceIdentityProof}). Only the service holding the same
 * editor credential can compute it, the challenge is never reused, and the
 * bound endpoint must be the IP address and port this command dialled, so a
 * proof relayed from a service on another port or address is refused. A host
 * name is never dialled for this: `localhost` is resolved here, each loopback
 * address it stands for is probed, and every later request of the run goes to
 * the address that proved the service ({@link checkServiceHealth}). The probe
 * itself carries no credential; until the proof checks out nothing else is
 * sent.
 *
 * BOUNDARY — deliberately NOT implemented here, because the service owns it:
 *   - detecting an already-running dev server, probing ports or URLs;
 *   - retry/backoff, health polling or waiting for the server to be listening;
 *   - session creation, tab binding or any session bookkeeping;
 *   - minting, hashing, storing, refreshing or revoking credentials — the
 *     service mints the one `--spawn-local` asks for and revokes it, and this
 *     script only passes it to the child it spawns and, once that child is
 *     gone, asks the service to release it: one request, never retried;
 *   - reading, parsing or forwarding `.env` files — the child does its own.
 * If you are about to add any of the above, add it to the launcher instead and
 * let this script keep being a thin wrapper.
 *
 * CHILD ENVIRONMENT: a `--spawn-local` child inherits a minimal environment,
 * never a copy of this terminal's — the target project and every dependency
 * it loads run inside it, and a developer's terminal routinely holds
 * `ANTHROPIC_API_KEY`, cloud keys and `GITHUB_TOKEN`. It receives the
 * allowlisted variables of {@link CHILD_ENV_ALLOWLIST} (the service
 * launcher's list, mirrored), the variables this run is explicitly given with
 * `--env NAME` or `--env NAME=value`, and the four preload variables, which
 * this command sets and never forwards ({@link buildChildEnv}).
 *
 * WHY THE PRELOAD MATTERS: server-tier spans exist only because a tracer
 * provider is registered *inside* the dev-server process before the framework
 * starts, which happens only when `--import <preload>` is present in
 * `NODE_OPTIONS`. The target project's source is never modified for this
 * signal. An inherited `NODE_OPTIONS` is therefore appended to, never
 * replaced: developers commonly set it, and clobbering it would break their
 * environment in a way that looks like a bug in this tool.
 *
 * WHY THE CREDENTIAL MATTERS: the service accepts telemetry ingest only from a
 * server-agent credential scoped to one project root, and the
 * preload installs nothing without one. The service is the only component that
 * mints it, in one of two ways, both authorised by the editor credential it
 * wrote to `$DEBUGGEN_HOME/auth.json`:
 *   - the default mode lets the launcher start the project; the launcher mints
 *     the credential, passes it to its own child and revokes it when that child
 *     exits, so this script never sees it;
 *   - `--spawn-local` asks `POST /dev-server/credential` for one scoped to the
 *     project root. The answer is `{ token, expiresAt }`, where `expiresAt`
 *     ends a first lease of 5 minutes. The service cannot observe a process
 *     this command starts, so it ties the credential to what it can observe —
 *     the preload's server-agent control connection, which the dev server
 *     holds for as long as it runs. It renews the lease while that connection
 *     is open, revokes the credential once the connection has been gone for 20
 *     seconds (the dev server exited, Ctrl-C included) or when the service
 *     shuts down, and revokes it at the end of the first lease when no preload
 *     ever connected with it. A lease nothing renews any more — the service
 *     crashed — lapses within 5 minutes of its last renewal.
 *     `debuggen.rotateServiceToken` revokes it at once. That supervision is
 *     the fallback: this command does not wait for it. The moment nothing
 *     will use the credential any more — the child exited, on its own or
 *     through a forwarded signal, or could not be spawned, or a step after
 *     the mint failed before the spawn — it asks
 *     `POST /credentials/release` with `{ token }`, authorised by the editor
 *     credential, and the service revokes the credential then
 *     (`{ released: true }`) or reports that nothing was live under it any
 *     more (`{ released: false }`, equally a success). A release that fails or
 *     is skipped is a warning, never a change to the exit status, and the
 *     supervision above still ends the credential.
 * Either way the child receives `DEBUGGEN_TOKEN` together with a matching
 * `DEBUGGEN_PROJECT_ROOT` and the `DEBUGGEN_INGEST_URL` endpoint.
 *
 * SAFETY: the editor credential is sent only as a bearer token, only to a
 * loopback address, and only after the listener there has proved it is the
 * service holding that same credential (SERVICE IDENTITY above); the foreground
 * mode repeats the proof before its closing stop request, and `--spawn-local`
 * before its closing release request, because the listener on the port may
 * have changed while the dev server ran. Every answer is read under the
 * {@link RESPONSE_MAX_BYTES} cap, so an oversized reply is discarded rather
 * than buffered. The server-agent credential is held only in this process's
 * memory and in the child's environment, and it leaves this process once more
 * only as the body of that release request, to the listener that has just
 * proved again that it is the service. This command never prints, logs or
 * writes either credential: both are redacted out of every part of a service
 * error it echoes (the status phrase included), a credential or release
 * response is never echoed at all, and the banner describes the server-agent
 * credential by its length only. This script writes nothing anywhere: it only
 * reads, requests and spawns, and once the child has exited it sends two
 * requests more and nothing else: the identity probe, then — only when that
 * proof holds — the one release request.
 *
 * The child's own output is deliberately NOT filtered: it inherits this
 * terminal (`stdio: 'inherit'`) so the dev server keeps its colours, its TTY
 * detection and its keyboard shortcuts, exactly as a plain `pnpm dev` would.
 * A dev script that prints its own environment therefore prints
 * `DEBUGGEN_TOKEN` along with everything else in it, to the developer's own
 * terminal — output the dev server owns, not this command. (The service's
 * launcher scrubs child output because it copies that output into the service
 * log, a file; nothing here copies it anywhere.)
 *
 * Usage: `node scripts/dev-instrumented.mjs [options]`, `pnpm demo:instrumented`,
 * or `--help`.
 *
 * @module scripts/dev-instrumented
 */

import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns/promises';
import fs from 'node:fs';
import { isIP } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL, URL } from 'node:url';
import { TextDecoder } from 'node:util';

/**
 * Repository root, derived from this module's own location rather than from
 * `process.cwd()`: the script is run from the root by `pnpm demo:instrumented`,
 * but also directly from a workspace directory, and the preload path must
 * resolve identically either way.
 *
 * @type {string}
 */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Repository-relative path of the Node preload, emitted by
 * `packages/telemetry/esbuild.node.mjs` and published by that package as its
 * `./node/register` export.
 */
export const PRELOAD_REL = 'packages/telemetry/dist/node/register.mjs';

/** The one command that produces {@link PRELOAD_REL}. */
export const PRELOAD_BUILD_COMMAND = 'pnpm --filter @debuggen/telemetry build';

/** Repository-relative default target project: the bundled demo application. */
export const DEFAULT_PROJECT_REL = 'apps/demo-app';

/** Service host used when `DEBUGGEN_HOST` is unset. Matches `.env.example`. */
export const DEFAULT_SERVICE_HOST = '127.0.0.1';

/** Service port used when `DEBUGGEN_PORT` is unset. Matches `.env.example`. */
export const DEFAULT_SERVICE_PORT = '43117';

/** Session home used when `DEBUGGEN_HOME` is unset. Matches `.env.example`. */
export const DEFAULT_DEBUGGEN_HOME = '~/.debuggen';

/** File inside `$DEBUGGEN_HOME` holding the editor credential (mode 0600). */
export const AUTH_FILE_NAME = 'auth.json';

/**
 * Unauthenticated liveness route on the service. This command sends it the
 * identity challenge below and requires the proof in the answer before it
 * sends anything that carries a credential.
 */
export const HEALTH_PATH = '/health';

/**
 * Request header of `GET /health` carrying the identity challenge: the
 * unpadded base64url form of {@link SERVICE_IDENTITY_CHALLENGE_BYTES} random
 * bytes (43 characters), fresh for every probe.
 */
export const SERVICE_IDENTITY_CHALLENGE_HEADER = 'X-Debuggen-Identity-Challenge';

/**
 * Response header carrying the identity proof: the unpadded base64url
 * HMAC-SHA256 that {@link computeServiceIdentityProof} defines.
 */
export const SERVICE_IDENTITY_PROOF_HEADER = 'X-Debuggen-Identity-Proof';

/**
 * Response header naming the endpoint the answering service is bound to, as
 * `host:port` with an IPv6 host bracketed (`127.0.0.1:43117`, `[::1]:43117`).
 * The proof covers it, so a proof relayed from a service on another address
 * names that other address and is refused.
 */
export const SERVICE_IDENTITY_ENDPOINT_HEADER = 'X-Debuggen-Identity-Endpoint';

/**
 * Domain-separation label that opens the proven message, so an HMAC made with
 * the editor credential for any other purpose can never pass as an identity
 * proof. The `v1` names this message layout.
 */
export const SERVICE_IDENTITY_PROOF_LABEL = 'debuggen-service-identity/v1';

/** Random bytes in one identity challenge: 256 bits, never reused. */
export const SERVICE_IDENTITY_CHALLENGE_BYTES = 32;

/**
 * Telemetry ingest route the preload posts batches to. Named here only because
 * it is the value of `DEBUGGEN_INGEST_URL` handed to a locally spawned child;
 * this script never posts to it.
 */
export const INGEST_PATH = '/telemetry/ingest';

/**
 * The service's launcher route (`POST /dev-server/launch`,
 * `{ projectRoot, command? }` → `{ devServerUrl, pid }`). The default mode
 * calls exactly this route: the service starts an instrumented dev server,
 * mints its project-scoped server-agent credential and revokes that credential
 * when the process exits.
 */
export const LAUNCH_PATH = '/dev-server/launch';

/**
 * The service's counterpart stop route (`POST /dev-server/stop`),
 * called with the same `{ projectRoot }` when the foreground run is
 * interrupted or `--stop` is passed.
 */
export const STOP_PATH = '/dev-server/stop';

/**
 * The service's server-agent credential route: `POST /dev-server/credential`,
 * `{ projectRoot }` → `{ token, expiresAt }`, editor credential required, for a
 * dev server the caller starts itself. `--spawn-local` calls
 * exactly this route and hands the answer's `token` to its child as
 * `DEBUGGEN_TOKEN`.
 *
 * It is the protocol route table's `devServer.credential` row, with both
 * strict body schemas (`devServerCredentialRequestSchema`,
 * `devServerCredentialResponseSchema`) beside it in
 * `packages/protocol/src/http.ts`; the service's launcher reads the path off
 * that row as `DEV_SERVER_CREDENTIAL_PATH`
 * (`apps/local-service/src/dev-server/launcher.ts`), and
 * `apps/local-service/src/server/routes/dev-server.ts` registers it behind the
 * editor-only bearer check. The service answers 403 when `projectRoot` is
 * outside the workspace folders the connected editor announced.
 *
 * A credential minted here is a lease the service supervises, and this script
 * never renews it: `expiresAt` ends a first lease of 5 minutes, which the
 * service renews while the dev server's preload holds its server-agent control
 * connection. Once the dev server has exited, `--spawn-local` releases the
 * credential through {@link RELEASE_PATH}. Should that release fail or be
 * skipped, the service still revokes the credential once that connection has
 * been gone for 20 seconds, at the end of the first lease when no preload ever
 * connected with it, and when the service shuts down; a lease nothing renews
 * lapses within 5 minutes of its last renewal, and
 * `debuggen.rotateServiceToken` revokes every credential at once.
 */
export const CREDENTIAL_PATH = '/dev-server/credential';

/**
 * The service's credential release route: `POST /credentials/release`
 * (protocol operation `credentials.release`), `{ token }` →
 * `{ released: boolean }`, editor credential required. `--spawn-local` calls
 * exactly this route, once, when the server-agent credential it obtained from
 * {@link CREDENTIAL_PATH} has no further use — its dev server exited, or could
 * not be spawned — so the credential stops working then rather than when the
 * service's lease supervision catches up with it.
 *
 * `{ released: true }` means the service revoked the credential on this
 * request; `{ released: false }` means this request released nothing. The
 * flag reports what the request did, not the state of the token: in general a
 * `false` is no proof that a token stops authenticating, since the service
 * answers it for a dev server it launched itself, whose credential stays live.
 * The token this command sends is never such a credential — it is the one
 * {@link CREDENTIAL_PATH} minted — so for it `false` means nothing was live
 * under it any more (the service's supervision had already revoked it, its
 * lease lapsed, or a rotation retired it), which is an equally successful
 * outcome. The answer is strict: any other body is off-contract. 401 and 403
 * mean the editor credential was refused, 404 and 405 a service older than
 * this checkout, and a 500 (`CLEANUP_PARTIAL`) a revocation the service has
 * not completed yet and keeps retrying. See {@link releaseServerAgentCredential}.
 */
export const RELEASE_PATH = '/credentials/release';

/**
 * Every service route this command is permitted to call, and therefore the
 * complete list a service build must answer for it to work: the five rows of
 * the protocol's route table named above. A request to anything else is a bug
 * in this file, which is why the list is exported and asserted by
 * `scripts/dev-instrumented.test.mjs` against a stub service that implements
 * only these paths.
 */
export const SERVICE_ROUTES = Object.freeze([
  HEALTH_PATH,
  LAUNCH_PATH,
  STOP_PATH,
  CREDENTIAL_PATH,
  RELEASE_PATH,
]);

/** Timeout for the liveness pre-flight: 2 s, after which the service counts as not answering. */
export const HEALTH_TIMEOUT_MS = 2_000;

/** Timeout for the launch, stop, credential and release requests. */
export const REQUEST_TIMEOUT_MS = 5_000;

/**
 * The longest the closing release of `--spawn-local` can take: the identity
 * probe that precedes it ({@link HEALTH_TIMEOUT_MS}, one address — the one
 * already proved) and then the release request itself
 * ({@link REQUEST_TIMEOUT_MS}). Shutdown signals are held for this long at
 * most (see {@link holdShutdownSignals}).
 */
const RELEASE_STEP_MAX_MS = HEALTH_TIMEOUT_MS + REQUEST_TIMEOUT_MS;

/**
 * The most bytes this command reads from a service answer: 64 KiB. Every
 * answer it expects — `{ devServerUrl, pid }`, `{ token, expiresAt }`,
 * `{ released }`, an error body — is a small JSON object of a few hundred
 * bytes, so the cap leaves ample room while keeping a misbehaving listener
 * from making this process buffer an unbounded body before anything is
 * parsed. A declared `Content-Length` above it is refused before any byte is
 * read, and a body that streams past it is cancelled the moment it does.
 */
export const RESPONSE_MAX_BYTES = 64 * 1024;

/**
 * Interval of the timer that keeps the event loop alive while the foreground
 * mode waits for a shutdown signal (see {@link awaitShutdownSignal}). One
 * minute: long enough to be free, short enough that the handle is unremarkable
 * in a process inspection.
 */
const KEEP_ALIVE_INTERVAL_MS = 60_000;

/** Everything went as asked (`--help`, a reported launch, a clean stop, or a child that exited 0). */
const EXIT_OK = 0;

/**
 * A failure this command reports rather than a status it inherited: a bad flag,
 * a missing preload, a service that is not answering, a missing or invalid
 * `auth.json`, a launch, stop or credential request the service refused or
 * answered off-contract, an unusable target project, or no package manager on
 * `PATH`. Every message that uses this code states whether anything was
 * launched or spawned, so "2" is never ambiguous about the state it leaves
 * behind. A release request that fails is never one of these: it is reported
 * as a warning, and the exit status stays the one the run already had.
 */
const EXIT_PREFLIGHT = 2;

/**
 * Status codes that mean "this service build does not implement that route".
 * They are a failure, never a signal to try a different path: the routes in
 * {@link SERVICE_ROUTES} are the service's own, so a 404 or 405 is a version
 * mismatch between this checkout and the running service. (For the release
 * route that failure is reported as a warning; see
 * {@link releaseServerAgentCredential}.)
 */
const ROUTE_ABSENT_STATUSES = Object.freeze([404, 405]);

/**
 * Failure carrying the exit code the CLI should use and, where one exists, a
 * multi-line hint stating exactly how to recover.
 */
export class DevInstrumentedError extends Error {
  /**
   * @param {string} message single-line description of what went wrong
   * @param {{ hint?: string, showUsage?: boolean }} [options] recovery detail
   */
  constructor(message, options = {}) {
    super(message);
    this.name = 'DevInstrumentedError';
    /** @type {number} process exit code that corresponds to this failure */
    this.exitCode = EXIT_PREFLIGHT;
    /** @type {string | undefined} multi-line recovery instructions */
    this.hint = options.hint;
    /** @type {boolean} whether the CLI should print full usage as well */
    this.showUsage = options.showUsage === true;
  }
}

/**
 * Write one line to a stream. Used instead of `console`: the lint baseline
 * declares no globals for `.mjs` files, and an explicit stream also keeps
 * diagnostics on stderr and the banner on stdout without ambiguity.
 *
 * @param {import('node:stream').Writable} stream
 * @param {string} text
 * @returns {void}
 */
function writeLine(stream, text) {
  stream.write(`${text}\n`);
}

/**
 * Normalise a path for display so messages read the same on every platform.
 *
 * @param {string} value
 * @returns {string}
 */
function toPosix(value) {
  return value.split(path.sep).join('/');
}

/**
 * Render an absolute path relative to the repository root when it is inside
 * it, and absolute when it is not (a target project elsewhere on disk).
 *
 * @param {string} root
 * @param {string} absolute
 * @returns {string}
 */
function display(root, absolute) {
  const relative = path.relative(root, absolute);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    return toPosix(absolute);
  }
  return toPosix(relative);
}

/**
 * Narrow an unknown thrown value to "has this errno code".
 *
 * @param {unknown} error
 * @param {string} code
 * @returns {boolean}
 */
function isErrnoCode(error, code) {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    /** @type {{ code?: unknown }} */ (error).code === code
  );
}

/**
 * A single line describing an unknown thrown value, for failure messages.
 * `fetch` wraps transport failures in a generic error and puts the useful
 * detail on `cause`, so that is unwrapped one level.
 *
 * @param {unknown} error
 * @returns {string}
 */
function describeCause(error) {
  if (error instanceof Error) {
    const cause = /** @type {{ cause?: unknown }} */ (error).cause;
    if (cause instanceof Error && cause.message !== '' && cause.message !== error.message) {
      return `${error.message} (${cause.message})`;
    }
    return error.message;
  }
  return String(error);
}

/**
 * Expand a leading `~` in a configured directory. `.env.example` ships
 * `DEBUGGEN_HOME=~/.debuggen` literally and dotenv does not expand it, so the
 * value reaches this process with the tilde intact.
 *
 * @param {string} value
 * @returns {string}
 */
export function expandHome(value) {
  if (value === '~') return os.homedir();
  if (value.startsWith('~/') || value.startsWith(`~${path.sep}`)) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

/**
 * Trim an empty or whitespace-only environment value down to `undefined`, so
 * `DEBUGGEN_PORT=` behaves like "unset" rather than producing `http://host:`.
 *
 * @param {string | undefined} value
 * @returns {string | undefined}
 */
function cleanEnv(value) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/**
 * Full `--help` text. It documents every flag, every environment variable the
 * script reads, and every environment variable it sets on the child, because
 * those injections are deliberately absent from `.env.example` and this is
 * where a developer finds out about them.
 *
 * @returns {string}
 */
export function usage() {
  return `dev-instrumented — run a development server with the telemetry preload attached

Usage
  node scripts/dev-instrumented.mjs [--project <dir>] [--service <url>] [--detach]
  node scripts/dev-instrumented.mjs --spawn-local [--env NAME[=value]]...
                                    [--project <dir>] [--service <url>]
  node scripts/dev-instrumented.mjs --stop [--project <dir>] [--service <url>]
  node scripts/dev-instrumented.mjs --help

  pnpm demo:instrumented            the same thing for ${DEFAULT_PROJECT_REL}

What it does (default mode)
  1. resolves the Node preload at ${PRELOAD_REL}
  2. resolves the target project and checks it declares a "dev" script
  3. resolves the local service from --service, or DEBUGGEN_HOST/DEBUGGEN_PORT
  4. reads the editor credential from $DEBUGGEN_HOME/${AUTH_FILE_NAME}
  5. checks GET {service}${HEALTH_PATH} answers and proves it holds the editor
     credential; nothing is sent to a listener that cannot
  6. asks the service to launch the project: POST {service}${LAUNCH_PATH}
     with { projectRoot }, authorised by that editor credential
  7. reports the devServerUrl and pid the service answers with, then waits;
     Ctrl-C (or SIGTERM) has the service prove itself again, then stops that
     server through POST {service}${STOP_PATH}

  The service's launcher attaches the preload, mints the server-agent
  credential for the process it starts and revokes it when that process
  exits. The service owns that process and its credential end to end, which
  is why the default mode goes through it, and it keeps one implementation of
  launching instead of two.

  Server-tier spans (incoming requests, route handlers, outgoing fetch, Prisma
  and pg queries) exist only because the preload registers a tracer provider
  inside the dev-server process before the framework starts. Nothing in the
  target project's source is modified, and this script writes nothing to disk.

  Every route it calls is a row of the protocol's route table, and these five
  are all of them:
  ${SERVICE_ROUTES.join(', ')}.

  Any local process can answer GET ${HEALTH_PATH} on the service's port, so a
  200 alone is not trusted. The probe carries a fresh random
  ${SERVICE_IDENTITY_CHALLENGE_HEADER}, and the answer must carry
  ${SERVICE_IDENTITY_PROOF_HEADER}: an HMAC-SHA256, keyed by the editor
  credential, of that challenge and of the host:port the service names in
  ${SERVICE_IDENTITY_ENDPOINT_HEADER}, which must be the IP address and port
  this command dialled. A host name such as localhost is resolved first, each
  loopback address it stands for is probed, and every later request goes to
  the address that proved the service. A listener that cannot prove it holds
  the editor credential is refused with exit 2 and never receives it.

What it does (--spawn-local)
  1. resolves the preload, the target project and the --env variables, as
     above, and the command that runs the project's own "dev" script
  2. reads the editor credential from $DEBUGGEN_HOME/${AUTH_FILE_NAME}
  3. checks GET {service}${HEALTH_PATH} answers and proves it holds the editor
     credential; nothing is sent to a listener that cannot
  4. asks the service for a server-agent credential scoped to the project:
     POST {service}${CREDENTIAL_PATH} with { projectRoot },
     authorised by that editor credential; the service answers
     { token, expiresAt }, expiresAt being the end of the first lease
  5. spawns the "dev" script here, in a minimal environment: the allowlisted
     variables of this terminal (see "What the child inherits"), the --env
     variables, the preload on NODE_OPTIONS, and DEBUGGEN_INGEST_URL,
     DEBUGGEN_PROJECT_ROOT and DEBUGGEN_TOKEN
  6. forwards SIGINT/SIGTERM to that child and waits for it to exit
  7. once the child has exited — on its own, through a forwarded signal, or
     because it could not be started — has the service prove itself again as
     in step 3, then releases the credential: POST {service}${RELEASE_PATH}
     with { token }, authorised by the editor credential; a release that
     fails or is skipped prints one warning and leaves the credential to the
     service's supervision below
  8. exits with the child's status

  This is an AUTHENTICATED run: it needs a running service and ${AUTH_FILE_NAME},
  and the service mints the credential only for a project under the
  workspace folders VS Code announced to it. Any failure in steps 1-4 stops
  the command before anything is spawned — a dev server without a credential
  would only look instrumented, because the preload records nothing without
  one.

  The server-agent credential is held in this process's memory and in the
  child's environment only, and goes back to the service once, as the body of
  the release; this command never prints, logs or writes it (the banner shows
  its length). The dev server inherits this terminal unfiltered, so a dev
  script that prints its own environment would show it there.

  This command releases the credential as soon as nothing will use it: after
  the dev server exits (Ctrl-C and SIGTERM included), after a spawn that
  failed, and after a failure between the mint and the spawn. The service
  answers { released: true } when it revoked the credential then, and
  { released: false } when nothing was live under it any more; both are a
  success, and either prints one line. A signal that arrives while the
  release is in flight (${String(RELEASE_STEP_MAX_MS / 1000)} seconds at most) waits for it rather than
  ending this command mid-request. The release is one request, never
  retried, and a failed or skipped one is a warning that leaves the exit
  status alone.

  The service also supervises the credential as a lease, which is what ends it
  when the release does not happen. The banner shows when its first lease
  ends (5 minutes after minting); the service renews it while the dev
  server's preload keeps its server-agent control connection open, and
  revokes it when the dev server disconnects — 20 seconds after that
  connection is gone, so it stops working shortly after the dev server
  exits, Ctrl-C included — and when the service shuts down. A lease nothing
  renews lapses within 5 minutes of its last renewal (a service that
  crashed, or a preload that never connected), and debuggen.rotateServiceToken
  revokes it at once. This command itself never renews it.

Options
  --project <dir>   project to launch; relative paths resolve against the
                    current directory (default: ${DEFAULT_PROJECT_REL} inside this
                    repository). The directory needs a package.json with a
                    "dev" script.
  --service <url>   base URL of the local service, overriding
                    DEBUGGEN_HOST/DEBUGGEN_PORT (example: http://127.0.0.1:43117).
                    Must address a loopback host: these requests carry the
                    editor credential, and the service binds loopback.
  --detach          report the launch and exit immediately instead of waiting
                    for Ctrl-C. The dev server keeps running under the service;
                    stop it with --stop, or from VS Code by ending the session.
  --spawn-local     spawn the project's own "dev" script from this terminal
                    with the preload, DEBUGGEN_INGEST_URL, DEBUGGEN_PROJECT_ROOT
                    and a server-agent credential (DEBUGGEN_TOKEN) the service
                    minted for this project through POST ${CREDENTIAL_PATH}.
                    AUTHENTICATED: it needs the running service and
                    ${AUTH_FILE_NAME}, and when the credential cannot be
                    obtained nothing is spawned. The credential is a lease the
                    service renews while the dev server runs and revokes when
                    the dev server disconnects; otherwise it lapses within 5
                    minutes. This command releases it through
                    POST ${RELEASE_PATH} once the dev server has exited.
                    Signals and the exit code are forwarded.
  --env NAME[=value]
                    give the --spawn-local child one more variable: NAME alone
                    forwards this terminal's value (exit 2 when it is unset),
                    NAME=value sets that value. Repeatable, one name at most
                    once; valid only with --spawn-local. NAME is letters, digits
                    and underscores, not starting with a digit. NODE_OPTIONS and
                    every DEBUGGEN_* name are refused: this command sets the
                    preload wiring itself, and the rest configure the service.
                    The banner lists the names, never the values.
  --stop            stop a dev server the service launched for this project
                    (POST ${STOP_PATH}) and exit.
  --help, -h        print this text

Environment it reads
  DEBUGGEN_HOST     service interface, loopback only — ${DEFAULT_SERVICE_HOST},
                    localhost or [::1] (default ${DEFAULT_SERVICE_HOST}). The
                    service proves its identity only when it runs with an
                    address here, not localhost.
  DEBUGGEN_PORT     service port (default ${DEFAULT_SERVICE_PORT})
  DEBUGGEN_HOME     session home holding ${AUTH_FILE_NAME} (default ${DEFAULT_DEBUGGEN_HOME});
                    a leading ~ is expanded
  NODE_OPTIONS      inherited and appended to, never replaced (--spawn-local)
  NAME              each variable named by a bare --env NAME (--spawn-local)

What the child inherits (--spawn-local only)
  Only what a dev server needs to run — the same allowlist the service's
  launcher applies to the dev servers it starts:
    platform       PATH, HOME, USER, LOGNAME, USERNAME, SHELL, TMPDIR, TMP,
                   TEMP, LANG, LANGUAGE, TZ, LC_*, XDG_*
    Windows        PATHEXT, SYSTEMROOT, SYSTEMDRIVE, WINDIR, COMSPEC,
                   USERPROFILE, HOMEDRIVE, HOMEPATH, APPDATA, LOCALAPPDATA,
                   PROGRAMDATA, ALLUSERSPROFILE, the PROGRAMFILES and
                   COMMONPROGRAMFILES family, PUBLIC, OS,
                   PROCESSOR_ARCHITECTURE, NUMBER_OF_PROCESSORS, COMPUTERNAME,
                   USERDOMAIN
    toolchain      NODE_ENV, NODE_PATH, NODE_EXTRA_CA_CERTS, SSL_CERT_FILE,
                   SSL_CERT_DIR, HTTP_PROXY, HTTPS_PROXY, NO_PROXY and ALL_PROXY
                   (upper- or lower-case), PNPM_HOME, VOLTA_HOME, BUN_INSTALL,
                   COREPACK_*, NVM_*, FNM_*
    terminal       TERM, COLORTERM, FORCE_COLOR, NO_COLOR, CI
    dev server     PORT, HOST, HOSTNAME, WATCHPACK_POLLING,
                   CHOKIDAR_USEPOLLING, NEXT_*
    database       DATABASE_URL, PGHOST, PGPORT, PGDATABASE, PGUSER,
                   PGPASSWORD, PGSSLMODE
    preload        DEBUGGEN_LOG_LEVEL
  On Windows the names compare case-insensitively.

  The listed variables are forwarded as they are, and some can carry a
  secret of their own — DATABASE_URL and PGPASSWORD a database password, a
  proxy URL its credentials, a NEXT_* variable whatever the project puts in
  it — exactly as they would reach any dev server started from this
  terminal. Everything else is dropped: ANTHROPIC_API_KEY, every other
  DEBUGGEN_* variable, cloud and source-control tokens and anything not
  listed never reach the project or the dependencies it loads. Pass a
  variable the project needs with --env NAME or --env NAME=value. The project's own .env files keep working: its dev server
  reads them itself, and this script neither reads nor forwards them.

Environment it sets on the child (--spawn-local only)
  NODE_OPTIONS          inherited value + " --import <file:// URL of the preload>"
  DEBUGGEN_INGEST_URL   {service}${INGEST_PATH}
  DEBUGGEN_PROJECT_ROOT absolute path of the launched project; the preload
                        reports ingest under this root
  DEBUGGEN_TOKEN        the server-agent credential POST ${CREDENTIAL_PATH}
                        minted for this project root; it replaces any inherited
                        value, and this command never prints it (the banner
                        shows only its length)

Exit codes
  0   --help, a reported launch, a stopped dev server, or a child that exited 0
  2   a failure this command reports: usage error, missing preload, unusable
      project, no package manager on PATH, a service that is not answering, a
      listener that did not prove it is the service, a missing or invalid
      ${AUTH_FILE_NAME}, or a launch, stop or credential request the service
      refused, answered off-contract or answered with more than ${RESPONSE_MAX_KIB} KiB.
      The message says whether anything was launched; in --spawn-local every
      such failure happens before the spawn, and the message says nothing was
      spawned.
  n   whatever the --spawn-local child exited with; 128 + signal number when it
      was signalled

  The closing release of --spawn-local never changes the exit code: one that
  fails, or is skipped because the service did not prove itself again, is a
  warning on stderr.`;
}

/**
 * @typedef {object} DevInstrumentedOptions
 * @property {boolean} help print usage and exit
 * @property {boolean} spawnLocal spawn the dev server here, with a server-agent
 *   credential the service minted for it
 * @property {boolean} detach report the service's launch and exit immediately
 * @property {boolean} stop stop a dev server the service launched, then exit
 * @property {string | undefined} project raw `--project` value, if given
 * @property {string | undefined} service raw `--service` value, if given
 * @property {ExtraEnvRequest[]} extraEnv every `--env NAME` / `--env NAME=value`,
 *   in command-line order; valid only with `spawnLocal`
 */

/**
 * Parse argv (already stripped of `node` and the script path).
 *
 * Unknown flags are a usage error rather than something passed through to the
 * child: passing arguments to the project's dev script is the project's own
 * business, and silently forwarding them would make typos look like framework
 * failures. Combinations that contradict each other are rejected here too, so
 * a mode is never silently ignored — the three mode flags select genuinely
 * different behaviour and precedence between them would be a guess. `--env`
 * is validated here as well (a portable name, never `NODE_OPTIONS` or a
 * `DEBUGGEN_*` name, each name once, `--spawn-local` only); a bare
 * `--env NAME` is resolved against the environment later, by
 * {@link resolveExtraEnv}.
 *
 * @param {readonly string[]} argv
 * @returns {DevInstrumentedOptions}
 * @throws {DevInstrumentedError} on an unknown flag, a missing flag value, a
 *   contradictory combination, or an `--env` that is invalid, repeated or used
 *   without `--spawn-local`
 */
export function parseArgs(argv) {
  /** @type {DevInstrumentedOptions} */
  const options = {
    help: false,
    spawnLocal: false,
    detach: false,
    stop: false,
    project: undefined,
    service: undefined,
    extraEnv: [],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) continue;

    /**
     * Read the value of a flag written either as `--flag value` or
     * `--flag=value`, rejecting a missing or flag-shaped value.
     *
     * @param {string} flag
     * @param {string | undefined} inline
     * @returns {string}
     */
    const takeValue = (flag, inline) => {
      const value = inline ?? argv[index + 1];
      if (inline === undefined) index += 1;
      if (value === undefined || value === '' || value.startsWith('-')) {
        throw new DevInstrumentedError(`${flag} needs a value`, { showUsage: true });
      }
      return value;
    };

    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }
    if (arg === '--spawn-local') {
      options.spawnLocal = true;
      continue;
    }
    if (arg === '--detach') {
      options.detach = true;
      continue;
    }
    if (arg === '--stop') {
      options.stop = true;
      continue;
    }
    if (arg === '--project' || arg.startsWith('--project=')) {
      options.project = takeValue('--project', arg.slice('--project='.length) || undefined);
      continue;
    }
    if (arg === '--service' || arg.startsWith('--service=')) {
      options.service = takeValue('--service', arg.slice('--service='.length) || undefined);
      continue;
    }
    if (arg === '--env' || arg.startsWith('--env=')) {
      const request = parseEnvFlag(takeValue('--env', arg.slice('--env='.length) || undefined));
      if (options.extraEnv.some((entry) => entry.name === request.name)) {
        throw new DevInstrumentedError(`--env ${request.name} is given more than once`, {
          hint: 'Name each variable once, so which value the dev server receives is never a guess.',
          showUsage: true,
        });
      }
      options.extraEnv.push(request);
      continue;
    }

    throw new DevInstrumentedError(`unrecognised argument: ${arg}`, { showUsage: true });
  }

  if (options.help) return options;

  if (options.extraEnv.length > 0 && !options.spawnLocal) {
    throw new DevInstrumentedError('--env applies only to --spawn-local', {
      hint: [
        'Without --spawn-local the service launches the dev server and builds its',
        'environment with the same allowlist. Give that dev server more variables',
        "through the project's own .env files, or with NAME=value at the start of",
        'the launch command you approve in VS Code.',
      ].join('\n'),
      showUsage: true,
    });
  }

  if (options.stop && options.spawnLocal) {
    throw new DevInstrumentedError('--stop and --spawn-local cannot be combined', {
      hint: '--stop asks the service to stop a server it launched; --spawn-local never launches through the service. Pick one.',
      showUsage: true,
    });
  }
  if (options.stop && options.detach) {
    throw new DevInstrumentedError('--stop and --detach cannot be combined', {
      hint: '--stop always returns as soon as the service has answered, so there is nothing to detach from.',
      showUsage: true,
    });
  }
  if (options.spawnLocal && options.detach) {
    throw new DevInstrumentedError('--spawn-local and --detach cannot be combined', {
      hint: [
        '--detach applies to a launch through the service, which owns the process',
        'it starts. A local spawn IS this process: to background it, use your',
        "shell's job control instead.",
      ].join('\n'),
      showUsage: true,
    });
  }

  return options;
}

/**
 * @typedef {object} ResolvedPreload
 * @property {string} file absolute path of the preload module
 * @property {string} relative repository-relative path, for messages
 * @property {string} url `file://` URL, the form `--import` is given
 */

/**
 * Locate the Node preload and describe it in the three forms the rest of the
 * script needs.
 *
 * The URL form is not cosmetic: `--import` inside `NODE_OPTIONS` is split on
 * whitespace by Node, and a `file://` URL percent-encodes every space, so a
 * checkout under a path with spaces still works. A plain path would not.
 *
 * @param {string} [root] repository root to resolve against
 * @returns {Promise<ResolvedPreload>}
 * @throws {DevInstrumentedError} exit 2 when the bundle has not been built
 */
export async function resolvePreload(root = REPO_ROOT) {
  const file = path.join(root, ...PRELOAD_REL.split('/'));

  /** @type {fs.Stats} */
  let stats;
  try {
    stats = await fs.promises.stat(file);
  } catch (error) {
    if (isErrnoCode(error, 'ENOENT') || isErrnoCode(error, 'ENOTDIR')) {
      throw new DevInstrumentedError(`the telemetry preload is missing: ${PRELOAD_REL}`, {
        hint: [
          'The preload registers the tracer provider inside the dev-server',
          'process, so there is nothing to attach until it is built:',
          '',
          `  ${PRELOAD_BUILD_COMMAND}`,
          '',
          'On a clean clone, `pnpm install && pnpm build` builds it along with',
          'every other workspace. Nothing was spawned.',
        ].join('\n'),
      });
    }
    throw new DevInstrumentedError(
      `could not read the telemetry preload ${PRELOAD_REL}: ${describeCause(error)}`,
    );
  }

  if (!stats.isFile()) {
    throw new DevInstrumentedError(`the telemetry preload is not a file: ${PRELOAD_REL}`, {
      hint: `Remove whatever is at that path and rebuild it with:\n\n  ${PRELOAD_BUILD_COMMAND}`,
    });
  }

  return { file, relative: PRELOAD_REL, url: pathToFileURL(file).href };
}

/**
 * The one host name this script accepts as loopback, matching
 * `packages/telemetry/src/node/config.ts`. Subdomains of it are refused: their
 * resolution is resolver-dependent, so they are not verifiable loopback.
 *
 * @type {string}
 */
const LOOPBACK_HOST_NAME = 'localhost';

/** An IPv4 dotted quad, each octet captured. @type {RegExp} */
const IPV4_QUAD = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u;

/** An IPv4-mapped IPv6 address; the capture is the embedded address. @type {RegExp} */
const IPV4_MAPPED_IPV6 = /^::ffff:([0-9a-f.:]+)$/u;

/** First octet of the IPv4 loopback range, 127.0.0.0/8 (RFC 1122). @type {number} */
const IPV4_LOOPBACK_FIRST_OCTET = 127;

/**
 * Whether a dotted quad is a well-formed address inside 127.0.0.0/8.
 *
 * @param {string} value candidate dotted quad
 * @returns {boolean}
 */
function isIpv4LoopbackAddress(value) {
  const match = IPV4_QUAD.exec(value);
  if (match === null) return false;
  const octets = match.slice(1).map((part) => Number.parseInt(part, 10));
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return false;
  return octets[0] === IPV4_LOOPBACK_FIRST_OCTET;
}

/**
 * Whether the IPv4 address embedded in an IPv4-mapped IPv6 address is loopback.
 * Accepts the hextet spelling the WHATWG parser produces (`7f00:1`) and the
 * dotted one (`127.0.0.1`).
 *
 * @param {string} embedded everything after the `::ffff:` prefix
 * @returns {boolean}
 */
function isMappedIpv4Loopback(embedded) {
  if (embedded.includes('.')) return isIpv4LoopbackAddress(embedded);
  const hextets = embedded.split(':');
  if (hextets.length !== 2) return false;
  const [high, low] = hextets;
  if (high === undefined || low === undefined) return false;
  if (!/^[0-9a-f]{1,4}$/u.test(high) || !/^[0-9a-f]{1,4}$/u.test(low)) return false;
  // The high hextet's upper byte is the embedded address's first octet.
  return Number.parseInt(high, 16) >>> 8 === IPV4_LOOPBACK_FIRST_OCTET;
}

/**
 * Whether a host name denotes this machine's loopback interface:
 * {@link LOOPBACK_HOST_NAME}, any IPv4 address in 127.0.0.0/8, IPv6 `::1`, or
 * an IPv4-mapped address whose embedded IPv4 is loopback. A wildcard bind
 * (`0.0.0.0`, `::`) is refused — reachable from the network is not loopback.
 *
 * This is the same policy `isLoopbackHostname` applies in
 * `packages/telemetry/src/node/config.ts`, deliberately duplicated rather than
 * imported: this script is run with bare `node` and imports nothing but `node:`
 * builtins, which is what lets it work on a checkout that has not been built.
 * A change to the policy belongs in both places, and the suite covers both.
 *
 * Exported so `scripts/dev-instrumented.test.mjs` can assert the boundary case
 * by case rather than only through the resolved base URL.
 *
 * @param {string} hostname host name or IP literal, bracketed or bare
 * @returns {boolean} true when the host is verifiably loopback
 */
export function isLoopbackHostname(hostname) {
  const normalised = typeof hostname === 'string' ? hostname.trim().toLowerCase() : '';
  if (normalised === '') return false;
  if (normalised === LOOPBACK_HOST_NAME) return true;

  const bare =
    normalised.startsWith('[') && normalised.endsWith(']') ? normalised.slice(1, -1) : normalised;
  if (bare === '::1') return true;

  const mapped = IPV4_MAPPED_IPV6.exec(bare);
  if (mapped !== null) {
    const embedded = mapped[1];
    return embedded !== undefined && isMappedIpv4Loopback(embedded);
  }
  return isIpv4LoopbackAddress(bare);
}

/**
 * The hint every refusal of a non-loopback service address carries.
 *
 * @param {string} subject what named the address, for the first line
 * @returns {string}
 */
function loopbackHint(subject) {
  return [
    `The local service binds a loopback interface, so ${subject} can`,
    'only address this machine. Requests here carry the editor credential as a',
    'bearer token, and a non-loopback address would disclose it — and the launch',
    'it authorises — to another origin.',
    '',
    `Use ${DEFAULT_SERVICE_HOST}, localhost or [::1], and set DEBUGGEN_PORT (or`,
    'pass --service) if the service listens on another port.',
  ].join('\n');
}

/**
 * Resolve the local service's base URL: `--service` wins, otherwise
 * `DEBUGGEN_HOST` and `DEBUGGEN_PORT` with the documented defaults.
 *
 * The returned value never has a trailing slash, so `${base}${path}` is always
 * a valid URL. A bare IPv6 host is bracketed.
 *
 * Whichever route produced it, the address must be **loopback**: this is the
 * trust boundary for every request the command makes, because those requests
 * carry the editor credential — the most privileged one on the machine, since
 * it is what authorises minting a server-agent credential and launching a
 * process. An address off this machine is therefore refused rather than
 * attempted, whether it arrived on the command line or in the environment.
 *
 * @param {{ service?: string | undefined, env?: NodeJS.ProcessEnv }} [options]
 * @returns {string}
 * @throws {DevInstrumentedError} when `--service` is not an http(s) URL, or when
 * either route names a host that is not loopback
 */
export function resolveServiceBase(options = {}) {
  const env = options.env ?? process.env;
  const override = cleanEnv(options.service);

  if (override !== undefined) {
    /** @type {URL} */
    let parsed;
    try {
      parsed = new URL(override);
    } catch {
      throw new DevInstrumentedError(`--service is not a valid URL: ${override}`, {
        hint: 'Pass an absolute URL, for example http://127.0.0.1:43117.',
      });
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new DevInstrumentedError(`--service must be http or https, got ${parsed.protocol}`);
    }
    if (parsed.username !== '' || parsed.password !== '') {
      throw new DevInstrumentedError('--service must not embed credentials in the URL', {
        hint: 'The service authenticates with a bearer token, which this command reads from $DEBUGGEN_HOME/auth.json.',
      });
    }
    if (!isLoopbackHostname(parsed.hostname)) {
      throw new DevInstrumentedError(
        `--service must address a loopback host, got ${parsed.hostname}`,
        { hint: loopbackHint('--service') },
      );
    }
    return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`;
  }

  const host = cleanEnv(env.DEBUGGEN_HOST) ?? DEFAULT_SERVICE_HOST;
  const port = cleanEnv(env.DEBUGGEN_PORT) ?? DEFAULT_SERVICE_PORT;
  if (!/^\d+$/.test(port)) {
    throw new DevInstrumentedError(`DEBUGGEN_PORT is not a number: ${port}`, {
      hint: `Unset it to use the default (${DEFAULT_SERVICE_PORT}) or pass --service <url>.`,
    });
  }
  if (!isLoopbackHostname(host)) {
    throw new DevInstrumentedError(`DEBUGGEN_HOST is not a loopback host: ${host}`, {
      hint: loopbackHint('DEBUGGEN_HOST'),
    });
  }
  const authority = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return `http://${authority}:${port}`;
}

/**
 * Absolute path of the session home, honouring `DEBUGGEN_HOME` and expanding a
 * leading `~`. It deliberately sits outside every checkout, which is why the
 * credential is read from there rather than from the repository.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function resolveDebuggenHome(env = process.env) {
  return path.resolve(expandHome(cleanEnv(env.DEBUGGEN_HOME) ?? DEFAULT_DEBUGGEN_HOME));
}

/**
 * The recovery hint for "the local service is not running yet". The address
 * paragraph is included only when there is an address worth naming.
 *
 * @param {string} [base] service base URL this run expected
 * @returns {string}
 */
function serviceStartHint(base) {
  const lines = [
    'Start the local coordination service first, then re-run this command:',
    '',
    '  - from VS Code: run the "Debug Generator: Start Service" command',
    '    (debuggen.startService), which also writes the editor credential; or',
    '  - from a terminal: pnpm --filter @debuggen/local-service dev',
  ];
  if (base !== undefined && base !== '') {
    lines.push(
      '',
      `Expected at ${base}. Override the address with --service <url>, or with`,
      'DEBUGGEN_HOST and DEBUGGEN_PORT.',
    );
  }
  return lines.join('\n');
}

/**
 * Read the editor credential the service writes to `$DEBUGGEN_HOME/auth.json`
 * (mode 0600) on first start. It is the credential that authorises asking for
 * a process-scoped server-agent credential.
 *
 * Several field layouts are accepted because the file is the service's to
 * write: a bare `token`, `editorToken`, or an `editor` entry holding either a
 * string or an object with a `token`. Anything else is reported as invalid
 * rather than guessed at.
 *
 * @param {string} [home] absolute path of the session home
 * @returns {Promise<string>} the editor credential
 * @throws {DevInstrumentedError} exit 2 when it is missing or unusable
 */
export async function readEditorCredential(home = resolveDebuggenHome()) {
  const file = path.join(home, AUTH_FILE_NAME);

  /** @type {string} */
  let raw;
  try {
    raw = await fs.promises.readFile(file, 'utf8');
  } catch (error) {
    if (isErrnoCode(error, 'ENOENT') || isErrnoCode(error, 'ENOTDIR')) {
      throw new DevInstrumentedError(`no editor credential at ${toPosix(file)}`, {
        hint: [
          'The service writes that file with mode 0600 the first time it starts,',
          'and every mode of this command needs it to authorise what it asks the',
          'service for: a launch, a stop, or the server-agent credential a',
          '--spawn-local child runs with.',
          '',
          serviceStartHint(),
          '',
          'Set DEBUGGEN_HOME if your session home is elsewhere.',
        ].join('\n'),
      });
    }
    if (isErrnoCode(error, 'EACCES') || isErrnoCode(error, 'EPERM')) {
      throw new DevInstrumentedError(`cannot read ${toPosix(file)}: permission denied`, {
        hint: 'The file is created 0600 for the user running the service. Run this command as that user.',
      });
    }
    throw new DevInstrumentedError(`cannot read ${toPosix(file)}: ${describeCause(error)}`);
  }

  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new DevInstrumentedError(`${toPosix(file)} is not valid JSON: ${describeCause(error)}`, {
      hint: 'Delete it and restart the service to have a fresh editor credential written.',
    });
  }

  const token = extractToken(parsed, ['token', 'editorToken', 'editor']);
  if (token === undefined) {
    throw new DevInstrumentedError(`${toPosix(file)} holds no editor credential`, {
      hint: 'Expected a JSON object with a "token" (or "editorToken", or an "editor" entry holding one). Restart the service to have it rewritten.',
    });
  }
  return token;
}

/**
 * Pull a credential string out of a parsed JSON body, accepting the documented
 * field layouts and nothing else. Never logs or returns anything but the
 * string itself.
 *
 * @param {unknown} value parsed JSON
 * @param {readonly string[]} keys candidate keys, in order of preference
 * @returns {string | undefined}
 */
function extractToken(value, keys) {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed === '' ? undefined : trimmed;
  }
  if (typeof value !== 'object' || value === null) return undefined;

  const record = /** @type {Record<string, unknown>} */ (value);
  for (const key of keys) {
    const candidate = record[key];
    if (typeof candidate === 'string') {
      const trimmed = candidate.trim();
      if (trimmed !== '') return trimmed;
      continue;
    }
    // One level of nesting only: { editor: { token } } / { credential: { token } }.
    if (typeof candidate === 'object' && candidate !== null) {
      const nested = /** @type {Record<string, unknown>} */ (candidate).token;
      if (typeof nested === 'string' && nested.trim() !== '') return nested.trim();
    }
  }
  return undefined;
}

/**
 * A fresh identity challenge: {@link SERVICE_IDENTITY_CHALLENGE_BYTES} bytes
 * from the operating system's CSPRNG, as unpadded base64url (43 characters).
 * Every probe draws a new one, so a proof recorded from an earlier probe never
 * answers a later one.
 *
 * @returns {string}
 */
function createServiceIdentityChallenge() {
  return randomBytes(SERVICE_IDENTITY_CHALLENGE_BYTES).toString('base64url');
}

/**
 * The identity proof for one challenge, as the service computes it and this
 * command recomputes it: the unpadded base64url HMAC-SHA256 keyed by the UTF-8
 * bytes of the editor credential, over the UTF-8 bytes of
 * `${SERVICE_IDENTITY_PROOF_LABEL}\n${challenge}\n${endpoint}`.
 *
 * Only a holder of the editor credential can produce it, and the probe that
 * asks for it carries no credential, so answering it discloses nothing to a
 * listener that is not the service. Binding the endpoint into the message is
 * what makes a proof relayed from a service on another address fail
 * {@link verifyServiceIdentity}.
 *
 * Pure and exported so `scripts/dev-instrumented.test.mjs` can hold it to the
 * transcription of the contract its stub services answer with.
 *
 * @example
 * computeServiceIdentityProof({ key: editorToken, challenge, endpoint: '127.0.0.1:43117' });
 * // → a 43-character base64url string
 *
 * @param {object} input
 * @param {string} input.key the editor credential, used as the HMAC key
 * @param {string} input.challenge the challenge the probe sent
 * @param {string} input.endpoint the `host:port` the answering service is bound to
 * @returns {string}
 * @throws {TypeError} when any input is not a non-empty string
 */
export function computeServiceIdentityProof({ key, challenge, endpoint }) {
  for (const [name, value] of Object.entries({ key, challenge, endpoint })) {
    if (typeof value !== 'string' || value === '') {
      throw new TypeError(`computeServiceIdentityProof: ${name} must be a non-empty string`);
    }
  }
  return createHmac('sha256', Buffer.from(key, 'utf8'))
    .update(Buffer.from(`${SERVICE_IDENTITY_PROOF_LABEL}\n${challenge}\n${endpoint}`, 'utf8'))
    .digest('base64url');
}

/** A decimal TCP port as the endpoint header spells it. @type {RegExp} */
const ENDPOINT_PORT = /^\d{1,5}$/u;

/** Anything that has no place in a `host:port`: whitespace, controls, format characters. */
const ENDPOINT_FORBIDDEN_CHARACTER = /[\s\p{Cc}\p{Cf}]/u;

/** The highest TCP port. */
const MAX_PORT = 65_535;

/**
 * Parse the `host:port` an identity answer names: an IPv6 host in brackets
 * (`[::1]:43117`), any other host bare (`127.0.0.1:43117`, `localhost:43117`),
 * and a port from 1 to 65535. An unbracketed host containing `:` is refused,
 * because where its port begins would be a guess.
 *
 * @param {string} value the endpoint header, verbatim
 * @returns {{ host: string, port: number } | undefined} the host lower-cased
 *   and without brackets, or `undefined` when the value is not a `host:port`
 */
function parseIdentityEndpoint(value) {
  if (ENDPOINT_FORBIDDEN_CHARACTER.test(value)) return undefined;

  /** @type {string} */
  let host;
  /** @type {string} */
  let portText;
  if (value.startsWith('[')) {
    const close = value.indexOf(']');
    if (close <= 1 || value[close + 1] !== ':') return undefined;
    host = value.slice(1, close);
    portText = value.slice(close + 2);
    if (!host.includes(':')) return undefined;
  } else {
    const colon = value.lastIndexOf(':');
    if (colon <= 0) return undefined;
    host = value.slice(0, colon);
    portText = value.slice(colon + 1);
    if (host.includes(':') || host.includes('[') || host.includes(']')) return undefined;
  }

  if (!ENDPOINT_PORT.test(portText)) return undefined;
  const port = Number.parseInt(portText, 10);
  if (port < 1 || port > MAX_PORT) return undefined;
  return { host: host.toLowerCase(), port };
}

/**
 * The endpoint this command targets, from the service base URL: its host
 * lower-cased without brackets, and its port — the scheme's default when the
 * URL names none.
 *
 * @param {string} base service base URL
 * @returns {{ host: string, port: number, display: string }}
 */
function targetEndpoint(base) {
  const url = new URL(base);
  const port =
    url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number.parseInt(url.port, 10);
  const host = url.hostname.toLowerCase();
  const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  return { host: bare, port, display: `${url.hostname}:${port}` };
}

/**
 * The canonical spelling of an IP address literal — the form the WHATWG URL
 * parser gives it (`[0:0:0:0:0:0:0:1]` becomes `::1`, `::ffff:127.0.0.1`
 * becomes `::ffff:7f00:1`) — or `undefined` for anything that is not an
 * address, a host name such as `localhost` included.
 *
 * Addresses are what a proof may name and what this command dials, because an
 * address names one listener: a host name can stand for several (`localhost`
 * is both `127.0.0.1` and `::1` on a dual-stack machine), and a proof bound to
 * a name would authenticate whichever of them answered.
 *
 * @param {string} host bare or bracketed host
 * @returns {string | undefined} the canonical address, unbracketed
 */
function canonicalAddress(host) {
  const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  const family = isIP(bare);
  if (family === 0) return undefined;
  try {
    const hostname = new URL(`http://${family === 6 ? `[${bare}]` : bare}/`).hostname;
    return hostname.startsWith('[') ? hostname.slice(1, -1) : hostname;
  } catch {
    // A literal the URL parser refuses (an IPv6 zone id) is not dialled here.
    return undefined;
  }
}

/**
 * Whether the host a proof is bound to is the address this command dialled:
 * both must be IP address literals, compared in canonical form
 * ({@link canonicalAddress}). No name is ever matched, and no two addresses
 * are treated as one: a listener on the loopback address the service did not
 * bind — `[::1]:P` beside a service on `127.0.0.1:P` — could forward the
 * challenge to the service and hand back its genuine proof, and that proof
 * names `127.0.0.1:P`, which answers only a command that dialled
 * `127.0.0.1:P`.
 *
 * @param {string} bound host from the endpoint header, normalised
 * @param {string} target host of the base URL this command dialled, normalised
 * @returns {boolean}
 */
function isSameServiceHost(bound, target) {
  const boundAddress = canonicalAddress(bound);
  return boundAddress !== undefined && boundAddress === canonicalAddress(target);
}

/**
 * @typedef {{ ok: true, reason?: undefined } | { ok: false, reason: string }} IdentityVerdict
 */

/**
 * Judge an answer to the identity challenge. It is accepted only when it names
 * an endpoint, its proof equals {@link computeServiceIdentityProof} for this
 * challenge, that endpoint and the editor credential — compared in constant
 * time — and the endpoint is the address this command dialled: the same port
 * (the scheme's default when the base URL names none) and the same IP address
 * ({@link isSameServiceHost}). An endpoint that names a host name is refused
 * however valid its proof, because a name does not identify one listener.
 *
 * The reason never quotes the proof; an endpoint the answer named is quoted
 * with invisible characters escaped, because it is the listener's text.
 *
 * @param {object} answer
 * @param {string} answer.key the editor credential
 * @param {string} answer.challenge the challenge the probe sent
 * @param {string} answer.base the service base URL this command targets
 * @param {string | null | undefined} answer.proof the {@link SERVICE_IDENTITY_PROOF_HEADER} value
 * @param {string | null | undefined} answer.endpoint the {@link SERVICE_IDENTITY_ENDPOINT_HEADER} value
 * @returns {IdentityVerdict}
 */
export function verifyServiceIdentity({ key, challenge, base, proof, endpoint }) {
  const missing = [
    typeof proof === 'string' && proof !== '' ? undefined : SERVICE_IDENTITY_PROOF_HEADER,
    typeof endpoint === 'string' && endpoint !== '' ? undefined : SERVICE_IDENTITY_ENDPOINT_HEADER,
  ].filter((name) => name !== undefined);
  if (missing.length > 0 || typeof proof !== 'string' || typeof endpoint !== 'string') {
    return { ok: false, reason: `the answer carries no ${missing.join(' and no ')} header` };
  }

  const bound = parseIdentityEndpoint(endpoint);
  if (bound === undefined) {
    return {
      ok: false,
      reason: `its ${SERVICE_IDENTITY_ENDPOINT_HEADER} ${quoteUntrusted(endpoint)} is not a host:port`,
    };
  }

  const expected = Buffer.from(computeServiceIdentityProof({ key, challenge, endpoint }), 'utf8');
  const presented = Buffer.from(proof, 'utf8');
  // `timingSafeEqual` needs equal lengths; a proof of another length is simply
  // not the proof, and the length of a correct one is public (43 characters).
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
    return {
      ok: false,
      reason: 'its proof was not made with the editor credential for this challenge',
    };
  }

  if (canonicalAddress(bound.host) === undefined) {
    return {
      ok: false,
      reason: `its proof is bound to ${quoteUntrusted(endpoint)}, a host name rather than an address`,
    };
  }
  const target = targetEndpoint(base);
  if (bound.port !== target.port || !isSameServiceHost(bound.host, target.host)) {
    return {
      ok: false,
      reason: `its proof is bound to ${quoteUntrusted(endpoint)}, not to ${target.display}`,
    };
  }
  return { ok: true };
}

/**
 * Release a response body without reading any of it. A body that cannot be
 * cancelled is already closed, errored or being read elsewhere, and in each
 * case there is nothing left for this process to release.
 *
 * @param {Response} response
 * @returns {Promise<void>}
 */
async function discardBody(response) {
  try {
    await response.body?.cancel();
  } catch {
    // Closed, errored or locked already: nothing remains to release.
  }
}

/**
 * The recovery hint for a listener that did not prove it is the service.
 *
 * @param {string} base service base URL this run targeted
 * @returns {string}
 */
function identityRefusedHint(base) {
  return [
    `Something answered at ${base}, but not with a proof made with the editor`,
    `credential in $DEBUGGEN_HOME/${AUTH_FILE_NAME}, so this command sent it nothing: that`,
    'credential authorises launching processes and minting server-agent credentials,',
    'and only the service that holds it may receive it.',
    '',
    'Likely causes:',
    '  - another process holds the port. Stop it, or point --service (or',
    '    DEBUGGEN_HOST and DEBUGGEN_PORT) at the address the service listens on.',
    '  - the proof names a different address: the service listens there, and this',
    '    command must dial exactly that address (127.0.0.1 and [::1] are two',
    '    different listeners to this check).',
    '  - the proof names a host name: the service runs with DEBUGGEN_HOST set to a',
    '    name such as localhost. A name can stand for more than one listener, so',
    '    only a proof naming an address is accepted. Restart the service with',
    `    DEBUGGEN_HOST=${DEFAULT_SERVICE_HOST} (the default) or ::1.`,
    '  - the running service is older than this checkout and does not answer the',
    '    identity challenge. Rebuild it, restart it, and re-run this command:',
    '',
    '      pnpm --filter @debuggen/local-service build',
    '',
    '  - the service runs with a different DEBUGGEN_HOME, so the editor credential',
    `    it holds is not the one in this ${AUTH_FILE_NAME}. Set DEBUGGEN_HOME to the`,
    "    service's session home, or restart the service with this one.",
  ].join('\n');
}

/**
 * @typedef {{ ok: true } | { ok: false, refused: boolean, error: DevInstrumentedError }} IdentityProbe
 *   what one probe of one address concluded: proven, or the failure it would
 *   raise — `refused` when something answered but did not prove its identity
 */

/**
 * Probe one address of the service: `GET {base}/health` with a fresh
 * {@link SERVICE_IDENTITY_CHALLENGE_HEADER} and no credential, judged by
 * {@link verifyServiceIdentity}. The answer's body is cancelled unread: the
 * status and the headers are all the probe needs.
 *
 * @param {string} base service base URL whose host is an IP address
 * @param {string} editorToken the proof's key; never sent
 * @returns {Promise<IdentityProbe>}
 */
async function probeServiceIdentity(base, editorToken) {
  const url = `${base}${HEALTH_PATH}`;
  const challenge = createServiceIdentityChallenge();

  /** @type {Response} */
  let response;
  try {
    response = await globalThis.fetch(url, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        [SERVICE_IDENTITY_CHALLENGE_HEADER]: challenge,
      },
      // Refused, not followed: the liveness of some other origin says nothing
      // about the service this command is about to launch a dev server against,
      // and the requests that follow this one carry the editor credential.
      redirect: 'error',
      signal: globalThis.AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === 'TimeoutError';
    const reason = timedOut ? `no answer within ${HEALTH_TIMEOUT_MS} ms` : describeCause(error);
    return {
      ok: false,
      refused: false,
      error: new DevInstrumentedError(`the local service is not answering ${url}: ${reason}`, {
        hint: serviceStartHint(base),
      }),
    };
  }

  await discardBody(response);

  if (!response.ok) {
    return {
      ok: false,
      refused: false,
      error: new DevInstrumentedError(`${url} answered ${statusLine(response)}`, {
        hint: serviceStartHint(base),
      }),
    };
  }

  const verdict = verifyServiceIdentity({
    key: editorToken,
    challenge,
    base,
    proof: response.headers.get(SERVICE_IDENTITY_PROOF_HEADER),
    endpoint: response.headers.get(SERVICE_IDENTITY_ENDPOINT_HEADER),
  });
  if (!verdict.ok) {
    return {
      ok: false,
      refused: true,
      error: new DevInstrumentedError(
        `the listener at ${url} did not prove it is the Debug Generator service holding the editor credential in $DEBUGGEN_HOME/${AUTH_FILE_NAME} (${verdict.reason}); the editor credential was not sent`,
        { hint: identityRefusedHint(base) },
      ),
    };
  }
  return { ok: true };
}

/**
 * @typedef {(hostname: string, options: { all: true, order: 'verbatim' }) =>
 *   Promise<ReadonlyArray<{ address: string, family: number }>>} AddressLookup
 *   `node:dns/promises` `lookup` with `all: true`, or a stand-in for tests
 */

/**
 * The service base URLs to probe for one configured base: the base itself when
 * its host is an IP address, otherwise one base per loopback address the host
 * name resolves to, in the resolver's order and without duplicates. An address
 * outside loopback is dropped, never probed.
 *
 * @param {string} base service base URL, as {@link resolveServiceBase} returned it
 * @param {AddressLookup} lookup name resolution
 * @returns {Promise<string[]>}
 * @throws {DevInstrumentedError} exit 2 when the name cannot be resolved, or
 *   resolves to no loopback address
 */
async function candidateServiceBases(base, lookup) {
  const url = new URL(base);
  const host = url.hostname;
  if (canonicalAddress(host) !== undefined) return [base];

  /** @type {unknown} */
  let resolved;
  try {
    resolved = await lookup(host, { all: true, order: 'verbatim' });
  } catch (error) {
    throw new DevInstrumentedError(
      `the service host ${host} could not be resolved: ${describeCause(error)}`,
      { hint: serviceStartHint(base) },
    );
  }

  /** @type {string[]} */
  const bases = [];
  for (const entry of Array.isArray(resolved) ? resolved : []) {
    const address =
      entry !== null && typeof entry === 'object' && typeof entry.address === 'string'
        ? canonicalAddress(entry.address)
        : undefined;
    if (address === undefined || !isLoopbackHostname(address)) continue;
    const pinned = new URL(base);
    pinned.hostname = address.includes(':') ? `[${address}]` : address;
    const candidate = `${pinned.origin}${pinned.pathname.replace(/\/+$/u, '')}`;
    if (!bases.includes(candidate)) bases.push(candidate);
  }
  if (bases.length === 0) {
    throw new DevInstrumentedError(`the service host ${host} resolves to no loopback address`, {
      hint: loopbackHint('--service (or DEBUGGEN_HOST)'),
    });
  }
  return bases;
}

/**
 * Pre-flight the service with its unauthenticated liveness route, have it
 * prove its identity before anything else is sent to it, and return the
 * address it proved it on — the base every later request of this run uses.
 *
 * Each probe carries a fresh {@link SERVICE_IDENTITY_CHALLENGE_HEADER} and no
 * credential. The answer must be 2xx and pass {@link verifyServiceIdentity}:
 * any local process can bind the service's port and answer 200, and every mode
 * goes on to send the editor credential — the one that authorises launches and
 * minting server-agent credentials — so a listener that cannot prove it holds
 * that credential is refused, and the credential is never sent to it.
 *
 * A proof names one IP address, so this command dials addresses, never a
 * name. A base whose host is an address is probed as it is. A host name —
 * `localhost` — is resolved here and each loopback address it stands for is
 * probed in the resolver's order, because on a dual-stack machine the name is
 * both `127.0.0.1` and `::1`, and a listener on the one the service did not
 * bind could relay the challenge to the service; its answer names the
 * service's address, not the one dialled, and is refused. The first address
 * that proves the service is returned, and every later request goes there
 * rather than to the name, so the credential is sent only to the listener
 * that proved it.
 *
 * @param {string} base service base URL
 * @param {string} editorToken editor credential from auth.json, the proof's key;
 *   never sent by this probe
 * @param {{ lookup?: AddressLookup }} [options] name resolution, for tests
 * @returns {Promise<string>} the proven base: `base` with its host replaced by
 *   the IP address that proved the service
 * @throws {DevInstrumentedError} exit 2 when no address answers 2xx with a
 *   proof of the service's identity
 * @throws {TypeError} when `editorToken` is not a non-empty string
 */
export async function checkServiceHealth(base, editorToken, options = {}) {
  if (typeof editorToken !== 'string' || editorToken === '') {
    throw new TypeError('checkServiceHealth needs the editor credential to verify the service');
  }
  const lookup = options.lookup ?? dnsLookup;
  const candidates = await candidateServiceBases(base, lookup);

  /** @type {Array<{ refused: boolean, error: DevInstrumentedError }>} */
  const failures = [];
  for (const candidate of candidates) {
    const probe = await probeServiceIdentity(candidate, editorToken);
    if (probe.ok) return candidate;
    failures.push(probe);
  }

  const [only] = failures;
  if (failures.length === 1 && only !== undefined) throw only.error;
  const host = new URL(base).hostname;
  throw new DevInstrumentedError(
    `none of the ${String(failures.length)} loopback addresses ${host} resolves to proved it is the Debug Generator service, so the editor credential was not sent: ${failures.map((failure) => failure.error.message).join('; ')}`,
    {
      hint: failures.some((failure) => failure.refused)
        ? identityRefusedHint(base)
        : serviceStartHint(base),
    },
  );
}

/** {@link RESPONSE_MAX_BYTES} in KiB, as messages state it. */
const RESPONSE_MAX_KIB = RESPONSE_MAX_BYTES / 1024;

/** A `Content-Length` value: decimal digits only. */
const CONTENT_LENGTH = /^\d+$/u;

/** One decoder for every answer; `decode` without `stream` keeps no state between calls. */
const UTF8_DECODER = new TextDecoder('utf-8');

/**
 * Read a response body as UTF-8 text, never holding more than `limit` bytes:
 * the chunks are counted as they arrive, and the stream is cancelled — the
 * rest of the body never read — as soon as the total passes `limit`. The bytes
 * are decoded once, at the end, the way `Response.text()` decodes them.
 *
 * A read that fails (the request's timeout firing, the connection dropping)
 * rejects with that failure, for the caller to report.
 *
 * @param {Response} response
 * @param {number} limit the most bytes accepted
 * @returns {Promise<string | undefined>} the text, or `undefined` when the body
 *   was longer than `limit`
 */
async function readBoundedText(response, limit) {
  const body = response.body;
  if (body === null) return '';

  const reader = body.getReader();
  /** @type {Uint8Array[]} */
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      try {
        await reader.cancel();
      } catch {
        // The stream errored as it was cancelled: nothing more will be read.
      }
      return undefined;
    }
    chunks.push(value);
  }
  return UTF8_DECODER.decode(Buffer.concat(chunks, total));
}

/**
 * The failure for an answer over {@link RESPONSE_MAX_BYTES}. It never quotes
 * the body, and it says what the unread answer leaves undetermined.
 *
 * @param {string} url the request's URL
 * @param {number} status the answer's status
 * @param {string | undefined} consequence what the request may already have done
 * @returns {DevInstrumentedError}
 */
function oversizedAnswer(url, status, consequence) {
  const lines = [
    "Every answer on the service's routes is a small JSON object, so an answer",
    `over ${RESPONSE_MAX_KIB} KiB is off-contract. It was neither parsed nor shown, and`,
    'nothing in it was acted on. The service log has the detail; a service that',
    'is older or newer than this checkout is rebuilt and restarted with:',
    '',
    '  pnpm --filter @debuggen/local-service build',
  ];
  if (consequence !== undefined) lines.push('', consequence);
  return new DevInstrumentedError(
    `${url} answered more than ${RESPONSE_MAX_KIB} KiB (status ${String(status)}); the reply was discarded unread`,
    { hint: lines.join('\n') },
  );
}

/**
 * POST JSON to the service with the editor credential as the bearer token,
 * and read the answer under the {@link RESPONSE_MAX_BYTES} cap.
 *
 * @param {object} request
 * @param {string} request.url absolute URL
 * @param {string} request.editorToken editor credential
 * @param {unknown} request.body JSON body
 * @param {string} [request.consequence] what the request may already have
 *   done when its answer has to be discarded, for the refusal's hint
 * @returns {Promise<{ status: number, statusText: string, json: unknown, text: string }>}
 * @throws {DevInstrumentedError} on a transport failure or timeout, and on an
 *   answer over {@link RESPONSE_MAX_BYTES}
 */
async function postJson({ url, editorToken, body, consequence }) {
  /** @type {Response} */
  let response;
  try {
    response = await globalThis.fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        authorization: `Bearer ${editorToken}`,
      },
      body: JSON.stringify(body),
      // Refused, not followed. `resolveServiceBase` accepted this origin as
      // loopback; a redirect would move this request — carrying the editor
      // credential in its `Authorization` header — to an origin nothing
      // accepted. The service answers its routes directly, so a 3xx is a
      // misconfiguration or a hostile listener, and either way the answer is to
      // stop rather than to follow.
      redirect: 'error',
      signal: globalThis.AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === 'TimeoutError';
    const reason = timedOut ? `no answer within ${REQUEST_TIMEOUT_MS} ms` : describeCause(error);
    throw new DevInstrumentedError(`request to ${url} failed: ${reason}`);
  }

  // A declared length over the cap is refused before a byte of the body is
  // read. An absent, malformed or understated one is no guarantee, so the read
  // below counts the bytes that actually arrive either way.
  const declared = (response.headers.get('content-length') ?? '').trim();
  if (CONTENT_LENGTH.test(declared) && Number(declared) > RESPONSE_MAX_BYTES) {
    await discardBody(response);
    throw oversizedAnswer(url, response.status, consequence);
  }

  // The body is read under the same timeout signal as the request. A body that
  // stalls or is cut off after the headers arrived is reported like any other
  // transport failure, so a caller's diagnostic (and `--spawn-local`'s
  // "nothing was spawned") is never replaced by a raw abort stack.
  /** @type {string | undefined} */
  let text;
  try {
    text = await readBoundedText(response, RESPONSE_MAX_BYTES);
  } catch (error) {
    const timedOut = error instanceof Error && error.name === 'TimeoutError';
    const reason = timedOut ? `no answer within ${REQUEST_TIMEOUT_MS} ms` : describeCause(error);
    throw new DevInstrumentedError(
      `request to ${url} failed while reading its ${String(response.status)} answer: ${reason}`,
    );
  }
  if (text === undefined) throw oversizedAnswer(url, response.status, consequence);

  /** @type {unknown} */
  let json;
  try {
    json = text === '' ? undefined : JSON.parse(text);
  } catch {
    json = undefined;
  }

  return { status: response.status, statusText: response.statusText, json, text };
}

/** The longest service-supplied reason a message carries, before the ellipsis. */
const REASON_MAX_LENGTH = 200;

/** The longest HTTP reason phrase a message carries, before the ellipsis. */
const STATUS_TEXT_MAX_LENGTH = 80;

/**
 * Every run of characters that could break a message's single line or act on
 * the terminal: whitespace (line and paragraph separators included), control
 * characters (C0, DEL and C1, so no escape sequence survives) and invisible
 * format characters (bidirectional overrides among them).
 */
const LINE_BREAKING_RUN = /[\s\p{Cc}\p{Cf}]+/gu;

/** Whether a string has anything visible once {@link LINE_BREAKING_RUN} is collapsed. */
const VISIBLE_CHARACTER = /[^\s\p{Cc}\p{Cf}]/u;

/**
 * Reduce service-supplied text to one bounded line for a message: every
 * {@link LINE_BREAKING_RUN} becomes a single space, the ends are trimmed, and
 * anything past `max` characters is cut and marked with `…`. A cut never
 * splits a surrogate pair.
 *
 * Call it on text that has already been redacted ({@link redactSecrets}):
 * bounding first could cut a credential in half, and half a credential no
 * longer matches the value being redacted.
 *
 * @example boundedLine('line one\n\tline two') // → 'line one line two'
 *
 * @param {string} value
 * @param {number} [max] longest result before the ellipsis
 * @returns {string} `''` when nothing visible remains
 */
function boundedLine(value, max = REASON_MAX_LENGTH) {
  const flat = value.replace(LINE_BREAKING_RUN, ' ').trim();
  if (flat.length <= max) return flat;
  let cut = flat.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return `${cut.trimEnd()}…`;
}

/**
 * `<status> <reason phrase>` for a message about a response. The reason phrase
 * is the service's own text, so it is treated like a body reason: every known
 * credential is redacted out of it first, and only then is it reduced to one
 * bounded line — bounding first could cut a credential in half, and half a
 * credential no longer matches the value being redacted.
 *
 * @param {{ status: number, statusText: string }} response
 * @param {readonly (string | undefined)[]} [secrets] credentials to redact
 * @returns {string}
 */
function statusLine(response, secrets = []) {
  const phrase = boundedLine(redactSecrets(response.statusText, secrets), STATUS_TEXT_MAX_LENGTH);
  return `${response.status} ${phrase}`.trimEnd();
}

/**
 * The reason a service response carries, raw: the first string with visible
 * text among the body's `message`, `error.message` and `error`, else the whole
 * response text. Raw on purpose — {@link withReason} redacts it and only then
 * reduces it to one bounded line, whichever path it came from.
 *
 * @param {{ json: unknown, text: string }} response
 * @returns {string}
 */
function responseReason({ json, text }) {
  if (typeof json === 'object' && json !== null) {
    const record = /** @type {Record<string, unknown>} */ (json);
    const error = record.error;
    const nested =
      typeof error === 'object' && error !== null
        ? /** @type {Record<string, unknown>} */ (error).message
        : undefined;
    for (const candidate of [record.message, nested, error]) {
      if (typeof candidate === 'string' && VISIBLE_CHARACTER.test(candidate)) return candidate;
    }
  }
  return text;
}

/**
 * Remove any credential this process knows about from text that is about to be
 * printed. A service is not expected to echo a bearer token back in an error
 * body, but a diagnostic that did would put a credential in a terminal and a
 * scrollback buffer, and this command echoes the reason a service error gives.
 *
 * @param {string} text
 * @param {readonly (string | undefined)[]} secrets
 * @returns {string}
 */
function redactSecrets(text, secrets) {
  let result = text;
  for (const secret of secrets) {
    if (typeof secret !== 'string' || secret.length < 8) continue;
    result = result.split(secret).join('[redacted]');
  }
  return result;
}

/**
 * Append the service's reason to a message when there is one: any known
 * credential is redacted out of it first, and the result is then reduced to a
 * single line of at most {@link REASON_MAX_LENGTH} characters plus `…`, for a
 * JSON field and a raw body alike.
 *
 * @param {string} message
 * @param {{ json: unknown, text: string }} response
 * @param {readonly (string | undefined)[]} [secrets] credentials to redact
 * @returns {string}
 */
function withReason(message, response, secrets = []) {
  const reason = boundedLine(redactSecrets(responseReason(response), secrets));
  return reason === '' ? message : `${message}: ${reason}`;
}

/**
 * The recovery hint for "the service refused the editor credential". Shared by
 * every authorised call so the paths give identical advice.
 *
 * @param {string} projectRoot project the call named
 * @returns {string}
 */
function credentialRejectedHint(projectRoot) {
  return [
    `The credential in ${AUTH_FILE_NAME} is stale, was rotated, or does not cover`,
    `${toPosix(projectRoot)}. An editor credential may act only on projects under`,
    'the workspace folders the editor announced, so open that project in VS Code,',
    'or restart the service (debuggen.rotateServiceToken rewrites the file), then',
    're-run this command.',
  ].join('\n');
}

/**
 * The recovery hint for "this service build does not implement the route".
 * A 404 or 405 on one of {@link SERVICE_ROUTES} is a version mismatch, not an
 * invitation to look for the endpoint somewhere else.
 *
 * @param {string} route service route that answered 404/405
 * @returns {string}
 */
function routeAbsentHint(route) {
  return [
    `${route} is one of the service routes this checkout defines, so a service`,
    'that does not answer it is older or newer than this checkout. Rebuild and',
    'restart it:',
    '',
    '  pnpm --filter @debuggen/local-service build',
    '',
    'then re-run this command. Do not point this command at a different path:',
    "the routes it calls are the service's own, and guessing one produces an",
    'answer no service actually vouched for.',
  ].join('\n');
}

/**
 * @typedef {object} LaunchResult
 * @property {string | undefined} devServerUrl URL the service reports
 * @property {number | undefined} pid process id the service reports
 */

/**
 * Ask the service to launch the project through its own launcher:
 * `POST /dev-server/launch` with `{ projectRoot }`, authorised by the editor
 * credential.
 *
 * This mode never handles a server-agent credential. The service mints one for
 * the process it starts, scopes it to that project root and revokes it when the
 * process exits, passing it straight to its own child. The only
 * route that hands a credential to this command is {@link CREDENTIAL_PATH},
 * which `--spawn-local` alone calls (see {@link requestServerAgentCredential}).
 *
 * @param {object} request
 * @param {string} request.base service base URL, without a trailing slash
 * @param {string} request.editorToken editor credential from auth.json
 * @param {string} request.projectRoot absolute path of the target project
 * @returns {Promise<LaunchResult>} what the service reports about the process
 * @throws {DevInstrumentedError} exit 2 when the launch is refused, or when the
 *   answer does not carry the `devServerUrl` the contract promises
 */
export async function launchDevServer({ base, editorToken, projectRoot }) {
  const url = `${base}${LAUNCH_PATH}`;
  const response = await postJson({
    url,
    editorToken,
    body: { projectRoot },
    consequence: [
      'The service may have started a dev server before it answered. Stop it with:',
      '',
      `  node scripts/dev-instrumented.mjs --stop --project ${toPosix(projectRoot)}`,
    ].join('\n'),
  });

  if (response.status === 401 || response.status === 403) {
    throw new DevInstrumentedError(
      withReason(`the service rejected the editor credential at ${LAUNCH_PATH}`, response, [
        editorToken,
      ]),
      { hint: credentialRejectedHint(projectRoot) },
    );
  }
  if (ROUTE_ABSENT_STATUSES.includes(response.status)) {
    throw new DevInstrumentedError(
      `the service answered ${response.status} for ${LAUNCH_PATH}; nothing was launched`,
      { hint: routeAbsentHint(LAUNCH_PATH) },
    );
  }
  if (response.status < 200 || response.status >= 300) {
    throw new DevInstrumentedError(
      withReason(`${url} answered ${statusLine(response, [editorToken])}`, response, [editorToken]),
      {
        hint:
          response.status === 409
            ? [
                'Another session already owns a dev server for this project. End that',
                'session in VS Code, or stop the server with:',
                '',
                `  node scripts/dev-instrumented.mjs --stop --project ${toPosix(projectRoot)}`,
              ].join('\n')
            : 'Nothing was launched. The service log has the detail behind that status.',
      },
    );
  }

  const record =
    typeof response.json === 'object' && response.json !== null
      ? /** @type {Record<string, unknown>} */ (response.json)
      : {};
  const devServerUrl = typeof record.devServerUrl === 'string' ? record.devServerUrl : undefined;
  const pid =
    typeof record.pid === 'number' && Number.isInteger(record.pid) ? record.pid : undefined;

  // The protocol's response is `{ devServerUrl, pid }`. A 2xx without a URL is
  // reported rather than accepted: the developer needs the address to open the
  // app, and silently printing "(not reported)" for the whole answer would hide
  // a definer that has drifted from the contract this caller was written
  // against. `pid` is informational and stays optional, because the launcher may
  // adopt a dev server it detected rather than one it spawned.
  if (devServerUrl === undefined) {
    throw new DevInstrumentedError(`${url} answered ${response.status} without a devServerUrl`, {
      hint: [
        `${LAUNCH_PATH} answers { devServerUrl, pid }. This service`,
        'returned neither a devServerUrl nor an error, so it does not match the',
        'contract this command was built against, and a dev server may have',
        'started without this command being able to name it. Check the service',
        'log, and stop any process it started with:',
        '',
        `  node scripts/dev-instrumented.mjs --stop --project ${toPosix(projectRoot)}`,
      ].join('\n'),
    });
  }

  return { devServerUrl, pid };
}

/**
 * Ask the service to stop the dev server it launched for this project:
 * `POST /dev-server/stop` with the same `{ projectRoot }`.
 *
 * Called when the foreground run is interrupted and by `--stop`. A failure is
 * reported rather than swallowed: the dev server is the service's child, so a
 * stop that did not happen leaves a process running that this command cannot
 * reach.
 *
 * @param {object} request
 * @param {string} request.base service base URL, without a trailing slash
 * @param {string} request.editorToken editor credential from auth.json
 * @param {string} request.projectRoot absolute path of the target project
 * @returns {Promise<void>}
 * @throws {DevInstrumentedError} exit 2 when the stop is refused
 */
export async function stopDevServer({ base, editorToken, projectRoot }) {
  const url = `${base}${STOP_PATH}`;
  const response = await postJson({
    url,
    editorToken,
    body: { projectRoot },
    consequence: [
      'The dev server may still be running under the service. Retry with',
      '--stop, or end the session in VS Code, which stops the process it owns.',
    ].join('\n'),
  });

  if (response.status === 401 || response.status === 403) {
    throw new DevInstrumentedError(
      withReason(`the service rejected the editor credential at ${STOP_PATH}`, response, [
        editorToken,
      ]),
      { hint: credentialRejectedHint(projectRoot) },
    );
  }
  if (ROUTE_ABSENT_STATUSES.includes(response.status)) {
    throw new DevInstrumentedError(
      `the service answered ${response.status} for ${STOP_PATH}; the dev server is still running`,
      { hint: routeAbsentHint(STOP_PATH) },
    );
  }
  if (response.status < 200 || response.status >= 300) {
    throw new DevInstrumentedError(
      withReason(`${url} answered ${statusLine(response, [editorToken])}`, response, [editorToken]),
      {
        hint: [
          'The dev server may still be running under the service. Retry with',
          '--stop, or end the session in VS Code, which stops the process it owns.',
        ].join('\n'),
      },
    );
  }
}

/**
 * @typedef {object} ServerAgentCredential
 * @property {string} token the server-agent credential; held in this process's
 *   memory and in the child's environment only — this command never prints,
 *   logs or writes it
 * @property {number} expiresAt epoch milliseconds at which the first lease
 *   ends: the service refuses the credential from then on unless it has
 *   renewed the lease for a connected dev server, and it revokes the
 *   credential earlier once that dev server disconnects
 */

/**
 * The keys of a `POST /dev-server/credential` answer, exactly: the service's
 * response schema (`devServerCredentialResponseSchema`) is strict, so any other
 * key means the definer has drifted from the contract this caller consumes.
 */
const CREDENTIAL_RESPONSE_KEYS = Object.freeze(['token', 'expiresAt']);

/**
 * Characters a bearer credential can never contain. The preload presents the
 * token as `Authorization: Bearer <token>` and in its `client.hello`, and an
 * HTTP header value cannot carry a control character, so a token with one — or
 * with whitespace, which would split the header's credential — is unusable.
 */
const TOKEN_FORBIDDEN_CHARACTERS = /[\s\p{Cc}]/u;

/**
 * The `token` field of a parsed response body, when it has a string one. Used
 * only to add that value to the redaction list of a refusal: a service is not
 * expected to put a credential in an error body, but one that did must not have
 * it printed.
 *
 * @param {unknown} json parsed body
 * @returns {string | undefined}
 */
function tokenField(json) {
  if (typeof json !== 'object' || json === null) return undefined;
  const token = /** @type {Record<string, unknown>} */ (json).token;
  return typeof token === 'string' ? token : undefined;
}

/**
 * Validate a 2xx `POST /dev-server/credential` body against the service's
 * strict `{ token, expiresAt }` shape. A failure is described in words that
 * never quote the body — not a value, not a key name — because the body carries
 * a credential by definition.
 *
 * @param {unknown} json parsed body
 * @param {number} now epoch milliseconds the expiry is judged against
 * @returns {{ credential: ServerAgentCredential, problem?: undefined } | { credential?: undefined, problem: string }}
 */
function parseCredentialAnswer(json, now) {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    return { problem: 'the body is not a JSON object' };
  }
  const record = /** @type {Record<string, unknown>} */ (json);
  const { token, expiresAt } = record;

  if (typeof token !== 'string' || token === '') {
    return { problem: 'it carries no non-empty string token' };
  }
  if (TOKEN_FORBIDDEN_CHARACTERS.test(token)) {
    return { problem: 'its token contains whitespace or control characters' };
  }
  // A finite number is not enough: `Date` rejects anything beyond ±8.64e15 ms,
  // and the banner renders the expiry as an ISO time.
  if (
    typeof expiresAt !== 'number' ||
    !Number.isFinite(expiresAt) ||
    Number.isNaN(new Date(expiresAt).getTime())
  ) {
    return { problem: 'its expiresAt is not an epoch-millisecond number' };
  }
  if (expiresAt <= now) {
    return { problem: 'its expiresAt has already passed' };
  }
  if (Object.keys(record).some((key) => !CREDENTIAL_RESPONSE_KEYS.includes(key))) {
    return { problem: 'it carries fields other than token and expiresAt' };
  }
  return { credential: { token, expiresAt } };
}

/**
 * Ask the service for a server-agent credential scoped to one project root:
 * `POST /dev-server/credential` with `{ projectRoot }`, authorised by the
 * editor credential and answered with `{ token, expiresAt }` (the route and
 * both strict body schemas are defined in
 * `apps/local-service/src/dev-server/launcher.ts`).
 *
 * This is what makes `--spawn-local` an authenticated run: the
 * token becomes the child's `DEBUGGEN_TOKEN`, and the preload presents it on
 * ingest and in its `client.hello`, where the service accepts it only for this
 * project root. The service mints one only for a project under the workspace
 * folders the connected editor announced, and answers 403 otherwise.
 *
 * No answer is accepted on trust. A 2xx whose body is not exactly
 * `{ token, expiresAt }` with a usable token and a future expiry is refused:
 * handing the child an unusable credential would start a dev server that only
 * looks instrumented. Nothing here retries or tries another path.
 *
 * No message ever carries a credential. The editor token — and any token a
 * refusal's body happens to carry — is redacted from the reason that is
 * echoed, and a 2xx body is never echoed at all. The credential returned here
 * exists only in this process's memory and in the environment of the child it
 * is handed to.
 *
 * Its lifetime is the service's to manage: `expiresAt` ends a first lease of 5
 * minutes, which the service renews while the dev server's preload holds its
 * server-agent control connection. The service revokes the credential once
 * that connection has been gone for 20 seconds — shortly after the dev server
 * exits — at the end of the first lease when no preload ever connected, and
 * when it shuts down; a lease nothing renews lapses within 5 minutes of its
 * last renewal, and `debuggen.rotateServiceToken` revokes it at once. This
 * function neither renews nor releases it: `--spawn-local` hands it back
 * through {@link releaseServerAgentCredential} once its dev server has
 * exited, so the service revokes it then rather than when its supervision
 * notices.
 *
 * @param {object} request
 * @param {string} request.base service base URL, without a trailing slash
 * @param {string} request.editorToken editor credential from auth.json
 * @param {string} request.projectRoot absolute path of the target project
 * @returns {Promise<ServerAgentCredential>} the minted credential and the end
 *   of its first lease
 * @throws {DevInstrumentedError} exit 2 when the service refuses, does not
 *   implement the route, or answers off-contract
 */
export async function requestServerAgentCredential({ base, editorToken, projectRoot }) {
  const url = `${base}${CREDENTIAL_PATH}`;
  const response = await postJson({
    url,
    editorToken,
    body: { projectRoot },
    consequence: [
      'A credential the service may have minted for this request is never used:',
      'no preload connects with it, so the service revokes it at the end of its',
      'first lease.',
    ].join('\n'),
  });
  const secrets = [editorToken, tokenField(response.json)];

  if (response.status === 401 || response.status === 403) {
    const hint = credentialRejectedHint(projectRoot);
    throw new DevInstrumentedError(
      withReason(
        `the service rejected the editor credential at ${CREDENTIAL_PATH} with ${response.status}`,
        response,
        secrets,
      ),
      {
        hint:
          response.status === 403
            ? [
                hint,
                '',
                `A 403 can also mean that ${toPosix(projectRoot)} is outside the`,
                'workspace folders VS Code announced to the service: it mints a',
                'server-agent credential only for a project the connected editor has',
                'open. Open the project in VS Code with the Debug Generator extension',
                'connected, then re-run this command.',
              ].join('\n')
            : hint,
      },
    );
  }
  if (ROUTE_ABSENT_STATUSES.includes(response.status)) {
    throw new DevInstrumentedError(
      `the service answered ${response.status} for ${CREDENTIAL_PATH}; no server-agent credential was minted`,
      { hint: routeAbsentHint(CREDENTIAL_PATH) },
    );
  }
  if (response.status < 200 || response.status >= 300) {
    throw new DevInstrumentedError(
      withReason(`${url} answered ${statusLine(response, secrets)}`, response, secrets),
      {
        hint: 'No server-agent credential was minted. The service log has the detail behind that status.',
      },
    );
  }

  const answer = parseCredentialAnswer(response.json, Date.now());
  if (answer.credential === undefined) {
    throw new DevInstrumentedError(
      `${url} answered ${response.status} off-contract: ${answer.problem}`,
      {
        hint: [
          `${CREDENTIAL_PATH} answers exactly { token, expiresAt }: a non-empty`,
          'credential and its expiry in epoch milliseconds. This service did not,',
          'so it does not match the contract this command was built against. The',
          'body is not shown because it may carry a credential. Rebuild and restart',
          'the service:',
          '',
          '  pnpm --filter @debuggen/local-service build',
        ].join('\n'),
      },
    );
  }
  return answer.credential;
}

/**
 * The keys of a `POST /credentials/release` answer, exactly: the service's
 * response schema for the `credentials.release` operation is strict, so any
 * other key means the definer has drifted from the contract this caller
 * consumes.
 */
const RELEASE_RESPONSE_KEYS = Object.freeze(['released']);

/**
 * Validate a 2xx `POST /credentials/release` body against the service's strict
 * `{ released: boolean }` shape. A failure is described in words that never
 * quote the body — not a value, not a key name — for the reason
 * {@link parseCredentialAnswer} gives: the request carried a credential, and an
 * answer that is off-contract may carry it back.
 *
 * @param {unknown} json parsed body
 * @returns {{ released: boolean, problem?: undefined } | { released?: undefined, problem: string }}
 */
function parseReleaseAnswer(json) {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    return { problem: 'the body is not a JSON object' };
  }
  const record = /** @type {Record<string, unknown>} */ (json);
  const { released } = record;
  if (typeof released !== 'boolean') {
    return { problem: 'it carries no boolean released' };
  }
  if (Object.keys(record).some((key) => !RELEASE_RESPONSE_KEYS.includes(key))) {
    return { problem: 'it carries fields other than released' };
  }
  return { released };
}

/**
 * The recovery hint for a release the service refused on the editor
 * credential. There is nothing to re-run: the credential being released has
 * no further use either way, and the hint says what still ends it.
 *
 * @returns {string}
 */
function releaseRejectedHint() {
  return [
    `The editor credential in ${AUTH_FILE_NAME} is stale or was rotated while the dev`,
    'server ran. A rotation (debuggen.rotateServiceToken) revokes every server-agent',
    'credential with it, so it has already ended this one; otherwise the service',
    "ends it 20 seconds after the dev server's preload disconnects, or at the end of",
    'its lease.',
  ].join('\n');
}

/**
 * Hand a server-agent credential back to the service that minted it:
 * `POST /credentials/release` with `{ token }`, authorised by the editor
 * credential, answered with `{ released }`.
 *
 * `--spawn-local` calls it once the credential it obtained through
 * {@link requestServerAgentCredential} has no further use — its dev server
 * exited, or could not be started — so the credential stops authenticating
 * at that moment rather than when the service's lease supervision notices the
 * dev server is gone (20 seconds after its preload disconnects, or at the end
 * of the lease). The caller proves the service's identity again first
 * ({@link checkServiceHealth}); this function sends the request and judges the
 * answer, nothing else.
 *
 * `true` means the service revoked the credential on this request; `false`
 * means nothing was live under the token any more — its supervision had
 * already revoked it, the lease lapsed, or a rotation retired it — which is a
 * success too: either way the credential no longer works. It is one request:
 * nothing here retries, backs off or tries another path.
 *
 * No message ever carries either credential. Both are redacted from every
 * reason and status phrase that is echoed, and a 2xx body is never echoed at
 * all, because it answers a request that carried the server-agent
 * credential.
 *
 * @example
 * const released = await releaseServerAgentCredential({ base, editorToken, token });
 * // → true (revoked now) or false (already gone); throws when not released
 *
 * @param {object} request
 * @param {string} request.base service base URL at the address that proved the
 *   service, without a trailing slash
 * @param {string} request.editorToken editor credential from auth.json, sent as
 *   the bearer token
 * @param {string} request.token the server-agent credential to release, sent as
 *   the body's `token`
 * @returns {Promise<boolean>} whether the service revoked the credential on this
 *   request (`false`: nothing was live under it any more)
 * @throws {DevInstrumentedError} when the service refused the editor credential
 *   (401, 403), does not implement the route (404, 405), answered any other
 *   non-2xx status (a 500 `CLEANUP_PARTIAL` among them: a revocation the
 *   service has not completed and keeps retrying), answered off-contract, or
 *   could not be reached
 * @throws {TypeError} when `token` is not a non-empty string
 */
export async function releaseServerAgentCredential({ base, editorToken, token }) {
  if (typeof token !== 'string' || token === '') {
    throw new TypeError(
      'releaseServerAgentCredential needs the server-agent credential to release',
    );
  }
  const url = `${base}${RELEASE_PATH}`;
  const secrets = [editorToken, token];
  const response = await postJson({
    url,
    editorToken,
    body: { token },
    consequence: [
      'The service may have released the credential before it answered. If it did',
      "not, it revokes it 20 seconds after the dev server's preload disconnects, or",
      'at the end of its lease.',
    ].join('\n'),
  });

  if (response.status === 401 || response.status === 403) {
    throw new DevInstrumentedError(
      withReason(
        `the service rejected the editor credential at ${RELEASE_PATH} with ${response.status}`,
        response,
        secrets,
      ),
      { hint: releaseRejectedHint() },
    );
  }
  if (ROUTE_ABSENT_STATUSES.includes(response.status)) {
    throw new DevInstrumentedError(
      `the service answered ${response.status} for ${RELEASE_PATH}: it does not implement the release route, so nothing was released`,
      { hint: routeAbsentHint(RELEASE_PATH) },
    );
  }
  if (response.status < 200 || response.status >= 300) {
    throw new DevInstrumentedError(
      withReason(`${url} answered ${statusLine(response, secrets)}`, response, secrets),
      {
        hint: [
          'The credential was not released by this request, and nothing here retries it.',
          'A revocation the service has begun and not completed (CLEANUP_PARTIAL) it',
          'keeps retrying on its own. The service log has the detail behind that status.',
        ].join('\n'),
      },
    );
  }

  const answer = parseReleaseAnswer(response.json);
  if (answer.released === undefined) {
    throw new DevInstrumentedError(
      `${url} answered ${response.status} off-contract: ${answer.problem}`,
      {
        hint: [
          `${RELEASE_PATH} answers exactly { released }, a boolean. This service did`,
          'not, so it does not match the contract this command was built against, and',
          'whether it released the credential is unknown. The body is not shown because',
          'it may carry a credential. Rebuild and restart the service:',
          '',
          '  pnpm --filter @debuggen/local-service build',
        ].join('\n'),
      },
    );
  }
  return answer.released;
}

/**
 * @typedef {object} ResolvedProject
 * @property {string} dir absolute path of the project directory
 * @property {string} label how the project is named in output, with control
 *   and format characters of its package name escaped visibly
 * @property {string | undefined} packageName the project's package name
 * @property {boolean} inRepo whether it lives inside this repository
 */

/**
 * Resolve the target project and confirm it is launchable.
 *
 * The default is the bundled demo application inside this repository; an
 * explicit `--project` is resolved against the current directory, so
 * `--project ../my-app` works from anywhere. Only two things are read from the
 * project: its package name (for pnpm's `--filter`) and whether it declares a
 * `dev` script. Detecting an already-running server, or inferring a start
 * command from anything other than that script, is the launcher's job.
 *
 * @param {object} [options]
 * @param {string} [options.root] repository root
 * @param {string} [options.project] raw `--project` value
 * @param {string} [options.cwd] directory relative paths resolve against
 * @returns {Promise<ResolvedProject>}
 * @throws {DevInstrumentedError} exit 2 when the project cannot be launched
 */
export async function resolveProject(options = {}) {
  const root = options.root ?? REPO_ROOT;
  const cwd = options.cwd ?? process.cwd();
  const dir =
    options.project === undefined
      ? path.join(root, ...DEFAULT_PROJECT_REL.split('/'))
      : path.resolve(cwd, options.project);

  const relative = path.relative(root, dir);
  const inRepo = relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
  const manifestPath = path.join(dir, 'package.json');

  /** @type {string} */
  let manifestRaw;
  try {
    manifestRaw = await fs.promises.readFile(manifestPath, 'utf8');
  } catch (error) {
    if (isErrnoCode(error, 'ENOENT') || isErrnoCode(error, 'ENOTDIR')) {
      throw new DevInstrumentedError(`no package.json in ${display(root, dir)}`, {
        hint: [
          'Point --project at a Node project directory that has a package.json',
          'with a "dev" script. With no --project this command launches',
          `${DEFAULT_PROJECT_REL} from this repository.`,
        ].join('\n'),
      });
    }
    throw new DevInstrumentedError(
      `cannot read ${display(root, manifestPath)}: ${describeCause(error)}`,
    );
  }

  /** @type {unknown} */
  let manifest;
  try {
    manifest = JSON.parse(manifestRaw);
  } catch (error) {
    throw new DevInstrumentedError(
      `${display(root, manifestPath)} is not valid JSON: ${describeCause(error)}`,
    );
  }

  const record =
    typeof manifest === 'object' && manifest !== null
      ? /** @type {Record<string, unknown>} */ (manifest)
      : {};
  const packageName =
    typeof record.name === 'string' && record.name !== '' ? record.name : undefined;
  const scripts =
    typeof record.scripts === 'object' && record.scripts !== null
      ? /** @type {Record<string, unknown>} */ (record.scripts)
      : {};

  // The name is the project's own text and reaches the terminal in every
  // message and banner that names the project, so it is shown with control and
  // format characters (bidirectional overrides included) escaped visibly. The
  // raw value is kept only for `pnpm --filter`, which validates it first.
  const shownName = packageName === undefined ? undefined : escapeInvisible(packageName);

  if (typeof scripts.dev !== 'string' || scripts.dev.trim() === '') {
    throw new DevInstrumentedError(
      `${shownName ?? display(root, dir)} has no "dev" script to instrument`,
      {
        hint: [
          "This command attaches the preload to the project's own development",
          'server, so the project must declare a "dev" script. Add one, or point',
          '--project at a project that has one.',
        ].join('\n'),
      },
    );
  }

  const label =
    shownName === undefined ? display(root, dir) : `${display(root, dir)} (${shownName})`;
  return { dir, label, packageName, inRepo };
}

/**
 * Find an executable on `PATH` without spawning a shell. On Windows the
 * `PATHEXT` extensions are tried in order, which is how `pnpm` resolves to
 * `pnpm.cmd`.
 *
 * @param {string} name bare command name
 * @param {NodeJS.ProcessEnv} [env]
 * @param {NodeJS.Platform} [platform] selects the Windows `PATHEXT` rule;
 *   injectable so the suite can exercise that rule on a POSIX host (directory
 *   separators stay the host's)
 * @returns {string | undefined} absolute path, or `undefined` when not found
 */
export function lookupExecutable(name, env = process.env, platform = process.platform) {
  const rawPath = env.PATH ?? env.Path ?? '';
  if (rawPath === '') return undefined;

  const extensions =
    platform === 'win32'
      ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter((value) => value !== '')
      : [''];

  for (const entry of rawPath.split(path.delimiter)) {
    if (entry === '') continue;
    for (const extension of extensions) {
      const candidate = path.join(entry, `${name}${extension}`);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        const stats = fs.statSync(candidate);
        if (stats.isFile()) return candidate;
      } catch {
        // Not executable, not there, or not readable: try the next candidate.
      }
    }
  }
  return undefined;
}

/**
 * @typedef {object} LaunchCommand
 * @property {string} file executable to spawn
 * @property {string[]} args argv for it
 * @property {string} cwd working directory for the child
 * @property {string} display human-readable form of the command
 * @property {boolean} [windowsVerbatimArguments] pass `args` to the Windows
 *   process verbatim instead of re-quoting them; set only by
 *   {@link wrapForPlatform}, whose `cmd.exe` command line is already quoted and
 *   escaped
 */

/** The longest package name npm accepts. */
const NPM_NAME_MAX_LENGTH = 214;

/**
 * npm's package-name alphabet: lowercase letters, digits, `-`, `.` and `_`,
 * not starting with `.` or `_`, optionally under one `@scope/` — the pattern
 * npm documents for `package.json` `name`, which also admits the legacy `~`
 * and a scope's `*` that {@link NPM_NAME_SPECIAL_CHARACTERS} then refuses. None
 * of cmd.exe's metacharacters (`& | < > ^ " % ! ( ) ; ,`, space) can match it.
 */
const NPM_NAME_PATTERN = /^(?:@[a-z0-9-*~][a-z0-9-*._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/u;

/** Characters npm no longer accepts in a new package name, though the pattern admits two of them. */
const NPM_NAME_SPECIAL_CHARACTERS = /[~'!()*]/u;

/**
 * Every character that could act on a terminal or disguise what a message
 * says: control characters (C0, DEL, C1), the two Unicode line separators, and
 * invisible format characters — bidirectional overrides and isolates
 * (U+202A–U+202E, U+2066–U+2069), zero-width characters and the like — which
 * can reorder or hide the text around them.
 */
const TERMINAL_UNSAFE_CHARACTER = /[\p{Cc}\p{Cf}\u2028\u2029]/gu;

/**
 * Replace every {@link TERMINAL_UNSAFE_CHARACTER} with a visible `\uXXXX`
 * (or `\u{XXXXX}`) escape, leaving everything else as it is. Used on text read
 * from a target project's `package.json` before it reaches any message.
 *
 * @example escapeInvisible('a\u202eb') // → 'a\\u202eb'
 *
 * @param {string} value
 * @returns {string}
 */
function escapeInvisible(value) {
  return value.replace(TERMINAL_UNSAFE_CHARACTER, (character) => {
    const hex = (character.codePointAt(0) ?? 0).toString(16);
    return hex.length > 4 ? `\\u{${hex}}` : `\\u${hex.padStart(4, '0')}`;
  });
}

/**
 * Render an untrusted string for a one-line message: JSON-quoted, with every
 * {@link TERMINAL_UNSAFE_CHARACTER} that `JSON.stringify` leaves raw (C1
 * controls, the line separators, bidirectional and other format characters)
 * escaped visibly, and cut short so a pathological value cannot flood the
 * output.
 *
 * @param {string} value
 * @returns {string}
 */
function quoteUntrusted(value) {
  const limit = 80;
  const shortened = value.length > limit ? `${value.slice(0, limit)}…` : value;
  return escapeInvisible(JSON.stringify(shortened));
}

/**
 * Why a `package.json` `name` cannot be handed to `pnpm --filter`, or
 * `undefined` when it can. The rules are npm's for a new package name, plus one
 * of pnpm's: a trailing `...` would turn the filter into a "this package and
 * its dependencies" selector and start more than one dev server.
 *
 * @param {string} name
 * @returns {string | undefined}
 */
function packageNameProblem(name) {
  if (name.length > NPM_NAME_MAX_LENGTH) {
    return `is longer than the ${NPM_NAME_MAX_LENGTH} characters npm allows`;
  }
  if (NPM_NAME_SPECIAL_CHARACTERS.test(name)) {
    return "contains one of ~ ' ! ( ) *, which npm does not allow in a package name";
  }
  if (!NPM_NAME_PATTERN.test(name)) {
    return 'is not a valid npm package name: only lowercase a-z, 0-9, "-", "." and "_" are allowed, not first "." or "_", optionally under one "@scope/"';
  }
  if (name.endsWith('...')) {
    return 'ends in "...", which pnpm --filter reads as a dependency selector';
  }
  return undefined;
}

/**
 * The command interpreter to run a `.cmd`/`.bat` launcher through: `ComSpec`
 * from the environment the child inherits, matched case-insensitively as
 * Windows does, else `cmd.exe`.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {string}
 */
function commandInterpreter(env) {
  for (const [key, value] of Object.entries(env)) {
    if (key.toLowerCase() === 'comspec' && typeof value === 'string' && value.trim() !== '') {
      return value.trim();
    }
  }
  return 'cmd.exe';
}

/**
 * Build the command that runs the project's `dev` script.
 *
 * Inside this repository pnpm's workspace filter is used from the repository
 * root, so the child sees the same resolution `pnpm dev` would give it.
 * Elsewhere — or when pnpm is not installed — the project's own package
 * manager script is run from the project directory.
 *
 * The filter form puts the target's `package.json` `name` on the command line,
 * which on Windows passes through `cmd.exe` (see {@link wrapForPlatform}). The
 * name is therefore validated as an npm package name first, and one that is not
 * is an error rather than a reason to fall back to another form: whatever wrote
 * it, it is not a name pnpm could select.
 *
 * @param {object} request
 * @param {ResolvedProject} request.project
 * @param {string} [request.root] repository root
 * @param {NodeJS.ProcessEnv} [request.env] environment to search and inherit
 * @param {NodeJS.Platform} [request.platform] platform whose launch rules apply
 * @returns {LaunchCommand}
 * @throws {DevInstrumentedError} exit 2 when no package manager is on PATH, or
 *   when the project's package name is not a valid npm package name
 */
export function buildLaunchCommand({
  project,
  root = REPO_ROOT,
  env = process.env,
  platform = process.platform,
}) {
  const pnpmPath = lookupExecutable('pnpm', env, platform);
  const npmPath = pnpmPath === undefined ? lookupExecutable('npm', env, platform) : undefined;
  const wrapping = { platform, comSpec: commandInterpreter(env) };

  if (pnpmPath === undefined && npmPath === undefined) {
    throw new DevInstrumentedError('neither pnpm nor npm is on PATH', {
      hint: [
        'This repository pins pnpm 12.4.2 through corepack:',
        '',
        '  corepack enable && corepack prepare pnpm@12.4.2 --activate',
      ].join('\n'),
    });
  }

  if (pnpmPath !== undefined && project.inRepo && project.packageName !== undefined) {
    const problem = packageNameProblem(project.packageName);
    if (problem !== undefined) {
      throw new DevInstrumentedError(
        `the package name ${quoteUntrusted(project.packageName)} in ${display(root, path.join(project.dir, 'package.json'))} ${problem}`,
        {
          hint: [
            'For a project inside this repository this command runs',
            '`pnpm --filter <name> dev`, so the name becomes a command-line argument',
            '(on Windows, one that passes through cmd.exe). Only a valid npm package',
            'name is accepted there: fix the "name" field of that package.json.',
          ].join('\n'),
        },
      );
    }
    return wrapForPlatform(
      {
        file: pnpmPath,
        args: ['--filter', project.packageName, 'dev'],
        cwd: root,
        display: `pnpm --filter ${project.packageName} dev`,
      },
      wrapping,
    );
  }

  const manager = pnpmPath ?? /** @type {string} */ (npmPath);
  const managerName = pnpmPath === undefined ? 'npm' : 'pnpm';
  return wrapForPlatform(
    {
      file: manager,
      args: ['run', 'dev'],
      cwd: project.dir,
      display: `${managerName} run dev`,
    },
    wrapping,
  );
}

/**
 * cmd.exe's metacharacters: every character its parser gives a meaning to
 * (grouping, expansion, escaping, quoting, redirection, piping, command
 * chaining, token delimiting, wildcards). The same set cross-spawn escapes.
 * Global, so it is used only with `String.prototype.replace`.
 */
const CMD_METACHARACTERS = /([()\][%!^"`<>&|;, *?])/gu;

/**
 * Escape an executable path for the command token of a `cmd.exe /d /s /c`
 * line: every metacharacter is caret-escaped, so cmd.exe's single parse of
 * that token restores the path exactly — spaces, parentheses and `&`
 * included — and `%` can never form a variable reference.
 *
 * @example escapeCmdCommand('C:\\Program Files (x86)\\pnpm.cmd')
 * // → 'C:\\Program^ Files^ ^(x86^)\\pnpm.cmd'
 *
 * @param {string} file absolute path of the executable
 * @returns {string}
 */
export function escapeCmdCommand(file) {
  return file.replace(CMD_METACHARACTERS, '^$1');
}

/**
 * Quote one argument the way the MSVCRT (`CommandLineToArgvW`) parser reads
 * it back: wrapped in quotes, each `"` escaped as `\"` with the backslashes
 * before it doubled, and trailing backslashes doubled because the closing quote
 * follows them. Every other backslash is literal. Linear in the input, with no
 * backtracking.
 *
 * @param {string} argument
 * @returns {string}
 */
function quoteMsvcrtArgument(argument) {
  let quoted = '"';
  let backslashes = 0;
  for (const character of argument) {
    if (character === '\\') {
      backslashes += 1;
      continue;
    }
    quoted +=
      character === '"'
        ? `${'\\'.repeat(backslashes * 2 + 1)}"`
        : `${'\\'.repeat(backslashes)}${character}`;
    backslashes = 0;
  }
  return `${quoted}${'\\'.repeat(backslashes * 2)}"`;
}

/**
 * Escape one argument for a `cmd.exe /d /s /c` line: MSVCRT-quote it, then
 * caret-escape every cmd.exe metacharacter — the quotes included, so cmd.exe's
 * quote state never toggles and nothing inside the argument is ever read as
 * `&`, `|`, `<`, `>`, `(`, `)` or a `%variable%`.
 *
 * `doubleEscape` caret-escapes a second time, for a `.cmd`/`.bat` target: the
 * batch file passes its arguments on as `%*`, and cmd.exe parses that
 * expansion again, consuming a second layer of carets.
 *
 * @example escapeCmdArgument('a&b', { doubleEscape: true })
 * // → '^^^"a^^^&b^^^"', which cmd.exe reads as '^"a^&b^"', then the batch
 * //   file's `%*` as '"a&b"', and the program as the argument a&b
 *
 * @param {string} argument
 * @param {{ doubleEscape?: boolean }} [options]
 * @returns {string}
 */
export function escapeCmdArgument(argument, options = {}) {
  const escaped = quoteMsvcrtArgument(argument).replace(CMD_METACHARACTERS, '^$1');
  return options.doubleEscape === true ? escaped.replace(CMD_METACHARACTERS, '^$1') : escaped;
}

/**
 * Keep `shell: false` on every platform. Windows cannot execute a `.cmd` or
 * `.bat` launcher (how `pnpm` and `npm` are installed there) directly, so it is
 * run through the command interpreter explicitly, in the form Node itself uses
 * for `shell: true` — `<ComSpec> /d /s /c "<command line>"` with
 * `windowsVerbatimArguments` — but with every part of that line escaped, as
 * cross-spawn does: the path by {@link escapeCmdCommand} and each argument by
 * {@link escapeCmdArgument} with the second escape a batch target needs.
 * Handing cmd.exe unquoted arguments would let `&`, `|`, `<`, `>` or `%` in
 * any of them run or redirect something.
 *
 * Any other executable, and every other platform, is returned unchanged.
 *
 * @param {LaunchCommand} command
 * @param {{ platform?: NodeJS.Platform, comSpec?: string }} [options] the
 *   platform whose rules apply (default this one) and the command interpreter
 *   (default `cmd.exe`); injectable so the Windows form is testable anywhere
 * @returns {LaunchCommand}
 */
export function wrapForPlatform(command, options = {}) {
  const platform = options.platform ?? process.platform;
  if (platform !== 'win32') return command;
  const extension = path.win32.extname(command.file).toLowerCase();
  if (extension !== '.cmd' && extension !== '.bat') return command;

  // No escaping carries a line break or a NUL through cmd.exe: a line break
  // ends the command there, and whatever follows it is a second command.
  if ([command.file, ...command.args].some((part) => /[\0\r\n]/u.test(part))) {
    throw new DevInstrumentedError(
      `cannot run ${command.display} through cmd.exe: an argument contains a line break or a NUL`,
    );
  }

  const line = [
    escapeCmdCommand(command.file),
    ...command.args.map((argument) => escapeCmdArgument(argument, { doubleEscape: true })),
  ].join(' ');
  return {
    ...command,
    file: options.comSpec ?? 'cmd.exe',
    // `/d` skips AutoRun commands, `/s` strips exactly the outer quotes below,
    // `/c` runs the line and exits.
    args: ['/d', '/s', '/c', `"${line}"`],
    windowsVerbatimArguments: true,
  };
}

/**
 * Append `--import <preload url>` to an inherited `NODE_OPTIONS` value.
 *
 * Appending rather than replacing is the point: developers commonly set
 * `NODE_OPTIONS` (a heap size, a different loader, `--trace-warnings`), and
 * discarding it would break their environment in a way that looks like a bug
 * in this tool. An identical `--import` already present is not repeated.
 *
 * @param {string | undefined} inherited current `NODE_OPTIONS`
 * @param {string} preloadUrl `file://` URL of the preload
 * @returns {string}
 */
export function appendImportOption(inherited, preloadUrl) {
  const option = `--import ${preloadUrl}`;
  const existing = (inherited ?? '').trim();
  if (existing === '') return option;
  if (existing.split(/\s+/u).includes(preloadUrl)) return existing;
  return `${existing} ${option}`;
}

/*
 * THE CHILD ENVIRONMENT ALLOWLIST. A `--spawn-local` child — the target
 * project's dev server and every dependency it loads — inherits only the
 * variables below, never a copy of this terminal's environment, which
 * routinely holds `ANTHROPIC_API_KEY`, cloud keys and `GITHUB_TOKEN`.
 *
 * The lists are those of `DEV_SERVER_ENV_ALLOWLIST` and
 * `isForwardedToDevServer` in `apps/local-service/src/dev-server/launcher.ts`,
 * the policy the service applies to the dev servers it launches, name for name.
 * They are deliberately duplicated rather than imported, like
 * {@link isLoopbackHostname}: this script runs with bare `node` and imports
 * nothing but `node:` builtins, which is what lets it work on a checkout that
 * has not been built. A change to the policy belongs in both places;
 * `scripts/dev-instrumented.test.mjs` reads the launcher's lists and fails when
 * the two differ.
 */

/** What the platform needs to run a program: search path, identity, temp, locale. */
const PLATFORM_RUNTIME_NAMES = Object.freeze([
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'USERNAME',
  'SHELL',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LANGUAGE',
  'TZ',
]);

/** What Windows needs to run a program, a `.cmd` shim and `cmd.exe` itself. */
const WINDOWS_RUNTIME_NAMES = Object.freeze([
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
]);

/** The proxy variables, which package managers and `fetch` read in either casing. */
const PROXY_NAMES = Object.freeze(['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY']);

/** What Node and the package managers need to resolve, trust and install. */
const TOOLCHAIN_NAMES = Object.freeze([
  'NODE_ENV',
  'NODE_PATH',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  ...PROXY_NAMES,
  'PNPM_HOME',
  'VOLTA_HOME',
  'BUN_INSTALL',
]);

/** Terminal and colour switches a dev server's output honours. */
const TERMINAL_NAMES = Object.freeze(['TERM', 'COLORTERM', 'FORCE_COLOR', 'NO_COLOR', 'CI']);

/** The dev server's own address and file-watching switches. */
const DEV_SERVER_NAMES = Object.freeze([
  'PORT',
  'HOST',
  'HOSTNAME',
  'WATCHPACK_POLLING',
  'CHOKIDAR_USEPOLLING',
]);

/**
 * The target's database variables: `DATABASE_URL` as `.env.example` documents
 * it, and the connection variables the `pg` driver reads.
 */
const DATABASE_NAMES = Object.freeze([
  'DATABASE_URL',
  'PGHOST',
  'PGPORT',
  'PGDATABASE',
  'PGUSER',
  'PGPASSWORD',
  'PGSSLMODE',
]);

/** Developer configuration shared with the preload, which reads its log level. */
const SHARED_DEVELOPER_NAMES = Object.freeze(['DEBUGGEN_LOG_LEVEL']);

/**
 * The whole of what passes from this terminal's environment into a
 * `--spawn-local` child (see {@link isForwardedToChild}). A variable is
 * forwarded when its name is one of `names` or starts with one of `prefixes` —
 * case-insensitively on Windows — or, on POSIX, is one of
 * `posixLowercaseNames`, the conventional lower-case proxy spellings.
 *
 * Deliberately absent: `ANTHROPIC_API_KEY` and every other `DEBUGGEN_*` but
 * `DEBUGGEN_LOG_LEVEL` (service configuration and credentials), `VSCODE_*` and
 * `ELECTRON_*`, `npm_config_*`, and every cloud or source-control credential.
 * A variable a project needs beyond this list is passed per run with
 * `--env NAME` or `--env NAME=value`, or kept in the project's own `.env`
 * files, which its dev server reads itself.
 *
 * @type {Readonly<{ names: readonly string[], prefixes: readonly string[], posixLowercaseNames: readonly string[] }>}
 */
export const CHILD_ENV_ALLOWLIST = Object.freeze({
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

/** Membership over {@link CHILD_ENV_ALLOWLIST}'s exact names. */
const FORWARDED_NAME_SET = new Set(CHILD_ENV_ALLOWLIST.names);

/** Membership over {@link CHILD_ENV_ALLOWLIST}'s POSIX lower-case spellings. */
const FORWARDED_POSIX_LOWERCASE_SET = new Set(CHILD_ENV_ALLOWLIST.posixLowercaseNames);

/** The variable the preload's `--import` flag is appended to. */
const NODE_OPTIONS_KEY = 'NODE_OPTIONS';

/** The three wiring variables this command sets on the child and never forwards. */
const WIRING_KEYS = Object.freeze([
  'DEBUGGEN_INGEST_URL',
  'DEBUGGEN_PROJECT_ROOT',
  'DEBUGGEN_TOKEN',
]);

/** {@link NODE_OPTIONS_KEY} and {@link WIRING_KEYS}: set on the child, never copied into it. */
const PRELOAD_KEY_SET = new Set([NODE_OPTIONS_KEY, ...WIRING_KEYS]);

/**
 * Whether a variable of this terminal's environment is copied into a
 * `--spawn-local` child: its name is on {@link CHILD_ENV_ALLOWLIST} — compared
 * case-insensitively on `win32`, exactly elsewhere. `NODE_OPTIONS` and the
 * three `DEBUGGEN_*` wiring keys answer `false`: the inherited `NODE_OPTIONS`
 * is the base the preload flag is appended to, and the wiring keys are always
 * set by this command.
 *
 * @example
 * isForwardedToChild('DATABASE_URL', 'linux');      // → true
 * isForwardedToChild('http_proxy', 'linux');        // → true
 * isForwardedToChild('SystemRoot', 'win32');        // → true
 * isForwardedToChild('GITHUB_TOKEN', 'linux');      // → false
 *
 * @param {string} name a variable name from the parent environment
 * @param {NodeJS.Platform} [platform] whose name semantics apply; injectable
 *   so the suite can exercise the Windows rule on a POSIX host
 * @returns {boolean}
 */
export function isForwardedToChild(name, platform = process.platform) {
  if (typeof name !== 'string' || name === '') return false;
  const key = platform === 'win32' ? name.toUpperCase() : name;
  if (PRELOAD_KEY_SET.has(key)) return false;
  return (
    FORWARDED_NAME_SET.has(key) ||
    CHILD_ENV_ALLOWLIST.prefixes.some((prefix) => key.startsWith(prefix)) ||
    (platform !== 'win32' && FORWARDED_POSIX_LOWERCASE_SET.has(name))
  );
}

/** A portable environment variable name. @type {RegExp} */
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;

/** The namespace of the product's own wiring and configuration variables. */
const PRODUCT_ENV_PREFIX = 'DEBUGGEN_';

/**
 * Why a name cannot be an `--env` extra, or `undefined` when it can. The test
 * is case-insensitive for the two refused names, because Windows reads
 * variable names that way.
 *
 * @param {string} name
 * @returns {{ problem: string, hint: string } | undefined}
 */
function extraEnvNameProblem(name) {
  if (!ENV_NAME_PATTERN.test(name)) {
    return {
      problem: 'is not a variable name',
      hint: 'A name is letters, digits and underscores, not starting with a digit: --env NAME or --env NAME=value.',
    };
  }
  const upper = name.toUpperCase();
  if (upper === NODE_OPTIONS_KEY) {
    return {
      problem: 'is set by this command',
      hint: [
        'The child NODE_OPTIONS is the one this terminal has, with the preload',
        '--import appended. Set NODE_OPTIONS in this terminal to change what it',
        'starts from.',
      ].join('\n'),
    };
  }
  if (upper.startsWith(PRODUCT_ENV_PREFIX)) {
    return {
      problem: "is in the product's own DEBUGGEN_ namespace",
      hint: [
        'DEBUGGEN_INGEST_URL, DEBUGGEN_PROJECT_ROOT and DEBUGGEN_TOKEN are set by',
        'this command, DEBUGGEN_LOG_LEVEL is inherited from this terminal, and',
        'the rest configure the service, not a dev server.',
      ].join('\n'),
    };
  }
  return undefined;
}

/**
 * @typedef {object} ExtraEnvRequest
 * @property {string} name variable name, validated by {@link parseArgs}
 * @property {string | undefined} value the value `--env NAME=value` gave, or
 *   `undefined` for `--env NAME`, which forwards this terminal's value
 */

/**
 * Parse one `--env` value: `NAME` or `NAME=value`, the value taken verbatim
 * (it may itself contain `=`, and it may be empty).
 *
 * @param {string} raw the flag's value
 * @returns {ExtraEnvRequest}
 * @throws {DevInstrumentedError} exit 2 for a name that is not a variable name,
 *   is `NODE_OPTIONS` or a `DEBUGGEN_*` name, or a value holding a NUL
 */
function parseEnvFlag(raw) {
  const separator = raw.indexOf('=');
  const name = separator === -1 ? raw : raw.slice(0, separator);
  const value = separator === -1 ? undefined : raw.slice(separator + 1);

  const refusal = extraEnvNameProblem(name);
  if (refusal !== undefined) {
    throw new DevInstrumentedError(`--env ${quoteUntrusted(name)} ${refusal.problem}`, {
      hint: refusal.hint,
      showUsage: true,
    });
  }
  if (value !== undefined && value.includes('\0')) {
    throw new DevInstrumentedError(`--env ${name}: a variable value cannot contain a NUL`, {
      showUsage: true,
    });
  }
  return { name, value };
}

/**
 * Resolve the `--env` requests against this terminal's environment into the
 * explicit extras {@link buildChildEnv} applies: `NAME=value` as given, and
 * `NAME` as this terminal's value, found case-insensitively on Windows.
 *
 * @param {readonly ExtraEnvRequest[]} requests in command-line order
 * @param {NodeJS.ProcessEnv} [env] environment a bare `NAME` is read from
 * @param {NodeJS.Platform} [platform] whose name semantics apply
 * @returns {Record<string, string>} the extras, built with own data properties
 * @throws {DevInstrumentedError} exit 2 when a bare `NAME` is unset here, or
 *   when two requests name the same variable
 */
export function resolveExtraEnv(requests, env = process.env, platform = process.platform) {
  const identity = (/** @type {string} */ name) =>
    platform === 'win32' ? name.toUpperCase() : name;
  /** @type {Set<string>} */
  const seen = new Set();
  /** @type {Array<[string, string]>} */
  const entries = [];

  for (const { name, value } of requests) {
    const id = identity(name);
    if (seen.has(id)) {
      throw new DevInstrumentedError(`--env ${name} is given more than once`, {
        hint: 'Name each variable once, so which value the dev server receives is never a guess.',
      });
    }
    seen.add(id);

    const inherited =
      value === undefined
        ? Object.entries(env).find(
            ([key, candidate]) => identity(key) === id && typeof candidate === 'string',
          )?.[1]
        : undefined;
    const effective = value ?? inherited;
    if (effective === undefined) {
      throw new DevInstrumentedError(`--env ${name} names a variable this terminal does not set`, {
        hint: `Set ${name} in this terminal first, or give its value: --env ${name}=<value>.`,
      });
    }
    entries.push([name, effective]);
  }
  return Object.fromEntries(entries);
}

/**
 * Build a `--spawn-local` child's environment — a minimal one, never a copy of
 * this terminal's — in three layers, as the service's launcher builds its own:
 *
 * 1. the parent variables {@link isForwardedToChild} admits
 *    ({@link CHILD_ENV_ALLOWLIST}), in their own spelling;
 * 2. `extraEnv`, the variables this run was explicitly given with `--env`,
 *    replacing a same-named parent variable;
 * 3. the four preload variables: `NODE_OPTIONS` — the inherited value with
 *    `--import <preload>` appended ({@link appendImportOption}) — and
 *    `DEBUGGEN_INGEST_URL`, `DEBUGGEN_PROJECT_ROOT` and `DEBUGGEN_TOKEN`, set
 *    last so nothing earlier can supply them.
 *
 * Everything else is dropped, so a variable off the list — `ANTHROPIC_API_KEY`,
 * a cloud key, `GITHUB_TOKEN` — never reaches the target project or its
 * dependencies. The listed ones are forwarded as they are, and some carry
 * secrets of the project's own (`DATABASE_URL`, `PGPASSWORD`, a proxy URL's
 * credentials, a `NEXT_*` value), as they would for any dev server started
 * from the same terminal. An inherited `DEBUGGEN_TOKEN` never passes
 * either: a server-agent credential is minted for one project root and one dev
 * server, so one lying around in the environment belongs to some other
 * process, and forwarding it would make the child post ingest with a
 * credential the service rejects. With no `token` the child has no
 * `DEBUGGEN_TOKEN` at all.
 *
 * On `win32` names compare case-insensitively: a `Path` or `Node_Options` is
 * matched, and replaced rather than duplicated under a second spelling. The
 * result is built with own data properties, so even a variable named
 * `__proto__` stays data.
 *
 * @example
 * buildChildEnv({
 *   preloadUrl: 'file:///repo/packages/telemetry/dist/node/register.mjs',
 *   base: 'http://127.0.0.1:43117',
 *   projectRoot: '/repo/apps/demo-app',
 *   token,
 *   env: { PATH: '/usr/bin', GITHUB_TOKEN: '…' },
 *   extraEnv: { STRIPE_TEST_MODE: '1' },
 * });
 * // → { PATH, STRIPE_TEST_MODE, NODE_OPTIONS, DEBUGGEN_INGEST_URL,
 * //     DEBUGGEN_PROJECT_ROOT, DEBUGGEN_TOKEN } — no GITHUB_TOKEN
 *
 * @param {object} request
 * @param {string} request.preloadUrl `file://` URL of the preload
 * @param {string} request.base service base URL
 * @param {string} request.projectRoot absolute path of the launched project
 * @param {string | undefined} request.token server-agent credential, if any
 * @param {NodeJS.ProcessEnv} [request.env] environment the allowlisted
 *   variables are taken from
 * @param {Readonly<Record<string, string>>} [request.extraEnv] explicit extras
 *   ({@link resolveExtraEnv})
 * @param {NodeJS.Platform} [request.platform] whose name semantics apply
 * @returns {Record<string, string>} a fresh environment object for `spawn`
 * @throws {DevInstrumentedError} exit 2 when an extra is `NODE_OPTIONS` or in
 *   the `DEBUGGEN_` namespace, which only this command sets
 */
export function buildChildEnv({
  preloadUrl,
  base,
  projectRoot,
  token,
  env = process.env,
  extraEnv = {},
  platform = process.platform,
}) {
  const identity = (/** @type {string} */ name) =>
    platform === 'win32' ? name.toUpperCase() : name;

  // One slot per variable identity (the upper-cased name on Windows), holding
  // the spelling that supplied the value: a later layer replaces an earlier one
  // instead of adding a second, differently cased key.
  /** @type {Map<string, readonly [string, string]>} */
  const slots = new Map();
  /** @type {string | undefined} */
  let nodeOptions;

  // Layer 1: the parent's allowlisted variables; the first spelling wins.
  for (const [name, value] of Object.entries(env)) {
    if (typeof value !== 'string') continue;
    const id = identity(name);
    if (id === NODE_OPTIONS_KEY) {
      nodeOptions ??= value;
      continue;
    }
    if (slots.has(id) || !isForwardedToChild(name, platform)) continue;
    slots.set(id, [name, value]);
  }

  // Layer 2: the extras this run was explicitly given.
  for (const [name, value] of Object.entries(extraEnv)) {
    const refusal = extraEnvNameProblem(name);
    if (refusal !== undefined) {
      throw new DevInstrumentedError(`--env ${quoteUntrusted(name)} ${refusal.problem}`, {
        hint: refusal.hint,
      });
    }
    if (typeof value !== 'string') continue;
    slots.set(identity(name), [name, value]);
  }

  // Layer 3: the preload variables are never taken from either layer above.
  for (const key of PRELOAD_KEY_SET) slots.delete(key);

  /** @type {Record<string, string>} */
  const childEnv = Object.fromEntries(slots.values());
  childEnv[NODE_OPTIONS_KEY] = appendImportOption(nodeOptions, preloadUrl);
  childEnv.DEBUGGEN_INGEST_URL = `${base}${INGEST_PATH}`;
  childEnv.DEBUGGEN_PROJECT_ROOT = projectRoot;
  if (token !== undefined) childEnv.DEBUGGEN_TOKEN = token;
  return childEnv;
}

/**
 * Describe a credential without disclosing it. The byte count is reported so a
 * developer can tell "set" from "set to something implausible" without the
 * value ever reaching a terminal, a log file or a scrollback buffer.
 *
 * @param {string | undefined} token
 * @returns {string} `<set, N bytes>`, or `<not set>` when there is none
 */
export function describeToken(token) {
  if (token === undefined) return '<not set>';
  return `<set, ${Buffer.byteLength(token, 'utf8')} bytes>`;
}

/**
 * The banner printed once, immediately before a `--spawn-local` child is
 * spawned. It names everything that makes this run different from a plain
 * `dev` — including the effective `NODE_OPTIONS`, so an inherited value is
 * visibly preserved rather than assumed — names the `--env` extras without
 * their values, describes the server-agent credential by its length only, and
 * states when its first lease ends, that this command releases it when the dev
 * server exits, and how the service renews and revokes it otherwise.
 *
 * @param {object} request
 * @param {string} request.root repository root
 * @param {ResolvedProject} request.project
 * @param {LaunchCommand} request.command
 * @param {ResolvedPreload} request.preload
 * @param {string} request.base
 * @param {Readonly<Record<string, string | undefined>>} request.childEnv
 * @param {readonly string[]} [request.extraEnvNames] names of the `--env`
 *   extras; only the names are shown, never the values
 * @param {number} request.expiresAt epoch milliseconds at which, the service
 *   said, the child's credential's first lease ends
 * @returns {string}
 */
export function buildBanner({
  root,
  project,
  command,
  preload,
  base,
  childEnv,
  extraEnvNames = [],
  expiresAt,
}) {
  const expiry = new Date(expiresAt).toISOString();
  const rows = [
    ['project', project.label],
    ['command', `${command.display}  (cwd ${display(root, command.cwd)})`],
    ['preload', preload.relative],
    ['service', base],
    ['NODE_OPTIONS', childEnv.NODE_OPTIONS ?? ''],
    ['DEBUGGEN_INGEST_URL', childEnv.DEBUGGEN_INGEST_URL ?? ''],
    ['DEBUGGEN_PROJECT_ROOT', childEnv.DEBUGGEN_PROJECT_ROOT ?? ''],
    ['DEBUGGEN_TOKEN', describeToken(childEnv.DEBUGGEN_TOKEN)],
    [
      '--env',
      extraEnvNames.length === 0 ? '(none)' : `${extraEnvNames.join(', ')}  (values not shown)`,
    ],
    ['lease ends', `${expiry}  (renewed while the dev server runs)`],
  ];
  const width = rows.reduce((longest, [label]) => Math.max(longest, (label ?? '').length), 0);

  return [
    'dev-instrumented: starting the development server in this terminal (--spawn-local)',
    ...rows.map(([label, value]) => `  ${(label ?? '').padEnd(width)}  ${value ?? ''}`),
    '',
    '  Stop it with Ctrl-C. Nothing in the project was modified, and no file',
    '  was written: the server-tier tracer lives in this child process only.',
    '',
    '  The dev server inherits only the part of this terminal environment a',
    '  dev server needs (--help lists it) plus the --env variables above. Those',
    '  pass as they are, a database URL or proxy credentials included; every',
    '  other variable, such as ANTHROPIC_API_KEY or GITHUB_TOKEN, stays out.',
    '',
    '  This run is AUTHENTICATED: the service minted the server-agent credential',
    `  above for this project root through POST ${CREDENTIAL_PATH}, so the`,
    '  preload can post server and database spans for it while a session',
    '  captures. The credential lives only in this process and in the dev',
    '  server environment; this command never prints it, but the dev server',
    '  writes to this terminal unfiltered, so a dev script that prints its own',
    '  environment would show it.',
    '',
    '  The credential is a lease the service supervises: its first lease ends',
    `  at ${expiry}, and the service renews it while the dev server's preload`,
    '  stays connected. When the dev server exits, Ctrl-C included, this',
    `  command releases it (POST ${RELEASE_PATH}) once the service has proved`,
    '  itself again. Should that release fail, the service still revokes it',
    '  when the dev server disconnects, 20 seconds after its connection is gone',
    '  (so shortly after the dev server exits), and when the service shuts',
    '  down; a lease nothing renews lapses within 5 minutes, and',
    '  debuggen.rotateServiceToken revokes it at once.',
  ].join('\n');
}

/**
 * The report printed after the service has launched the project. It states
 * what the service answered with and who owns the process, because the process
 * is deliberately not this one.
 *
 * @param {object} request
 * @param {ResolvedProject} request.project
 * @param {string} request.base service base URL
 * @param {LaunchResult} request.result what the service reported
 * @param {boolean} request.foreground whether this command waits for Ctrl-C
 * @returns {string}
 */
export function buildLaunchReport({ project, base, result, foreground }) {
  const rows = [
    ['project', project.label],
    ['service', base],
    ['route', `POST ${LAUNCH_PATH}`],
    ['dev server', result.devServerUrl ?? '(not reported)'],
    ['pid', result.pid === undefined ? '(not reported)' : String(result.pid)],
  ];
  const width = rows.reduce((longest, [label]) => Math.max(longest, (label ?? '').length), 0);

  return [
    `dev-instrumented: the service launched ${project.label}`,
    ...rows.map(([label, value]) => `  ${(label ?? '').padEnd(width)}  ${value ?? ''}`),
    '',
    '  The service owns that process: per the protocol it attaches the telemetry',
    '  preload and mints the project-scoped server-agent credential for it, so',
    '  server and database spans are recorded under this project root. Nothing',
    '  in the project was modified.',
    '',
    foreground
      ? `  Press Ctrl-C to stop it again (POST ${STOP_PATH}).`
      : `  Nothing is running in this terminal. Stop the dev server with --stop, or\n  by ending the session in VS Code.`,
  ].join('\n');
}

/**
 * Wait until this process is asked to shut down, and report which signal did
 * it.
 *
 * Registering a `SIGINT` listener suppresses the default termination, which is
 * what lets the foreground mode stop the service's dev server before exiting.
 * The listeners are removed as soon as the first signal arrives, so a second
 * Ctrl-C from an impatient developer terminates this process immediately
 * instead of queuing another stop request.
 *
 * A timer holds the event loop open for the wait. Node's signal watchers are
 * unreferenced, so a process whose only remaining work is "wait for SIGINT"
 * drains its loop and exits — which, for a top-level `await`, means exiting
 * with status 13 the moment the launch is reported instead of waiting for the
 * developer. The timer is cleared with the listeners, so it never delays exit.
 *
 * @param {readonly NodeJS.Signals[]} [signals] signals to wait for
 * @returns {Promise<NodeJS.Signals>} the signal that arrived
 */
export async function awaitShutdownSignal(signals = ['SIGINT', 'SIGTERM']) {
  return await new Promise((resolve) => {
    /** @type {Array<[NodeJS.Signals, () => void]>} */
    const handlers = [];
    const keepAlive = setInterval(() => undefined, KEEP_ALIVE_INTERVAL_MS);

    for (const signal of signals) {
      /** @returns {void} */
      const handler = () => {
        clearInterval(keepAlive);
        for (const [name, registered] of handlers) process.off(name, registered);
        resolve(signal);
      };
      handlers.push([signal, handler]);
      process.on(signal, handler);
    }
  });
}

/**
 * Translate a child's termination into this process's exit code.
 *
 * @param {number | null} code
 * @param {NodeJS.Signals | null} signal
 * @returns {number}
 */
export function childExitCode(code, signal) {
  if (typeof code === 'number') return code;
  if (signal !== null) {
    const number = os.constants.signals[signal];
    return 128 + (typeof number === 'number' ? number : 0);
  }
  return EXIT_OK;
}

/**
 * Spawn the dev server and wait for it, forwarding `SIGINT` and `SIGTERM`.
 *
 * With `stdio: 'inherit'` a terminal already delivers Ctrl-C to the whole
 * foreground group, so forwarding is what makes a programmatic
 * `kill <this pid>` behave the same way. Registering the handlers also stops
 * this process from dying first and orphaning the dev server — it waits for
 * the child, then reports the child's status as its own.
 *
 * @param {LaunchCommand} command
 * @param {NodeJS.ProcessEnv} childEnv
 * @returns {Promise<number>} exit code to use for this process
 * @throws {DevInstrumentedError} exit 2 when the command cannot be executed
 */
export async function runDevServer(command, childEnv) {
  const child = spawn(command.file, command.args, {
    cwd: command.cwd,
    env: childEnv,
    stdio: 'inherit',
    shell: false,
    windowsHide: true,
    // A `cmd.exe` line from `wrapForPlatform` is already quoted and escaped;
    // letting Node re-quote it would break that escaping. Ignored off Windows.
    windowsVerbatimArguments: command.windowsVerbatimArguments === true,
  });

  /** @type {NodeJS.Signals[]} */
  const forwarded = ['SIGINT', 'SIGTERM'];
  /** @type {Array<[NodeJS.Signals, () => void]>} */
  const handlers = [];

  for (const signal of forwarded) {
    /** @returns {void} */
    const handler = () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      try {
        child.kill(signal);
      } catch {
        // The child is already gone; its 'exit' event settles the promise.
      }
    };
    handlers.push([signal, handler]);
    process.on(signal, handler);
  }

  /** @returns {void} */
  const removeHandlers = () => {
    for (const [signal, handler] of handlers) process.off(signal, handler);
  };

  try {
    return await new Promise((resolve, reject) => {
      child.once('error', (error) => {
        const missing = isErrnoCode(error, 'ENOENT');
        reject(
          new DevInstrumentedError(
            `could not run ${command.display}: ${describeCause(error)}`,
            missing
              ? {
                  hint: `${command.file} is not executable. Check that pnpm (or npm) is installed and on PATH.`,
                }
              : {},
          ),
        );
      });
      child.once('exit', (code, signal) => {
        resolve(childExitCode(code, signal));
      });
    });
  } finally {
    removeHandlers();
  }
}

/**
 * The sentence every pre-spawn failure of `--spawn-local` ends with, so exit
 * code 2 is never ambiguous about whether a dev server is now running.
 */
const NOTHING_SPAWNED =
  'Nothing was spawned: --spawn-local starts the dev server only once the service has minted its credential.';

/**
 * The sentence a failure of the foreground mode's closing identity check ends
 * with: the stop request was not sent, so the dev server is still running.
 */
const STILL_RUNNING = [
  'The stop request was not sent, so the dev server the service launched is',
  'still running. End the session in VS Code, or run this command with --stop',
  'once the service answers the identity challenge again.',
].join('\n');

/**
 * Restate a {@link DevInstrumentedError} with one more paragraph at the end of
 * its hint, stating what the failure leaves behind. Anything that is not a
 * {@link DevInstrumentedError} is returned unchanged, so an unexpected failure
 * keeps its stack.
 *
 * @param {unknown} error
 * @param {string} consequence the closing paragraph
 * @returns {unknown}
 */
function withConsequence(error, consequence) {
  if (!(error instanceof DevInstrumentedError)) return error;
  return new DevInstrumentedError(error.message, {
    hint: error.hint === undefined ? consequence : `${error.hint}\n\n${consequence}`,
    showUsage: error.showUsage,
  });
}

/**
 * Restate a failure raised before the `--spawn-local` child exists with a hint
 * that says nothing was spawned (see {@link withConsequence}).
 *
 * @param {unknown} error
 * @returns {unknown}
 */
function beforeSpawn(error) {
  return withConsequence(error, NOTHING_SPAWNED);
}

/**
 * Keep `SIGINT` and `SIGTERM` from ending this process while a short, bounded
 * step finishes, and return the function that lets them through again.
 *
 * A listener is what suppresses a signal's default termination; this one hands
 * the signal to `onSignal` and nothing else. The step it guards is the closing
 * release of `--spawn-local`, which takes at most {@link RELEASE_STEP_MAX_MS}:
 * a developer's second Ctrl-C arriving while it is in flight would otherwise
 * end this process between sending the release and hearing whether it
 * happened. The listeners are removed as soon as the step settles, so a
 * signal after that behaves as it always does.
 *
 * @param {(signal: NodeJS.Signals) => void} onSignal called for every signal
 *   that arrives while the listeners are installed
 * @param {readonly NodeJS.Signals[]} [signals] signals to hold
 * @returns {() => void} removes the listeners again
 */
function holdShutdownSignals(onSignal, signals = ['SIGINT', 'SIGTERM']) {
  /** @type {Array<[NodeJS.Signals, () => void]>} */
  const handlers = [];
  for (const signal of signals) {
    /** @returns {void} */
    const handler = () => onSignal(signal);
    handlers.push([signal, handler]);
    process.on(signal, handler);
  }
  return () => {
    for (const [signal, handler] of handlers) process.off(signal, handler);
  };
}

/**
 * What ends the server-agent credential when this command could not release
 * it: the service's own supervision of the lease. Every release warning closes
 * with it, so a warning is never read as "the credential stays valid".
 */
const RELEASE_FALLBACK = [
  '  The service still revokes it without this command: 20 seconds after the',
  "  dev server's preload disconnects, or at the end of its lease.",
].join('\n');

/**
 * The one line a successful release prints, by what the service answered.
 */
const RELEASE_OUTCOME = Object.freeze({
  released: 'dev-instrumented: released the server-agent credential; the service revoked it',
  alreadyGone:
    'dev-instrumented: the server-agent credential was no longer live; there was nothing to release',
});

/**
 * Print the single warning a release that did not happen produces: what went
 * wrong, then {@link RELEASE_FALLBACK}. The text is redacted of both
 * credentials before it is written, whatever produced it.
 *
 * @param {import('node:stream').Writable} stderr stream to warn on
 * @param {string} headline what did not happen
 * @param {unknown} error why
 * @param {readonly string[]} secrets credentials to redact
 * @returns {void}
 */
function warnUnreleased(stderr, headline, error, secrets) {
  const reason = error instanceof Error ? error.message : String(error);
  writeLine(
    stderr,
    redactSecrets(
      `dev-instrumented: warning: ${headline}: ${reason}\n${RELEASE_FALLBACK}`,
      secrets,
    ),
  );
}

/**
 * Release a `--spawn-local` server-agent credential once nothing will use it
 * any more: after the dev server exited — on its own, through a forwarded
 * signal, or because it could not be spawned — or after a step between the
 * mint and the spawn failed.
 *
 * The listener at `base` is made to prove it is the service again first
 * ({@link checkServiceHealth}), exactly as the foreground mode does before its
 * closing stop: the dev server may have run for hours, and whatever holds the
 * port now is what the editor credential and the server-agent credential
 * would reach. A listener that cannot prove it is sent neither, and the
 * release is skipped. Then one release request is sent
 * ({@link releaseServerAgentCredential}), never retried. Shutdown signals are
 * held for the whole step ({@link holdShutdownSignals}), which is bounded by
 * the probe's and the request's timeouts.
 *
 * Every failure of the step is reported rather than thrown, and none changes
 * an exit status: the release is the prompt end of a credential that the
 * service's lease supervision ends anyway, so a release that is skipped or
 * fails prints one warning to `stderr` naming that fallback, and one that
 * succeeds — `{ released: true }` or `{ released: false }` alike — prints one
 * line to `stdout`. Neither credential is ever printed.
 *
 * @param {object} request
 * @param {string} request.base service base URL at the address that proved the
 *   service when the credential was minted
 * @param {string} request.editorToken editor credential from auth.json
 * @param {string} request.token the server-agent credential to release
 * @param {import('node:stream').Writable} request.stdout stream the outcome
 *   line and a held signal's note are written to
 * @param {import('node:stream').Writable} request.stderr stream a warning is
 *   written to
 * @returns {Promise<void>}
 */
async function releaseAfterUse({ base, editorToken, token, stdout, stderr }) {
  const secrets = [editorToken, token];
  let signalNoted = false;
  const letSignalsThrough = holdShutdownSignals((signal) => {
    if (signalNoted) return;
    signalNoted = true;
    writeLine(
      stdout,
      `dev-instrumented: ${signal} received; finishing the credential release first (at most ${String(RELEASE_STEP_MAX_MS / 1000)} s)`,
    );
  });

  try {
    try {
      await checkServiceHealth(base, editorToken);
    } catch (error) {
      warnUnreleased(
        stderr,
        'the release of the server-agent credential was skipped',
        error,
        secrets,
      );
      return;
    }

    try {
      const released = await releaseServerAgentCredential({ base, editorToken, token });
      writeLine(stdout, released ? RELEASE_OUTCOME.released : RELEASE_OUTCOME.alreadyGone);
    } catch (error) {
      warnUnreleased(stderr, 'the server-agent credential was not released', error, secrets);
    }
  } finally {
    letSignalsThrough();
  }
}

/**
 * @typedef {object} LocalSpawnPlan
 * @property {LaunchCommand} command what will be spawned
 * @property {Record<string, string>} childEnv the child's environment,
 *   credential included ({@link buildChildEnv})
 * @property {string[]} extraEnvNames names of the `--env` extras, for the
 *   banner; their values are never printed
 * @property {number} expiresAt epoch milliseconds at which the credential's
 *   first lease ends
 * @property {string} serviceBase the service base URL at the address that
 *   proved the service ({@link checkServiceHealth}); the credential request
 *   went there, the child's ingest URL names it, and the closing release is
 *   sent there once the service has proved itself again
 * @property {string} editorToken the editor credential from auth.json, which
 *   authorises the closing release; held in memory only and never printed
 * @property {string} token the server-agent credential the service minted —
 *   the same value `childEnv.DEBUGGEN_TOKEN` carries — for the closing release
 *   to name; held in memory only and never printed
 */

/**
 * Everything `--spawn-local` does before it spawns, as a hard pre-flight:
 * resolve the `--env` extras against this terminal ({@link resolveExtraEnv})
 * and the launch command (which validates the project's package name and finds
 * the package manager), read the editor credential, confirm the service
 * answers and proves it holds that credential ({@link checkServiceHealth}),
 * and only then ask it for a server-agent credential scoped to the project.
 *
 * The credential is requested last, once everything local has been validated,
 * so the service is not asked to mint one for a run that cannot start: a
 * credential no preload ever connects with, and that nothing releases, stays
 * valid until the service revokes it at the end of its first lease, 5 minutes
 * after minting. Should a step after the mint still fail — building the
 * child's environment refuses an extra — the credential is released before
 * the failure is raised ({@link releaseAfterUse}): best effort, reported on
 * its own line, and the original failure is what the command reports and
 * exits with. Every failure is raised with a hint that says nothing was
 * spawned.
 *
 * Exported so `scripts/dev-instrumented.test.mjs` can drive a failure between
 * the mint and the spawn, which no command line reaches: `parseArgs` refuses
 * every extra that {@link buildChildEnv} would.
 *
 * @param {object} request
 * @param {string} request.root repository root
 * @param {ResolvedProject} request.project
 * @param {ResolvedPreload} request.preload
 * @param {string} request.base service base URL
 * @param {NodeJS.ProcessEnv} request.env environment to read, and to take the
 *   allowlisted child variables from
 * @param {readonly ExtraEnvRequest[]} request.extraEnv the `--env` requests
 * @param {import('node:stream').Writable} request.stdout stream a release's
 *   outcome line is written to, should a failure after the mint need one
 * @param {import('node:stream').Writable} request.stderr stream a release's
 *   warning is written to, likewise
 * @returns {Promise<LocalSpawnPlan>}
 * @throws {DevInstrumentedError} exit 2, before anything is spawned
 */
export async function prepareLocalSpawn({
  root,
  project,
  preload,
  base,
  env,
  extraEnv,
  stdout,
  stderr,
}) {
  /** @type {{ serviceBase: string, editorToken: string, token: string } | undefined} */
  let minted;
  try {
    const extras = resolveExtraEnv(extraEnv, env);
    const command = buildLaunchCommand({ project, root, env });
    const editorToken = await readEditorCredential(resolveDebuggenHome(env));
    const serviceBase = await checkServiceHealth(base, editorToken);
    const { token, expiresAt } = await requestServerAgentCredential({
      base: serviceBase,
      editorToken,
      projectRoot: project.dir,
    });
    minted = { serviceBase, editorToken, token };
    const childEnv = buildChildEnv({
      preloadUrl: preload.url,
      base: serviceBase,
      projectRoot: project.dir,
      token,
      env,
      extraEnv: extras,
    });
    return {
      command,
      childEnv,
      extraEnvNames: Object.keys(extras),
      expiresAt,
      serviceBase,
      editorToken,
      token,
    };
  } catch (error) {
    if (minted !== undefined) {
      await releaseAfterUse({
        base: minted.serviceBase,
        editorToken: minted.editorToken,
        token: minted.token,
        stdout,
        stderr,
      });
    }
    throw beforeSpawn(error);
  }
}

/**
 * Print a failure and return the exit code it maps to.
 *
 * @param {unknown} error
 * @param {import('node:stream').Writable} [stderr] stream to report on
 * @returns {number}
 */
function reportFailure(error, stderr = process.stderr) {
  if (error instanceof DevInstrumentedError) {
    writeLine(stderr, `dev-instrumented: ${error.message}`);
    if (error.hint !== undefined) writeLine(stderr, `\n${error.hint}`);
    if (error.showUsage) writeLine(stderr, `\n${usage()}`);
    return error.exitCode;
  }

  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
  writeLine(stderr, `dev-instrumented: unexpected failure\n${detail}`);
  return EXIT_PREFLIGHT;
}

/**
 * @typedef {object} MainContext
 * @property {string} [root] repository root, for resolving the preload and the
 *   default project
 * @property {string} [cwd] directory a relative `--project` resolves against
 * @property {NodeJS.ProcessEnv} [env] environment to read and to inherit into a
 *   `--spawn-local` child
 * @property {import('node:stream').Writable} [stdout] stream the banner, the
 *   launch report, the usage text and a credential release's outcome line are
 *   written to
 * @property {import('node:stream').Writable} [stderr] stream failures, hints
 *   and a credential release's warning are written to
 */

/**
 * CLI entry point.
 *
 * The order is fixed so that every failure happens before anything runs:
 * resolve the preload, resolve the target project, resolve the service, read
 * the editor credential, confirm the service answers and proves it holds that
 * credential ({@link checkServiceHealth}), and only then launch, stop or spawn.
 * No request carries the editor credential before that proof, and the
 * foreground mode repeats the proof before its closing stop request.
 *
 * `--spawn-local` runs the same pre-flight and one more step: it asks the
 * service for the server-agent credential its child needs, after the launch
 * command has been resolved and validated (see {@link prepareLocalSpawn}). Any
 * failure there exits 2 before the child exists. Once the credential exists,
 * every path out — the child's exit, a signal-forwarded exit, a failed spawn,
 * a failure between the mint and the spawn — ends with the service proving
 * itself again and one release request ({@link releaseAfterUse}), whose
 * outcome never changes the exit code.
 *
 * The context parameter exists so the whole command can be driven against a
 * temporary tree and a stub service in `scripts/dev-instrumented.test.mjs`;
 * the defaults are the production values and the CLI entry below passes none of
 * them.
 *
 * @param {readonly string[]} [argv] arguments after the script path
 * @param {MainContext} [context] injected roots and environment
 * @returns {Promise<number>} process exit code
 */
export async function main(argv = process.argv.slice(2), context = {}) {
  const root = context.root ?? REPO_ROOT;
  const cwd = context.cwd ?? process.cwd();
  const env = context.env ?? process.env;
  const stdout = context.stdout ?? process.stdout;
  const stderr = context.stderr ?? process.stderr;

  /** @type {DevInstrumentedOptions} */
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    return reportFailure(error, stderr);
  }

  if (options.help) {
    writeLine(stdout, usage());
    return EXIT_OK;
  }

  try {
    const project = await resolveProject({ root, project: options.project, cwd });
    const base = resolveServiceBase({ service: options.service, env });

    if (options.stop) {
      const editorToken = await readEditorCredential(resolveDebuggenHome(env));
      const serviceBase = await checkServiceHealth(base, editorToken);
      await stopDevServer({ base: serviceBase, editorToken, projectRoot: project.dir });
      writeLine(
        stdout,
        `dev-instrumented: the service stopped the dev server for ${project.label}`,
      );
      return EXIT_OK;
    }

    // Both remaining modes depend on the preload: the local spawn attaches it
    // itself, and the service's launcher attaches this same file, so reporting
    // a missing bundle here names the build command instead of leaving the
    // launcher to fail with a path.
    const preload = await resolvePreload(root);

    if (options.spawnLocal) {
      // The authenticated local spawn: the child starts only with a
      // server-agent credential the service minted for this project root, so
      // the preload it carries is armed rather than inert. The credential is
      // held in `childEnv` and in this plan, nowhere else; the banner
      // describes it by length and the end of its first lease only.
      const { command, childEnv, extraEnvNames, expiresAt, serviceBase, editorToken, token } =
        await prepareLocalSpawn({
          root,
          project,
          preload,
          base,
          env,
          extraEnv: options.extraEnv,
          stdout,
          stderr,
        });

      // From here on the credential exists, so every way out of this block —
      // the child's own exit, an exit a forwarded SIGINT/SIGTERM caused, a
      // spawn that failed (ENOENT) — releases it before this command returns.
      // The release never changes what is returned or thrown: the child's
      // status stays the exit code, and a spawn failure is still reported.
      try {
        writeLine(
          stdout,
          buildBanner({
            root,
            project,
            command,
            preload,
            base: serviceBase,
            childEnv,
            extraEnvNames,
            expiresAt,
          }),
        );

        return await runDevServer(command, childEnv);
      } finally {
        await releaseAfterUse({ base: serviceBase, editorToken, token, stdout, stderr });
      }
    }

    const editorToken = await readEditorCredential(resolveDebuggenHome(env));
    const serviceBase = await checkServiceHealth(base, editorToken);

    const result = await launchDevServer({
      base: serviceBase,
      editorToken,
      projectRoot: project.dir,
    });
    writeLine(
      stdout,
      buildLaunchReport({ project, base: serviceBase, result, foreground: !options.detach }),
    );

    if (options.detach) return EXIT_OK;

    const signal = await awaitShutdownSignal();
    writeLine(stdout, `\ndev-instrumented: ${signal} received; stopping the dev server`);
    // Proved again, at the address proved before: the wait can last hours, and
    // whatever holds that port now — the service after a restart, or another
    // process after it stopped — is what the stop request's bearer credential
    // would reach.
    try {
      await checkServiceHealth(serviceBase, editorToken);
    } catch (error) {
      throw withConsequence(error, STILL_RUNNING);
    }
    await stopDevServer({ base: serviceBase, editorToken, projectRoot: project.dir });
    writeLine(stdout, 'dev-instrumented: the service stopped the dev server');
    return EXIT_OK;
  } catch (error) {
    return reportFailure(error, stderr);
  }
}

/**
 * Resolve the process entry path, following symlinks where possible so that it
 * can be compared with `import.meta.url` (which Node reports as a real path).
 *
 * @param {string} entry
 * @returns {string}
 */
function resolveEntryPath(entry) {
  try {
    return fs.realpathSync(entry);
  } catch {
    return path.resolve(entry);
  }
}

/**
 * Whether this module is the process entry point, so importing it (from a test
 * or another script) never starts a dev server.
 *
 * @returns {boolean}
 */
function isEntryPoint() {
  const entry = process.argv[1];
  if (entry === undefined || entry === '') return false;
  return import.meta.url === pathToFileURL(resolveEntryPath(entry)).href;
}

if (isEntryPoint()) {
  // `process.exitCode` rather than `process.exit()` so buffered stdout is
  // flushed before the process ends.
  process.exitCode = await main(process.argv.slice(2));
}
