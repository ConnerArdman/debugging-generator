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
 *                    hands it to the child as `DEBUGGEN_TOKEN` (AAP 0.5.6).
 *                    The mode therefore needs the running service and
 *                    `$DEBUGGEN_HOME/auth.json`, and any failure to obtain the
 *                    credential stops the command before anything is spawned —
 *                    without one the preload stays inert and records nothing
 *                    (`packages/telemetry/src/node/config.ts`), so starting the
 *                    server anyway would only look instrumented. The credential
 *                    carries the expiry the service chose (`expiresAt`); the
 *                    service has no revoke route, so it is not revoked when the
 *                    child exits and stops working at that expiry, or earlier
 *                    on `debuggen.rotateServiceToken`.
 *
 * `--detach` returns as soon as the service has reported the launch instead of
 * waiting for Ctrl-C, and `--stop` stops a dev server the service launched for
 * the project — the two halves of the default mode, available separately for
 * scripts and for a terminal that has since been closed.
 *
 * ROUTES — THE CONTRACT IS NOT NEGOTIABLE HERE: this file is a *caller*. The
 * routes it may use are the ones the service defines, and
 * {@link SERVICE_ROUTES} is the whole list: `GET /health`,
 * `POST /dev-server/launch` and `POST /dev-server/stop` from the protocol's
 * route table (AAP 0.4.2, `packages/protocol/src/http.ts`), and
 * `POST /dev-server/credential`, which the service's launcher defines once
 * (`DEV_SERVER_CREDENTIAL_PATH` in `apps/local-service/src/dev-server/launcher.ts`)
 * and `apps/local-service/src/server/routes/dev-server.ts` registers. There is
 * deliberately no route-name guessing, no probe list and no environment
 * override that points at a different path: a caller that invents an endpoint
 * the service does not define cannot work against the specified service, and
 * an override would only hide that. A new route is added to its definer first
 * and named here second — in that order.
 *
 * BOUNDARY — deliberately NOT implemented here, because the service owns it:
 *   - detecting an already-running dev server, probing ports or URLs;
 *   - retry/backoff, health polling or waiting for the server to be listening;
 *   - session creation, tab binding or any session bookkeeping;
 *   - minting, hashing, storing, refreshing or revoking credentials — the
 *     service mints the one `--spawn-local` asks for, and this script only
 *     passes it to the child it spawns;
 *   - reading, parsing or forwarding `.env` files — the child does its own.
 * If you are about to add any of the above, add it to the launcher instead and
 * let this script keep being a thin wrapper.
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
 * server-agent credential scoped to one project root (AAP 0.5.6), and the
 * preload installs nothing without one. The service is the only component that
 * mints it, in one of two ways, both authorised by the editor credential it
 * wrote to `$DEBUGGEN_HOME/auth.json`:
 *   - the default mode lets the launcher start the project; the launcher mints
 *     the credential, passes it to its own child and revokes it when that child
 *     exits, so this script never sees it;
 *   - `--spawn-local` asks `POST /dev-server/credential` for one scoped to the
 *     project root. The answer is `{ token, expiresAt }`: a process this
 *     command starts is not one the service can watch exit, so the credential
 *     carries an explicit expiry instead of being tied to the child.
 * Either way the child receives `DEBUGGEN_TOKEN` together with a matching
 * `DEBUGGEN_PROJECT_ROOT` and the `DEBUGGEN_INGEST_URL` endpoint.
 *
 * SAFETY: the editor credential is sent only as a bearer token to the service
 * on loopback. The server-agent credential is held only in this process's
 * memory and in the child's environment. This command never prints, logs or
 * writes either: both are redacted out of every part of a service error it
 * echoes (the status phrase included), a credential response is never echoed
 * at all, and the banner describes the server-agent credential by its length
 * only. This script writes nothing anywhere: it only reads, requests and
 * spawns, and once the child has exited it sends nothing further.
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
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL, URL } from 'node:url';

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

/** Unauthenticated liveness route on the service. */
export const HEALTH_PATH = '/health';

/**
 * Telemetry ingest route the preload posts batches to. Named here only because
 * it is the value of `DEBUGGEN_INGEST_URL` handed to a locally spawned child;
 * this script never posts to it.
 */
