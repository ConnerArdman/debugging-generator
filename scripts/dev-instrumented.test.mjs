/**
 * Tests for `scripts/dev-instrumented.mjs`, the CLI that starts a development
 * server with the telemetry preload attached.
 *
 * The suite has two jobs, and both exist because the CLI is a *caller* of
 * contracts it does not own:
 *
 *  1. CALLER/DEFINER CONTRACT. {@link PROTOCOL_ROUTES} below is the definer
 *     side, transcribed from the specification: the protocol's route table
 *     (`POST /dev-server/launch` `{ projectRoot, command? }` →
 *     `{ devServerUrl, pid }`, `POST /dev-server/stop`, `GET /health`), the
 *     service's own credential route (`POST /dev-server/credential`
 *     `{ projectRoot }` → `{ token, expiresAt }`, defined by
 *     `apps/local-service/src/dev-server/launcher.ts`), its release route
 *     (`POST /credentials/release` `{ token }` → `{ released }`, the
 *     `credentials.release` row of `packages/protocol/src/http.ts`), and
 *     `docs/SECURITY.md` §7 for who must present a credential. It is written
 *     from those definitions and NEVER from the module under test — deriving
 *     the accepted routes from the caller's own exports would make the pair
 *     self-consistent and blind to exactly the drift this suite exists to
 *     catch. `SERVICE_ROUTES` is then
 *     asserted against it, so a rename on either side fails.
 *
 *     The definer is enforced the way a service enforces it: unknown path 404,
 *     wrong method 405, missing or wrong bearer credential 401, wrong
 *     content-type 415, and a body that is not exactly `{ projectRoot }` (plus
 *     the launch route's optional `command`; `{ token }` for the release
 *     route) 400. Every rejection is recorded, and the end-to-end cases assert
 *     the caller provokes none of them.
 *
 *     `GET /health` answers the service-identity challenge from
 *     {@link IDENTITY}, transcribed the same way, and impostor listeners —
 *     no proof, a forged proof, a proof keyed by another credential, a proof
 *     relayed from a service on another port — assert that no mode sends a
 *     credential, or any request at all, to a listener that cannot prove it is
 *     the service.
 *
 *     `agrees with the definers of those routes` closes the loop against the
 *     real definers: it reads `packages/protocol/src/http.ts` for the three
 *     table routes, and the credential route's path and strict request and
 *     response schemas from whichever of the launcher or the protocol declares
 *     them. An in-process run against the real hono app with its auth
 *     middleware belongs to the service's own integration suite
 *     (`apps/local-service/test/integration/**`).
 *
 *  2. ENVIRONMENT CONTRACT. `.env.example` claims to document every variable
 *     the product and its suites read. That claim is re-derived from the tree:
 *     the variable names this script and `playwright.config.ts` actually read
 *     must all appear in that file.
 *
 * Nothing here touches the network beyond a loopback server on an ephemeral
 * port, and every filesystem fixture lives in a directory created by
 * `fs.mkdtemp` and removed afterwards, so the suite is hermetic and safe to run
 * concurrently with any other.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  AUTH_FILE_NAME,
  CHILD_ENV_ALLOWLIST,
  DEFAULT_SERVICE_HOST,
  DEFAULT_SERVICE_PORT,
  DevInstrumentedError,
  INGEST_PATH,
  RELEASE_PATH,
  RESPONSE_MAX_BYTES,
  SERVICE_IDENTITY_CHALLENGE_BYTES,
  SERVICE_IDENTITY_CHALLENGE_HEADER,
  SERVICE_IDENTITY_ENDPOINT_HEADER,
  SERVICE_IDENTITY_PROOF_HEADER,
  SERVICE_IDENTITY_PROOF_LABEL,
  SERVICE_ROUTES,
  awaitShutdownSignal,
  buildChildEnv,
  buildLaunchCommand,
  checkServiceHealth,
  computeServiceIdentityProof,
  describeToken,
  escapeCmdArgument,
  escapeCmdCommand,
  isForwardedToChild,
  isLoopbackHostname,
  launchDevServer,
  main,
  parseArgs,
  prepareLocalSpawn,
  releaseServerAgentCredential,
  requestServerAgentCredential,
  resolveExtraEnv,
  resolvePreload,
  resolveProject,
  resolveServiceBase,
  stopDevServer,
  usage,
  verifyServiceIdentity,
  wrapForPlatform,
} from './dev-instrumented.mjs';

/**
 * The definer's contract, transcribed from the protocol and from the service's
 * launcher rather than imported from the module under test.
 *
 * `authenticated` follows `docs/SECURITY.md` §7: `GET /health` is one of the two
 * unauthenticated routes, and everything else requires a bearer credential —
 * for these three routes the editor credential the service wrote to
 * `$DEBUGGEN_HOME/auth.json`.
 */
const PROTOCOL_ROUTES = Object.freeze({
  health: Object.freeze({
    method: 'GET',
    path: '/health',
    authenticated: false,
    required: Object.freeze([]),
    optional: Object.freeze([]),
  }),
  launch: Object.freeze({
    method: 'POST',
    path: '/dev-server/launch',
    authenticated: true,
    required: Object.freeze(['projectRoot']),
    optional: Object.freeze(['command']),
  }),
  stop: Object.freeze({
    method: 'POST',
    path: '/dev-server/stop',
    authenticated: true,
    required: Object.freeze(['projectRoot']),
    optional: Object.freeze([]),
  }),
  // `DEV_SERVER_CREDENTIAL_PATH` / `devServerCredentialRequestSchema` in
  // apps/local-service/src/dev-server/launcher.ts: a strict `{ projectRoot }`,
  // editor role only, answered with a strict `{ token, expiresAt }`.
  credential: Object.freeze({
    method: 'POST',
    path: '/dev-server/credential',
    authenticated: true,
    required: Object.freeze(['projectRoot']),
    optional: Object.freeze([]),
  }),
  // `credentials.release` in packages/protocol/src/http.ts: a strict
  // `{ token }` naming the server-agent credential to revoke, editor role
  // only, answered with a strict `{ released: boolean }` — `false` when
  // nothing was live under that token any more, which is a success too.
  release: Object.freeze({
    method: 'POST',
    path: '/credentials/release',
    authenticated: true,
    required: Object.freeze(['token']),
    optional: Object.freeze([]),
  }),
});

/**
 * Every route of the contract: the protocol table's three in the order it
 * lists them, then the service's credential route and its release route.
 */
const ALL_PROTOCOL_ROUTES = Object.freeze([
  PROTOCOL_ROUTES.health,
  PROTOCOL_ROUTES.launch,
  PROTOCOL_ROUTES.stop,
  PROTOCOL_ROUTES.credential,
  PROTOCOL_ROUTES.release,
]);

/** Shorthands for expectations, spelled from the contract above. */
const HEALTH = PROTOCOL_ROUTES.health.path;
const LAUNCH = PROTOCOL_ROUTES.launch.path;
const STOP = PROTOCOL_ROUTES.stop.path;
const CREDENTIAL = PROTOCOL_ROUTES.credential.path;
const RELEASE = PROTOCOL_ROUTES.release.path;

/**
 * The service-identity contract of `GET /health`, transcribed from its
 * specification rather than imported from the module under test, for the same
 * reason as {@link PROTOCOL_ROUTES}: the stub services below answer with this
 * transcription, so a caller that drifted from the contract fails against them.
 *
 * The probe sends `challengeHeader` (unpadded base64url of `challengeBytes`
 * random bytes); the service answers with `endpointHeader` — the `host:port`
 * it is bound to, IPv6 bracketed — and `proofHeader`, the unpadded base64url
 * HMAC-SHA256 keyed by the UTF-8 editor credential over the UTF-8 message
 * `${label}\n${challenge}\n${endpoint}` ({@link identityProof}).
 */
const IDENTITY = Object.freeze({
  challengeHeader: 'X-Debuggen-Identity-Challenge',
  proofHeader: 'X-Debuggen-Identity-Proof',
  endpointHeader: 'X-Debuggen-Identity-Endpoint',
  label: 'debuggen-service-identity/v1',
  challengeBytes: 32,
});

/** An unpadded base64url string of 32 bytes: the form of a challenge and a proof. */
const BASE64URL_32_BYTES = /^[A-Za-z0-9_-]{43}$/u;

/**
 * The identity proof as the contract defines it.
 *
 * @param {string} key editor credential
 * @param {string} challenge the probe's challenge
 * @param {string} endpoint `host:port` the answering service names
 * @returns {string}
 */
function identityProof(key, challenge, endpoint) {
  return createHmac('sha256', Buffer.from(key, 'utf8'))
    .update(Buffer.from(`${IDENTITY.label}\n${challenge}\n${endpoint}`, 'utf8'))
    .digest('base64url');
}

/**
 * The identity headers a genuine service bound to `127.0.0.1:<port>` answers
 * a probe with, or none when the request carries no challenge. The port is the
 * one the request actually arrived on.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {string} [key] editor credential the proof is keyed by
 * @returns {Record<string, string>}
 */
function identityAnswer(req, key = EDITOR_TOKEN) {
  const challenge = req.headers[IDENTITY.challengeHeader.toLowerCase()];
  if (typeof challenge !== 'string' || challenge === '') return {};
  const endpoint = `127.0.0.1:${String(req.socket.localPort)}`;
  return {
    [IDENTITY.endpointHeader]: endpoint,
    [IDENTITY.proofHeader]: identityProof(key, challenge, endpoint),
  };
}

/** Repository root, derived from this file's location. */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The script under test, read once for the static contract assertions. */
const SCRIPT_SOURCE = fs.readFileSync(path.join(REPO_ROOT, 'scripts/dev-instrumented.mjs'), 'utf8');

/**
 * The editor credential the stub service accepts, generated per run rather
 * than written into this file: a committed high-entropy literal assigned to a
 * credential-shaped name is exactly what `pnpm check:secrets` rejects, and a
 * test has no reason to carry a fixed one.
 */
const EDITOR_TOKEN = `editor-credential-${randomUUID()}`;

/**
 * The server-agent credential the stub service mints, generated per run for
 * the same reason as {@link EDITOR_TOKEN}.
 */
const SERVER_AGENT_TOKEN = `server-agent-credential-${randomUUID()}`;

/**
 * How far in the future the stub's credential answer puts `expiresAt`: the
 * first lease the service grants a credential minted through the credential
 * route (`DEFAULT_CLI_CREDENTIAL_LEASE_MS`, five minutes), which it renews
 * while the dev server's preload stays connected.
 */
const CREDENTIAL_LIFETIME_MS = 5 * 60 * 1000;

/** What the stub service reports for a successful launch. */
const LAUNCHED = Object.freeze({ devServerUrl: 'http://localhost:3000', pid: 4242 });

/**
 * A writable stream that keeps what was written, so the command's own output
 * can be asserted without patching `process.stdout`.
 *
 * @returns {{ write: (chunk: string) => boolean, text: () => string }}
 */
function captureStream() {
  /** @type {string[]} */
  const chunks = [];
  return {
    write(chunk) {
      chunks.push(String(chunk));
      return true;
    },
    text() {
      return chunks.join('');
    },
  };
}

/**
 * @typedef {object} RecordedRequest
 * @property {string} method
 * @property {string} path
 * @property {string | undefined} authorization
 * @property {string | undefined} challenge the identity challenge it carried
 * @property {unknown} body
 */

/**
 * @typedef {object} StubService
 * @property {string} base base URL, without a trailing slash
 * @property {RecordedRequest[]} requests every request the service received
 * @property {Array<{ path: string, status: number, reason: string }>} rejections
 *   every request the contract refused
 * @property {() => string[]} routes `METHOD /path` for each request, in order
 * @property {number} expiresAt the `expiresAt` a default credential answer carries
 * @property {Array<Record<'SIGINT' | 'SIGTERM', number>>} releaseSignalListeners
 *   how many `SIGINT` and `SIGTERM` listeners this process had when each
 *   release request arrived — the stub runs in the process `main` runs in, so
 *   this is what the command had installed while the release was in flight
 * @property {() => Promise<void>} close shut the server down
 */

/**
 * Start a stub of the local coordination service that enforces
 * {@link PROTOCOL_ROUTES} the way a service enforces it.
 *
 * @param {object} [options]
 * @param {readonly { method: string, path: string, authenticated: boolean, required: readonly string[], optional: readonly string[] }[]} [options.implemented]
 *   routes this build answers; defaults to the whole contract
 * @param {number} [options.launchStatus] status for the launch route
 * @param {number} [options.stopStatus] status for the stop route
 * @param {Record<string, unknown>} [options.launchBody] body the launch route answers with
 * @param {number} [options.credentialStatus] status for the credential route
 * @param {unknown} [options.credentialBody] body the credential route answers
 *   with, whatever its status; by default `{ token, expiresAt }` on 200 and a
 *   `{ code, message }` error otherwise
 * @param {string} [options.credentialText] a raw `text/plain` body for the
 *   credential route instead of JSON
 * @param {number} [options.identityProbes] how many health probes are answered
 *   with the identity proof ({@link identityAnswer}) before later ones are
 *   answered without it, as when another process has taken the port over;
 *   default every probe
 * @param {number} [options.releaseStatus] status for the release route
 * @param {unknown} [options.releaseBody] body the release route answers with,
 *   whatever its status; by default, on 200, `{ released }` — `true` the first
 *   time a token this stub minted is named, `false` for any other token or a
 *   second release, as the service answers — and a `{ code, message }` error
 *   otherwise (`CLEANUP_PARTIAL` on 500)
 * @param {Promise<unknown>} [options.releaseGate] the release route answers
 *   only once this settles, so a test can act while the release is in flight
 * @returns {Promise<StubService>}
 */
async function startStubService(options = {}) {
  const implemented = options.implemented ?? ALL_PROTOCOL_ROUTES;
  const identityProbes = options.identityProbes ?? Number.POSITIVE_INFINITY;
  let healthProbes = 0;
  const launchStatus = options.launchStatus ?? 200;
  const stopStatus = options.stopStatus ?? 200;
  const launchBody = options.launchBody ?? LAUNCHED;
  const credentialStatus = options.credentialStatus ?? 200;
  const expiresAt = Date.now() + CREDENTIAL_LIFETIME_MS;
  const credentialBody =
    'credentialBody' in options
      ? options.credentialBody
      : credentialStatus === 200
        ? { token: SERVER_AGENT_TOKEN, expiresAt }
        : { code: 'UNAUTHORIZED', message: 'credential refused' };
  const releaseStatus = options.releaseStatus ?? 200;

  /** Tokens this stub minted that no release has named yet. @type {Set<string>} */
  const live = new Set();
  /** @type {RecordedRequest[]} */
  const requests = [];
  /** @type {Array<{ path: string, status: number, reason: string }>} */
  const rejections = [];
  /** @type {Array<Record<'SIGINT' | 'SIGTERM', number>>} */
  const releaseSignalListeners = [];

  const server = http.createServer((req, res) => {
    /** @type {Buffer[]} */
    const body = [];
    req.on('data', (chunk) => body.push(Buffer.from(chunk)));
    req.on('end', () => {
      const raw = Buffer.concat(body).toString('utf8');
      /** @type {unknown} */
      let parsed;
      try {
        parsed = raw === '' ? undefined : JSON.parse(raw);
      } catch {
        parsed = raw;
      }

      const requestPath = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
      const method = req.method ?? 'GET';
      const challenge = req.headers[IDENTITY.challengeHeader.toLowerCase()];
      requests.push({
        method,
        path: requestPath,
        authorization: req.headers.authorization,
        challenge: typeof challenge === 'string' ? challenge : undefined,
        body: parsed,
      });

      /**
       * @param {number} status
       * @param {unknown} payload
       * @returns {void}
       */
      const answer = (status, payload) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      };

      /**
       * @param {number} status
       * @param {string} reason
       * @returns {void}
       */
      const refuse = (status, reason) => {
        rejections.push({ path: requestPath, status, reason });
        answer(status, { message: reason });
      };

      const route = implemented.find((entry) => entry.path === requestPath);
      if (route === undefined) {
        refuse(404, `no route ${requestPath}`);
        return;
      }
      if (route.method !== method) {
        refuse(405, `${requestPath} accepts ${route.method}, not ${method}`);
        return;
      }
      if (route.authenticated) {
        if (req.headers.authorization !== `Bearer ${EDITOR_TOKEN}`) {
          refuse(401, `${requestPath} requires the editor credential`);
          return;
        }
        if (!String(req.headers['content-type'] ?? '').includes('application/json')) {
          refuse(415, `${requestPath} accepts application/json`);
          return;
        }
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          refuse(400, `${requestPath} expects a JSON object body`);
          return;
        }
        const record = /** @type {Record<string, unknown>} */ (parsed);
        for (const key of route.required) {
          const value = record[key];
          if (typeof value !== 'string' || value === '') {
            refuse(400, `${requestPath} requires ${key}`);
            return;
          }
        }
        if (typeof record.projectRoot === 'string' && !path.isAbsolute(record.projectRoot)) {
          refuse(400, `${requestPath} requires an absolute projectRoot`);
          return;
        }
        const allowed = new Set([...route.required, ...route.optional]);
        const unknown = Object.keys(record).filter((key) => !allowed.has(key));
        if (unknown.length > 0) {
          refuse(400, `${requestPath} does not accept ${unknown.join(', ')}`);
          return;
        }
      }

      if (requestPath === HEALTH) {
        healthProbes += 1;
        res.writeHead(200, {
          'content-type': 'application/json',
          ...(healthProbes <= identityProbes ? identityAnswer(req) : {}),
        });
        res.end(JSON.stringify({ status: 'ok', version: '0.1.0', pairing: true }));
        return;
      }
      if (requestPath === LAUNCH) {
        answer(launchStatus, launchStatus === 200 ? launchBody : { message: 'launch refused' });
        return;
      }
      if (requestPath === CREDENTIAL) {
        if (options.credentialText !== undefined) {
          res.writeHead(credentialStatus, { 'content-type': 'text/plain' });
          res.end(options.credentialText);
          return;
        }
        const minted = /** @type {{ token?: unknown } | null | undefined} */ (credentialBody);
        if (credentialStatus === 200 && typeof minted?.token === 'string') live.add(minted.token);
        answer(credentialStatus, credentialBody);
        return;
      }
      if (requestPath === RELEASE) {
        releaseSignalListeners.push({
          SIGINT: process.listenerCount('SIGINT'),
          SIGTERM: process.listenerCount('SIGTERM'),
        });
        // The contract checks above guarantee a non-empty string token here.
        const named = String(/** @type {Record<string, unknown>} */ (parsed).token);
        const releaseBody =
          'releaseBody' in options
            ? options.releaseBody
            : releaseStatus === 200
              ? { released: live.delete(named) }
              : releaseStatus === 500
                ? { code: 'CLEANUP_PARTIAL', message: 'revocation still pending' }
                : { code: 'REFUSED', message: 'release refused' };
        /** @returns {void} */
        const respond = () => answer(releaseStatus, releaseBody);
        void Promise.resolve(options.releaseGate).then(respond, respond);
        return;
      }
      answer(stopStatus, stopStatus === 200 ? { stopped: true } : { message: 'stop refused' });
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  return {
    base: `http://127.0.0.1:${port}`,
    requests,
    rejections,
    routes: () => requests.map((request) => `${request.method} ${request.path}`),
    expiresAt,
    releaseSignalListeners,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve(undefined));
      }),
  };
}

/**
 * @typedef {object} Fixture
 * @property {string} base temporary directory holding the whole fixture
 * @property {string} root repository root the command resolves against
 * @property {string} home session home holding `auth.json`
 * @property {string} projectDir absolute path of the default target project
 * @property {string} preloadUrl `file://` URL of the fabricated preload
 */

/** Every temporary directory this suite created, removed in `afterAll`. */
const temporaryRoots = [];

/**
 * Build a temporary tree that looks like this repository to the command: a
 * built telemetry preload, a target project with a `dev` script, and a session
 * home with an editor credential.
 *
 * @param {object} [options]
 * @param {boolean} [options.withCredential] write `auth.json`
 * @param {string} [options.packageName] the target's `package.json` `name`
 *   (default `target-app`)
 * @returns {Promise<Fixture>}
 */
