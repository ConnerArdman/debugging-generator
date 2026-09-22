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
 *                    (`POST /dev-server/stop`). This is the mode that yields
 *                    AUTHENTICATED server and database telemetry, because the
 *                    service is the only component that mints a server-agent
 *                    credential (see WHY THE CREDENTIAL MATTERS below).
 *   --spawn-local    spawn the project's own `dev` script from this terminal
 *                    with the preload attached and no credential, which is the
 *                    unauthenticated shape: the service rejects ingest, so no
 *                    server or database spans are recorded. Useful offline and
 *                    to demonstrate exactly that failure mode.
 *
 * `--detach` returns as soon as the service has reported the launch instead of
 * waiting for Ctrl-C, and `--stop` stops a dev server the service launched for
 * the project — the two halves of the default mode, available separately for
 * scripts and for a terminal that has since been closed.
 *
 * ROUTES — THE CONTRACT IS NOT NEGOTIABLE HERE: this file is a *caller*. The
 * routes it may use are the ones the protocol defines (AAP 0.4.2), and
 * {@link SERVICE_ROUTES} is the whole list: `GET /health`,
 * `POST /dev-server/launch`, `POST /dev-server/stop`. There is deliberately no
 * route-name guessing, no probe list and no environment override that points at
 * a different path: a caller that invents an endpoint the service does not
 * define cannot work against the specified service, and an override would only
 * hide that. If a future protocol version adds a dedicated server-agent
 * credential route, add it to `packages/protocol/src/http.ts` first and then
 * name it here — in that order.
 *
 * BOUNDARY — deliberately NOT implemented here, because the launcher owns it:
 *   - detecting an already-running dev server, probing ports or URLs;
 *   - retry/backoff, health polling or waiting for the server to be listening;
 *   - session creation, tab binding or any session bookkeeping;
 *   - minting, hashing, storing or refreshing credentials of any kind;
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
 * server-agent credential scoped to one project root, and expires it when the
 * launched process exits (AAP 0.5.6). That credential is minted per dev-server
 * launch by the service itself, so the only way a caller obtains an
 * instrumented dev server with a valid credential is to let the launcher start
 * it — which is what the default mode does, authorised by the editor
 * credential the service wrote to `$DEBUGGEN_HOME/auth.json`. The launcher
 * passes `DEBUGGEN_TOKEN` and a matching `DEBUGGEN_PROJECT_ROOT` to the child
 * it starts; this script never handles a server-agent credential at all.
 *
 * SAFETY: the editor credential is sent only as a bearer token to the service
 * on loopback, is never printed, never logged and never written to disk, and is
 * redacted out of any service error this command echoes. This script writes
 * nothing anywhere: it only reads, requests and spawns.
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
 * calls exactly this route: it is the one place in the protocol where an
 * instrumented dev server is started and its project-scoped server-agent
 * credential is minted (AAP 0.5.6).
 */
export const LAUNCH_PATH = '/dev-server/launch';

/**
 * The service's counterpart stop route (AAP 0.4.2: `POST /dev-server/stop`),
 * called with the same `{ projectRoot }` when the foreground run is
 * interrupted or `--stop` is passed.
 */
export const STOP_PATH = '/dev-server/stop';

/**
 * Every service route this command is permitted to call, and therefore the
 * complete list a service build must answer for it to work. All three are
 * defined by the protocol (AAP 0.4.2); a request to anything else is a bug in
 * this file, which is why the list is exported and asserted by
 * `scripts/dev-instrumented.test.mjs` against a stub service that implements
 * only these paths.
 */
export const SERVICE_ROUTES = Object.freeze([HEALTH_PATH, LAUNCH_PATH, STOP_PATH]);

/** Timeout for the liveness pre-flight, per the plan's 2 s budget. */
export const HEALTH_TIMEOUT_MS = 2_000;

/** Timeout for the launch and stop requests. */
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
 * `auth.json`, a launch or stop the service refused, an unusable target
 * project, or no package manager on `PATH`. Every message that uses this code
 * states whether anything was launched, so "2" is never ambiguous about the
 * state it leaves behind.
 */