export const INGEST_PATH = '/telemetry/ingest';

/**
 * The service's launcher route (AAP 0.4.2: `POST /dev-server/launch`,
 * `{ projectRoot, command? }` → `{ devServerUrl, pid }`). The default mode
 * calls exactly this route: the service starts an instrumented dev server,
 * mints its project-scoped server-agent credential and revokes that credential
 * when the process exits (AAP 0.5.6).
 */
export const LAUNCH_PATH = '/dev-server/launch';

/**
 * The service's counterpart stop route (AAP 0.4.2: `POST /dev-server/stop`),
 * called with the same `{ projectRoot }` when the foreground run is
 * interrupted or `--stop` is passed.
 */
export const STOP_PATH = '/dev-server/stop';

/**
 * The service's server-agent credential route: `POST /dev-server/credential`,
 * `{ projectRoot }` → `{ token, expiresAt }`, editor credential required, for a
 * dev server the caller starts itself (AAP 0.5.6). `--spawn-local` calls
 * exactly this route and hands the answer's `token` to its child as
 * `DEBUGGEN_TOKEN`.
 *
 * It is not a row of the protocol's route table: the service's launcher
 * defines it once, as `DEV_SERVER_CREDENTIAL_PATH` in
 * `apps/local-service/src/dev-server/launcher.ts` together with both strict
 * body schemas, and `apps/local-service/src/server/routes/dev-server.ts`
 * registers it behind the editor-only bearer check. The service answers 403
 * when `projectRoot` is outside the workspace folders the connected editor
 * announced, and there is no counterpart revoke route: a credential minted here
 * stops working at its `expiresAt`, or when every credential is rotated.
 */
export const CREDENTIAL_PATH = '/dev-server/credential';

/**
 * Every service route this command is permitted to call, and therefore the
 * complete list a service build must answer for it to work: the three the
 * protocol defines (AAP 0.4.2) and the service's own credential route. A
 * request to anything else is a bug in this file, which is why the list is
 * exported and asserted by `scripts/dev-instrumented.test.mjs` against a stub
 * service that implements only these paths.
 */
export const SERVICE_ROUTES = Object.freeze([HEALTH_PATH, LAUNCH_PATH, STOP_PATH, CREDENTIAL_PATH]);

/** Timeout for the liveness pre-flight, per the plan's 2 s budget. */
export const HEALTH_TIMEOUT_MS = 2_000;

/** Timeout for the launch, stop and credential requests. */
export const REQUEST_TIMEOUT_MS = 5_000;

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
 * behind.
 */
const EXIT_PREFLIGHT = 2;