async function createFixture(options = {}) {
  const base = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'dev-instrumented-test-'));
  temporaryRoots.push(base);

  const root = path.join(base, 'repo');
  const preloadDir = path.join(root, 'packages', 'telemetry', 'dist', 'node');
  await fs.promises.mkdir(preloadDir, { recursive: true });
  const preload = path.join(preloadDir, 'register.mjs');
  await fs.promises.writeFile(preload, 'export default {};\n', 'utf8');

  const projectDir = path.join(root, 'apps', 'demo-app');
  await fs.promises.mkdir(projectDir, { recursive: true });
  await fs.promises.writeFile(
    path.join(projectDir, 'package.json'),
    `${JSON.stringify({ name: options.packageName ?? 'target-app', private: true, scripts: { dev: 'next dev' } }, null, 2)}\n`,
    'utf8',
  );

  const home = path.join(base, 'home');
  await fs.promises.mkdir(home, { recursive: true });
  if (options.withCredential !== false) {
    await fs.promises.writeFile(
      path.join(home, 'auth.json'),
      `${JSON.stringify({ token: EDITOR_TOKEN, role: 'vscode' }, null, 2)}\n`,
      'utf8',
    );
  }

  return { base, root, home, projectDir, preloadUrl: pathToFileURL(preload).href };
}

/**
 * @typedef {object} FakeDevServer
 * @property {string} binDir directory to put first on the child's `PATH`
 * @property {Record<string, string>} env what the run's environment needs for
 *   the fake to be found: a `PATH` with {@link FakeDevServer.binDir} first
 * @property {() => Record<string, string>} read what the fake recorded
 * @property {() => Record<string, string>} readEnv the fake's whole
 *   environment, as `env` printed it
 * @property {() => boolean} ran whether the fake was executed at all
 * @property {() => boolean} ready whether the fake has written both records,
 *   and so — with `waitForSignal` — is now waiting for its signal
 */

/**
 * Quote a value for a POSIX shell script: single quotes, each embedded `'`
 * closed, escaped and reopened.
 *
 * @param {string} value
 * @returns {string}
 */
function shellQuote(value) {
  return `'${value.replace(/'/gu, "'\\''")}'`;
}

/**
 * Put a fake package manager on a `PATH` of our own, so the local spawn mode
 * can be driven as a whole — pre-flight, credential, banner, spawn, exit code —
 * without running a real development server.
 *
 * It stands in for `pnpm`, which is what {@link buildLaunchCommand} looks up,
 * and it records the argv, working directory and the four injected variables
 * to one file, and the whole environment it received to another, rather than
 * to stdout: `runDevServer` spawns with `stdio: 'inherit'`, so anything it
 * printed would land in the test runner's own output. The dump paths and the
 * exit status are written into the script itself, because the child inherits
 * only the allowlisted part of the run's environment — a variable naming them
 * would never reach it.
 *
 * @param {Fixture} fixture
 * @param {object} [options]
 * @param {number} [options.exitCode] status the fake exits with (default 0)
 * @param {string} [options.interpreter] the `#!` interpreter (default
 *   `/bin/sh`); an interpreter that does not exist makes the kernel refuse the
 *   exec with ENOENT, so the spawn itself fails although `PATH` lookup found
 *   an executable file
 * @param {boolean} [options.waitForSignal] instead of exiting at once, wait
 *   until `SIGINT` or `SIGTERM` arrives and then exit with `exitCode`, like a
 *   dev server stopped with Ctrl-C
 * @returns {Promise<FakeDevServer>}
 */
async function createFakeDevServer(fixture, options = {}) {
  const binDir = path.join(fixture.base, `bin-${randomUUID()}`);
  await fs.promises.mkdir(binDir, { recursive: true });

  const dump = path.join(fixture.base, `dev-server-${randomUUID()}.txt`);
  const envDump = `${dump}.env`;
  const readyMarker = `${dump}.ready`;
  const exitCode = options.exitCode ?? 0;
  const executable = path.join(binDir, 'pnpm');
  await fs.promises.writeFile(
    executable,
    [
      `#!${options.interpreter ?? '/bin/sh'}`,
      ...(options.waitForSignal === true ? [`trap 'exit ${String(exitCode)}' INT TERM`] : []),
      '{',
      '  echo "argv=$*"',
      '  echo "cwd=$(pwd)"',
      '  echo "NODE_OPTIONS=$NODE_OPTIONS"',
      '  echo "DEBUGGEN_INGEST_URL=$DEBUGGEN_INGEST_URL"',
      '  echo "DEBUGGEN_PROJECT_ROOT=$DEBUGGEN_PROJECT_ROOT"',
      '  echo "DEBUGGEN_TOKEN=${DEBUGGEN_TOKEN-<unset>}"',
      `} > ${shellQuote(dump)}`,
      `env > ${shellQuote(envDump)}`,
      `: > ${shellQuote(readyMarker)}`,
      // Short sleeps, so the trap runs promptly once a signal arrives: the
      // shell defers it until its foreground command has finished.
      ...(options.waitForSignal === true ? ['while :; do sleep 0.05; done'] : []),
      `exit ${String(exitCode)}`,
      '',
    ].join('\n'),
    'utf8',
  );
  await fs.promises.chmod(executable, 0o755);

  /**
   * @param {string} file
   * @returns {Record<string, string>}
   */
  const parse = (file) => {
    /** @type {Record<string, string>} */
    const record = {};
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const separator = line.indexOf('=');
      if (separator > 0) record[line.slice(0, separator)] = line.slice(separator + 1);
    }
    return record;
  };

  return {
    binDir,
    env: { PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}` },
    ran: () => fs.existsSync(dump),
    ready: () => fs.existsSync(readyMarker),
    read: () => parse(dump),
    readEnv: () => parse(envDump),
  };
}

/**
 * A loopback address with nothing listening on it: a server is bound to an
 * ephemeral port only to learn a port number, then closed again. Used for the
 * "no local service is running" cases, which every mode — `--spawn-local`
 * included — must refuse before it launches or spawns anything.
 *
 * @returns {Promise<string>} base URL of an address that refuses connections
 */
async function closedServiceAddress() {
  const server = http.createServer(() => {});
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  await new Promise((resolve) => server.close(() => resolve(undefined)));
  return `http://127.0.0.1:${port}`;
}

/**
 * Collapse whitespace so an assertion about a documented claim is about the
 * claim and not about where the help text happens to wrap.
 *
 * @param {string} text
 * @returns {string}
 */
function squash(text) {
  return text.replace(/\s+/gu, ' ').trim();
}

/**
 * The context `main` is driven with: the fixture tree, an environment naming
 * the fixture's session home, and captured output streams.
 *
 * @param {Fixture} fixture
 * @param {Record<string, string>} [extraEnv] variables the run needs on top of
 *   the defaults — a `PATH` carrying a fake package manager, for instance
 * @returns {{ context: Record<string, unknown>, stdout: ReturnType<typeof captureStream>, stderr: ReturnType<typeof captureStream> }}
 */
function contextFor(fixture, extraEnv = {}) {
  const stdout = captureStream();
  const stderr = captureStream();
  return {
    context: {
      root: fixture.root,
      cwd: fixture.root,
      env: { DEBUGGEN_HOME: fixture.home, PATH: process.env.PATH ?? '', ...extraEnv },
      stdout,
      stderr,
    },
    stdout,
    stderr,
  };
}

/**
 * Poll until a predicate holds, so a test can act once the command has reached
 * a point (the launch request landing) without sleeping for a fixed time.
 *
 * @param {() => boolean} predicate
 * @param {string} description what was being waited for, for the failure message
 * @returns {Promise<void>}
 */
