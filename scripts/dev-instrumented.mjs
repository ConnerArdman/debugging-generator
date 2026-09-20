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
 * wants the instrumented dev server in their own terminal — and nothing more.
 * It resolves paths, pre-flights the service, asks the service for a credential,
 * spawns the project's `dev` script with the right environment, and forwards
 * signals and the exit code.
 *
 * BOUNDARY — deliberately NOT implemented here, because the launcher owns it:
 *   - detecting an already-running dev server, probing ports or URLs;
 *   - retry/backoff, health polling or waiting for the server to be listening;
 *   - session creation, tab binding or any session bookkeeping;
 *   - child-process lifecycle bookkeeping beyond "forward signals, exit with
 *     the child's status";
 *   - minting, hashing, storing or refreshing credentials (it *asks* the
 *     service for one and passes it through);
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
 * credential scoped to one project root, and expires it when the launched
 * process exits. This script requests that credential with the editor
 * credential the service wrote to `$DEBUGGEN_HOME/auth.json`, hands it to the
 * child as `DEBUGGEN_TOKEN`, and passes the same project root as
 * `DEBUGGEN_PROJECT_ROOT` so the preload's ingest calls match the credential's
 * scope.
 *
 * SAFETY: the credential is never printed, never logged and never written to
 * disk — the banner reports only that it is set and how long it is. This
 * script writes nothing anywhere: it only reads, requests and spawns.
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

/** Telemetry ingest route the preload posts batches to. */
export const INGEST_PATH = '/telemetry/ingest';

/** The service's own launcher route, used only by `--via-service`. */
export const LAUNCH_PATH = '/dev-server/launch';

/**
 * Candidate routes for "mint a server-agent credential for this project root",
 * tried in order with the editor credential as the bearer token.
 *
 * The service owns these route names (`apps/local-service/src/server/routes/`
 * and `src/server/auth.ts`); this list is the ask, not a second definition of
 * the credential itself. A `404` or `405` means "not this route" and the next
 * candidate is tried; any other status is treated as the service's real answer.
 * Set `DEBUGGEN_CREDENTIAL_PATH` to a single route to bypass the list.
 */
export const CREDENTIAL_PATHS = Object.freeze([
  '/dev-server/credential',
  '/credentials/server-agent',
  '/dev-server/token',
]);

/** Timeout for the liveness pre-flight, per the plan's 2 s budget. */
export const HEALTH_TIMEOUT_MS = 2_000;

/** Timeout for the credential and launch requests. */
export const REQUEST_TIMEOUT_MS = 5_000;

/** Everything went as asked (or `--help` / `--via-service` completed). */
const EXIT_OK = 0;

/**
 * Usage error or pre-flight failure: bad flag, missing preload, service down,
 * missing or invalid `auth.json`, credential request rejected, unusable target
 * project, or no package manager on `PATH`. Nothing was spawned.
 */
const EXIT_PREFLIGHT = 2;

/** Status codes that mean "this route does not exist here, try the next". */
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
  node scripts/dev-instrumented.mjs [--project <dir>] [--service <url>] [--no-token]
  node scripts/dev-instrumented.mjs --via-service [--project <dir>] [--service <url>]
  node scripts/dev-instrumented.mjs --help

  pnpm demo:instrumented            the same thing for ${DEFAULT_PROJECT_REL}

What it does
  1. resolves the Node preload at ${PRELOAD_REL}
  2. resolves the local service from --service, or DEBUGGEN_HOST/DEBUGGEN_PORT
  3. reads the editor credential from $DEBUGGEN_HOME/${AUTH_FILE_NAME}
  4. checks GET {service}${HEALTH_PATH} answers
  5. asks the service for a server-agent credential scoped to the project root
  6. spawns the project's "dev" script with the preload and that credential

  Server-tier spans (incoming requests, route handlers, outgoing fetch, Prisma
  and pg queries) exist only because the preload registers a tracer provider
  inside this child process before the framework starts. Nothing in the target
  project's source is modified, and this script writes nothing to disk.

  Starting a dev server is also a product feature: the local service's launcher
  (apps/local-service/src/dev-server/launcher.ts) does it for a session, with
  detection, and ties the child to that session. This script is the CLI
  equivalent for a terminal, not a second implementation — use --via-service to
  delegate to the product path instead.