/**
 * Status codes that mean "this service build does not implement that route".
 * They are a hard failure, never a signal to try a different path: the routes
 * in {@link SERVICE_ROUTES} are the service's own, so a 404 or 405 is a version
 * mismatch between this checkout and the running service.
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
  node scripts/dev-instrumented.mjs --spawn-local [--project <dir>] [--service <url>]
  node scripts/dev-instrumented.mjs --stop [--project <dir>] [--service <url>]
  node scripts/dev-instrumented.mjs --help

  pnpm demo:instrumented            the same thing for ${DEFAULT_PROJECT_REL}

What it does (default mode)
  1. resolves the Node preload at ${PRELOAD_REL}
  2. resolves the target project and checks it declares a "dev" script
  3. resolves the local service from --service, or DEBUGGEN_HOST/DEBUGGEN_PORT
  4. reads the editor credential from $DEBUGGEN_HOME/${AUTH_FILE_NAME}
  5. checks GET {service}${HEALTH_PATH} answers
  6. asks the service to launch the project: POST {service}${LAUNCH_PATH}
     with { projectRoot }, authorised by that editor credential
  7. reports the devServerUrl and pid the service answers with, then waits;
     Ctrl-C (or SIGTERM) stops that server again through
     POST {service}${STOP_PATH}

  The service's launcher attaches the preload, mints the server-agent
  credential for the process it starts and revokes it when that process
  exits. The service owns that process and its credential end to end, which
  is why the default mode goes through it, and it keeps one implementation of
  launching instead of two.

  Server-tier spans (incoming requests, route handlers, outgoing fetch, Prisma
  and pg queries) exist only because the preload registers a tracer provider
  inside the dev-server process before the framework starts. Nothing in the
  target project's source is modified, and this script writes nothing to disk.

  Every route it calls is defined by the service — three by the protocol's
  route table (AAP 0.4.2), ${CREDENTIAL_PATH} by the service's
  launcher — and these four are all of them:
  ${SERVICE_ROUTES.join(', ')}.

What it does (--spawn-local)
  1. resolves the preload and the target project, as above, and the command
     that runs the project's own "dev" script
  2. reads the editor credential from $DEBUGGEN_HOME/${AUTH_FILE_NAME}
  3. checks GET {service}${HEALTH_PATH} answers
  4. asks the service for a server-agent credential scoped to the project:
     POST {service}${CREDENTIAL_PATH} with { projectRoot },
     authorised by that editor credential; the service answers
     { token, expiresAt }
  5. spawns the "dev" script here, with the preload on NODE_OPTIONS and
     DEBUGGEN_INGEST_URL, DEBUGGEN_PROJECT_ROOT and DEBUGGEN_TOKEN set
  6. forwards SIGINT/SIGTERM to that child and exits with its status

  This is an AUTHENTICATED run: it needs a running service and ${AUTH_FILE_NAME},
  and the service mints the credential only for a project under the
  workspace folders VS Code announced to it. Any failure in steps 1-4 stops
  the command before anything is spawned — a dev server without a credential
  would only look instrumented, because the preload records nothing without
  one.

  The server-agent credential is held in this process's memory and in the
  child's environment only; this command never prints, logs or writes it (the
  banner shows its length). The dev server inherits this terminal unfiltered,
  so a dev script that prints its own environment would show it there. It
  expires at the time the banner shows, which
  the service chose (12 hours after minting by default). The service has no
  revoke route, so the credential is not revoked when the child exits: it
  stops working at that expiry, or earlier when debuggen.rotateServiceToken
  rotates every credential. Once the child has exited nothing further is sent.

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
                    obtained nothing is spawned. The credential expires at the
                    time the banner shows; the service has no revoke route, so
                    it is not revoked when the child exits. Signals and the exit
                    code are forwarded.
  --stop            stop a dev server the service launched for this project
                    (POST ${STOP_PATH}) and exit.
  --help, -h        print this text

Environment it reads
  DEBUGGEN_HOST     service interface, loopback only — ${DEFAULT_SERVICE_HOST},
                    localhost or [::1] (default ${DEFAULT_SERVICE_HOST})
  DEBUGGEN_PORT     service port (default ${DEFAULT_SERVICE_PORT})
  DEBUGGEN_HOME     session home holding ${AUTH_FILE_NAME} (default ${DEFAULT_DEBUGGEN_HOME});
                    a leading ~ is expanded
  NODE_OPTIONS      inherited and appended to, never replaced (--spawn-local)

Environment it sets on the child (--spawn-local only)
  NODE_OPTIONS          inherited value + " --import <file:// URL of the preload>"
  DEBUGGEN_INGEST_URL   {service}${INGEST_PATH}
  DEBUGGEN_PROJECT_ROOT absolute path of the launched project; the preload
                        reports ingest under this root
  DEBUGGEN_TOKEN        the server-agent credential POST ${CREDENTIAL_PATH}
                        minted for this project root; it replaces any inherited
                        value, and this command never prints it (the banner
                        shows only its length)

  Everything else is inherited as-is. DATABASE_URL and the rest of the
  project's configuration stay with the project's own .env handling; this
  script neither reads nor forwards .env files.

Exit codes
  0   --help, a reported launch, a stopped dev server, or a child that exited 0
  2   a failure this command reports: usage error, missing preload, unusable
      project, no package manager on PATH, a service that is not answering, a
      missing or invalid ${AUTH_FILE_NAME}, or a launch, stop or credential
      request the service refused or answered off-contract. The message says
      whether anything was launched; in --spawn-local every such failure
      happens before the spawn, and the message says nothing was spawned.
  n   whatever the --spawn-local child exited with; 128 + signal number when it
      was signalled`;
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
 */