async function waitFor(predicate, description) {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** @type {StubService | undefined} */
let service;

afterEach(async () => {
  if (service !== undefined) {
    await service.close();
    service = undefined;
  }
});

afterAll(async () => {
  for (const directory of temporaryRoots) {
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
});

/**
 * Escape a literal for use inside a regular expression.
 *
 * @param {string} value
 * @returns {string}
 */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/**
 * The top-level keys of a `const <name> = z.strictObject({ ... })` declaration
 * in TypeScript source, or `undefined` when the source declares no such strict
 * object. Read from the text rather than imported, so the check needs no build
 * of the definer: nested calls, arrays and objects are skipped by bracket
 * depth, and string and template literals are skipped whole so a bracket or a
 * colon inside a message cannot be mistaken for structure.
 *
 * @param {string} source TypeScript source text
 * @param {string} name the schema constant's name
 * @returns {string[] | undefined}
 */
function strictObjectKeys(source, name) {
  const declaration = new RegExp(
    `\\b${escapeRegExp(name)}\\s*=\\s*z\\.strictObject\\(\\s*\\{`,
    'u',
  );
  const match = declaration.exec(source);
  if (match === null) return undefined;

  let depth = 1;
  let topLevel = '';
  let index = match.index + match[0].length;
  while (index < source.length && depth > 0) {
    const character = source[index] ?? '';
    if (character === "'" || character === '"' || character === '`') {
      // Skip the literal, honouring backslash escapes.
      index += 1;
      while (index < source.length && source[index] !== character) {
        index += source[index] === '\\' ? 2 : 1;
      }
      index += 1;
      topLevel += ' ';
      continue;
    }
    if (character === '/' && source[index + 1] === '*') {
      const end = source.indexOf('*/', index + 2);
      index = end === -1 ? source.length : end + 2;
      continue;
    }
    if (character === '/' && source[index + 1] === '/') {
      const end = source.indexOf('\n', index);
      index = end === -1 ? source.length : end;
      continue;
    }
    if (character === '{' || character === '(' || character === '[') depth += 1;
    else if (character === '}' || character === ')' || character === ']') depth -= 1;
    else if (depth === 1) topLevel += character;
    index += 1;
  }

  return [...topLevel.matchAll(/([A-Za-z_$][\w$]*)\s*:/gu)].map((entry) => entry[1] ?? '');
}

describe('the route contract the caller is held to', () => {
  it('matches the service, route for route', () => {
    // Left side: the caller's exported list. Right side: the contract
    // transcribed at the top of this file from the protocol's route table and the
    // service's launcher. A rename on either side fails here.
    expect([...SERVICE_ROUTES]).toEqual([HEALTH, LAUNCH, STOP, CREDENTIAL, RELEASE]);
    expect([HEALTH, LAUNCH, STOP, CREDENTIAL, RELEASE]).toEqual([
      '/health',
      '/dev-server/launch',
      '/dev-server/stop',
      '/dev-server/credential',
      '/credentials/release',
    ]);
    expect(RELEASE_PATH).toBe('/credentials/release');
    expect(PROTOCOL_ROUTES.credential).toEqual({
      method: 'POST',
      path: '/dev-server/credential',
      authenticated: true,
      required: ['projectRoot'],
      optional: [],
    });
    expect(PROTOCOL_ROUTES.release).toEqual({
      method: 'POST',
      path: '/credentials/release',
      authenticated: true,
      required: ['token'],
      optional: [],
    });
  });

  it('contains no guessed credential endpoint and no route override', () => {
    // The defect this guards: guessed credential endpoints plus a
    // DEBUGGEN_CREDENTIAL_PATH override, none of which the service defines.
    // The one credential route the service does define is in SERVICE_ROUTES.
    for (const invented of [
      '/credentials/server-agent',
      '/dev-server/token',
      'DEBUGGEN_CREDENTIAL_PATH',
    ]) {
      expect(SCRIPT_SOURCE).not.toContain(invented);
    }
  });

  it('agrees with the definers of those routes', async () => {
    // Read the definers themselves, not a comment about them: the protocol's
    // route table for the three table routes, and the credential route's
    // single definition, which the launcher owns today and the protocol may
    // take over without changing the path or either body.
    const protocolFile = 'packages/protocol/src/http.ts';
    const launcherFile = 'apps/local-service/src/dev-server/launcher.ts';
    const protocol = await fs.promises.readFile(path.join(REPO_ROOT, protocolFile), 'utf8');
    const launcher = await fs.promises.readFile(path.join(REPO_ROOT, launcherFile), 'utf8');

    for (const route of [PROTOCOL_ROUTES.health, PROTOCOL_ROUTES.launch, PROTOCOL_ROUTES.stop]) {
      const row = new RegExp(
        `method:\\s*'${route.method}',\\s*pattern:\\s*'${escapeRegExp(route.path)}'`,
        'u',
      );
      expect(protocol, `${protocolFile} must declare ${route.method} ${route.path}`).toMatch(row);
    }

    const credential = PROTOCOL_ROUTES.credential;
    const inLauncher =
      new RegExp(`DEV_SERVER_CREDENTIAL_PATH\\s*=\\s*'${escapeRegExp(credential.path)}'`, 'u').test(
        launcher,
      ) &&
      new RegExp(`DEV_SERVER_CREDENTIAL_METHOD\\s*=\\s*'${credential.method}'`, 'u').test(launcher);
    const inProtocol = new RegExp(
      `method:\\s*'${credential.method}',\\s*pattern:\\s*'${escapeRegExp(credential.path)}'`,
      'u',
    ).test(protocol);
    expect(
      inLauncher || inProtocol,
      `${launcherFile} or ${protocolFile} must declare ${credential.method} ${credential.path}`,
    ).toBe(true);

    /**
     * The keys of a strict schema, from whichever definer declares it.
     *
     * @param {string} name
     * @returns {string[] | undefined}
     */
    const schemaKeys = (name) =>
      strictObjectKeys(launcher, name) ?? strictObjectKeys(protocol, name);

    expect(schemaKeys('devServerCredentialRequestSchema')).toEqual([
      ...credential.required,
      ...credential.optional,
    ]);
    expect(schemaKeys('devServerCredentialResponseSchema')).toEqual(['token', 'expiresAt']);

    // The release route is the `credentials.release` row of the protocol's
    // table. Its schemas are read by the names that row gives them, so the
    // check follows the definer rather than a name this file would guess.
    const release = PROTOCOL_ROUTES.release;
    const releaseRow = new RegExp(
      `'credentials\\.release':\\s*\\{\\s*operation:\\s*'credentials\\.release',\\s*method:\\s*'${release.method}',\\s*pattern:\\s*'${escapeRegExp(release.path)}',[^}]*?request:\\s*([A-Za-z_$][\\w$]*),\\s*response:\\s*([A-Za-z_$][\\w$]*)`,
      'u',
    ).exec(protocol);
    expect(
      releaseRow,
      `${protocolFile} must declare credentials.release as ${release.method} ${release.path}`,
    ).not.toBeNull();
    const [, releaseRequest = '', releaseResponse = ''] = releaseRow ?? [];
    expect(strictObjectKeys(protocol, releaseRequest)).toEqual([
      ...release.required,
      ...release.optional,
    ]);
    expect(strictObjectKeys(protocol, releaseResponse)).toEqual(['released']);
  });
});

describe('launching through the service', () => {
  it('asks the launcher route once, with the editor credential and the project root', async () => {
    service = await startStubService();
    const fixture = await createFixture();
    const { context, stdout, stderr } = contextFor(fixture);

    const code = await main(['--service', service.base, '--detach'], context);

    expect(stderr.text()).toBe('');
    expect(code).toBe(0);
    expect(service.routes()).toEqual([`GET ${HEALTH}`, `POST ${LAUNCH}`]);

    const launch = service.requests[1];
    expect(launch?.authorization).toBe(`Bearer ${EDITOR_TOKEN}`);
    expect(launch?.body).toEqual({ projectRoot: fixture.projectDir });

    const report = stdout.text();
    expect(report).toContain(LAUNCHED.devServerUrl);
    expect(report).toContain(String(LAUNCHED.pid));
    expect(report).toContain(`POST ${LAUNCH}`);
  });

  it('satisfies every rule the contract enforces, provoking no refusal', async () => {
    service = await startStubService();
    const fixture = await createFixture();
    const { context } = contextFor(fixture);

    const code = await main(['--service', service.base, '--detach'], context);

    // Method, bearer credential, content-type and body shape all accepted: the
    // definer refused nothing, so caller and contract agree on more than the
    // route name.
    expect(service.rejections).toEqual([]);
    expect(code).toBe(0);
  });

  it('requests no path outside the protocol route set', async () => {
    service = await startStubService();
    const fixture = await createFixture();
    const { context } = contextFor(fixture);

    await main(['--service', service.base, '--detach'], context);

    const contractPaths = ALL_PROTOCOL_ROUTES.map((route) => route.path);
    const unknown = service.requests.filter((request) => !contractPaths.includes(request.path));
    expect(unknown).toEqual([]);
  });

  it('never leaks the editor credential into its own output', async () => {
    service = await startStubService();
    const fixture = await createFixture();
    const { context, stdout, stderr } = contextFor(fixture);

    await main(['--service', service.base, '--detach'], context);

    expect(stdout.text()).not.toContain(EDITOR_TOKEN);
    expect(stderr.text()).not.toContain(EDITOR_TOKEN);
  });

  it('stops the launched server when the foreground run is interrupted', async () => {
    service = await startStubService();
    const fixture = await createFixture();
    const { context, stdout } = contextFor(fixture);
    const started = service;

    const run = main(['--service', started.base], context);
    await waitFor(
      () => started.requests.some((request) => request.path === LAUNCH),
      'the launch request',
    );
    process.emit('SIGINT');

    await expect(run).resolves.toBe(0);
    // The service proves itself again before the stop carries the credential.
    expect(started.routes()).toEqual([
      `GET ${HEALTH}`,
      `POST ${LAUNCH}`,
      `GET ${HEALTH}`,
      `POST ${STOP}`,
    ]);
    expect(started.requests[3]?.body).toEqual({ projectRoot: fixture.projectDir });
    expect(started.rejections).toEqual([]);
    expect(stdout.text()).toContain('stopped the dev server');
  });

  it('sends no stop to a listener that no longer proves it is the service', async () => {
    // One proof, for the launch pre-flight; the port answers without one when
    // the foreground run is interrupted, as after another process took it over.
    service = await startStubService({ identityProbes: 1 });
    const fixture = await createFixture();
    const { context, stderr } = contextFor(fixture);
    const started = service;

    const run = main(['--service', started.base], context);
    await waitFor(
      () => started.requests.some((request) => request.path === LAUNCH),
      'the launch request',
    );
    process.emit('SIGINT');

    await expect(run).resolves.toBe(2);
    expect(started.routes()).toEqual([`GET ${HEALTH}`, `POST ${LAUNCH}`, `GET ${HEALTH}`]);
    expect(started.requests[2]?.authorization).toBeUndefined();
    const errors = squash(stderr.text());
    expect(errors).toContain('did not prove it is the Debug Generator service');
    expect(errors).toContain('the editor credential was not sent');
    expect(errors).toContain('The stop request was not sent, so the dev server the service');
    expect(stderr.text()).not.toContain(EDITOR_TOKEN);
  });

  it('reports a launch route the service does not implement, without trying another path', async () => {
    service = await startStubService({
      implemented: [PROTOCOL_ROUTES.health, PROTOCOL_ROUTES.stop],
    });
    const fixture = await createFixture();
    const { context, stderr } = contextFor(fixture);

    const code = await main(['--service', service.base, '--detach'], context);

    expect(code).toBe(2);
    expect(stderr.text()).toContain(LAUNCH);
    expect(stderr.text()).toContain('nothing was launched');
    // Exactly one attempt at the launcher route: no fallback, no probing.
    expect(service.routes()).toEqual([`GET ${HEALTH}`, `POST ${LAUNCH}`]);
  });

  it('reports a refused launch with the service reason', async () => {
    service = await startStubService({ launchStatus: 409 });
    const fixture = await createFixture();
    const { context, stderr } = contextFor(fixture);

    const code = await main(['--service', service.base, '--detach'], context);

    expect(code).toBe(2);
    expect(stderr.text()).toContain('409');
    expect(stderr.text()).toContain('launch refused');
    expect(stderr.text()).toContain('--stop');
  });

  it('rejects a 2xx answer that does not carry the devServerUrl the contract promises', async () => {
    service = await startStubService({ launchBody: { started: true } });
    const fixture = await createFixture();
    const { context, stderr } = contextFor(fixture);

    const code = await main(['--service', service.base, '--detach'], context);

    expect(code).toBe(2);
    expect(stderr.text()).toContain('without a devServerUrl');
    expect(stderr.text()).toContain('--stop');
  });

  it('accepts an answer that names the URL but reports no pid', async () => {
    service = await startStubService({ launchBody: { devServerUrl: 'http://localhost:3100' } });
    const fixture = await createFixture();
    const { context, stdout } = contextFor(fixture);

    const code = await main(['--service', service.base, '--detach'], context);

    expect(code).toBe(0);
    expect(stdout.text()).toContain('http://localhost:3100');
    expect(stdout.text()).toContain('(not reported)');
  });

  it('reports a rejected credential and never reaches the launch route', async () => {
    service = await startStubService();
    const fixture = await createFixture({ withCredential: false });
    const { context, stderr } = contextFor(fixture);

    const code = await main(['--service', service.base, '--detach'], context);

    expect(code).toBe(2);
    expect(stderr.text()).toContain('no editor credential');
    expect(service.routes()).toEqual([]);
  });
});

describe('stopping through the service', () => {
  it('calls the stop route with the project root and nothing else', async () => {
    service = await startStubService();
    const fixture = await createFixture();
    const { context, stdout } = contextFor(fixture);

    const code = await main(['--service', service.base, '--stop'], context);

    expect(code).toBe(0);
    expect(service.routes()).toEqual([`GET ${HEALTH}`, `POST ${STOP}`]);
    expect(service.requests[1]?.body).toEqual({ projectRoot: fixture.projectDir });
    expect(service.rejections).toEqual([]);
    expect(stdout.text()).toContain('stopped the dev server');
  });

  it('fails loudly when the stop is refused, because the server is still running', async () => {
    service = await startStubService({ stopStatus: 500 });
    const fixture = await createFixture();
    const { context, stderr } = contextFor(fixture);

    const code = await main(['--service', service.base, '--stop'], context);

    expect(code).toBe(2);
    expect(stderr.text()).toContain('may still be running');
  });
});

describe('route helpers in isolation', () => {
  it('parses the launch response into the reported URL and pid', async () => {
    service = await startStubService();

    const result = await launchDevServer({
      base: service.base,
      editorToken: EDITOR_TOKEN,
      projectRoot: path.join(os.tmpdir(), 'some-project'),
    });

    expect(result).toEqual({ devServerUrl: LAUNCHED.devServerUrl, pid: LAUNCHED.pid });
  });

  it('rejects a launch the service refuses on credentials', async () => {
    service = await startStubService();

    await expect(
      launchDevServer({
        base: service.base,
        editorToken: 'not-the-editor-credential',
        projectRoot: path.join(os.tmpdir(), 'some-project'),
      }),
    ).rejects.toThrow(/rejected the editor credential/u);
    expect(service.rejections.map((entry) => entry.status)).toEqual([401]);
  });

  it('resolves when the stop route accepts', async () => {
    service = await startStubService();

    await expect(
      stopDevServer({
        base: service.base,
        editorToken: EDITOR_TOKEN,
        projectRoot: path.join(os.tmpdir(), 'some-project'),
      }),
    ).resolves.toBeUndefined();
  });
});

describe('the service address trust boundary', () => {
  /**
   * Start a loopback server that answers every request with a redirect and
   * records what it was asked for.
   *
   * @param {string} location the `Location` header to answer with
   * @returns {Promise<{ base: string, requests: string[], close: () => Promise<void> }>}
   */
  async function startRedirectingServer(location) {
    /** @type {string[]} */
    const requests = [];
    const server = http.createServer((req, res) => {
      requests.push(
        `${req.method ?? 'GET'} ${new URL(req.url ?? '/', 'http://127.0.0.1').pathname}`,
      );
      res.writeHead(307, { location });
      res.end();
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    return {
      base: `http://127.0.0.1:${port}`,
      requests,
      close: () =>
        new Promise((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve(undefined));
        }),
    };
  }

  /**
   * Start a loopback server that records every request, including its
   * `Authorization` header, and answers 200.
   *
   * @returns {Promise<{ base: string, authorizations: (string | undefined)[], close: () => Promise<void> }>}
   */
  async function startRecordingServer() {
    /** @type {(string | undefined)[]} */
    const authorizations = [];
    const server = http.createServer((req, res) => {
      authorizations.push(req.headers.authorization);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(LAUNCHED));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    return {
      base: `http://127.0.0.1:${port}`,
      authorizations,
      close: () =>
        new Promise((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve(undefined));
        }),
    };
  }

  it('recognises loopback addresses and nothing else', () => {
    for (const host of [
      DEFAULT_SERVICE_HOST,
      '127.0.0.2',
      '127.255.255.254',
      'localhost',
      'LOCALHOST',
      '::1',
      '[::1]',
      '::ffff:127.0.0.1',
      '::ffff:7f00:1',
    ]) {
      expect(isLoopbackHostname(host), `${host} is loopback`).toBe(true);
    }

    for (const host of [
      '0.0.0.0',
      '::',
      '192.168.1.5',
      '10.0.0.7',
      '8.8.8.8',
      'service.example.invalid',
      // Resolver-dependent, so not verifiable loopback.
      'app.localhost',
      // A public name wearing a loopback-looking prefix.
      '127.0.0.1.example.invalid',
      '999.0.0.1',
      '::ffff:192.168.0.1',
      '',
    ]) {
      expect(isLoopbackHostname(host), `${host} is not loopback`).toBe(false);
    }
  });

  it('resolves the documented loopback defaults and honours a loopback override', () => {
    expect(resolveServiceBase({ env: {} })).toBe(
      `http://${DEFAULT_SERVICE_HOST}:${DEFAULT_SERVICE_PORT}`,
    );
    expect(
      resolveServiceBase({ env: { DEBUGGEN_HOST: 'localhost', DEBUGGEN_PORT: '20000' } }),
    ).toBe('http://localhost:20000');
    // A bare IPv6 host is bracketed, and the brackets survive the check.
    expect(resolveServiceBase({ env: { DEBUGGEN_HOST: '::1', DEBUGGEN_PORT: '20000' } })).toBe(
      'http://[::1]:20000',
    );
    expect(resolveServiceBase({ service: 'https://127.0.0.1:8443', env: {} })).toBe(
      'https://127.0.0.1:8443',
    );
    // A path prefix on the override is preserved; only the trailing slash goes.
    expect(resolveServiceBase({ service: 'http://127.0.0.1:43117/debuggen/', env: {} })).toBe(
      'http://127.0.0.1:43117/debuggen',
    );
  });

  it('refuses a service address off this machine, from either route', () => {
    // Every request this command makes carries the editor credential, which is
    // what authorises minting a server-agent credential and launching a
    // process. An address that is not loopback is not the local service.
    for (const service of [
      'http://192.168.1.5:43117',
      'http://10.0.0.7:43117',
      'http://service.example.invalid',
      'https://service.example.invalid',
      'http://0.0.0.0:43117',
    ]) {
      expect(() => resolveServiceBase({ service, env: {} }), service).toThrow(
        /--service must address a loopback host/u,
      );
    }

    for (const host of ['0.0.0.0', '192.168.1.5', 'service.example.invalid']) {
      expect(() => resolveServiceBase({ env: { DEBUGGEN_HOST: host } }), host).toThrow(
        /DEBUGGEN_HOST is not a loopback host/u,
      );
    }

    // Assembled from fragments, not written out: `pnpm check:secrets` refuses any
    // tracked URI whose authority embeds a user and a password, and rightly
    // cannot tell a rejected test input from a pasted credential.
    const withUserinfo = ['http://', 'someone', ':', 'placeholder', '@', '127.0.0.1:43117'].join(
      '',
    );
    expect(() => resolveServiceBase({ service: withUserinfo, env: {} })).toThrow(
      /must not embed credentials/u,
    );
  });

  it('refuses a non-loopback address before it reads the credential or spawns anything', async () => {
    const fixture = await createFixture();
    const { context, stdout, stderr } = contextFor(fixture);

    const code = await main(['--service', 'http://192.168.1.5:43117', '--detach'], context);

    expect(code).toBe(2);
    expect(stderr.text()).toContain('loopback');
    expect(stdout.text()).not.toContain(EDITOR_TOKEN);
    expect(stderr.text()).not.toContain(EDITOR_TOKEN);
  });

  it('refuses to follow a redirect, so the credential never reaches the target origin', async () => {
    const target = await startRecordingServer();
    const redirector = await startRedirectingServer(`${target.base}${LAUNCH}`);

    try {
      await expect(
        launchDevServer({
          base: redirector.base,
          editorToken: EDITOR_TOKEN,
          projectRoot: path.join(os.tmpdir(), 'some-project'),
        }),
      ).rejects.toThrow(/failed/u);

      // The redirect was received and refused: the second origin was never
      // asked for anything, so it never saw the bearer token.
      expect(redirector.requests).toEqual([`POST ${LAUNCH}`]);
      expect(target.authorizations).toEqual([]);
    } finally {
      await redirector.close();
      await target.close();
    }
  });

  it('refuses a redirected health probe rather than trusting another origin', async () => {
    const target = await startRecordingServer();
    const redirector = await startRedirectingServer(`${target.base}${HEALTH}`);
    const fixture = await createFixture();
    const { context, stderr } = contextFor(fixture);

    try {
      const code = await main(['--service', redirector.base, '--detach'], context);

      expect(code).toBe(2);
      expect(stderr.text()).toContain('not answering');
      expect(redirector.requests).toEqual([`GET ${HEALTH}`]);
      expect(target.authorizations).toEqual([]);
    } finally {
      await redirector.close();
      await target.close();
    }
  });
});

describe('the service identity proof', () => {
  it('exports the contract the stub services answer with', () => {
    expect(SERVICE_IDENTITY_CHALLENGE_HEADER).toBe(IDENTITY.challengeHeader);
    expect(SERVICE_IDENTITY_PROOF_HEADER).toBe(IDENTITY.proofHeader);
    expect(SERVICE_IDENTITY_ENDPOINT_HEADER).toBe(IDENTITY.endpointHeader);
    expect(SERVICE_IDENTITY_PROOF_LABEL).toBe(IDENTITY.label);
    expect(SERVICE_IDENTITY_CHALLENGE_BYTES).toBe(IDENTITY.challengeBytes);

    const key = `editor-credential-${randomUUID()}`;
    const challenge = randomBytes(IDENTITY.challengeBytes).toString('base64url');
    for (const endpoint of ['127.0.0.1:43117', '[::1]:43117', 'localhost:20000']) {
      const proof = computeServiceIdentityProof({ key, challenge, endpoint });
      expect(proof).toBe(identityProof(key, challenge, endpoint));
      expect(proof).toMatch(BASE64URL_32_BYTES);
    }
    // Every input is bound into the proof.
    const reference = computeServiceIdentityProof({ key, challenge, endpoint: '127.0.0.1:1' });
    expect(
      computeServiceIdentityProof({ key: `${key}x`, challenge, endpoint: '127.0.0.1:1' }),
    ).not.toBe(reference);
    expect(
      computeServiceIdentityProof({ key, challenge: `${challenge}x`, endpoint: '127.0.0.1:1' }),
    ).not.toBe(reference);
    expect(computeServiceIdentityProof({ key, challenge, endpoint: '127.0.0.1:2' })).not.toBe(
      reference,
    );
    expect(() => computeServiceIdentityProof({ key: '', challenge, endpoint: 'a:1' })).toThrow(
      TypeError,
    );
  });

  it("agrees with the service's definition of the identity contract", async () => {
    // Read the definer itself: the service's health route declares the header
    // names and the label, and computes the proof as an unpadded base64url
    // HMAC-SHA256. A rename on either side fails here rather than as a refused
    // service. On this side the proven message is held to the IDENTITY
    // transcription by the test above and by every stub answer.
    const healthFile = 'apps/local-service/src/server/routes/health.ts';
    const health = await fs.promises.readFile(path.join(REPO_ROOT, healthFile), 'utf8');
    for (const [name, value] of [
      ['SERVICE_IDENTITY_CHALLENGE_HEADER', IDENTITY.challengeHeader],
      ['SERVICE_IDENTITY_PROOF_HEADER', IDENTITY.proofHeader],
      ['SERVICE_IDENTITY_ENDPOINT_HEADER', IDENTITY.endpointHeader],
      ['SERVICE_IDENTITY_PROOF_LABEL', IDENTITY.label],
    ]) {
      expect(health, `${healthFile} must declare ${name} = '${value}'`).toMatch(
        new RegExp(`export const ${name}\\s*=\\s*'${escapeRegExp(value)}'`, 'u'),
      );
    }
    expect(health, `${healthFile} must key an HMAC-SHA256 with the editor credential`).toMatch(
      /createHmac\(\s*'sha256'/u,
    );
    expect(health, `${healthFile} must answer unpadded base64url`).toContain(
      ".digest('base64url')",
    );
  });

  it('sends a fresh challenge and no credential with every probe', async () => {
    service = await startStubService();

    await checkServiceHealth(service.base, EDITOR_TOKEN);
    await checkServiceHealth(service.base, EDITOR_TOKEN);

    expect(service.routes()).toEqual([`GET ${HEALTH}`, `GET ${HEALTH}`]);
    const [first, second] = service.requests;
    expect(first?.challenge).toMatch(BASE64URL_32_BYTES);
    expect(second?.challenge).toMatch(BASE64URL_32_BYTES);
    expect(first?.challenge).not.toBe(second?.challenge);
    expect(service.requests.map((request) => request.authorization)).toEqual([
      undefined,
      undefined,
    ]);
  });

  it('accepts a proof bound to the address dialled, in any spelling of that address', () => {
    const key = `editor-credential-${randomUUID()}`;
    const challenge = randomBytes(IDENTITY.challengeBytes).toString('base64url');
    /** @type {Array<[string, string]>} base URL, then the endpoint the service names */
    const accepted = [
      ['http://127.0.0.1:43117', '127.0.0.1:43117'],
      ['http://127.0.0.2:43117', '127.0.0.2:43117'],
      ['http://[::1]:43117', '[::1]:43117'],
      ['http://[::1]:43117', '[0:0:0:0:0:0:0:1]:43117'],
      ['http://[::ffff:127.0.0.1]:43117', '[::FFFF:127.0.0.1]:43117'],
      ['http://127.0.0.1', '127.0.0.1:80'],
      ['https://127.0.0.1', '127.0.0.1:443'],
      ['http://127.0.0.1:43117/debuggen', '127.0.0.1:43117'],
    ];
    for (const [base, endpoint] of accepted) {
      const proof = identityProof(key, challenge, endpoint);
      expect(verifyServiceIdentity({ key, challenge, base, proof, endpoint }), endpoint).toEqual({
        ok: true,
      });
    }
  });

  it('refuses a genuine proof bound to another address, which a relay on the other address family would present', () => {
    const key = `editor-credential-${randomUUID()}`;
    const challenge = randomBytes(IDENTITY.challengeBytes).toString('base64url');
    // A listener holding [::1]:P while the service holds 127.0.0.1:P can
    // forward the challenge and return the service's real proof, which names
    // 127.0.0.1:P. Only an exact match of the address the command dialled
    // defeats that relay.
    /** @type {Array<[string, string]>} base URL, then the endpoint the proof is bound to */
    const relayed = [
      ['http://127.0.0.1:43117', '[::1]:43117'],
      ['http://[::1]:43117', '127.0.0.1:43117'],
      ['http://127.0.0.2:43117', '127.0.0.1:43117'],
      ['http://[::ffff:127.0.0.1]:43117', '127.0.0.1:43117'],
    ];
    for (const [base, endpoint] of relayed) {
      const verdict = verifyServiceIdentity({
        key,
        challenge,
        base,
        proof: identityProof(key, challenge, endpoint),
        endpoint,
      });
      expect(verdict.ok, `${base} ← ${endpoint}`).toBe(false);
      expect(verdict.reason).toContain(`bound to "${endpoint}", not to`);
    }
  });

  it('refuses a genuine proof bound to a host name, whichever host was dialled', () => {
    const key = `editor-credential-${randomUUID()}`;
    const challenge = randomBytes(IDENTITY.challengeBytes).toString('base64url');
    // A name can stand for more than one listener: a proof bound to
    // localhost:P would authenticate whichever of 127.0.0.1:P and [::1]:P
    // answered, a relay included.
    /** @type {Array<[string, string]>} base URL, then the endpoint the proof is bound to */
    const named = [
      ['http://127.0.0.1:43117', 'localhost:43117'],
      ['http://[::1]:43117', 'localhost:43117'],
      ['http://localhost:43117', 'localhost:43117'],
      ['http://LOCALHOST:43117', 'LocalHost:43117'],
      ['http://127.0.0.1:43117', 'app.localhost:43117'],
    ];
    for (const [base, endpoint] of named) {
      const verdict = verifyServiceIdentity({
        key,
        challenge,
        base,
        proof: identityProof(key, challenge, endpoint),
        endpoint,
      });
      expect(verdict.ok, `${base} ← ${endpoint}`).toBe(false);
      expect(verdict.reason).toContain(
        `bound to "${endpoint}", a host name rather than an address`,
      );
    }
  });

  it('refuses a proof that is missing, malformed, forged or bound elsewhere', () => {
    const key = `editor-credential-${randomUUID()}`;
    const challenge = randomBytes(IDENTITY.challengeBytes).toString('base64url');
    const base = 'http://127.0.0.1:43117';
    const endpoint = '127.0.0.1:43117';
    const proof = identityProof(key, challenge, endpoint);

    /** @type {Array<[Partial<{ proof: string | null, endpoint: string | null }>, string]>} */
    const refusals = [
      [{ proof: null }, `carries no ${IDENTITY.proofHeader} header`],
      [{ endpoint: null }, `carries no ${IDENTITY.endpointHeader} header`],
      [{ proof: null, endpoint: null }, `no ${IDENTITY.proofHeader} and no`],
      [{ proof: '' }, `carries no ${IDENTITY.proofHeader}`],
      [{ proof: 'short' }, 'not made with the editor credential'],
      [{ proof: randomBytes(32).toString('base64url') }, 'not made with the editor credential'],
      [
        { proof: identityProof(`other-${randomUUID()}`, challenge, endpoint) },
        'not made with the editor credential',
      ],
      [
        { proof: identityProof(key, `${challenge}x`, endpoint) },
        'not made with the editor credential',
      ],
      [{ proof: `${proof}=` }, 'not made with the editor credential'],
    ];
    for (const [override, reason] of refusals) {
      const verdict = verifyServiceIdentity({ key, challenge, base, proof, endpoint, ...override });
      expect(verdict.ok, reason).toBe(false);
      expect(verdict.reason).toContain(reason);
      expect(verdict.reason).not.toContain(key);
      expect(verdict.reason).not.toContain(proof);
    }

    // Well-formed and correctly proved, but bound to an address this command
    // does not target: a relayed proof.
    for (const elsewhere of ['127.0.0.1:43118', '127.0.0.2:43117', '[::1]:43117']) {
      const verdict = verifyServiceIdentity({
        key,
        challenge,
        base,
        proof: identityProof(key, challenge, elsewhere),
        endpoint: elsewhere,
      });
      expect(verdict.ok, elsewhere).toBe(false);
      expect(verdict.reason).toContain(`bound to "${elsewhere}", not to 127.0.0.1:43117`);
    }

    // Correctly proved over a value that is not a host:port.
    for (const malformed of [
      '127.0.0.1',
      ':43117',
      '::1:43117',
      '[::1]',
      '[::1]43117',
      '[127.0.0.1]:43117',
      '[]:43117',
      '127.0.0.1:0',
      '127.0.0.1:65536',
      '127.0.0.1:12a',
      '127.0.0.1:+80',
      '127.0.0.1 :43117',
      '127.0.0.1:43117\u202e',
    ]) {
      const verdict = verifyServiceIdentity({
        key,
        challenge,
        base,
        proof: identityProof(key, challenge, malformed),
        endpoint: malformed,
      });
      expect(verdict.ok, malformed).toBe(false);
      expect(verdict.reason).toContain('is not a host:port');
      expect(verdict.reason).not.toContain('\u202e');
    }
  });

  /**
   * @typedef {'no-proof' | 'wrong-proof' | 'other-token' | 'relayed'} ImpostorKind
   */

  /**
   * Start a listener that is not the service: it answers `GET /health` with a
   * 200 and the identity headers `kind` calls for, answers every other request
   * with a 200 and a body the caller would accept — so a caller that went on
   * would visibly get further — and records every request.
   *
   * - `no-proof`: no identity headers at all;
   * - `wrong-proof`: its real endpoint and a random proof of the right length;
   * - `other-token`: its real endpoint and a proof keyed by another credential;
   * - `relayed`: the challenge forwarded to a genuine stub service on another
   *   port, and that service's proof and endpoint copied into the answer.
   *
   * @param {ImpostorKind} kind
   * @returns {Promise<{ base: string, requests: Array<{ method: string, path: string, authorization: string | undefined }>, upstream: StubService | undefined, close: () => Promise<void> }>}
   */
  async function startImpostor(kind) {
    const upstream = kind === 'relayed' ? await startStubService() : undefined;
    /** @type {Array<{ method: string, path: string, authorization: string | undefined }>} */
    const requests = [];
    const otherKey = `editor-credential-${randomUUID()}`;

    const server = http.createServer((req, res) => {
      const requestPath = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
      requests.push({
        method: req.method ?? 'GET',
        path: requestPath,
        authorization: req.headers.authorization,
      });
      req.resume();
      req.on('end', () => {
        if (requestPath !== HEALTH) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              ...LAUNCHED,
              token: SERVER_AGENT_TOKEN,
              expiresAt: Date.now() + CREDENTIAL_LIFETIME_MS,
            }),
          );
          return;
        }
        const challenge = String(req.headers[IDENTITY.challengeHeader.toLowerCase()] ?? '');
        const endpoint = `127.0.0.1:${String(req.socket.localPort)}`;

        /** @type {Promise<Record<string, string>>} */
        let headers;
        if (kind === 'no-proof') {
          headers = Promise.resolve({});
        } else if (kind === 'wrong-proof') {
          headers = Promise.resolve({
            [IDENTITY.endpointHeader]: endpoint,
            [IDENTITY.proofHeader]: randomBytes(32).toString('base64url'),
          });
        } else if (kind === 'other-token') {
          headers = Promise.resolve({
            [IDENTITY.endpointHeader]: endpoint,
            [IDENTITY.proofHeader]: identityProof(otherKey, challenge, endpoint),
          });
        } else {
          headers = globalThis
            .fetch(`${upstream?.base ?? ''}${HEALTH}`, {
              headers: { [IDENTITY.challengeHeader]: challenge },
            })
            .then(async (relayed) => {
              await relayed.body?.cancel();
              return {
                [IDENTITY.endpointHeader]: relayed.headers.get(IDENTITY.endpointHeader) ?? '',
                [IDENTITY.proofHeader]: relayed.headers.get(IDENTITY.proofHeader) ?? '',
              };
            });
        }
        // A relay whose upstream failed answers without identity headers,
        // which the caller must refuse like any other unproved answer.
        void headers
          .catch(() => ({}))
          .then((identity) => {
            res.writeHead(200, { 'content-type': 'application/json', ...identity });
            res.end(JSON.stringify({ status: 'ok' }));
          });
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;

    return {
      base: `http://127.0.0.1:${port}`,
      requests,
      upstream,
      close: async () => {
        await new Promise((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve(undefined));
        });
        await upstream?.close();
      },
    };
  }

  /** @type {Array<[string, ImpostorKind]>} */
  const impostors = [
    ['answers 200 without any proof', 'no-proof'],
    ['answers with a proof that is not an HMAC of the challenge', 'wrong-proof'],
    ['answers with a proof made with a different editor credential', 'other-token'],
    ['relays the proof of the real service on another port', 'relayed'],
  ];

  /** @type {Array<[string, string[]]>} */
  const modes = [
    ['the default launch', ['--detach']],
    ['--stop', ['--stop']],
    ['--spawn-local', ['--spawn-local']],
  ];

  const spawns = it.skipIf(process.platform === 'win32');

  for (const [mode, flags] of modes) {
    const test = flags.includes('--spawn-local') ? spawns : it;
    for (const [what, kind] of impostors) {
      test(`${mode} sends nothing to a listener that ${what}`, async () => {
        const impostor = await startImpostor(kind);
        const fixture = await createFixture();
        const dev = await createFakeDevServer(fixture);
        const { context, stdout, stderr } = contextFor(fixture, dev.env);

        try {
          const code = await main([...flags, '--service', impostor.base], context);

          expect(code).toBe(2);
          // One unauthenticated probe, and nothing after it: no POST and no
          // request carrying the bearer credential.
          expect(impostor.requests.map((entry) => `${entry.method} ${entry.path}`)).toEqual([
            `GET ${HEALTH}`,
          ]);
          expect(impostor.requests.filter((entry) => entry.authorization !== undefined)).toEqual(
            [],
          );
          if (impostor.upstream !== undefined) {
            // The genuine service behind the relay was asked for its proof and
            // for nothing else.
            expect(impostor.upstream.routes()).toEqual([`GET ${HEALTH}`]);
            expect(impostor.upstream.requests[0]?.authorization).toBeUndefined();
          }

          expect(stdout.text()).toBe('');
          expect(dev.ran()).toBe(false);
          const errors = squash(stderr.text());
          expect(errors).toContain(
            `the listener at ${impostor.base}${HEALTH} did not prove it is the Debug Generator service holding the editor credential in $DEBUGGEN_HOME/${AUTH_FILE_NAME}`,
          );
          expect(errors).toContain('the editor credential was not sent');
          expect(errors).toContain('another process holds the port');
          expect(errors).toContain('pnpm --filter @debuggen/local-service build');
          expect(errors).toContain('different DEBUGGEN_HOME');
          const reason = {
            'no-proof': `carries no ${IDENTITY.proofHeader} and no ${IDENTITY.endpointHeader} header`,
            'wrong-proof': 'not made with the editor credential',
            'other-token': 'not made with the editor credential',
            relayed: `bound to "127.0.0.1:${new URL(impostor.upstream?.base ?? 'http://x:1').port}"`,
          }[kind];
          expect(errors).toContain(reason);
          if (flags.includes('--spawn-local')) expect(errors).toContain('Nothing was spawned');
          expect(`${stdout.text()}${stderr.text()}`).not.toContain(EDITOR_TOKEN);
        } finally {
          await impostor.close();
        }
      });
    }
  }
});

describe('dialling the address that proves the service', () => {
  /** @type {Array<() => Promise<void>>} */
  const cleanups = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  /**
   * A listener on another loopback address that shares the service's port —
   * `[::1]:P` beside a service on `127.0.0.1:P` on a dual-stack machine,
   * played here by `127.0.0.2:P` — and relays every challenge to the service,
   * copying its genuine proof and endpoint into its own answer. It records
   * what it receives.
   *
   * @param {string} host the relay's address
   * @param {StubService} upstream the genuine service
   * @returns {Promise<{ requests: Array<{ method: string, path: string, authorization: string | undefined }> }>}
   */
  async function startAddressRelay(host, upstream) {
    const port = Number.parseInt(new URL(upstream.base).port, 10);
    /** @type {Array<{ method: string, path: string, authorization: string | undefined }>} */
    const requests = [];
    const server = http.createServer((req, res) => {
      requests.push({
        method: req.method ?? 'GET',
        path: new URL(req.url ?? '/', 'http://127.0.0.1').pathname,
        authorization: req.headers.authorization,
      });
      req.resume();
      const challenge = String(req.headers[IDENTITY.challengeHeader.toLowerCase()] ?? '');
      void globalThis
        .fetch(`${upstream.base}${HEALTH}`, { headers: { [IDENTITY.challengeHeader]: challenge } })
        .then(async (relayed) => {
          await relayed.body?.cancel();
          res.writeHead(200, {
            'content-type': 'application/json',
            [IDENTITY.endpointHeader]: relayed.headers.get(IDENTITY.endpointHeader) ?? '',
            [IDENTITY.proofHeader]: relayed.headers.get(IDENTITY.proofHeader) ?? '',
          });
          res.end(JSON.stringify({ status: 'ok' }));
        });
    });
    await new Promise((resolve) => server.listen(port, host, () => resolve(undefined)));
    cleanups.push(
      () =>
        new Promise((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve(undefined));
        }),
    );
    return { requests };
  }

  /**
   * A stand-in for `node:dns/promises` `lookup` that answers `addresses` for
   * `localhost` and records every call.
   *
   * @param {string[]} addresses
   */
  function lookupOf(addresses) {
    /** @type {Array<[string, unknown]>} */
    const calls = [];
    /** @type {(hostname: string, options: { all: true, order: 'verbatim' }) => Promise<Array<{ address: string, family: number }>>} */
    const lookup = async (hostname, options) => {
      calls.push([hostname, options]);
      return addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
    };
    return { lookup, calls };
  }

  it('probes an address as it is, without resolving anything', async () => {
    const service = await startStubService();
    cleanups.push(() => service.close());
    const { lookup, calls } = lookupOf([]);

    await expect(checkServiceHealth(service.base, EDITOR_TOKEN, { lookup })).resolves.toBe(
      service.base,
    );
    expect(calls).toEqual([]);
  });

  it('resolves a host name and pins the address that proves the service, past a relay on another address', async () => {
    const service = await startStubService();
    cleanups.push(() => service.close());
    const relay = await startAddressRelay('127.0.0.2', service);
    const port = new URL(service.base).port;
    const { lookup, calls } = lookupOf(['127.0.0.2', '127.0.0.1']);

    const pinned = await checkServiceHealth(`http://localhost:${port}/`, EDITOR_TOKEN, {
      lookup,
    });

    expect(pinned).toBe(`http://127.0.0.1:${port}`);
    expect(calls).toEqual([['localhost', { all: true, order: 'verbatim' }]]);
    // The relay got one unauthenticated probe and was refused: its answer
    // names 127.0.0.1, not the 127.0.0.2 it was dialled on.
    expect(relay.requests).toEqual([{ method: 'GET', path: HEALTH, authorization: undefined }]);
    // The service answered the relayed challenge and the direct one, and was
    // sent no credential by either.
    expect(service.routes()).toEqual([`GET ${HEALTH}`, `GET ${HEALTH}`]);
    expect(service.requests.map((request) => request.authorization)).toEqual([
      undefined,
      undefined,
    ]);
  });

  it('refuses, sending nothing else, when the only address of the name is a relay', async () => {
    const service = await startStubService();
    cleanups.push(() => service.close());
    const relay = await startAddressRelay('127.0.0.2', service);
    const port = new URL(service.base).port;
    const { lookup } = lookupOf(['127.0.0.2']);

    const refusal = checkServiceHealth(`http://localhost:${port}`, EDITOR_TOKEN, { lookup });

    await expect(refusal).rejects.toThrow(
      `the listener at http://127.0.0.2:${port}${HEALTH} did not prove it is the Debug Generator service`,
    );
    await expect(refusal).rejects.toThrow(`bound to "127.0.0.1:${port}", not to 127.0.0.2:${port}`);
    expect(relay.requests.filter((request) => request.authorization !== undefined)).toEqual([]);
  });

  it('probes each loopback address of the name once, and no other address', async () => {
    const service = await startStubService();
    cleanups.push(() => service.close());
    const port = new URL(service.base).port;
    const { lookup } = lookupOf(['192.0.2.10', '127.0.0.1', '127.0.0.1']);

    await expect(
      checkServiceHealth(`http://localhost:${port}`, EDITOR_TOKEN, { lookup }),
    ).resolves.toBe(`http://127.0.0.1:${port}`);
    expect(service.routes()).toEqual([`GET ${HEALTH}`]);
  });

  it('refuses a name that resolves to no loopback address, or cannot be resolved', async () => {
    await expect(
      checkServiceHealth('http://localhost:43117', EDITOR_TOKEN, {
        lookup: lookupOf(['192.0.2.10']).lookup,
      }),
    ).rejects.toThrow('the service host localhost resolves to no loopback address');
    await expect(
      checkServiceHealth('http://localhost:43117', EDITOR_TOKEN, {
        lookup: async () => {
          throw Object.assign(new Error('getaddrinfo ENOTFOUND localhost'), { code: 'ENOTFOUND' });
        },
      }),
    ).rejects.toThrow('the service host localhost could not be resolved');
  });

  it('names every address it tried when none of them proves the service', async () => {
    const closed = await startStubService();
    const port = new URL(closed.base).port;
    await closed.close();
    const { lookup } = lookupOf(['127.0.0.2', '127.0.0.3']);

    await expect(
      checkServiceHealth(`http://localhost:${port}`, EDITOR_TOKEN, { lookup }),
    ).rejects.toThrow(
      new RegExp(
        `none of the 2 loopback addresses localhost resolves to proved it is the Debug Generator service, so the editor credential was not sent: the local service is not answering http://127\\.0\\.0\\.2:${port}${HEALTH}: .*; the local service is not answering http://127\\.0\\.0\\.3:${port}${HEALTH}`,
        'u',
      ),
    );
  });

  it('launches through the address that proved the service when --service names localhost', async () => {
    const service = await startStubService();
    cleanups.push(() => service.close());
    const port = new URL(service.base).port;
    const fixture = await createFixture();
    const { context } = contextFor(fixture);

    const code = await main(['--detach', '--service', `http://localhost:${port}`], context);

    expect(code).toBe(0);
    const launch = service.requests.find((request) => request.path === LAUNCH);
    expect(launch?.authorization).toBe(`Bearer ${EDITOR_TOKEN}`);
  });
});

describe('the local spawn mode', () => {
  it('drops an inherited credential when the caller supplies none', () => {
    const childEnv = buildChildEnv({
      preloadUrl: 'file:///tmp/register.mjs',
      base: 'http://127.0.0.1:43117',
      projectRoot: '/tmp/target',
      token: undefined,
      env: {
        NODE_OPTIONS: '--trace-warnings',
        DEBUGGEN_TOKEN: 'stale-credential',
        PATH: '/usr/bin',
      },
    });

    expect(childEnv.NODE_OPTIONS).toBe('--trace-warnings --import file:///tmp/register.mjs');
    expect(childEnv.DEBUGGEN_INGEST_URL).toBe(`http://127.0.0.1:43117${INGEST_PATH}`);
    expect(childEnv.DEBUGGEN_PROJECT_ROOT).toBe('/tmp/target');
    expect('DEBUGGEN_TOKEN' in childEnv).toBe(false);
  });

  it('carries the supplied credential through, replacing an inherited one', () => {
    const childEnv = buildChildEnv({
      preloadUrl: 'file:///tmp/register.mjs',
      base: 'http://127.0.0.1:43117',
      projectRoot: '/tmp/target',
      token: 'server-agent-credential',
      env: { PATH: '/usr/bin', DEBUGGEN_TOKEN: 'stale-credential' },
    });

    expect(childEnv.DEBUGGEN_TOKEN).toBe('server-agent-credential');
    // Described by length only: a credential never reaches a terminal or a log.
    expect(describeToken(childEnv.DEBUGGEN_TOKEN)).toBe(
      `<set, ${'server-agent-credential'.length} bytes>`,
    );
    // Neutral: the description of an absent credential claims nothing about
    // any mode.
    expect(describeToken(undefined)).toBe('<not set>');
  });

  /**
   * Parent variables that must never reach a target project, each with a
   * per-run value so its absence can be asserted by value as well as by name.
   *
   * @returns {Record<string, string>}
   */
  const parentSecrets = () => ({
    ANTHROPIC_API_KEY: `sentinel-${randomUUID()}`,
    GITHUB_TOKEN: `sentinel-${randomUUID()}`,
    AWS_SECRET_ACCESS_KEY: `sentinel-${randomUUID()}`,
    FOO_SECRET: `sentinel-${randomUUID()}`,
    DEBUGGEN_PROVIDER: `sentinel-${randomUUID()}`,
    VSCODE_IPC_HOOK: `sentinel-${randomUUID()}`,
    npm_config_registry: `sentinel-${randomUUID()}`,
  });

  /** Parent variables on the allowlist, with the values the child must see. */
  const ALLOWLISTED = Object.freeze({
    HOME: '/home/developer',
    DATABASE_URL: 'postgresql://localhost/debuggen_test',
    NEXT_TELEMETRY_DISABLED: '1',
    LC_ALL: 'C',
    http_proxy: 'http://127.0.0.1:9',
    DEBUGGEN_LOG_LEVEL: 'debug',
  });

  it('keeps every variable off the allowlist out of the child environment', () => {
    const secrets = parentSecrets();
    const childEnv = buildChildEnv({
      preloadUrl: 'file:///tmp/register.mjs',
      base: 'http://127.0.0.1:43117',
      projectRoot: '/tmp/target',
      token: 'server-agent-credential',
      env: {
        PATH: '/usr/bin',
        ...ALLOWLISTED,
        ...secrets,
        DEBUGGEN_HOME: '/tmp/home',
        // Differently cased spellings are other variables on POSIX.
        Path: '/elsewhere',
        node_options: '--require ./steal.js',
      },
      platform: 'linux',
    });

    expect(childEnv).toEqual({
      PATH: '/usr/bin',
      ...ALLOWLISTED,
      NODE_OPTIONS: '--import file:///tmp/register.mjs',
      DEBUGGEN_INGEST_URL: `http://127.0.0.1:43117${INGEST_PATH}`,
      DEBUGGEN_PROJECT_ROOT: '/tmp/target',
      DEBUGGEN_TOKEN: 'server-agent-credential',
    });
    for (const value of Object.values(secrets)) {
      expect(JSON.stringify(childEnv)).not.toContain(value);
    }
  });

  it('forwards the explicit extras, replacing a same-named parent variable', () => {
    const childEnv = buildChildEnv({
      preloadUrl: 'file:///tmp/register.mjs',
      base: 'http://127.0.0.1:43117',
      projectRoot: '/tmp/target',
      token: 'server-agent-credential',
      env: { PATH: '/usr/bin', FEATURE_FLAGS: 'inherited-only' },
      extraEnv: { FEATURE_FLAGS: 'a,b', PORT: '3200', EMPTY: '' },
      platform: 'linux',
    });

    expect(childEnv.FEATURE_FLAGS).toBe('a,b');
    expect(childEnv.PORT).toBe('3200');
    expect(childEnv.EMPTY).toBe('');
    expect(childEnv.PATH).toBe('/usr/bin');

    // The builder refuses the names only this command sets, whoever calls it.
    for (const name of ['NODE_OPTIONS', 'DEBUGGEN_TOKEN', 'debuggen_ingest_url']) {
      expect(() =>
        buildChildEnv({
          preloadUrl: 'file:///tmp/register.mjs',
          base: 'http://127.0.0.1:43117',
          projectRoot: '/tmp/target',
          token: 'server-agent-credential',
          env: {},
          extraEnv: { [name]: 'x' },
        }),
      ).toThrow(/^--env "/u);
    }
  });

  it('compares names case-insensitively on Windows and folds their spellings', () => {
    const childEnv = buildChildEnv({
      preloadUrl: 'file:///C:/repo/register.mjs',
      base: 'http://127.0.0.1:43117',
      projectRoot: 'C:\\target',
      token: 'server-agent-credential',
      env: {
        Path: 'C:\\bin',
        SystemRoot: 'C:\\Windows',
        ComSpec: 'C:\\Windows\\System32\\cmd.exe',
        http_proxy: 'http://127.0.0.1:9',
        Lc_All: 'C',
        Node_Options: '--trace-warnings',
        debuggen_token: 'stale-credential',
        Anthropic_Api_Key: 'sentinel',
        DEBUGGEN_HOME: 'C:\\home',
      },
      extraEnv: { PATH: 'C:\\override' },
      platform: 'win32',
    });

    expect(childEnv).toEqual({
      PATH: 'C:\\override',
      SystemRoot: 'C:\\Windows',
      ComSpec: 'C:\\Windows\\System32\\cmd.exe',
      http_proxy: 'http://127.0.0.1:9',
      Lc_All: 'C',
      NODE_OPTIONS: '--trace-warnings --import file:///C:/repo/register.mjs',
      DEBUGGEN_INGEST_URL: `http://127.0.0.1:43117${INGEST_PATH}`,
      DEBUGGEN_PROJECT_ROOT: 'C:\\target',
      DEBUGGEN_TOKEN: 'server-agent-credential',
    });

    expect(isForwardedToChild('SystemRoot', 'win32')).toBe(true);
    expect(isForwardedToChild('SystemRoot', 'linux')).toBe(false);
    expect(isForwardedToChild('http_proxy', 'linux')).toBe(true);
    expect(isForwardedToChild('Http_Proxy', 'linux')).toBe(false);
    expect(isForwardedToChild('next_public_api', 'win32')).toBe(true);
    expect(isForwardedToChild('Node_Options', 'win32')).toBe(false);
    expect(isForwardedToChild('', 'linux')).toBe(false);
  });

  it('resolves --env against this terminal, and refuses an unset or repeated name', () => {
    expect(
      resolveExtraEnv(
        [
          { name: 'FORWARDED', value: undefined },
          { name: 'GIVEN', value: 'a=b' },
          { name: 'BLANK', value: '' },
        ],
        { FORWARDED: 'from-terminal' },
        'linux',
      ),
    ).toEqual({ FORWARDED: 'from-terminal', GIVEN: 'a=b', BLANK: '' });

    // Windows finds a bare name whatever its spelling in the environment.
    expect(
      resolveExtraEnv([{ name: 'path', value: undefined }], { Path: 'C:\\bin' }, 'win32'),
    ).toEqual({ path: 'C:\\bin' });
    // A name that is an own data property, never the prototype.
    const proto = resolveExtraEnv([{ name: '__proto__', value: 'x' }], {}, 'linux');
    expect(Object.getOwnPropertyDescriptor(proto, '__proto__')?.value).toBe('x');

    expect(() => resolveExtraEnv([{ name: 'MISSING', value: undefined }], {}, 'linux')).toThrow(
      '--env MISSING names a variable this terminal does not set',
    );
    expect(() =>
      resolveExtraEnv([{ name: 'path', value: undefined }], { Path: '/usr/bin' }, 'linux'),
    ).toThrow(/does not set/u);
    expect(() =>
      resolveExtraEnv(
        [
          { name: 'Foo', value: '1' },
          { name: 'FOO', value: '2' },
        ],
        {},
        'win32',
      ),
    ).toThrow(/given more than once/u);
    expect(
      resolveExtraEnv(
        [
          { name: 'Foo', value: '1' },
          { name: 'FOO', value: '2' },
        ],
        {},
        'linux',
      ),
    ).toEqual({ Foo: '1', FOO: '2' });
  });

  it("mirrors the service launcher's dev-server environment allowlist exactly", async () => {
    // The script cannot import the TypeScript launcher, so it carries a copy of
    // its allowlist. Read the launcher's own declarations and hold the copy to
    // them: a name added to or removed from either side fails here.
    const launcherFile = 'apps/local-service/src/dev-server/launcher.ts';
    const launcher = await fs.promises.readFile(path.join(REPO_ROOT, launcherFile), 'utf8');
    const drift = (/** @type {string} */ what) =>
      `${launcherFile} ${what}; update CHILD_ENV_ALLOWLIST in scripts/dev-instrumented.mjs to match it`;

    /** Every `const X_NAMES = [ ... ] as const;` body, by name. */
    const arrays = new Map(
      [
        ...launcher.matchAll(/\bconst\s+([A-Z_]+_NAMES)\s*=\s*\[([\s\S]*?)\]\s*as\s+const\s*;/gu),
      ].map((match) => [match[1] ?? '', match[2] ?? '']),
    );
    /**
     * The names an array declares, its spreads of other arrays resolved.
     *
     * @param {string} name
     * @returns {string[]}
     */
    const resolveNames = (name) => {
      const body = arrays.get(name);
      if (body === undefined) throw new Error(drift(`no longer declares ${name}`));
      return [...body.matchAll(/\.\.\.([A-Z_]+_NAMES)|'([^']*)'/gu)].flatMap((token) =>
        token[1] === undefined ? [token[2] ?? ''] : resolveNames(token[1]),
      );
    };

    const declaration =
      /export const DEV_SERVER_ENV_ALLOWLIST\b[^=]*=\s*Object\.freeze\(\{([\s\S]*?)\n\}\);/u.exec(
        launcher,
      );
    expect(declaration, drift('no longer declares DEV_SERVER_ENV_ALLOWLIST')).not.toBeNull();
    const allowlist = declaration?.[1] ?? '';

    const namesBody = /names:\s*Object\.freeze\(\[([\s\S]*?)\]\)/u.exec(allowlist)?.[1];
    expect(namesBody, drift('declares its names differently')).toBeDefined();
    const spreads = [...(namesBody ?? '').matchAll(/\.\.\.([A-Z_]+_NAMES)/gu)].map(
      (match) => match[1] ?? '',
    );
    expect(spreads.length, drift('lists its names without *_NAMES spreads')).toBeGreaterThan(0);
    const launcherNames = spreads.flatMap((name) => resolveNames(name));

    const prefixesBody = /prefixes:\s*Object\.freeze\(\[([^\]]*)\]\)/u.exec(allowlist)?.[1];
    expect(prefixesBody, drift('declares its prefixes differently')).toBeDefined();
    const launcherPrefixes = [...(prefixesBody ?? '').matchAll(/'([^']*)'/gu)].map(
      (match) => match[1] ?? '',
    );

    const lowerSource =
      /posixLowercaseNames:\s*Object\.freeze\(\s*([A-Z_]+_NAMES)\.map\(\s*\(name\)\s*=>\s*name\.toLowerCase\(\)\s*\)\s*\)/u.exec(
        allowlist,
      )?.[1];
    expect(lowerSource, drift('derives its POSIX lower-case names differently')).toBeDefined();
    const launcherLowercase = resolveNames(lowerSource ?? '').map((name) => name.toLowerCase());

    // The matching rule itself: upper-cased on Windows, exact elsewhere.
    expect(launcher, drift('compares names differently')).toMatch(
      /const key = platform === 'win32' \? name\.toUpperCase\(\) : name;/u,
    );

    const sorted = (/** @type {readonly string[]} */ values) => [...values].sort();
    expect(sorted(CHILD_ENV_ALLOWLIST.names), drift('lists other names')).toEqual(
      sorted(launcherNames),
    );
    expect(sorted(CHILD_ENV_ALLOWLIST.prefixes), drift('lists other prefixes')).toEqual(
      sorted(launcherPrefixes),
    );
    expect(
      sorted(CHILD_ENV_ALLOWLIST.posixLowercaseNames),
      drift('lists other POSIX lower-case names'),
    ).toEqual(sorted(launcherLowercase));
    // The extraction found the lists it is meant to, not an empty match.
    expect(launcherNames).toContain('DATABASE_URL');
    expect(launcherNames).toContain('PROGRAMFILES(X86)');
    expect(launcherLowercase).toContain('http_proxy');
  });

  it('asks the credential route for a scoped credential and returns it verbatim', async () => {
    service = await startStubService();
    const projectRoot = path.join(os.tmpdir(), 'some-project');

    const credential = await requestServerAgentCredential({
      base: service.base,
      editorToken: EDITOR_TOKEN,
      projectRoot,
    });

    expect(credential).toEqual({ token: SERVER_AGENT_TOKEN, expiresAt: service.expiresAt });
    expect(service.routes()).toEqual([`POST ${CREDENTIAL}`]);
    expect(service.requests[0]?.authorization).toBe(`Bearer ${EDITOR_TOKEN}`);
    expect(service.requests[0]?.body).toEqual({ projectRoot });
    expect(service.rejections).toEqual([]);
  });

  it('refuses a credential answer that is not exactly a usable { token, expiresAt }', async () => {
    const future = Date.now() + CREDENTIAL_LIFETIME_MS;
    /** @type {Array<[unknown, string]>} */
    const cases = [
      [{ expiresAt: future }, 'no non-empty string token'],
      [{ token: '', expiresAt: future }, 'no non-empty string token'],
      [{ token: `${SERVER_AGENT_TOKEN}\nx`, expiresAt: future }, 'whitespace or control'],
      [{ token: SERVER_AGENT_TOKEN, expiresAt: 'tomorrow' }, 'not an epoch-millisecond number'],
      [{ token: SERVER_AGENT_TOKEN, expiresAt: Number.MAX_VALUE }, 'epoch-millisecond'],
      [{ token: SERVER_AGENT_TOKEN, expiresAt: Date.now() - 1_000 }, 'already passed'],
      [{ token: SERVER_AGENT_TOKEN, expiresAt: future, scope: 'x' }, 'fields other than'],
      [[SERVER_AGENT_TOKEN], 'not a JSON object'],
    ];

    for (const [body, problem] of cases) {
      service = await startStubService({ credentialBody: body });

      const error = await requestServerAgentCredential({
        base: service.base,
        editorToken: EDITOR_TOKEN,
        projectRoot: path.join(os.tmpdir(), 'some-project'),
      }).then(
        () => undefined,
        (/** @type {unknown} */ caught) => caught,
      );

      expect(error, problem).toBeInstanceOf(Error);
      const { message, hint } = /** @type {{ message: string, hint?: string }} */ (error);
      expect(message).toContain('off-contract');
      expect(message).toContain(problem);
      // The body carries a credential by definition, so no part of it is shown.
      expect(`${message}\n${hint ?? ''}`).not.toContain(SERVER_AGENT_TOKEN);
      expect(`${message}\n${hint ?? ''}`).not.toContain(EDITOR_TOKEN);

      await service.close();
      service = undefined;
    }
  });

  // The spawn is exercised through a fake `pnpm` on a `PATH` of the test's own,
  // which POSIX shells can execute directly; `buildLaunchCommand` resolves
  // `pnpm.cmd` through `PATHEXT` on Windows and `wrapForPlatform` runs it
  // through the command interpreter, which this fake is not.
  const spawns = it.skipIf(process.platform === 'win32');

  spawns(
    'mints a server-agent credential and hands it to the dev server, and only to it',
    async () => {
      service = await startStubService();
      const fixture = await createFixture();
      const dev = await createFakeDevServer(fixture, { exitCode: 7 });
      const { context, stdout, stderr } = contextFor(fixture, {
        ...dev.env,
        // Inherited from some other process: the minted credential replaces it.
        DEBUGGEN_TOKEN: 'stale-credential-from-another-process',
      });

      const code = await main(['--spawn-local', '--service', service.base], context);

      // 7 is the child's own status; 2 would be this command reporting a failure.
      expect(code).toBe(7);
      expect(stderr.text()).toBe('');

      // The pre-flight, then the credential route with the editor credential and
      // the project root; once the child has exited, a fresh identity probe and
      // exactly one release of the minted credential. No launch, no stop, no
      // retry.
      expect(service.routes()).toEqual([
        `GET ${HEALTH}`,
        `POST ${CREDENTIAL}`,
        `GET ${HEALTH}`,
        `POST ${RELEASE}`,
      ]);
      expect(service.rejections).toEqual([]);
      expect(service.requests[0]?.authorization).toBeUndefined();
      expect(service.requests[0]?.challenge).toMatch(BASE64URL_32_BYTES);
      expect(service.requests[1]?.authorization).toBe(`Bearer ${EDITOR_TOKEN}`);
      expect(service.requests[1]?.body).toEqual({ projectRoot: fixture.projectDir });
      expect(service.requests[2]?.authorization).toBeUndefined();
      expect(service.requests[2]?.challenge).toMatch(BASE64URL_32_BYTES);
      expect(service.requests[2]?.challenge).not.toBe(service.requests[0]?.challenge);
      expect(service.requests[3]?.authorization).toBe(`Bearer ${EDITOR_TOKEN}`);
      expect(service.requests[3]?.body).toEqual({ token: SERVER_AGENT_TOKEN });
      expect(squash(stdout.text())).toContain(
        'released the server-agent credential; the service revoked it',
      );

      // All four preload variables reached the child, the credential verbatim.
      expect(dev.ran()).toBe(true);
      const recorded = dev.read();
      expect(recorded.argv).toBe('--filter target-app dev');
      expect(recorded.cwd).toBe(fs.realpathSync(fixture.root));
      expect(recorded.NODE_OPTIONS).toBe(`--import ${fixture.preloadUrl}`);
      expect(recorded.DEBUGGEN_INGEST_URL).toBe(`${service.base}${INGEST_PATH}`);
      expect(recorded.DEBUGGEN_PROJECT_ROOT).toBe(fixture.projectDir);
      expect(recorded.DEBUGGEN_TOKEN).toBe(SERVER_AGENT_TOKEN);

      // Neither credential reached this command's own output.
      for (const secret of [SERVER_AGENT_TOKEN, EDITOR_TOKEN]) {
        expect(stdout.text()).not.toContain(secret);
        expect(stderr.text()).not.toContain(secret);
      }

      // The banner describes the credential by length and the end of its first
      // lease only, says that this command releases it when the dev server
      // exits, and how the service renews and revokes it otherwise.
      const banner = squash(stdout.text());
      expect(banner).toContain(`DEBUGGEN_TOKEN <set, ${SERVER_AGENT_TOKEN.length} bytes>`);
      expect(banner).toContain(
        `lease ends ${new Date(service.expiresAt).toISOString()} (renewed while the dev server runs)`,
      );
      expect(banner).toContain('This run is AUTHENTICATED');
      expect(banner).toContain('the service renews it while the dev server');
      expect(banner).toContain(
        `When the dev server exits, Ctrl-C included, this command releases it (POST ${RELEASE})`,
      );
      expect(banner).toContain(
        'the service still revokes it when the dev server disconnects, 20 seconds after',
      );
      expect(banner).toContain('shortly after the dev server exits');
      expect(banner).toContain('lapses within 5 minutes');
      expect(banner).not.toContain('no revoke route');
      expect(banner).not.toContain('not revoked');
    },
  );

  spawns(
    'starts the dev server with the allowlisted environment and the --env extras, and no other secret',
    async () => {
      service = await startStubService();
      const fixture = await createFixture();
      const dev = await createFakeDevServer(fixture);
      const secrets = parentSecrets();
      const { context, stdout, stderr } = contextFor(fixture, {
        ...dev.env,
        ...ALLOWLISTED,
        ...secrets,
        FORWARDED_ONE: 'from-this-terminal',
        DEBUGGEN_TOKEN: 'stale-credential-from-another-process',
      });

      const code = await main(
        [
          '--spawn-local',
          '--env',
          'FORWARDED_ONE',
          '--env=EXTRA_FLAG=on',
          '--service',
          service.base,
        ],
        context,
      );

      expect(stderr.text()).toBe('');
      expect(code).toBe(0);

      // What the child process really received, as `env` printed it.
      const received = dev.readEnv();
      for (const [name, value] of Object.entries(secrets)) {
        expect(received, `${name} reached the dev server`).not.toHaveProperty(name);
        expect(Object.values(received)).not.toContain(value);
      }
      expect(received).not.toHaveProperty('DEBUGGEN_HOME');
      for (const [name, value] of Object.entries(ALLOWLISTED)) {
        expect(received[name], name).toBe(value);
      }
      expect(received.PATH).toBe(dev.env.PATH);
      expect(received.FORWARDED_ONE).toBe('from-this-terminal');
      expect(received.EXTRA_FLAG).toBe('on');
      expect(received.DEBUGGEN_TOKEN).toBe(SERVER_AGENT_TOKEN);
      expect(received.DEBUGGEN_PROJECT_ROOT).toBe(fixture.projectDir);
      expect(received.NODE_OPTIONS).toBe(`--import ${fixture.preloadUrl}`);

      // The banner names the extras and shows none of their values.
      const banner = squash(stdout.text());
      expect(banner).toContain('--env FORWARDED_ONE, EXTRA_FLAG (values not shown)');
      expect(banner).not.toContain('from-this-terminal');
      expect(banner).toContain('The dev server inherits only the part of this terminal');
    },
  );

  /**
   * @typedef {object} SpawnRefusal
   * @property {string} name what goes wrong, for the test title
   * @property {string[]} [args] arguments before `--spawn-local`
   * @property {Parameters<typeof startStubService>[0]} [stub] stub service
   *   options; omitted with `down`
   * @property {boolean} [down] run against an address nothing listens on
   * @property {boolean} [withCredential] write `auth.json` (default true)
   * @property {string[]} expected fragments the (whitespace-collapsed) stderr
   *   must contain
   * @property {string[] | undefined} routes what the stub must have been asked,
   *   when a stub runs
   * @property {number[]} [rejected] statuses the stub's own contract checks
   *   refused with (default none)
   */

  const future = Date.now() + CREDENTIAL_LIFETIME_MS;
  const askedForCredential = [`GET ${HEALTH}`, `POST ${CREDENTIAL}`];

  /** @type {SpawnRefusal[]} */
  const refusals = [
    {
      name: 'the service is not answering',
      down: true,
      expected: ['not answering'],
      routes: undefined,
    },
    {
      name: 'auth.json is missing',
      withCredential: false,
      stub: {},
      expected: ['no editor credential'],
      routes: [],
    },
    {
      name: '--env names a variable this terminal does not set',
      args: ['--env', 'NOT_SET_IN_THIS_TERMINAL'],
      stub: {},
      expected: ['--env NOT_SET_IN_THIS_TERMINAL names a variable this terminal does not set'],
      // Resolved before the service is asked anything, so nothing is minted.
      routes: [],
    },
    {
      name: 'the credential route answers 401',
      stub: { credentialStatus: 401 },
      expected: [`rejected the editor credential at ${CREDENTIAL} with 401`, 'credential refused'],
      routes: askedForCredential,
    },
    {
      name: 'the credential route answers 403',
      stub: { credentialStatus: 403 },
      expected: [
        `rejected the editor credential at ${CREDENTIAL} with 403`,
        'outside the workspace folders VS Code announced to the service',
      ],
      routes: askedForCredential,
    },
    {
      name: 'the service does not implement the credential route',
      stub: {
        implemented: [PROTOCOL_ROUTES.health, PROTOCOL_ROUTES.launch, PROTOCOL_ROUTES.stop],
      },
      expected: [
        `the service answered 404 for ${CREDENTIAL}; no server-agent credential was minted`,
        'older or newer than this checkout',
      ],
      // Exactly one attempt at the credential route: no fallback, no probing.
      routes: askedForCredential,
      rejected: [404],
    },
    {
      name: 'a 2xx credential answer carries no token',
      stub: { credentialBody: { expiresAt: future } },
      expected: ['off-contract: it carries no non-empty string token'],
      routes: askedForCredential,
    },
    {
      name: 'a 2xx credential answer has a non-numeric expiresAt',
      stub: { credentialBody: { token: SERVER_AGENT_TOKEN, expiresAt: 'tomorrow' } },
      expected: ['off-contract: its expiresAt is not an epoch-millisecond number'],
      routes: askedForCredential,
    },
    {
      name: 'an error body echoes both credentials',
      stub: {
        credentialStatus: 500,
        credentialBody: {
          code: 'INTERNAL',
          message: `could not mint for Bearer ${EDITOR_TOKEN}; discarded ${SERVER_AGENT_TOKEN}`,
          token: SERVER_AGENT_TOKEN,
        },
      },
      expected: ['answered 500', 'could not mint for Bearer [redacted]; discarded [redacted]'],
      routes: askedForCredential,
    },
  ];

  for (const refusal of refusals) {
    spawns(`spawns nothing when ${refusal.name}`, async () => {
      const fixture = await createFixture({ withCredential: refusal.withCredential !== false });
      const dev = await createFakeDevServer(fixture);
      const started = refusal.down === true ? undefined : await startStubService(refusal.stub);
      service = started;
      const base = started === undefined ? await closedServiceAddress() : started.base;
      const { context, stdout, stderr } = contextFor(fixture, dev.env);

      const code = await main(
        [...(refusal.args ?? []), '--spawn-local', '--service', base],
        context,
      );

      expect(code).toBe(2);
      expect(dev.ran()).toBe(false);
      // No banner: it is printed only once the credential is in hand.
      expect(stdout.text()).toBe('');

      const errors = squash(stderr.text());
      expect(errors).toContain('Nothing was spawned');
      for (const fragment of refusal.expected) expect(errors).toContain(fragment);
      for (const secret of [SERVER_AGENT_TOKEN, EDITOR_TOKEN]) {
        expect(stderr.text()).not.toContain(secret);
      }

      if (started !== undefined) {
        expect(started.routes()).toEqual(refusal.routes);
        expect(started.rejections.map((entry) => entry.status)).toEqual(refusal.rejected ?? []);
      }
    });
  }

  it('documents the mode it implements: authenticated, service-dependent, released when the dev server exits, a supervised lease otherwise', () => {
    const text = usage();
    const options = text.slice(text.indexOf('\nOptions\n'));
    const start = options.indexOf('  --spawn-local');
    const paragraph = squash(options.slice(start, options.indexOf('  --env ', start)));

    // The claim and the behaviour asserted above have to stay the same claim.
    expect(paragraph).toContain(`through POST ${CREDENTIAL}`);
    expect(paragraph).toContain(
      `AUTHENTICATED: it needs the running service and ${AUTH_FILE_NAME}`,
    );
    expect(paragraph).toContain('when the credential cannot be obtained nothing is spawned');
    expect(paragraph).toContain(
      'The credential is a lease the service renews while the dev server runs and revokes when the dev server disconnects; otherwise it lapses within 5 minutes.',
    );

    const walkthrough = squash(
      text.slice(text.indexOf('What it does (--spawn-local)'), text.indexOf('\nOptions\n')),
    );
    expect(walkthrough).toContain(`POST {service}${CREDENTIAL} with { projectRoot }`);
    expect(walkthrough).toContain('expiresAt being the end of the first lease');
    expect(walkthrough).toContain(
      `This is an AUTHENTICATED run: it needs a running service and ${AUTH_FILE_NAME}`,
    );
    expect(walkthrough).toContain('its first lease ends (5 minutes after minting)');
    expect(walkthrough).toContain(
      "the service renews it while the dev server's preload keeps its server-agent control connection open",
    );
    expect(walkthrough).toContain(
      'revokes it when the dev server disconnects — 20 seconds after that connection is gone',
    );
    expect(walkthrough).toContain('and when the service shuts down');
    expect(walkthrough).toContain('A lease nothing renews lapses within 5 minutes');
    expect(walkthrough).toContain('debuggen.rotateServiceToken revokes it at once');
    expect(walkthrough).toContain('This command itself never renews it');
    // The release is documented as the behaviour asserted below: after the
    // child exits, after a signal, after a failed spawn, after a post-mint
    // failure; proved identity first; one request; a warning, not an exit code.
    expect(walkthrough).toContain(
      `has the service prove itself again as in step 3, then releases the credential: POST {service}${RELEASE} with { token }`,
    );
    expect(walkthrough).toContain(
      'after the dev server exits (Ctrl-C and SIGTERM included), after a spawn that failed, and after a failure between the mint and the spawn',
    );
    expect(walkthrough).toContain('{ released: false } when nothing was live under it any more');
    expect(walkthrough).toContain('The release is one request, never retried');
    expect(walkthrough).toContain('a warning that leaves the exit status alone');
    expect(walkthrough).not.toContain('it sends nothing further');
    expect(squash(SCRIPT_SOURCE)).not.toContain('it sends nothing further');
    expect(paragraph).toContain(
      `This command releases it through POST ${RELEASE} once the dev server has exited.`,
    );

    // The exit-code table agrees that every --spawn-local failure precedes the
    // spawn.
    const exitCodes = squash(text.slice(text.indexOf('Exit codes')));
    expect(exitCodes).toContain(
      'in --spawn-local every such failure happens before the spawn, and the message says nothing was spawned',
    );
    expect(exitCodes).toContain('The closing release of --spawn-local never changes the exit code');

    // The help text claims no unauthenticated mode.
    for (const unauthenticated of [
      'WITHOUT a credential',
      'stays inert',
      'runs offline',
      'it does not require one',
      'nor a running service',
      'a note rather than a failure',
    ]) {
      expect(squash(text)).not.toContain(unauthenticated);
    }
    // Neither the help text nor any comment in the script claims a long-lived
    // credential that nothing revokes.
    for (const unrevoked of [
      'no revoke route',
      'not revoked',
      'never revoked',
      'nothing revokes',
      '12 hours',
      'twelve hours',
    ]) {
      expect(squash(text), unrevoked).not.toContain(unrevoked);
      expect(squash(SCRIPT_SOURCE), unrevoked).not.toContain(unrevoked);
    }
  });
});