const EXIT_PREFLIGHT = 2;

/**
 * Status codes that mean "this service build does not implement that route".
 * They are a hard failure, never a signal to try a different path: the routes
 * in {@link SERVICE_ROUTES} are the protocol's, so a 404 or 405 is a version
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

  The service's launcher attaches the preload and mints the server-agent
  credential for the process it starts (it is the only component that can:
  a credential is scoped to one project root and expires with the process).
  That is why the default mode goes through it — it is the only way this
  command produces authenticated server and database telemetry, and it keeps
  one implementation of launching instead of two.

  Server-tier spans (incoming requests, route handlers, outgoing fetch, Prisma
  and pg queries) exist only because the preload registers a tracer provider
  inside the dev-server process before the framework starts. Nothing in the
  target project's source is modified, and this script writes nothing to disk.

  Every route it calls is defined by the protocol (AAP 0.4.2), and these three
  are all of them: ${SERVICE_ROUTES.join(', ')}.

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
                    with the preload and DEBUGGEN_INGEST_URL, and WITHOUT a
                    credential: the service rejects unauthenticated ingest, so
                    NO server or database spans are recorded. Useful offline
                    and to demonstrate that failure mode. Signals and the exit
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
  DEBUGGEN_TOKEN        removed from the child's environment: only the
                        service's launcher mints a server-agent credential, so
                        a local spawn has none and an inherited value would be
                        a stale credential for some other process

  Everything else is inherited as-is. DATABASE_URL and the rest of the
  project's configuration stay with the project's own .env handling; this
  script neither reads nor forwards .env files.

Exit codes
  0   --help, a reported launch, a stopped dev server, or a child that exited 0
  2   a failure this command reports: usage error, missing preload, service not
      answering, missing or invalid ${AUTH_FILE_NAME}, a launch or stop the
      service refused, unusable project, or no package manager on PATH. The
      message says whether anything was launched.
  n   whatever the --spawn-local child exited with; 128 + signal number when it
      was signalled`;
}

/**
 * @typedef {object} DevInstrumentedOptions
 * @property {boolean} help print usage and exit
 * @property {boolean} spawnLocal spawn the dev server here, without a credential
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
          'and this command needs it to authorise the launch it asks the service',
          'to perform.',
          '',
          serviceStartHint(),
          '',
          'Set DEBUGGEN_HOME if your session home is elsewhere, or pass',
          '--spawn-local to start the dev server from this terminal without a',
          'credential (ingest is rejected, so no server or database spans will be',
          'recorded).',
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
 * here is reported before anything is spawned, because a dev server started
 * without a reachable service produces telemetry nobody collects.
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
    throw new DevInstrumentedError(
      `${url} answered ${response.status} ${response.statusText}`.trimEnd(),
      { hint: serviceStartHint(base) },
    );
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

  const text = await response.text();
  /** @type {unknown} */
  let json;
  try {
    json = text === '' ? undefined : JSON.parse(text);
  } catch {
    json = undefined;
  }

  return { status: response.status, statusText: response.statusText, json, text };
}

/**
 * The single-line reason a service response carries, when it carries one.
 * Bounded so a large body cannot flood the terminal.
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
      if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim();
    }
  }
  const flat = text.replace(/\s+/gu, ' ').trim();
  if (flat === '') return '';
  return flat.length > 200 ? `${flat.slice(0, 200)}…` : flat;
}

/**
 * Remove any credential this process knows about from text that is about to be
 * printed. A service is not expected to echo a bearer token back in an error
 * body, but a diagnostic that did would put a credential in a terminal and a
 * scrollback buffer, and this command prints service errors verbatim.
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
 * Append the service's reason to a message when there is one, with any known
 * credential redacted out of it.
 *
 * @param {string} message
 * @param {{ json: unknown, text: string }} response
 * @param {readonly (string | undefined)[]} [secrets] credentials to redact
 * @returns {string}
 */
function withReason(message, response, secrets = []) {
  const reason = redactSecrets(responseReason(response), secrets);
  return reason === '' ? message : `${message}: ${reason}`;
}