/**
 * Parse argv (already stripped of `node` and the script path).
 *
 * Unknown flags are a usage error rather than something passed through to the
 * child: passing arguments to the project's dev script is the project's own
 * business, and silently forwarding them would make typos look like framework
 * failures. Combinations that contradict each other are rejected here too, so
 * a mode is never silently ignored — the three mode flags select genuinely
 * different behaviour and precedence between them would be a guess.
 *
 * @param {readonly string[]} argv
 * @returns {DevInstrumentedOptions}
 * @throws {DevInstrumentedError} on an unknown flag, a missing flag value or a
 *   contradictory combination
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

    throw new DevInstrumentedError(`unrecognised argument: ${arg}`, { showUsage: true });
  }

  if (options.help) return options;

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
    `The local service binds a loopback interface (AAP 0.5.6), so ${subject} can`,
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
 * Pre-flight the service with its unauthenticated liveness route. A failure
 * here is reported before anything happens, because every mode goes on to make
 * an authorised request the service must answer: a launch, a stop, or — for
 * `--spawn-local` — the server-agent credential its child needs.
 *
 * @param {string} base service base URL
 * @returns {Promise<void>}
 * @throws {DevInstrumentedError} exit 2 when it does not answer 2xx
 */
export async function checkServiceHealth(base) {
  const url = `${base}${HEALTH_PATH}`;

  /** @type {Response} */
  let response;
  try {
    response = await globalThis.fetch(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      // Refused, not followed: the liveness of some other origin says nothing
      // about the service this command is about to launch a dev server against,
      // and the requests that follow this one carry the editor credential.
      redirect: 'error',
      signal: globalThis.AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === 'TimeoutError';
    const reason = timedOut ? `no answer within ${HEALTH_TIMEOUT_MS} ms` : describeCause(error);
    throw new DevInstrumentedError(`the local service is not answering ${url}: ${reason}`, {
      hint: serviceStartHint(base),
    });
  }

  if (!response.ok) {
    throw new DevInstrumentedError(`${url} answered ${statusLine(response)}`, {
      hint: serviceStartHint(base),
    });
  }
}

/**
 * POST JSON to the service with the editor credential as the bearer token.
 *
 * @param {object} request
 * @param {string} request.url absolute URL
 * @param {string} request.editorToken editor credential
 * @param {unknown} request.body JSON body
 * @returns {Promise<{ status: number, statusText: string, json: unknown, text: string }>}
 * @throws {DevInstrumentedError} on a transport failure or timeout
 */
async function postJson({ url, editorToken, body }) {
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

  // The body is read under the same timeout signal as the request. A body that
  // stalls or is cut off after the headers arrived is reported like any other
  // transport failure, so a caller's diagnostic (and `--spawn-local`'s
  // "nothing was spawned") is never replaced by a raw abort stack.
  /** @type {string} */
  let text;
  try {
    text = await response.text();
  } catch (error) {
    const timedOut = error instanceof Error && error.name === 'TimeoutError';
    const reason = timedOut ? `no answer within ${REQUEST_TIMEOUT_MS} ms` : describeCause(error);
    throw new DevInstrumentedError(
      `request to ${url} failed while reading its ${String(response.status)} answer: ${reason}`,
    );
  }
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
 * credential (AAP 0.4.2).
 *
 * This mode never handles a server-agent credential. The service mints one for
 * the process it starts, scopes it to that project root and revokes it when the
 * process exits (AAP 0.5.6), passing it straight to its own child. The only
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
  const response = await postJson({ url, editorToken, body: { projectRoot } });

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
        `${LAUNCH_PATH} answers { devServerUrl, pid } (AAP 0.4.2). This service`,
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
 * `POST /dev-server/stop` with the same `{ projectRoot }` (AAP 0.4.2).
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
  const response = await postJson({ url, editorToken, body: { projectRoot } });

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
 * @property {number} expiresAt epoch milliseconds after which the service
 *   refuses it
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
 * This is what makes `--spawn-local` an authenticated run (AAP 0.5.6): the
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
 * echoed, and a 2xx body is never echoed at all. There is no revoke route, so
 * the credential returned here stays valid until its `expiresAt` or the next
 * rotation; it exists only in this process's memory and in the environment of
 * the child it is handed to.
 *
 * @param {object} request
 * @param {string} request.base service base URL, without a trailing slash
 * @param {string} request.editorToken editor credential from auth.json
 * @param {string} request.projectRoot absolute path of the target project
 * @returns {Promise<ServerAgentCredential>} the minted credential and its expiry
 * @throws {DevInstrumentedError} exit 2 when the service refuses, does not
 *   implement the route, or answers off-contract
 */
export async function requestServerAgentCredential({ base, editorToken, projectRoot }) {
  const url = `${base}${CREDENTIAL_PATH}`;
  const response = await postJson({ url, editorToken, body: { projectRoot } });
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

/**
 * Build the child's environment: the inherited environment plus the four
 * variables the preload reads (`NODE_OPTIONS` with `--import`,
 * `DEBUGGEN_INGEST_URL`, `DEBUGGEN_PROJECT_ROOT`, `DEBUGGEN_TOKEN`). The
 * credential the caller supplies replaces any inherited `DEBUGGEN_TOKEN`; with
 * none, an inherited one is removed.
 *
 * Deleting rather than ignoring matters. A server-agent credential is minted
 * by the service for one project root and one process, and expires (AAP
 * 0.5.6), so a `DEBUGGEN_TOKEN` lying around in the environment belongs to
 * some other process: forwarding it would make the child post ingest with a
 * credential the service will reject, and the run would look authenticated
 * while recording nothing. `--spawn-local` always supplies the credential
 * {@link requestServerAgentCredential} obtained; the builder stays general so
 * that property holds for any caller.
 *
 * @param {object} request
 * @param {string} request.preloadUrl `file://` URL of the preload
 * @param {string} request.base service base URL
 * @param {string} request.projectRoot absolute path of the launched project
 * @param {string | undefined} request.token server-agent credential, if any
 * @param {NodeJS.ProcessEnv} [request.env] environment to inherit
 * @returns {NodeJS.ProcessEnv}
 */
export function buildChildEnv({ preloadUrl, base, projectRoot, token, env = process.env }) {
  /** @type {NodeJS.ProcessEnv} */
  const childEnv = {
    ...env,
    NODE_OPTIONS: appendImportOption(env.NODE_OPTIONS, preloadUrl),
    DEBUGGEN_INGEST_URL: `${base}${INGEST_PATH}`,
    DEBUGGEN_PROJECT_ROOT: projectRoot,
  };

  if (token === undefined) {
    // Never inherit another process's credential into a run that has none.
    delete childEnv.DEBUGGEN_TOKEN;
  } else {
    childEnv.DEBUGGEN_TOKEN = token;
  }

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
 * visibly preserved rather than assumed — describes the server-agent
 * credential by its length only, and states when that credential expires and
 * that nothing revokes it earlier.
 *
 * @param {object} request
 * @param {string} request.root repository root
 * @param {ResolvedProject} request.project
 * @param {LaunchCommand} request.command
 * @param {ResolvedPreload} request.preload
 * @param {string} request.base
 * @param {NodeJS.ProcessEnv} request.childEnv
 * @param {number} request.expiresAt epoch milliseconds the service said the
 *   child's credential expires at
 * @returns {string}
 */
export function buildBanner({ root, project, command, preload, base, childEnv, expiresAt }) {
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
    ['expires', expiry],
  ];
  const width = rows.reduce((longest, [label]) => Math.max(longest, (label ?? '').length), 0);

  return [
    'dev-instrumented: starting the development server in this terminal (--spawn-local)',
    ...rows.map(([label, value]) => `  ${(label ?? '').padEnd(width)}  ${value ?? ''}`),
    '',
    '  Stop it with Ctrl-C. Nothing in the project was modified, and no file',
    '  was written: the server-tier tracer lives in this child process only.',
    '',
    '  This run is AUTHENTICATED: the service minted the server-agent credential',
    `  above for this project root through POST ${CREDENTIAL_PATH}, so the`,
    '  preload can post server and database spans for it while a session',
    '  captures. The credential lives only in this process and in the dev',
    '  server environment; this command never prints it, but the dev server',
    '  writes to this terminal unfiltered, so a dev script that prints its own',
    '  environment would show it.',
    '',
    '  The service has no revoke route, so the credential is not revoked when',
    `  the dev server exits: it stops working at ${expiry}, or earlier`,
    '  when debuggen.rotateServiceToken rotates every credential.',
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
 * Restate a failure raised before the `--spawn-local` child exists with a hint
 * that says nothing was spawned. Anything that is not a
 * {@link DevInstrumentedError} is returned unchanged, so an unexpected failure
 * keeps its stack.
 *
 * @param {unknown} error
 * @returns {unknown}
 */
function beforeSpawn(error) {
  if (!(error instanceof DevInstrumentedError)) return error;
  return new DevInstrumentedError(error.message, {
    hint: error.hint === undefined ? NOTHING_SPAWNED : `${error.hint}\n\n${NOTHING_SPAWNED}`,
    showUsage: error.showUsage,
  });
}

/**
 * @typedef {object} LocalSpawnPlan
 * @property {LaunchCommand} command what will be spawned
 * @property {NodeJS.ProcessEnv} childEnv the child's environment, credential
 *   included
 * @property {number} expiresAt epoch milliseconds the credential expires at
 */

/**
 * Everything `--spawn-local` does before it spawns, as a hard pre-flight:
 * resolve the launch command (which validates the project's package name and
 * finds the package manager), read the editor credential, confirm the service
 * answers, and ask it for a server-agent credential scoped to the project.
 *
 * The credential is requested last, once everything local has been validated,
 * so the service never mints one for a run that cannot start: with no revoke
 * route, a minted credential would otherwise stay valid until its expiry with
 * no process to use it. Every failure is raised with a hint that says nothing
 * was spawned.
 *
 * @param {object} request
 * @param {string} request.root repository root
 * @param {ResolvedProject} request.project
 * @param {ResolvedPreload} request.preload
 * @param {string} request.base service base URL
 * @param {NodeJS.ProcessEnv} request.env environment to read and to inherit
 * @returns {Promise<LocalSpawnPlan>}
 * @throws {DevInstrumentedError} exit 2, before anything is spawned
 */
async function prepareLocalSpawn({ root, project, preload, base, env }) {
  try {
    const command = buildLaunchCommand({ project, root, env });
    const editorToken = await readEditorCredential(resolveDebuggenHome(env));
    await checkServiceHealth(base);
    const { token, expiresAt } = await requestServerAgentCredential({
      base,
      editorToken,
      projectRoot: project.dir,
    });
    const childEnv = buildChildEnv({
      preloadUrl: preload.url,
      base,
      projectRoot: project.dir,
      token,
      env,
    });
    return { command, childEnv, expiresAt };
  } catch (error) {
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
 *   launch report and the usage text are written to
 * @property {import('node:stream').Writable} [stderr] stream failures and hints
 *   are written to
 */

/**
 * CLI entry point.
 *
 * The order is fixed so that every failure happens before anything runs:
 * resolve the preload, resolve the target project, resolve the service, read
 * the editor credential, confirm the service answers, and only then launch,
 * stop or spawn.
 *
 * `--spawn-local` runs the same pre-flight and one more step: it asks the
 * service for the server-agent credential its child needs, after the launch
 * command has been resolved and validated (see {@link prepareLocalSpawn}). Any
 * failure there exits 2 before the child exists.
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
      await checkServiceHealth(base);
      await stopDevServer({ base, editorToken, projectRoot: project.dir });
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
      // held in `childEnv` and nowhere else; the banner describes it by length
      // and expiry only, and once the child exits nothing further is sent.
      const { command, childEnv, expiresAt } = await prepareLocalSpawn({
        root,
        project,
        preload,
        base,
        env,
      });

      writeLine(
        stdout,
        buildBanner({ root, project, command, preload, base, childEnv, expiresAt }),
      );

      return await runDevServer(command, childEnv);
    }

    const editorToken = await readEditorCredential(resolveDebuggenHome(env));
    await checkServiceHealth(base);

    const result = await launchDevServer({ base, editorToken, projectRoot: project.dir });
    writeLine(stdout, buildLaunchReport({ project, base, result, foreground: !options.detach }));

    if (options.detach) return EXIT_OK;

    const signal = await awaitShutdownSignal();
    writeLine(stdout, `\ndev-instrumented: ${signal} received; stopping the dev server`);
    await stopDevServer({ base, editorToken, projectRoot: project.dir });
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