describe('releasing the server-agent credential', () => {
  /** The random parts of both credentials: what must never leak, even in part. */
  const secretParts = [
    EDITOR_TOKEN.slice('editor-credential-'.length),
    SERVER_AGENT_TOKEN.slice('server-agent-credential-'.length),
  ];

  /**
   * Assert that no credential, whole or by its random part, is in `text`.
   *
   * @param {string} text
   * @param {string} [label]
   * @returns {void}
   */
  const expectNoCredential = (text, label) => {
    for (const secret of [EDITOR_TOKEN, SERVER_AGENT_TOKEN, ...secretParts]) {
      expect(text, label).not.toContain(secret);
    }
  };

  /**
   * The fallback every release warning states, whitespace-collapsed.
   */
  const FALLBACK =
    "The service still revokes it without this command: 20 seconds after the dev server's preload disconnects, or at the end of its lease.";

  /**
   * A gate for the stub's release answer and the function that opens it.
   *
   * @returns {{ gate: Promise<unknown>, open: () => void }}
   */
  const releaseGate = () => {
    /** @type {(value: unknown) => void} */
    let resolveGate = () => undefined;
    const gate = new Promise((resolve) => {
      resolveGate = resolve;
    });
    return { gate, open: () => resolveGate(undefined) };
  };

  it('releases a minted credential with one editor-authorised request, and answers false once nothing is live', async () => {
    service = await startStubService();
    const projectRoot = path.join(os.tmpdir(), 'some-project');
    await requestServerAgentCredential({
      base: service.base,
      editorToken: EDITOR_TOKEN,
      projectRoot,
    });

    const request = { base: service.base, editorToken: EDITOR_TOKEN, token: SERVER_AGENT_TOKEN };
    await expect(releaseServerAgentCredential(request)).resolves.toBe(true);
    // Released already: the service finds nothing live under the token, and
    // says so with `false` — a success, not an error.
    await expect(releaseServerAgentCredential(request)).resolves.toBe(false);

    expect(service.routes()).toEqual([`POST ${CREDENTIAL}`, `POST ${RELEASE}`, `POST ${RELEASE}`]);
    for (const release of service.requests.slice(1)) {
      expect(release.authorization).toBe(`Bearer ${EDITOR_TOKEN}`);
      expect(release.body).toEqual({ token: SERVER_AGENT_TOKEN });
    }
    expect(service.rejections).toEqual([]);
  });

  it('sends nothing when it is given no credential to release', async () => {
    service = await startStubService();

    for (const token of ['', undefined]) {
      await expect(
        releaseServerAgentCredential({
          base: service.base,
          editorToken: EDITOR_TOKEN,
          token: /** @type {string} */ (token),
        }),
      ).rejects.toThrow(TypeError);
    }
    expect(service.routes()).toEqual([]);
  });

  it('turns every answer but a strict { released } into one failed request that names neither credential', async () => {
    // Every refusal reason echoes both credentials, as a careless or hostile
    // service might: only the redacted form may reach a message.
    const echo = `Bearer ${EDITOR_TOKEN} for ${SERVER_AGENT_TOKEN}`;
    const withoutRelease = [
      PROTOCOL_ROUTES.health,
      PROTOCOL_ROUTES.launch,
      PROTOCOL_ROUTES.stop,
      PROTOCOL_ROUTES.credential,
    ];
    /** @type {Array<[string, Parameters<typeof startStubService>[0], string[]]>} */
    const cases = [
      [
        '401',
        { releaseStatus: 401, releaseBody: { code: 'UNAUTHORIZED', message: echo } },
        [
          `the service rejected the editor credential at ${RELEASE} with 401`,
          `Bearer [redacted] for [redacted]`,
        ],
      ],
      [
        '403',
        { releaseStatus: 403, releaseBody: { code: 'FORBIDDEN', message: echo } },
        [`the service rejected the editor credential at ${RELEASE} with 403`],
      ],
      [
        '404, a service without the route',
        { implemented: withoutRelease },
        [`the service answered 404 for ${RELEASE}: it does not implement the release route`],
      ],
      [
        '405, a service with the route under another method',
        { implemented: [...withoutRelease, { ...PROTOCOL_ROUTES.release, method: 'GET' }] },
        [`the service answered 405 for ${RELEASE}`],
      ],
      [
        '500 CLEANUP_PARTIAL',
        {
          releaseStatus: 500,
          releaseBody: { code: 'CLEANUP_PARTIAL', message: `revocation pending: ${echo}` },
        },
        [
          'answered 500 Internal Server Error: revocation pending: Bearer [redacted] for [redacted]',
        ],
      ],
      ['502', { releaseStatus: 502 }, ['answered 502 Bad Gateway']],
      [
        'a 2xx without the flag',
        { releaseBody: { ok: true } },
        ['off-contract: it carries no boolean released'],
      ],
      [
        'a 2xx with a string flag',
        { releaseBody: { released: 'true' } },
        ['off-contract: it carries no boolean released'],
      ],
      [
        'a 2xx that echoes the credential beside the flag',
        { releaseBody: { released: true, token: SERVER_AGENT_TOKEN } },
        ['off-contract: it carries fields other than released'],
      ],
      [
        'a 2xx array',
        { releaseBody: [SERVER_AGENT_TOKEN] },
        ['off-contract: the body is not a JSON object'],
      ],
      ['a 2xx null', { releaseBody: null }, ['off-contract: the body is not a JSON object']],
    ];

    for (const [name, stub, fragments] of cases) {
      service = await startStubService(stub);

      const failure = await releaseServerAgentCredential({
        base: service.base,
        editorToken: EDITOR_TOKEN,
        token: SERVER_AGENT_TOKEN,
      }).then(
        () => undefined,
        (/** @type {unknown} */ error) => error,
      );

      expect(failure, name).toBeInstanceOf(DevInstrumentedError);
      const { message, hint } = /** @type {DevInstrumentedError} */ (failure);
      for (const fragment of fragments) expect(message, name).toContain(fragment);
      expectNoCredential(`${message}\n${hint ?? ''}`, name);
      // One request: no retry, no fallback path.
      expect(
        service.routes().filter((route) => route.endsWith(RELEASE)),
        name,
      ).toEqual([`POST ${RELEASE}`]);

      await service.close();
      service = undefined;
    }
  });

  const spawns = it.skipIf(process.platform === 'win32');

  spawns(
    'releases the credential after a dev server stopped by a forwarded Ctrl-C, keeping its exit status',
    async () => {
      service = await startStubService();
      const fixture = await createFixture();
      const dev = await createFakeDevServer(fixture, { waitForSignal: true, exitCode: 130 });
      const { context, stdout, stderr } = contextFor(fixture, dev.env);
      const started = service;

      const run = main(['--spawn-local', '--service', started.base], context);
      await waitFor(() => dev.ready(), 'the dev server to start');
      // Forwarded by the command to its child, which exits on it.
      process.emit('SIGINT');

      await expect(run).resolves.toBe(130);
      expect(started.routes()).toEqual([
        `GET ${HEALTH}`,
        `POST ${CREDENTIAL}`,
        `GET ${HEALTH}`,
        `POST ${RELEASE}`,
      ]);
      expect(started.requests[3]?.body).toEqual({ token: SERVER_AGENT_TOKEN });
      expect(started.requests[3]?.authorization).toBe(`Bearer ${EDITOR_TOKEN}`);
      expect(started.rejections).toEqual([]);
      expect(stderr.text()).toBe('');
      expect(stdout.text()).toContain(
        'dev-instrumented: released the server-agent credential; the service revoked it',
      );
      expectNoCredential(`${stdout.text()}${stderr.text()}`);
    },
  );

  spawns(
    'releases the credential when the dev server cannot be spawned, and still reports that failure',
    async () => {
      service = await startStubService();
      const fixture = await createFixture();
      // `pnpm` is found on PATH, but its interpreter does not exist: the exec
      // fails with ENOENT and the child never runs.
      const dev = await createFakeDevServer(fixture, {
        interpreter: path.join(fixture.base, 'no-such-interpreter'),
      });
      const { context, stdout, stderr } = contextFor(fixture, dev.env);

      const code = await main(['--spawn-local', '--service', service.base], context);

      expect(code).toBe(2);
      expect(dev.ran()).toBe(false);
      expect(squash(stderr.text())).toContain('could not run pnpm --filter target-app dev');
      expect(squash(stderr.text())).not.toContain('warning:');
      expect(service.routes()).toEqual([
        `GET ${HEALTH}`,
        `POST ${CREDENTIAL}`,
        `GET ${HEALTH}`,
        `POST ${RELEASE}`,
      ]);
      expect(service.requests[3]?.body).toEqual({ token: SERVER_AGENT_TOKEN });
      expect(stdout.text()).toContain('released the server-agent credential');
      expectNoCredential(`${stdout.text()}${stderr.text()}`);
    },
  );

  /**
   * Drive the one post-mint, pre-spawn failure no command line reaches:
   * `parseArgs` refuses a `DEBUGGEN_*` extra, but `resolveExtraEnv` passes one
   * through and `buildChildEnv` refuses it — after the credential was minted.
   *
   * @param {Parameters<typeof startStubService>[0]} stub
   */
  const failAfterMint = async (stub) => {
    service = await startStubService(stub);
    const fixture = await createFixture();
    const dev = await createFakeDevServer(fixture);
    const stdout = captureStream();
    const stderr = captureStream();

    const failure = await prepareLocalSpawn({
      root: fixture.root,
      project: await resolveProject({ root: fixture.root }),
      preload: await resolvePreload(fixture.root),
      base: service.base,
      env: { DEBUGGEN_HOME: fixture.home, PATH: dev.env.PATH },
      extraEnv: [{ name: 'DEBUGGEN_TOKEN', value: 'supplied-as-an-extra' }],
      stdout,
      stderr,
    }).then(
      () => undefined,
      (/** @type {unknown} */ error) => error,
    );

    expect(failure).toBeInstanceOf(DevInstrumentedError);
    const { message, hint } = /** @type {DevInstrumentedError} */ (failure);
    // The original failure is the one raised, still saying nothing was spawned.
    expect(message).toBe(`--env "DEBUGGEN_TOKEN" is in the product's own DEBUGGEN_ namespace`);
    expect(squash(hint ?? '')).toContain('Nothing was spawned');
    expect(dev.ran()).toBe(false);
    expectNoCredential(`${message}\n${hint ?? ''}\n${stdout.text()}\n${stderr.text()}`);
    return { stdout: stdout.text(), stderr: stderr.text(), started: service };
  };

  it('releases the credential when a step after the mint fails, and raises that failure', async () => {
    const { stdout, stderr, started } = await failAfterMint({});

    expect(started.routes()).toEqual([
      `GET ${HEALTH}`,
      `POST ${CREDENTIAL}`,
      `GET ${HEALTH}`,
      `POST ${RELEASE}`,
    ]);
    expect(started.requests[3]?.body).toEqual({ token: SERVER_AGENT_TOKEN });
    expect(stdout).toBe(
      'dev-instrumented: released the server-agent credential; the service revoked it\n',
    );
    expect(stderr).toBe('');
  });

  it('still raises the original failure when that release fails too', async () => {
    const { stdout, stderr, started } = await failAfterMint({ releaseStatus: 500 });

    expect(started.routes().filter((route) => route.endsWith(RELEASE))).toEqual([
      `POST ${RELEASE}`,
    ]);
    expect(stdout).toBe('');
    expect(squash(stderr)).toContain('warning: the server-agent credential was not released');
    expect(squash(stderr)).toContain(FALLBACK);
  });

  /**
   * @typedef {object} UnreleasedCase
   * @property {string} name what goes wrong, for the test title
   * @property {Parameters<typeof startStubService>[0]} stub
   * @property {string[]} expected fragments of the (whitespace-collapsed) warning
   * @property {string[]} routes what the stub must have been asked
   */

  const minted = [`GET ${HEALTH}`, `POST ${CREDENTIAL}`];

  /** @type {UnreleasedCase[]} */
  const unreleased = [
    {
      name: 'the service answers 500 CLEANUP_PARTIAL',
      stub: {
        releaseStatus: 500,
        releaseBody: {
          code: 'CLEANUP_PARTIAL',
          message: `revocation of ${SERVER_AGENT_TOKEN} still pending`,
        },
      },
      expected: [
        'warning: the server-agent credential was not released',
        'answered 500 Internal Server Error: revocation of [redacted] still pending',
      ],
      routes: [...minted, `GET ${HEALTH}`, `POST ${RELEASE}`],
    },
    {
      name: 'the service does not implement the release route',
      stub: {
        implemented: [
          PROTOCOL_ROUTES.health,
          PROTOCOL_ROUTES.launch,
          PROTOCOL_ROUTES.stop,
          PROTOCOL_ROUTES.credential,
        ],
      },
      expected: [
        'warning: the server-agent credential was not released',
        `the service answered 404 for ${RELEASE}`,
      ],
      routes: [...minted, `GET ${HEALTH}`, `POST ${RELEASE}`],
    },
    {
      name: 'the service answers off-contract',
      stub: { releaseBody: { released: 'yes' } },
      expected: [
        'warning: the server-agent credential was not released',
        'off-contract: it carries no boolean released',
      ],
      routes: [...minted, `GET ${HEALTH}`, `POST ${RELEASE}`],
    },
    {
      name: 'the service refuses the editor credential',
      stub: { releaseStatus: 401 },
      expected: [`rejected the editor credential at ${RELEASE} with 401`],
      routes: [...minted, `GET ${HEALTH}`, `POST ${RELEASE}`],
    },
    {
      // One proof, for the pre-flight: by the time the dev server exits the
      // port answers without one, as after another process took it over.
      name: 'the listener no longer proves it is the service',
      stub: { identityProbes: 1 },
      expected: [
        'warning: the release of the server-agent credential was skipped',
        'did not prove it is the Debug Generator service',
        'the editor credential was not sent',
      ],
      // The probe, and nothing that carries either credential after it.
      routes: [...minted, `GET ${HEALTH}`],
    },
  ];

  for (const entry of unreleased) {
    spawns(`warns once and keeps the child's exit status when ${entry.name}`, async () => {
      service = await startStubService(entry.stub);
      const fixture = await createFixture();
      const dev = await createFakeDevServer(fixture, { exitCode: 7 });
      const { context, stdout, stderr } = contextFor(fixture, dev.env);
      const started = service;

      const code = await main(['--spawn-local', '--service', started.base], context);

      expect(code).toBe(7);
      expect(dev.ran()).toBe(true);
      expect(started.routes()).toEqual(entry.routes);
      expect(started.requests[2]?.authorization).toBeUndefined();

      const warnings = squash(stderr.text());
      expect(warnings.match(/warning:/gu) ?? []).toHaveLength(1);
      for (const fragment of entry.expected) expect(warnings).toContain(fragment);
      expect(warnings).toContain(FALLBACK);
      expect(stdout.text()).not.toContain('released the server-agent credential');
      expectNoCredential(`${stdout.text()}${stderr.text()}`);
    });
  }

  spawns('treats { released: false } as a success', async () => {
    service = await startStubService({ releaseBody: { released: false } });
    const fixture = await createFixture();
    const dev = await createFakeDevServer(fixture, { exitCode: 7 });
    const { context, stdout, stderr } = contextFor(fixture, dev.env);

    const code = await main(['--spawn-local', '--service', service.base], context);

    expect(code).toBe(7);
    expect(stderr.text()).toBe('');
    expect(stdout.text()).toContain(
      'dev-instrumented: the server-agent credential was no longer live; there was nothing to release',
    );
  });

  spawns(
    'holds SIGINT and SIGTERM while the release is in flight, then lets them through',
    async () => {
      const { gate, open } = releaseGate();
      service = await startStubService({ releaseGate: gate });
      const fixture = await createFixture();
      const dev = await createFakeDevServer(fixture, { exitCode: 5 });
      const { context, stdout } = contextFor(fixture, dev.env);
      const started = service;
      const before = {
        SIGINT: process.listenerCount('SIGINT'),
        SIGTERM: process.listenerCount('SIGTERM'),
      };

      const run = main(['--spawn-local', '--service', started.base], context);
      try {
        await waitFor(
          () => started.requests.some((request) => request.path === RELEASE),
          'the release request',
        );
        // Held, not acted on: noted once, however many arrive.
        process.emit('SIGINT');
        process.emit('SIGINT');
      } finally {
        open();
      }

      await expect(run).resolves.toBe(5);
      expect(started.releaseSignalListeners).toEqual([
        { SIGINT: before.SIGINT + 1, SIGTERM: before.SIGTERM + 1 },
      ]);
      expect(process.listenerCount('SIGINT')).toBe(before.SIGINT);
      expect(process.listenerCount('SIGTERM')).toBe(before.SIGTERM);
      const notes = stdout
        .text()
        .split('\n')
        .filter((line) => line.includes('finishing the credential release first'));
      expect(notes).toEqual([
        'dev-instrumented: SIGINT received; finishing the credential release first (at most 7 s)',
      ]);
      expect(stdout.text()).toContain('released the server-agent credential');
    },
  );
});