/**
 * The recovery hint for "the service refused the editor credential". Shared by
 * both authorised calls so the two paths give identical advice.
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
 * @param {string} route protocol route that answered 404/405
 * @returns {string}
 */
function routeAbsentHint(route) {
  return [
    `${route} is part of the protocol (AAP 0.4.2), so a service that does not`,
    'answer it is older or newer than this checkout. Rebuild and restart it:',
    '',
    '  pnpm --filter @debuggen/local-service build',
    '',
    'then re-run this command. Do not point this command at a different path:',
    "the routes it calls are the protocol's, and guessing one produces a launch",
    'that no service actually performed.',
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
 * This is the whole of the credential story on this side. The service mints
 * the server-agent credential for the process it starts, scopes it to that
 * project root and expires it with the process (AAP 0.5.6), so a caller that
 * wants authenticated server telemetry asks the launcher to start the server —
 * there is no credential-minting route in the protocol for a caller to call,
 * and this file must never invent one.
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
      withReason(`${url} answered ${response.status} ${response.statusText}`.trimEnd(), response, [
        editorToken,
      ]),
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
      withReason(`${url} answered ${response.status} ${response.statusText}`.trimEnd(), response, [
        editorToken,
      ]),
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
 * @typedef {object} ResolvedProject
 * @property {string} dir absolute path of the project directory
 * @property {string} label how the project is named in output
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

  if (typeof scripts.dev !== 'string' || scripts.dev.trim() === '') {
    throw new DevInstrumentedError(
      `${packageName ?? display(root, dir)} has no "dev" script to instrument`,
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
    packageName === undefined ? display(root, dir) : `${display(root, dir)} (${packageName})`;
  return { dir, label, packageName, inRepo };
}

/**
 * Find an executable on `PATH` without spawning a shell. On Windows the
 * `PATHEXT` extensions are tried in order, which is how `pnpm` resolves to
 * `pnpm.cmd`.
 *
 * @param {string} name bare command name
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string | undefined} absolute path, or `undefined` when not found
 */
export function lookupExecutable(name, env = process.env) {
  const rawPath = env.PATH ?? env.Path ?? '';
  if (rawPath === '') return undefined;

  const extensions =
    process.platform === 'win32'
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
 */

/**
 * Build the command that runs the project's `dev` script.
 *
 * Inside this repository pnpm's workspace filter is used from the repository
 * root, so the child sees the same resolution `pnpm dev` would give it.
 * Elsewhere — or when pnpm is not installed — the project's own package
 * manager script is run from the project directory.
 *
 * @param {object} request
 * @param {ResolvedProject} request.project
 * @param {string} [request.root] repository root
 * @param {NodeJS.ProcessEnv} [request.env]
 * @returns {LaunchCommand}
 * @throws {DevInstrumentedError} exit 2 when no package manager is on PATH
 */
export function buildLaunchCommand({ project, root = REPO_ROOT, env = process.env }) {
  const pnpmPath = lookupExecutable('pnpm', env);
  const npmPath = pnpmPath === undefined ? lookupExecutable('npm', env) : undefined;

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
    return wrapForPlatform({
      file: pnpmPath,
      args: ['--filter', project.packageName, 'dev'],
      cwd: root,
      display: `pnpm --filter ${project.packageName} dev`,
    });
  }

  const manager = pnpmPath ?? /** @type {string} */ (npmPath);
  const managerName = pnpmPath === undefined ? 'npm' : 'pnpm';
  return wrapForPlatform({
    file: manager,
    args: ['run', 'dev'],
    cwd: project.dir,
    display: `${managerName} run dev`,
  });
}

/**
 * Keep `shell: false` on every platform. Windows cannot execute a `.cmd`
 * launcher directly, so it is run through the command interpreter explicitly
 * rather than by enabling a shell, which would expose the arguments to shell
 * interpolation.
 *
 * @param {LaunchCommand} command
 * @returns {LaunchCommand}
 */
function wrapForPlatform(command) {
  if (process.platform !== 'win32') return command;
  const extension = path.extname(command.file).toLowerCase();
  if (extension !== '.cmd' && extension !== '.bat') return command;
  const interpreter = process.env.ComSpec ?? 'cmd.exe';
  return {
    ...command,
    file: interpreter,
    args: ['/d', '/s', '/c', command.file, ...command.args],
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
 * Build the child's environment: the inherited environment plus the three
 * variables that turn a plain dev server into an instrumented one, and minus
 * any inherited `DEBUGGEN_TOKEN` when this run has no credential of its own.
 *
 * Deleting rather than ignoring matters. Only the service's launcher mints a
 * server-agent credential, and one is scoped to a single project root and
 * expires with the process it was minted for (AAP 0.5.6), so a `DEBUGGEN_TOKEN`
 * lying around in the environment belongs to some other process: forwarding it
 * would make the child post ingest with a credential the service will reject,
 * and the run would look authenticated while recording nothing.
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
    // Never inherit another process's credential into an unauthenticated run.
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
 * In `--spawn-local` the credential is always absent — only the service's
 * launcher mints one — so the description says what that costs rather than
 * leaving an empty field.
 *
 * @param {string | undefined} token
 * @returns {string}
 */
export function describeToken(token) {
  if (token === undefined) {
    return '<not set (--spawn-local): the service rejects unauthenticated ingest, so no server or database spans will be recorded>';
  }
  return `<set, ${Buffer.byteLength(token, 'utf8')} bytes>`;
}

/**
 * The banner printed once, immediately before a `--spawn-local` child is
 * spawned. It names everything that makes this run different from a plain
 * `dev` — including the effective `NODE_OPTIONS`, so an inherited value is
 * visibly preserved rather than assumed — and the missing credential as a
 * description of what it costs.
 *
 * @param {object} request
 * @param {string} request.root repository root
 * @param {ResolvedProject} request.project
 * @param {LaunchCommand} request.command
 * @param {ResolvedPreload} request.preload
 * @param {string} request.base
 * @param {NodeJS.ProcessEnv} request.childEnv
 * @returns {string}
 */
export function buildBanner({ root, project, command, preload, base, childEnv }) {
  const rows = [
    ['project', project.label],
    ['command', `${command.display}  (cwd ${display(root, command.cwd)})`],
    ['preload', preload.relative],
    ['service', base],
    ['NODE_OPTIONS', childEnv.NODE_OPTIONS ?? ''],
    ['DEBUGGEN_INGEST_URL', childEnv.DEBUGGEN_INGEST_URL ?? ''],
    ['DEBUGGEN_PROJECT_ROOT', childEnv.DEBUGGEN_PROJECT_ROOT ?? ''],
    ['DEBUGGEN_TOKEN', describeToken(childEnv.DEBUGGEN_TOKEN)],
  ];
  const width = rows.reduce((longest, [label]) => Math.max(longest, (label ?? '').length), 0);

  return [
    'dev-instrumented: starting the development server in this terminal (--spawn-local)',
    ...rows.map(([label, value]) => `  ${(label ?? '').padEnd(width)}  ${value ?? ''}`),
    '',
    '  Stop it with Ctrl-C. Nothing in the project was modified, and no file',
    '  was written: the server-tier tracer lives in this child process only.',
    '',
    '  This run is UNAUTHENTICATED: the service accepts telemetry ingest only',
    '  from a server-agent credential it minted for the process it launched, so',
    '  no server or database spans will be recorded. Run this command without',
    '  --spawn-local to have the service launch the project instead, which is',
    '  the path that produces authenticated server telemetry.',
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
      // No editor credential is read: this mode makes no authorised call, and
      // reading a credential it cannot use would be misleading.
      await checkServiceHealth(base);

      const command = buildLaunchCommand({ project, root, env });
      const childEnv = buildChildEnv({
        preloadUrl: preload.url,
        base,
        projectRoot: project.dir,
        token: undefined,
        env,
      });

      writeLine(stdout, buildBanner({ root, project, command, preload, base, childEnv }));

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