Options
  --project <dir>   project to launch; relative paths resolve against the
                    current directory (default: ${DEFAULT_PROJECT_REL} inside this
                    repository). The directory needs a package.json with a
                    "dev" script.
  --service <url>   base URL of the local service, overriding
                    DEBUGGEN_HOST/DEBUGGEN_PORT (example: http://127.0.0.1:43117)
  --via-service     do not spawn anything here: ask the service to launch the
                    project through its own launcher (POST ${LAUNCH_PATH}),
                    print the dev server URL and pid it reports, and exit. The
                    preload is still checked first, because the service
                    attaches that same file.
  --no-token        skip the credential request and start the child without
                    DEBUGGEN_TOKEN. The service rejects unauthenticated ingest,
                    so NO server or database spans are recorded; useful only to
                    demonstrate that failure mode.
  --help, -h        print this text

Environment it reads
  DEBUGGEN_HOST     service interface (default ${DEFAULT_SERVICE_HOST})
  DEBUGGEN_PORT     service port (default ${DEFAULT_SERVICE_PORT})
  DEBUGGEN_HOME     session home holding ${AUTH_FILE_NAME} (default ${DEFAULT_DEBUGGEN_HOME});
                    a leading ~ is expanded
  DEBUGGEN_CREDENTIAL_PATH
                    single credential route to use instead of trying
                    ${CREDENTIAL_PATHS.join(', ')}
  NODE_OPTIONS      inherited and appended to, never replaced

Environment it sets on the child
  NODE_OPTIONS          inherited value + " --import <file:// URL of the preload>"
  DEBUGGEN_INGEST_URL   {service}${INGEST_PATH}
  DEBUGGEN_TOKEN        the server-agent credential (omitted with --no-token).
                        Never printed, never logged, never written to disk.
  DEBUGGEN_PROJECT_ROOT absolute path of the launched project; ingest is
                        accepted only for the credential's project root, so
                        these two always match

  Everything else is inherited as-is. DATABASE_URL and the rest of the
  project's configuration stay with the project's own .env handling; this
  script neither reads nor forwards .env files.

Exit codes
  0   --help or --via-service completed, or the child exited 0
  2   usage error, missing preload, service not answering, missing or invalid
      ${AUTH_FILE_NAME}, credential request rejected, unusable project, or no
      package manager on PATH — nothing was spawned
  n   whatever the child exited with; 128 + signal number when it was signalled`;
}

/**
 * @typedef {object} DevInstrumentedOptions
 * @property {boolean} help print usage and exit
 * @property {boolean} viaService delegate to the service's launcher route
 * @property {boolean} noToken skip the credential request
 * @property {string | undefined} project raw `--project` value, if given
 * @property {string | undefined} service raw `--service` value, if given
 */

/**
 * Parse argv (already stripped of `node` and the script path).
 *
 * Unknown flags are a usage error rather than something passed through to the
 * child: passing arguments to the project's dev script is the project's own
 * business, and silently forwarding them would make typos look like framework
 * failures.
 *
 * @param {readonly string[]} argv
 * @returns {DevInstrumentedOptions}
 * @throws {DevInstrumentedError} on an unknown flag or a missing flag value
 */
export function parseArgs(argv) {
  /** @type {DevInstrumentedOptions} */
  const options = {
    help: false,
    viaService: false,
    noToken: false,
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
    if (arg === '--via-service') {
      options.viaService = true;
      continue;
    }
    if (arg === '--no-token') {
      options.noToken = true;
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
 * Resolve the local service's base URL: `--service` wins, otherwise
 * `DEBUGGEN_HOST` and `DEBUGGEN_PORT` with the documented defaults.
 *
 * The returned value never has a trailing slash, so `${base}${path}` is always
 * a valid URL. A bare IPv6 host is bracketed.
 *
 * @param {{ service?: string | undefined, env?: NodeJS.ProcessEnv }} [options]
 * @returns {string}
 * @throws {DevInstrumentedError} when `--service` is not an http(s) URL
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
    return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`;
  }

  const host = cleanEnv(env.DEBUGGEN_HOST) ?? DEFAULT_SERVICE_HOST;
  const port = cleanEnv(env.DEBUGGEN_PORT) ?? DEFAULT_SERVICE_PORT;
  if (!/^\d+$/.test(port)) {
    throw new DevInstrumentedError(`DEBUGGEN_PORT is not a number: ${port}`, {
      hint: `Unset it to use the default (${DEFAULT_SERVICE_PORT}) or pass --service <url>.`,
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
          'and this command needs it to ask for a server-agent credential for',
          'the project it launches.',
          '',
          serviceStartHint(),
          '',
          'Set DEBUGGEN_HOME if your session home is elsewhere, or pass',
          '--no-token to start the dev server without ingest credentials (no',
          'server or database spans will be recorded).',
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
 * The credential routes this run will try, in order.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {readonly string[]}
 */
function credentialPaths(env = process.env) {
  const override = cleanEnv(env.DEBUGGEN_CREDENTIAL_PATH);
  if (override === undefined) return CREDENTIAL_PATHS;
  return [override.startsWith('/') ? override : `/${override}`];
}

/**
 * Ask the service for a server-agent credential scoped to one project root.
 *
 * The credential itself is minted, hashed and stored by the service
 * (`apps/local-service/src/server/auth.ts`); this function only asks for one
 * and returns it. It never derives, caches or persists a credential, and the
 * caller passes it straight to the child's environment — the same thing the
 * product launcher does for a session-owned dev server.
 *
 * `POST /dev-server/launch` is deliberately not used here: that route is the
 * launcher, which would spawn the process itself, and this CLI exists to be
 * the alternative to that. `--via-service` is the way to use the launcher.
 *
 * @param {object} request
 * @param {string} request.base service base URL, without a trailing slash
 * @param {string} request.editorToken editor credential from auth.json
 * @param {string} request.projectRoot absolute path the credential is scoped to
 * @param {NodeJS.ProcessEnv} [request.env] environment to read the override from
 * @returns {Promise<string>} the server-agent credential
 * @throws {DevInstrumentedError} exit 2 when no route answers with a credential
 */
export async function mintServerAgentToken({ base, editorToken, projectRoot, env }) {
  const paths = credentialPaths(env ?? process.env);
  /** @type {string[]} */
  const attempts = [];

  for (const route of paths) {
    const url = `${base}${route}`;
    const response = await postJson({ url, editorToken, body: { projectRoot } });

    if (ROUTE_ABSENT_STATUSES.includes(response.status)) {
      attempts.push(`${route} → ${response.status}`);
      continue;
    }

    if (response.status === 401 || response.status === 403) {
      throw new DevInstrumentedError(
        withReason(`the service rejected the editor credential at ${route}`, response, [
          editorToken,
        ]),
        {
          hint: [
            `The credential in ${AUTH_FILE_NAME} is stale or was rotated. Restart the`,
            'service (or run debuggen.rotateServiceToken and let it rewrite the',
            'file), then re-run this command.',
          ].join('\n'),
        },
      );
    }

    if (response.status < 200 || response.status >= 300) {
      throw new DevInstrumentedError(
        withReason(
          `${url} answered ${response.status} ${response.statusText}`.trimEnd(),
          response,
          [editorToken],
        ),
      );
    }

    const token = extractToken(response.json, ['token', 'credential', 'serverAgentToken']);
    if (token === undefined) {
      throw new DevInstrumentedError(`${url} answered without a credential`, {
        hint: 'Expected a JSON object with a "token" (or a "credential" holding one).',
      });
    }
    return token;
  }

  throw new DevInstrumentedError(
    `the service exposes no server-agent credential route (tried ${attempts.join(', ')})`,
    {
      hint: [
        'This build of the service does not answer any of the routes this',
        'command knows about. Either:',
        '',
        '  - set DEBUGGEN_CREDENTIAL_PATH to the route it does expose, or',
        '  - run with --via-service to let the service launch the dev server',
        `    itself through ${LAUNCH_PATH}, or`,
        '  - run with --no-token to start without ingest credentials (no server',
        '    or database spans will be recorded).',
      ].join('\n'),
    },
  );
}

/**
 * @typedef {object} LaunchViaServiceResult
 * @property {string | undefined} devServerUrl URL the service reports
 * @property {number | undefined} pid process id the service reports
 */

/**
 * Delegate to the product launcher: ask the service to start the project
 * itself. Used only by `--via-service`, as the documented way to exercise the
 * path a real session uses instead of this CLI's own spawn.
 *
 * @param {object} request
 * @param {string} request.base service base URL
 * @param {string} request.editorToken editor credential
 * @param {string} request.projectRoot absolute path of the target project
 * @returns {Promise<LaunchViaServiceResult>}
 * @throws {DevInstrumentedError} exit 2 when the launch is refused
 */
export async function launchViaService({ base, editorToken, projectRoot }) {
  const url = `${base}${LAUNCH_PATH}`;
  const response = await postJson({ url, editorToken, body: { projectRoot } });

  if (response.status === 401 || response.status === 403) {
    throw new DevInstrumentedError(
      withReason('the service rejected the editor credential', response, [editorToken]),
      {
        hint: `The credential in ${AUTH_FILE_NAME} is stale or was rotated; restart the service and re-run.`,
      },
    );
  }
  if (ROUTE_ABSENT_STATUSES.includes(response.status)) {
    throw new DevInstrumentedError(`the service has no ${LAUNCH_PATH} route`, {
      hint: 'Run without --via-service to spawn the dev server from this terminal instead.',
    });
  }
  if (response.status < 200 || response.status >= 300) {
    throw new DevInstrumentedError(
      withReason(`${url} answered ${response.status} ${response.statusText}`.trimEnd(), response, [
        editorToken,
      ]),
    );
  }

  const record =
    typeof response.json === 'object' && response.json !== null
      ? /** @type {Record<string, unknown>} */ (response.json)
      : {};
  const devServerUrl = typeof record.devServerUrl === 'string' ? record.devServerUrl : undefined;
  const pid =
    typeof record.pid === 'number' && Number.isInteger(record.pid) ? record.pid : undefined;
  return { devServerUrl, pid };
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
 * Build the child's environment: the inherited environment plus the four
 * variables that turn a plain dev server into an instrumented one.
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
    // Never inherit a stale credential into an explicitly unauthenticated run.
    delete childEnv.DEBUGGEN_TOKEN;
  } else {
    childEnv.DEBUGGEN_TOKEN = token;
  }

  return childEnv;
}

/**
 * Describe the credential without disclosing it. The byte count is reported so
 * a developer can tell "set" from "set to something implausible" without the
 * value ever reaching a terminal, a log file or a scrollback buffer.
 *
 * @param {string | undefined} token
 * @returns {string}
 */
export function describeToken(token) {
  if (token === undefined) {
    return '<not set (--no-token): the service rejects unauthenticated ingest, so no server or database spans will be recorded>';
  }
  return `<set, ${Buffer.byteLength(token, 'utf8')} bytes>`;
}

/**
 * The banner printed once, immediately before the child is spawned. It names
 * everything that makes this run different from a plain `dev` — including the
 * effective `NODE_OPTIONS`, so an inherited value is visibly preserved rather
 * than assumed — and the credential only as a description.
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
    'dev-instrumented: starting the instrumented development server',
    ...rows.map(([label, value]) => `  ${(label ?? '').padEnd(width)}  ${value ?? ''}`),
    '',
    '  Stop it with Ctrl-C. Nothing in the project was modified, and no file',
    '  was written: the server-tier tracer lives in this child process only.',
  ].join('\n');
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
 * @returns {number}
 */
function reportFailure(error) {
  if (error instanceof DevInstrumentedError) {
    writeLine(process.stderr, `dev-instrumented: ${error.message}`);
    if (error.hint !== undefined) writeLine(process.stderr, `\n${error.hint}`);
    if (error.showUsage) writeLine(process.stderr, `\n${usage()}`);
    return error.exitCode;
  }

  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
  writeLine(process.stderr, `dev-instrumented: unexpected failure\n${detail}`);
  return EXIT_PREFLIGHT;
}

/**
 * CLI entry point.
 *
 * The order is fixed so that every failure happens before anything is
 * spawned: resolve the preload, resolve the service, read the editor
 * credential, confirm the service answers, obtain the process-scoped
 * credential, and only then start the dev server.
 *
 * @param {readonly string[]} [argv] arguments after the script path
 * @returns {Promise<number>} process exit code
 */
export async function main(argv = process.argv.slice(2)) {
  /** @type {DevInstrumentedOptions} */
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    return reportFailure(error);
  }

  if (options.help) {
    writeLine(process.stdout, usage());
    return EXIT_OK;
  }

  try {
    const preload = await resolvePreload(REPO_ROOT);
    const project = await resolveProject({ root: REPO_ROOT, project: options.project });
    const base = resolveServiceBase({ service: options.service });

    if (options.viaService && options.noToken) {
      writeLine(
        process.stderr,
        'dev-instrumented: --no-token has no effect with --via-service; the service mints the credential for the process it launches.',
      );
    }

    // The editor credential is needed for both the delegated launch and the
    // credential request, and only skippable on the explicitly
    // unauthenticated local path.
    const needsEditorCredential = options.viaService || !options.noToken;
    const editorToken = needsEditorCredential ? await readEditorCredential() : undefined;

    await checkServiceHealth(base);

    if (options.viaService) {
      const result = await launchViaService({
        base,
        editorToken: /** @type {string} */ (editorToken),
        projectRoot: project.dir,
      });
      writeLine(
        process.stdout,
        [
          `dev-instrumented: the service launched ${project.label} through ${LAUNCH_PATH}`,
          `  dev server  ${result.devServerUrl ?? '(not reported)'}`,
          `  pid         ${result.pid ?? '(not reported)'}`,
          '',
          '  The service owns that process: it attached the preload, minted the',
          '  credential and will stop the process with the session. Nothing is',
          '  running in this terminal.',
        ].join('\n'),
      );
      return EXIT_OK;
    }

    const token = options.noToken
      ? undefined
      : await mintServerAgentToken({
          base,
          editorToken: /** @type {string} */ (editorToken),
          projectRoot: project.dir,
        });

    const command = buildLaunchCommand({ project, root: REPO_ROOT });
    const childEnv = buildChildEnv({
      preloadUrl: preload.url,
      base,
      projectRoot: project.dir,
      token,
    });

    writeLine(
      process.stdout,
      buildBanner({ root: REPO_ROOT, project, command, preload, base, childEnv }),
    );

    return await runDevServer(command, childEnv);
  } catch (error) {
    return reportFailure(error);
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