describe('service reasons in messages', () => {
  /** The random part of the editor credential: what must never leak, even in part. */
  const editorSecret = EDITOR_TOKEN.slice('editor-credential-'.length);

  /**
   * Drive `--spawn-local` into a refused credential request and return the
   * reason its first stderr line carries after `answered 500 <phrase>: `.
   *
   * @param {Parameters<typeof startStubService>[0]} stub
   * @returns {Promise<{ reason: string, stderr: string }>}
   */
  const refusedReason = async (stub) => {
    service = await startStubService({ credentialStatus: 500, ...stub });
    const fixture = await createFixture();
    const dev = await createFakeDevServer(fixture);
    const { context, stderr } = contextFor(fixture, dev.env);

    const code = await main(['--spawn-local', '--service', service.base], context);

    expect(code).toBe(2);
    expect(dev.ran()).toBe(false);
    const [first = ''] = stderr.text().split('\n');
    const marker = 'answered 500 Internal Server Error: ';
    expect(first).toContain(marker);
    return { reason: first.slice(first.indexOf(marker) + marker.length), stderr: stderr.text() };
  };

  const spawns = it.skipIf(process.platform === 'win32');

  spawns(
    'reduces a long multi-line JSON message to one line of at most 200 characters',
    async () => {
      // The editor credential straddles the 200-character cut: bounding before
      // redacting would print the first half of its random part.
      const message = [
        'line one',
        '\tline two\r',
        `${'y'.repeat(150)}${EDITOR_TOKEN} tail ${'z'.repeat(300)}`,
      ].join('\n');

      const { reason, stderr } = await refusedReason({
        credentialBody: { code: 'INTERNAL', message },
      });

      expect(reason.endsWith('…')).toBe(true);
      expect(reason.length).toBeLessThanOrEqual(201);
      expect(reason.startsWith('line one line two yyy')).toBe(true);
      expect(reason).toContain('[redacted]');
      expect(reason).not.toMatch(/[\t\r\n]/u);
      expect(stderr).not.toContain(editorSecret.slice(0, 8));
    },
  );

  spawns('bounds the nested error.message and a raw text body the same way', async () => {
    const nested = await refusedReason({
      credentialBody: { error: { message: `nested\n\n${'n'.repeat(400)}` } },
    });
    expect(nested.reason).toBe(`nested ${'n'.repeat(193)}…`);

    const raw = await refusedReason({
      credentialText: `<html>\n\u001b[31m${'r'.repeat(400)}\u009b2J\u202e</html>`,
    });
    expect(raw.reason.endsWith('…')).toBe(true);
    expect(raw.reason.length).toBeLessThanOrEqual(201);
    expect(raw.reason.startsWith('<html> [31m')).toBe(true);
    // No control or bidirectional-format character reaches the terminal.
    for (const character of ['\u001b', '\u009b', '\u202e']) {
      expect(raw.stderr).not.toContain(character);
    }
  });
});

describe('response and project text that reaches the terminal', () => {
  /**
   * Start a loopback server whose answer to each request is decided by the
   * test, for the response shapes the contract stub does not produce: a
   * hostile reason phrase and a body cut off after its headers.
   *
   * @param {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, path: string) => void} answer
   * @returns {Promise<{ base: string, routes: string[], close: () => Promise<void> }>}
   */
  async function startScriptedServer(answer) {
    /** @type {string[]} */
    const routes = [];
    const server = http.createServer((req, res) => {
      const requestPath = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
      routes.push(`${req.method ?? 'GET'} ${requestPath}`);
      req.resume();
      req.on('end', () => answer(req, res, requestPath));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    return {
      base: `http://127.0.0.1:${port}`,
      routes,
      close: () =>
        new Promise((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve(undefined));
        }),
    };
  }

  /** A reason phrase that echoes both credentials, as a hostile listener might. */
  const HOSTILE_PHRASE = `denied Bearer ${EDITOR_TOKEN} after minting ${SERVER_AGENT_TOKEN}`;

  it('redacts both credentials from the status phrase of a refused credential, launch, stop or release', async () => {
    const scripted = await startScriptedServer((_req, res) => {
      res.writeHead(500, HOSTILE_PHRASE, { 'content-type': 'application/json' });
      // The body names the minted token, which is how this command learns it.
      res.end(JSON.stringify({ code: 'INTERNAL', message: 'refused', token: SERVER_AGENT_TOKEN }));
    });
    const projectRoot = path.join(os.tmpdir(), 'some-project');

    try {
      /** @type {string[]} */
      const messages = [];
      for (const call of [requestServerAgentCredential, launchDevServer, stopDevServer]) {
        const failure = await call({ base: scripted.base, editorToken: EDITOR_TOKEN, projectRoot })
          .then(() => undefined)
          .catch((/** @type {unknown} */ error) => error);
        expect(failure, call.name).toBeInstanceOf(Error);
        messages.push(/** @type {Error} */ (failure).message);
      }

      const [credential = '', launch = '', stop = ''] = messages;
      for (const message of messages) {
        expect(message).toContain('answered 500 denied Bearer [redacted]');
        expect(message).not.toContain(EDITOR_TOKEN);
      }
      // The credential route's own answer names the minted token, so that one
      // is redacted from its message too.
      expect(credential).toContain('after minting [redacted]');
      expect(credential).not.toContain(SERVER_AGENT_TOKEN);
      expect(launch).toContain(': refused');
      expect(stop).toContain(': refused');

      // The release names the server-agent credential in its own body, so
      // both credentials are redacted from its phrase and its reason.
      const release = await releaseServerAgentCredential({
        base: scripted.base,
        editorToken: EDITOR_TOKEN,
        token: SERVER_AGENT_TOKEN,
      }).then(
        () => undefined,
        (/** @type {unknown} */ error) => error,
      );
      expect(release).toBeInstanceOf(DevInstrumentedError);
      const releaseMessage = /** @type {DevInstrumentedError} */ (release).message;
      expect(releaseMessage).toContain(
        'answered 500 denied Bearer [redacted] after minting [redacted]: refused',
      );
      expect(releaseMessage).not.toContain(EDITOR_TOKEN);
      expect(releaseMessage).not.toContain(SERVER_AGENT_TOKEN);
    } finally {
      await scripted.close();
    }
  });

  const spawns = it.skipIf(process.platform === 'win32');

  spawns(
    'reports a credential answer cut off mid-body as a pre-spawn failure, not a stack',
    async () => {
      const scripted = await startScriptedServer((req, res, requestPath) => {
        if (requestPath === HEALTH) {
          res.writeHead(200, { 'content-type': 'application/json', ...identityAnswer(req) });
          res.end('{"status":"ok"}');
          return;
        }
        // Headers promise a body that never finishes arriving.
        res.writeHead(200, { 'content-type': 'application/json', 'content-length': '200' });
        res.write('{"token":"');
        setTimeout(() => res.socket?.destroy(), 20);
      });
      const fixture = await createFixture();
      const dev = await createFakeDevServer(fixture);
      const { context, stdout, stderr } = contextFor(fixture, dev.env);

      try {
        const code = await main(['--spawn-local', '--service', scripted.base], context);

        expect(code).toBe(2);
        expect(dev.ran()).toBe(false);
        expect(stdout.text()).toBe('');
        expect(scripted.routes).toEqual([`GET ${HEALTH}`, `POST ${CREDENTIAL}`]);

        const errors = squash(stderr.text());
        expect(errors).toContain(`request to ${scripted.base}${CREDENTIAL} failed while reading`);
        expect(errors).toContain('Nothing was spawned');
        expect(errors).not.toContain('unexpected failure');
        expect(stderr.text()).not.toContain(EDITOR_TOKEN);
      } finally {
        await scripted.close();
      }
    },
  );

  /** One mebibyte: far past the cap, and what an oversized answer carries here. */
  const ONE_MIB = 1024 * 1024;

  /**
   * A credential answer the caller would accept, preceded by `padding` bytes of
   * JSON whitespace: a caller that read the whole body would parse it and go
   * on, so refusing it is the cap's doing and nothing else's.
   *
   * @param {number} padding
   * @returns {Buffer}
   */
  const paddedCredentialAnswer = (padding) =>
    Buffer.concat([
      Buffer.alloc(padding, 0x20),
      Buffer.from(
        JSON.stringify({
          token: SERVER_AGENT_TOKEN,
          expiresAt: Date.now() + CREDENTIAL_LIFETIME_MS,
        }),
        'utf8',
      ),
    ]);

  /**
   * Stream a body without a `Content-Length` (chunked), 16 KiB at a time and
   * honouring backpressure, until `total` bytes are sent — or, with no
   * `total`, until the client goes away.
   *
   * @param {import('node:http').ServerResponse} res
   * @param {Buffer | undefined} total the whole body, or `undefined` for an
   *   endless one
   * @returns {void}
   */
  const streamChunked = (res, total) => {
    res.on('error', () => undefined);
    res.writeHead(200, { 'content-type': 'application/json' });
    const chunkSize = 16 * 1024;
    let offset = 0;
    const pump = () => {
      if (res.destroyed || res.writableEnded) return;
      if (total !== undefined && offset >= total.length) {
        res.end();
        return;
      }
      const chunk =
        total === undefined
          ? Buffer.alloc(chunkSize, 0x20)
          : total.subarray(offset, offset + chunkSize);
      offset += chunk.length;
      if (res.write(chunk)) setImmediate(pump);
      else res.once('drain', pump);
    };
    pump();
  };

  it('caps every answer at 64 KiB', () => {
    expect(RESPONSE_MAX_BYTES).toBe(64 * 1024);
  });

  spawns(
    'refuses a credential answer that streams 1 MiB without a Content-Length, spawning nothing',
    async () => {
      const scripted = await startScriptedServer((req, res, requestPath) => {
        if (requestPath === HEALTH) {
          res.writeHead(200, { 'content-type': 'application/json', ...identityAnswer(req) });
          res.end('{"status":"ok"}');
          return;
        }
        streamChunked(res, paddedCredentialAnswer(ONE_MIB));
      });
      const fixture = await createFixture();
      const dev = await createFakeDevServer(fixture);
      const { context, stdout, stderr } = contextFor(fixture, dev.env);

      try {
        const code = await main(['--spawn-local', '--service', scripted.base], context);

        expect(code).toBe(2);
        expect(dev.ran()).toBe(false);
        expect(stdout.text()).toBe('');
        expect(scripted.routes).toEqual([`GET ${HEALTH}`, `POST ${CREDENTIAL}`]);
        const errors = squash(stderr.text());
        expect(errors).toContain(
          `${scripted.base}${CREDENTIAL} answered more than 64 KiB (status 200); the reply was discarded unread`,
        );
        expect(errors).toContain('It was neither parsed nor shown');
        expect(errors).toContain('the service revokes it at the end of its first lease');
        expect(errors).toContain('Nothing was spawned');
        expect(errors).not.toContain('unexpected failure');
        expect(stderr.text()).not.toContain(SERVER_AGENT_TOKEN);
        expect(stderr.text()).not.toContain(EDITOR_TOKEN);
      } finally {
        await scripted.close();
      }
    },
  );

  it('cancels an endless answer as soon as it passes the cap, instead of waiting it out', async () => {
    const scripted = await startScriptedServer((_req, res) => streamChunked(res, undefined));

    try {
      const started = Date.now();
      const failure = await requestServerAgentCredential({
        base: scripted.base,
        editorToken: EDITOR_TOKEN,
        projectRoot: path.join(os.tmpdir(), 'some-project'),
      }).then(
        () => undefined,
        (/** @type {unknown} */ error) => error,
      );

      // Read to the end, the body would have run into the 5 s request timeout
      // ("no answer within"); the cap stops the read long before that.
      expect(failure).toBeInstanceOf(Error);
      expect(/** @type {Error} */ (failure).message).toContain(
        'answered more than 64 KiB (status 200); the reply was discarded unread',
      );
      expect(Date.now() - started).toBeLessThan(4_000);
    } finally {
      await scripted.close();
    }
  });

  it('refuses a launch answer whose Content-Length is over the cap, before reading it', async () => {
    const scripted = await startScriptedServer((req, res, requestPath) => {
      if (requestPath === HEALTH) {
        res.writeHead(200, { 'content-type': 'application/json', ...identityAnswer(req) });
        res.end('{"status":"ok"}');
        return;
      }
      // Declares 1 MiB, sends a complete launch answer, then holds the rest
      // back: a caller that started reading would wait for bytes that never
      // come and fail on its timeout instead.
      res.on('error', () => undefined);
      res.writeHead(200, {
        'content-type': 'application/json',
        'content-length': String(ONE_MIB),
      });
      res.write(JSON.stringify(LAUNCHED));
    });
    const fixture = await createFixture();
    const { context, stdout, stderr } = contextFor(fixture);

    try {
      const started = Date.now();
      const code = await main(['--service', scripted.base, '--detach'], context);

      expect(code).toBe(2);
      expect(Date.now() - started).toBeLessThan(4_000);
      // No launch report: the answer that would have named the dev server was
      // never read.
      expect(stdout.text()).toBe('');
      expect(scripted.routes).toEqual([`GET ${HEALTH}`, `POST ${LAUNCH}`]);
      const errors = squash(stderr.text());
      expect(errors).toContain(
        `${scripted.base}${LAUNCH} answered more than 64 KiB (status 200); the reply was discarded unread`,
      );
      expect(errors).toContain('The service may have started a dev server before it answered');
      expect(errors).toContain('--stop --project');
      expect(errors).not.toContain(LAUNCHED.devServerUrl);
    } finally {
      await scripted.close();
    }
  });

  it('parses an answer of exactly 64 KiB and refuses one byte more, declared or streamed', async () => {
    const credentialLength = paddedCredentialAnswer(0).length;
    const atCap = paddedCredentialAnswer(RESPONSE_MAX_BYTES - credentialLength);
    const overCap = paddedCredentialAnswer(RESPONSE_MAX_BYTES - credentialLength + 1);
    expect(atCap.length).toBe(RESPONSE_MAX_BYTES);
    expect(overCap.length).toBe(RESPONSE_MAX_BYTES + 1);

    /** @type {Array<[string, Buffer, boolean]>} */
    const cases = [
      ['declared', atCap, false],
      ['declared', overCap, false],
      ['streamed', atCap, true],
      ['streamed', overCap, true],
    ];
    for (const [how, body, chunked] of cases) {
      const scripted = await startScriptedServer((_req, res) => {
        if (chunked) {
          streamChunked(res, body);
          return;
        }
        res.writeHead(200, {
          'content-type': 'application/json',
          'content-length': String(body.length),
        });
        res.end(body);
      });
      try {
        const outcome = await requestServerAgentCredential({
          base: scripted.base,
          editorToken: EDITOR_TOKEN,
          projectRoot: path.join(os.tmpdir(), 'some-project'),
        }).then(
          (credential) => credential,
          (/** @type {unknown} */ error) => error,
        );

        const label = `${how} ${String(body.length)} bytes`;
        if (body.length <= RESPONSE_MAX_BYTES) {
          expect(outcome, label).toMatchObject({ token: SERVER_AGENT_TOKEN });
        } else {
          expect(outcome, label).toBeInstanceOf(Error);
          expect(/** @type {Error} */ (outcome).message, label).toContain('more than 64 KiB');
        }
      } finally {
        await scripted.close();
      }
    }
  });

  it('shows bidirectional and other invisible characters of a package name as escapes', async () => {
    const fixture = await createFixture();
    const dev = await createFakeDevServer(fixture);
    const spoofing = 'app\u202egnp.exe';

    // An invalid in-repository name: refused before it reaches `pnpm --filter`,
    // and quoted with the override made visible.
    let refusal = '';
    try {
      buildLaunchCommand({
        project: { dir: fixture.projectDir, label: 'x', packageName: spoofing, inRepo: true },
        root: fixture.root,
        env: { PATH: dev.env.PATH },
        platform: 'linux',
      });
    } catch (error) {
      refusal = error instanceof Error ? error.message : String(error);
    }
    expect(refusal).toContain('app\\u202egnp.exe');
    expect(refusal).not.toContain('\u202e');

    // A project elsewhere is never put on a command line, but its name still
    // labels the banner and every message: escaped there too.
    const elsewhere = path.join(fixture.base, 'elsewhere');
    await fs.promises.mkdir(elsewhere, { recursive: true });
    await fs.promises.writeFile(
      path.join(elsewhere, 'package.json'),
      JSON.stringify({ name: `shop\u2066\u200b${spoofing}`, scripts: { dev: 'next dev' } }),
      'utf8',
    );
    const resolved = await resolveProject({ root: fixture.root, project: elsewhere });
    expect(resolved.label).toContain('shop\\u2066\\u200bapp\\u202egnp.exe');
    expect(resolved.label).not.toMatch(/[\u202e\u2066\u200b]/u);
    // The raw name is kept for the one place that validates it first.
    expect(resolved.packageName).toBe(`shop\u2066\u200b${spoofing}`);

    await fs.promises.writeFile(
      path.join(elsewhere, 'package.json'),
      JSON.stringify({ name: spoofing, scripts: {} }),
      'utf8',
    );
    const missingDev = await resolveProject({ root: fixture.root, project: elsewhere })
      .then(() => '')
      .catch((/** @type {unknown} */ error) => (error instanceof Error ? error.message : ''));
    expect(missingDev).toContain('app\\u202egnp.exe has no "dev" script');
    expect(missingDev).not.toContain('\u202e');
  });
});

/**
 * The metacharacters that, reaching cmd.exe's parser unescaped and outside a
 * quoted run, would chain, pipe, redirect or open a block.
 */
const CMD_OPERATORS = '&|<>()';

/**
 * @typedef {object} CmdPass
 * @property {string} text the line as cmd.exe hands it on
 * @property {boolean[]} literal per character of `text`, whether it was
 *   escaped (and so cannot delimit a token)
 * @property {string[]} operators every operator that reached the parser live
 * @property {number} quotes how many unescaped `"` toggled the quoted run
 */

/**
 * One parse of a line by cmd.exe's escape-and-quote phase, the part of its
 * parser that decides what `&`, `|`, `<`, `>`, `(` and `)` mean: outside a
 * quoted run a `^` is removed and the next character is taken literally, and a
 * `"` toggles the quoted run; inside one only `"` is special. Test-local by
 * design — a model of the interpreter this suite cannot run on a POSIX host,
 * written from cmd.exe's documented behaviour rather than from the escaping
 * under test.
 *
 * @param {string} line
 * @returns {CmdPass}
 */
function cmdEscapePass(line) {
  let text = '';
  /** @type {boolean[]} */
  const literal = [];
  /** @type {string[]} */
  const operators = [];
  let quoted = false;
  let quotes = 0;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index] ?? '';
    if (quoted) {
      if (character === '"') quoted = false;
      text += character;
      literal.push(true);
      continue;
    }
    if (character === '^') {
      index += 1;
      if (index < line.length) {
        text += line[index] ?? '';
        literal.push(true);
      }
      continue;
    }
    if (character === '"') {
      quoted = true;
      quotes += 1;
    } else if (CMD_OPERATORS.includes(character)) {
      operators.push(character);
    }
    text += character;
    literal.push(false);
  }
  return { text, literal, operators, quotes };
}

/**
 * Split a command line into argv the way the MSVCRT startup code
 * (`CommandLineToArgvW`) does: spaces and tabs separate arguments outside
 * quotes; `2n` backslashes before `"` are `n` backslashes and a quote toggle,
 * `2n + 1` are `n` backslashes and a literal `"`; other backslashes are
 * literal; `""` inside quotes is a literal `"`.
 *
 * @param {string} line
 * @returns {string[]}
 */
function parseMsvcrtArgv(line) {
  /** @type {string[]} */
  const argv = [];
  let current = '';
  let started = false;
  let quoted = false;
  let index = 0;
  while (index < line.length) {
    const character = line[index] ?? '';
    if (character === '\\') {
      let backslashes = 0;
      while (line[index] === '\\') {
        backslashes += 1;
        index += 1;
      }
      if (line[index] === '"') {
        current += '\\'.repeat(Math.floor(backslashes / 2));
        if (backslashes % 2 === 1) {
          current += '"';
          index += 1;
        }
      } else {
        current += '\\'.repeat(backslashes);
      }
      started = true;
      continue;
    }
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        current += '"';
        index += 2;
      } else {
        quoted = !quoted;
        index += 1;
      }
      started = true;
      continue;
    }
    if ((character === ' ' || character === '\t') && !quoted) {
      if (started) argv.push(current);
      current = '';
      started = false;
      index += 1;
      continue;
    }
    current += character;
    started = true;
    index += 1;
  }
  if (started) argv.push(current);
  return argv;
}

/**
 * Replay what Windows does with a wrapped `.cmd` launch: cmd.exe strips the
 * outer quotes (`/s`) and parses the line once, which yields the command token
 * and the batch file's arguments; the batch file hands those on as `%*`, which
 * cmd.exe parses a second time; the program then splits them MSVCRT-style.
 *
 * @param {string} line the fourth argument `wrapForPlatform` produced
 * @returns {{ file: string, argv: string[], passes: CmdPass[], percentPairs: string[] }}
 */
function replayCmdLaunch(line) {
  expect(line.startsWith('"') && line.endsWith('"'), 'the /s form wraps the line in quotes').toBe(
    true,
  );
  const inner = line.slice(1, -1);
  // cmd.exe expands %NAME% before it looks at carets; a caret inside the pair
  // makes the name one no variable has, so it is left alone.
  const percentPairs = [...inner.matchAll(/%[^%^]*%/gu)].map((match) => match[0]);

  const first = cmdEscapePass(inner);
  const separator = first.literal.findIndex(
    (isLiteral, index) => !isLiteral && first.text[index] === ' ',
  );
  const file = separator === -1 ? first.text : first.text.slice(0, separator);
  const rest = separator === -1 ? '' : first.text.slice(separator + 1);

  const second = cmdEscapePass(rest);
  return { file, argv: parseMsvcrtArgv(second.text), passes: [first, second], percentPairs };
}

describe('Windows command lines and package names', () => {
  /** Arguments carrying every cmd.exe and MSVCRT special case at once. */
  const adversarialArguments = [
    '--filter',
    '@scope/app',
    'dev',
    'x&calc',
    'a|b',
    'a>b',
    'a<b',
    '"a"',
    'a b',
    '%PATH%',
    '%%',
    '^a',
    '(a)',
    '!a!',
    ';a,b',
    '`a`',
    '*?[]',
    'tab\tseparated',
    'back\\slash',
    'trailing\\',
    'trailing\\\\',
    'quote\\"inside',
    '\\\\"',
    // A quote cmd.exe would read as closing a quoted run, followed by an
    // operator: with only one caret layer, the batch file's re-parse of `%*`
    // runs whatever follows the `&`.
    'x"&calc',
    'y\\"|more',
    '',
  ];

  it('wraps a .cmd launcher so cmd.exe and the program read back exactly the original argv', () => {
    const file = 'C:\\Program Files (x86)\\A&B\\pnpm.cmd';
    const comSpec = 'C:\\Windows\\System32\\cmd.exe';

    const wrapped = wrapForPlatform(
      {
        file,
        args: adversarialArguments,
        cwd: 'C:\\repo',
        display: 'pnpm --filter @scope/app dev',
      },
      { platform: 'win32', comSpec },
    );

    expect(wrapped.file).toBe(comSpec);
    expect(wrapped.windowsVerbatimArguments).toBe(true);
    expect(wrapped.args.slice(0, 3)).toEqual(['/d', '/s', '/c']);
    expect(wrapped.args).toHaveLength(4);
    expect(wrapped.cwd).toBe('C:\\repo');
    expect(wrapped.display).toBe('pnpm --filter @scope/app dev');

    const replay = replayCmdLaunch(wrapped.args[3] ?? '');
    expect(replay.file).toBe(file);
    expect(replay.argv).toEqual(adversarialArguments);
    // No pass ever saw a live operator or toggled a quoted run, and no
    // %NAME% pair could have expanded.
    for (const pass of replay.passes) {
      expect(pass.operators).toEqual([]);
      expect(pass.quotes).toBe(0);
    }
    expect(replay.percentPairs).toEqual([]);
  });

  it('wraps a .bat launcher and a plain path the same way', () => {
    for (const file of ['C:\\Users\\dev\\AppData\\Roaming\\npm\\pnpm.CMD', 'D:\\tools\\npm.bat']) {
      const wrapped = wrapForPlatform(
        { file, args: ['run', 'dev'], cwd: 'D:\\app', display: 'npm run dev' },
        { platform: 'win32' },
      );
      expect(wrapped.file).toBe('cmd.exe');
      const replay = replayCmdLaunch(wrapped.args[3] ?? '');
      expect(replay.file).toBe(file);
      expect(replay.argv).toEqual(['run', 'dev']);
    }
  });

  it('escapes the command token once and each batch argument twice', () => {
    expect(escapeCmdCommand('C:\\Program Files (x86)\\A&B\\pnpm.cmd')).toBe(
      'C:\\Program^ Files^ ^(x86^)\\A^&B\\pnpm.cmd',
    );
    expect(escapeCmdArgument('a&b')).toBe('^"a^&b^"');
    expect(escapeCmdArgument('a&b', { doubleEscape: true })).toBe('^^^"a^^^&b^^^"');
    expect(escapeCmdArgument('trailing\\')).toBe('^"trailing\\\\^"');
    expect(escapeCmdArgument('say "hi"')).toBe('^"say^ \\^"hi\\^"^"');
  });

  it('refuses a line break or NUL, which no escaping carries through cmd.exe', () => {
    for (const argument of ['a\nb', 'a\rb', 'a\0b']) {
      expect(() =>
        wrapForPlatform(
          { file: 'C:\\npm\\pnpm.cmd', args: ['--filter', argument], cwd: 'C:\\', display: 'pnpm' },
          { platform: 'win32' },
        ),
      ).toThrow(/line break or a NUL/u);
    }
  });

  it('returns any other executable, and every other platform, unchanged', () => {
    const exe = { file: 'C:\\nodejs\\node.exe', args: ['a&b'], cwd: 'C:\\', display: 'node' };
    expect(wrapForPlatform(exe, { platform: 'win32' })).toBe(exe);

    const shim = { file: 'C:\\npm\\pnpm.cmd', args: ['a&b'], cwd: 'C:\\', display: 'pnpm' };
    for (const platform of /** @type {NodeJS.Platform[]} */ (['linux', 'darwin', 'freebsd'])) {
      expect(wrapForPlatform(shim, { platform })).toBe(shim);
    }
  });

  it('builds a wrapped Windows launch end to end from PATHEXT and ComSpec', async () => {
    const fixture = await createFixture();
    const binDir = path.join(fixture.base, `win-bin-${randomUUID()}`);
    await fs.promises.mkdir(binDir, { recursive: true });
    const shim = path.join(binDir, 'pnpm.CMD');
    await fs.promises.writeFile(shim, '@echo off\r\n', 'utf8');
    await fs.promises.chmod(shim, 0o755);

    const command = buildLaunchCommand({
      project: {
        dir: fixture.projectDir,
        label: 'apps/demo-app (@scope/app)',
        packageName: '@scope/app',
        inRepo: true,
      },
      root: fixture.root,
      env: { PATH: binDir, PATHEXT: '.EXE;.CMD', COMSPEC: 'C:\\Windows\\System32\\cmd.exe' },
      platform: 'win32',
    });

    expect(command.file).toBe('C:\\Windows\\System32\\cmd.exe');
    expect(command.windowsVerbatimArguments).toBe(true);
    expect(command.cwd).toBe(fixture.root);
    const replay = replayCmdLaunch(command.args[3] ?? '');
    expect(replay.file).toBe(shim);
    expect(replay.argv).toEqual(['--filter', '@scope/app', 'dev']);
  });

  it('accepts valid npm package names for pnpm --filter', async () => {
    const fixture = await createFixture();
    const dev = await createFakeDevServer(fixture);

    for (const name of ['target-app', '@debuggen/demo-app', 'socket.io', 'a_b', 'x'.repeat(214)]) {
      const command = buildLaunchCommand({
        project: { dir: fixture.projectDir, label: name, packageName: name, inRepo: true },
        root: fixture.root,
        env: { PATH: dev.binDir },
        platform: 'linux',
      });
      expect(command.args).toEqual(['--filter', name, 'dev']);
    }
  });

  it('rejects every package name that is not a valid npm name, before anything runs', async () => {
    const fixture = await createFixture();
    const dev = await createFakeDevServer(fixture);

    for (const name of [
      'x&calc',
      'a|b',
      'a>b',
      'a<b',
      '"a"',
      'a b',
      '%PATH%',
      '^a',
      '(a)',
      '!a',
      'a;b',
      'a,b',
      '@scope/a&b',
      '@sc*pe/a',
      'Upper',
      '.hidden',
      '_private',
      'a...',
      'x'.repeat(215),
      '\u001b[31mred',
    ]) {
      expect(
        () =>
          buildLaunchCommand({
            project: { dir: fixture.projectDir, label: 'x', packageName: name, inRepo: true },
            root: fixture.root,
            env: { PATH: dev.binDir },
            platform: 'linux',
          }),
        name,
      ).toThrow(/^the package name .+ in apps\/demo-app\/package\.json /u);
    }
    expect(dev.ran()).toBe(false);

    // The name is quoted, control characters escaped, so a hostile one cannot
    // write to the terminal.
    expect(() =>
      buildLaunchCommand({
        project: {
          dir: fixture.projectDir,
          label: 'x',
          packageName: '\u001b[31mred',
          inRepo: true,
        },
        root: fixture.root,
        env: { PATH: dev.binDir },
        platform: 'linux',
      }),
    ).toThrow('"\\u001b[31mred"');
  });

  const spawns = it.skipIf(process.platform === 'win32');

  spawns('refuses such a name through the CLI and asks the service for nothing', async () => {
    service = await startStubService();
    const fixture = await createFixture({ packageName: 'x&calc' });
    const dev = await createFakeDevServer(fixture);
    const { context, stdout, stderr } = contextFor(fixture, dev.env);

    const code = await main(['--spawn-local', '--service', service.base], context);

    expect(code).toBe(2);
    expect(dev.ran()).toBe(false);
    expect(stdout.text()).toBe('');
    const errors = squash(stderr.text());
    expect(errors).toContain('the package name "x&calc" in apps/demo-app/package.json');
    expect(errors).toContain('is not a valid npm package name');
    expect(errors).toContain('Nothing was spawned');
    // Validated before the credential request, so none was minted for a run
    // that could not start.
    expect(service.routes()).toEqual([]);
  });
});

describe('the command as a process', () => {
  /**
   * Copy the script into a fixture tree and run it there, so the entry point
   * itself is exercised with the fixture as its repository root. The script
   * imports nothing but `node:` builtins, which is what makes the copy a
   * faithful instance of it.
   *
   * @param {Fixture} fixture
   * @returns {Promise<string>} absolute path of the copied script
   */
  const installScript = async (fixture) => {
    const directory = path.join(fixture.root, 'scripts');
    await fs.promises.mkdir(directory, { recursive: true });
    const target = path.join(directory, 'dev-instrumented.mjs');
    await fs.promises.writeFile(target, SCRIPT_SOURCE, 'utf8');
    return target;
  };

  it('stays in the foreground until a signal arrives, then stops the dev server', async () => {
    service = await startStubService();
    const fixture = await createFixture();
    const script = await installScript(fixture);
    const started = service;

    const child = spawn(process.execPath, [script, '--service', started.base], {
      env: { PATH: process.env.PATH ?? '', DEBUGGEN_HOME: fixture.home },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => (output += String(chunk)));
    child.stderr.on('data', (chunk) => (output += String(chunk)));

    const exited = new Promise((resolve) => {
      child.once('exit', (code, signal) => resolve({ code, signal }));
    });

    await waitFor(
      () => started.requests.some((request) => request.path === LAUNCH),
      'the launch request from the child process',
    );
    // The foreground command must stay alive until a shutdown signal arrives.
    // Node's signal watchers do not hold the event loop open, so the wait keeps
    // its own timer; the process must therefore still be running a quarter
    // second after the launch was reported, with no stop request sent.
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(child.exitCode).toBeNull();
    expect(started.requests.some((request) => request.path === STOP)).toBe(false);

    child.kill('SIGINT');
    const result = await exited;

    expect(result).toEqual({ code: 0, signal: null });
    expect(started.routes()).toEqual([
      `GET ${HEALTH}`,
      `POST ${LAUNCH}`,
      `GET ${HEALTH}`,
      `POST ${STOP}`,
    ]);
    expect(started.rejections).toEqual([]);
    expect(output).toContain('stopped the dev server');
    expect(output).not.toContain(EDITOR_TOKEN);
  });

  const spawns = it.skipIf(process.platform === 'win32');

  spawns(
    'finishes the credential release when a real SIGINT arrives while it is in flight',
    async () => {
      /** @type {(value: unknown) => void} */
      let openGate = () => undefined;
      const gate = new Promise((resolve) => {
        openGate = resolve;
      });
      service = await startStubService({ releaseGate: gate });
      const fixture = await createFixture();
      const dev = await createFakeDevServer(fixture, { exitCode: 3 });
      const script = await installScript(fixture);
      const started = service;

      const child = spawn(process.execPath, [script, '--spawn-local', '--service', started.base], {
        env: { PATH: dev.env.PATH, DEBUGGEN_HOME: fixture.home },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      child.stdout.on('data', (chunk) => (output += String(chunk)));
      child.stderr.on('data', (chunk) => (output += String(chunk)));
      const exited = new Promise((resolve) => {
        child.once('exit', (code, signal) => resolve({ code, signal }));
      });

      try {
        await waitFor(
          () => started.requests.some((request) => request.path === RELEASE),
          'the release request from the child process',
        );
        // Without the hold, SIGINT's default action would end the process
        // here, between sending the release and hearing its answer.
        child.kill('SIGINT');
        await waitFor(
          () => output.includes('SIGINT received; finishing the credential release first'),
          'the held signal to be noted',
        );
      } finally {
        openGate(undefined);
      }
      const result = await exited;

      // The dev server's own status, not a signal death and not a failure.
      expect(result).toEqual({ code: 3, signal: null });
      expect(started.routes()).toEqual([
        `GET ${HEALTH}`,
        `POST ${CREDENTIAL}`,
        `GET ${HEALTH}`,
        `POST ${RELEASE}`,
      ]);
      expect(started.requests[3]?.body).toEqual({ token: SERVER_AGENT_TOKEN });
      expect(output).toContain('released the server-agent credential; the service revoked it');
      expect(output).not.toContain('warning:');
      expect(output).not.toContain(EDITOR_TOKEN);
      expect(output).not.toContain(SERVER_AGENT_TOKEN);
    },
  );

  it('prints usage and exits 0 for --help', async () => {
    const fixture = await createFixture();
    const script = await installScript(fixture);

    const child = spawn(process.execPath, [script, '--help'], {
      env: { PATH: process.env.PATH ?? '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => (output += String(chunk)));

    const code = await new Promise((resolve) => child.once('exit', (value) => resolve(value)));

    expect(code).toBe(0);
    for (const route of ALL_PROTOCOL_ROUTES) expect(output).toContain(route.path);
    expect(output).toContain('--spawn-local');
    expect(output).toContain('--stop');
    expect(output).toContain('--detach');
  });
});

describe('argument parsing', () => {
  it('rejects the removed credential-era flags so a typo is never silent', () => {
    expect(() => parseArgs(['--no-token'])).toThrow(/unrecognised argument/u);
    expect(() => parseArgs(['--via-service'])).toThrow(/unrecognised argument/u);
  });

  it('rejects contradictory modes', () => {
    expect(() => parseArgs(['--stop', '--spawn-local'])).toThrow(/cannot be combined/u);
    expect(() => parseArgs(['--stop', '--detach'])).toThrow(/cannot be combined/u);
    expect(() => parseArgs(['--spawn-local', '--detach'])).toThrow(/cannot be combined/u);
  });

  it('accepts each mode on its own', () => {
    expect(parseArgs([]).spawnLocal).toBe(false);
    expect(parseArgs(['--spawn-local']).spawnLocal).toBe(true);
    expect(parseArgs(['--detach']).detach).toBe(true);
    expect(parseArgs(['--stop']).stop).toBe(true);
    expect(parseArgs(['--project=../elsewhere']).project).toBe('../elsewhere');
  });

  it('collects repeatable --env extras for --spawn-local, in order', () => {
    expect(parseArgs(['--spawn-local']).extraEnv).toEqual([]);
    expect(
      parseArgs([
        '--spawn-local',
        '--env',
        'FORWARDED',
        '--env=GIVEN=a=b',
        '--env',
        'BLANK=',
        '--env',
        '_under_score1',
      ]).extraEnv,
    ).toEqual([
      { name: 'FORWARDED', value: undefined },
      { name: 'GIVEN', value: 'a=b' },
      { name: 'BLANK', value: '' },
      { name: '_under_score1', value: undefined },
    ]);
  });

  it('refuses an --env that is malformed, reserved, repeated or outside --spawn-local', () => {
    /** @type {Array<[string[], RegExp]>} */
    const refusals = [
      [['--spawn-local', '--env', '1ST'], /--env "1ST" is not a variable name/u],
      [['--spawn-local', '--env', 'A-B=1'], /--env "A-B" is not a variable name/u],
      [['--spawn-local', '--env', '=value'], /--env "" is not a variable name/u],
      [['--spawn-local', '--env', 'NODE_OPTIONS=--inspect'], /is set by this command/u],
      [['--spawn-local', '--env', 'node_options'], /is set by this command/u],
      [['--spawn-local', '--env', 'DEBUGGEN_TOKEN=x'], /DEBUGGEN_ namespace/u],
      [['--spawn-local', '--env', 'DEBUGGEN_LOG_LEVEL=debug'], /DEBUGGEN_ namespace/u],
      [['--spawn-local', '--env', 'debuggen_home'], /DEBUGGEN_ namespace/u],
      [['--spawn-local', '--env', 'A=1\0'], /cannot contain a NUL/u],
      [['--spawn-local', '--env', 'A=1', '--env', 'A=2'], /--env A is given more than once/u],
      [['--spawn-local', '--env'], /--env needs a value/u],
      [['--env', 'A=1'], /--env applies only to --spawn-local/u],
      [['--detach', '--env', 'A=1'], /--env applies only to --spawn-local/u],
      [['--stop', '--env', 'A'], /--env applies only to --spawn-local/u],
    ];
    for (const [argv, message] of refusals) {
      expect(() => parseArgs(argv), argv.join(' ')).toThrow(message);
    }
  });
});

describe('shutdown signals', () => {
  it('resolves with the signal and unregisters its listeners', async () => {
    const before = process.listenerCount('SIGINT');
    const arrived = awaitShutdownSignal(['SIGINT']);
    expect(process.listenerCount('SIGINT')).toBe(before + 1);

    process.emit('SIGINT');

    await expect(arrived).resolves.toBe('SIGINT');
    expect(process.listenerCount('SIGINT')).toBe(before);
  });
});

describe('the documented environment contract', () => {
  /** @type {string} */
  let envExample;
  /** @type {string} */
  let playwrightConfig;

  beforeAll(() => {
    envExample = fs.readFileSync(path.join(REPO_ROOT, '.env.example'), 'utf8');
    playwrightConfig = fs.readFileSync(path.join(REPO_ROOT, 'playwright.config.ts'), 'utf8');
  });

  /**
   * Configuration variable names a file reads, taken from the two forms these
   * files use: `env.NAME` / `process.env.NAME` and `readEnv('NAME')`. Only the
   * product's own namespace is collected; `PATH`, `PATHEXT`, `ComSpec`, `CI`
   * and `NODE_OPTIONS` are the operating system's and the runner's, not this
   * product's configuration.
   *
   * @param {string} source
   * @returns {string[]}
   */
  const configurationVariables = (source) => {
    const names = new Set();
    const patterns = [
      /\benv\.([A-Z][A-Z0-9_]*)/gu,
      /\benv\[['"]([A-Z][A-Z0-9_]*)['"]\]/gu,
      /\breadEnv\(['"]([A-Z][A-Z0-9_]*)['"]\)/gu,
    ];
    for (const pattern of patterns) {
      for (const match of source.matchAll(pattern)) {
        const name = match[1];
        const productNamespace =
          /^(DEBUGGEN_|DEMO_URL|FIXTURE_APP_URL|DATABASE_URL|ANTHROPIC_|NEXT_OTEL_)/u;
        if (name !== undefined && productNamespace.test(name)) names.add(name);
      }
    }
    return [...names].sort();
  };

  it('documents every variable this script reads', () => {
    const missing = configurationVariables(SCRIPT_SOURCE).filter(
      (name) => !envExample.includes(name),
    );
    expect(missing).toEqual([]);
  });

  it('documents every variable playwright.config.ts reads', () => {
    const read = configurationVariables(playwrightConfig);
    // Guards the extraction itself: these two are the keys the finding named.
    expect(read).toContain('DEMO_URL');
    expect(read).toContain('FIXTURE_APP_URL');
    expect(read.filter((name) => !envExample.includes(name))).toEqual([]);
  });

  it('documents the defaults playwright.config.ts applies for the two suite URLs', () => {
    for (const value of ['http://localhost:3000', 'http://localhost:3100']) {
      expect(playwrightConfig).toContain(value);
      expect(envExample).toContain(value);
    }
  });

  it('marks the launcher-injected variables as injected rather than configurable', () => {
    const injectedSection = envExample.slice(envExample.indexOf('Injected by the tool'));
    for (const name of ['DEBUGGEN_TOKEN', 'DEBUGGEN_INGEST_URL', 'DEBUGGEN_PROJECT_ROOT']) {
      expect(injectedSection).toContain(name);
      // Never as an assignable line: setting them by hand has no effect.
      expect(envExample).not.toMatch(new RegExp(`^${name}=`, 'mu'));
    }
    // DEBUGGEN_PROMPTS_DIR is deliberately NOT in that list: the local service
    // reads it from `.env` like every other key in its contract
    // (`SERVICE_ENV_KEYS` in apps/local-service/src/config.ts), so a value set
    // by hand does take effect - it sits one step below an explicit host
    // override in the prompt-directory precedence. It is documented as an
    // assignable service key for that reason.
    expect(envExample).toMatch(/^DEBUGGEN_PROMPTS_DIR=$/mu);
  });
});
