/**
 * Tests for `scripts/dev-instrumented.mjs`, the CLI that starts a development
 * server with the telemetry preload attached.
 *
 * The suite has two jobs, and both exist because the CLI is a *caller* of
 * contracts it does not own:
 *
 *  1. CALLER/DEFINER CONTRACT. {@link PROTOCOL_ROUTES} below is the definer
 *     side, transcribed from the specification: the protocol's route table
 *     (AAP 0.4.2 `POST /dev-server/launch` `{ projectRoot, command? }` →
 *     `{ devServerUrl, pid }`, `POST /dev-server/stop`, `GET /health`), the
 *     service's own credential route (`POST /dev-server/credential`
 *     `{ projectRoot }` → `{ token, expiresAt }`, defined by
 *     `apps/local-service/src/dev-server/launcher.ts`), and AAP 0.5.6 for who
 *     must present a credential. It is written from those definitions and
 *     NEVER from the module under test — deriving the accepted routes from the
 *     caller's own exports would make the pair self-consistent and blind to
 *     exactly the drift this suite exists to catch. `SERVICE_ROUTES` is then
 *     asserted against it, so a rename on either side fails.
 *
 *     The definer is enforced the way a service enforces it: unknown path 404,
 *     wrong method 405, missing or wrong bearer credential 401, wrong
 *     content-type 415, and a body that is not exactly `{ projectRoot }` (plus
 *     the launch route's optional `command`) 400. Every rejection is recorded,
 *     and the end-to-end cases assert the caller provokes none of them.
 *
 *     `agrees with the definers of those routes` closes the loop against the
 *     real definers: it reads `packages/protocol/src/http.ts` for the three
 *     table routes, and the credential route's path and strict request and
 *     response schemas from whichever of the launcher or the protocol declares
 *     them. An in-process run against the real hono app with its auth
 *     middleware belongs to the service's own integration suite
 *     (`apps/local-service/test/integration/**`, AAP 0.8.3).
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
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  AUTH_FILE_NAME,
  DEFAULT_SERVICE_HOST,
  DEFAULT_SERVICE_PORT,
  INGEST_PATH,
  SERVICE_ROUTES,
  awaitShutdownSignal,
  buildChildEnv,
  buildLaunchCommand,
  describeToken,
  escapeCmdArgument,
  escapeCmdCommand,
  isLoopbackHostname,
  launchDevServer,
  main,
  parseArgs,
  requestServerAgentCredential,
  resolveProject,
  resolveServiceBase,
  stopDevServer,
  usage,
  wrapForPlatform,
} from './dev-instrumented.mjs';

/**
 * The definer's contract, transcribed from the protocol and from the service's
 * launcher rather than imported from the module under test.
 *
 * `authenticated` follows AAP 0.5.6: `GET /health` is one of the two
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
});

/**
 * Every route of the contract: the protocol table's three in the order it
 * lists them, then the service's credential route.
 */
const ALL_PROTOCOL_ROUTES = Object.freeze([
  PROTOCOL_ROUTES.health,
  PROTOCOL_ROUTES.launch,
  PROTOCOL_ROUTES.stop,
  PROTOCOL_ROUTES.credential,
]);

/** Shorthands for expectations, spelled from the contract above. */
const HEALTH = PROTOCOL_ROUTES.health.path;
const LAUNCH = PROTOCOL_ROUTES.launch.path;
const STOP = PROTOCOL_ROUTES.stop.path;
const CREDENTIAL = PROTOCOL_ROUTES.credential.path;

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
 * How far in the future the stub's credential expires: the service's default
 * lifetime for a credential minted through the credential route
 * (`DEFAULT_CLI_CREDENTIAL_TTL_MS`, twelve hours).
 */
const CREDENTIAL_LIFETIME_MS = 12 * 60 * 60 * 1000;

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
 * @returns {Promise<StubService>}
 */
async function startStubService(options = {}) {
  const implemented = options.implemented ?? ALL_PROTOCOL_ROUTES;
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

  /** @type {RecordedRequest[]} */
  const requests = [];
  /** @type {Array<{ path: string, status: number, reason: string }>} */
  const rejections = [];

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
      requests.push({
        method,
        path: requestPath,
        authorization: req.headers.authorization,
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
        answer(200, { status: 'ok', version: '0.1.0', pairing: true });
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
        answer(credentialStatus, credentialBody);
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
 * @property {Record<string, string>} env variables the fake reads
 * @property {() => Record<string, string>} read what the fake recorded
 * @property {() => boolean} ran whether the fake was executed at all
 */

/**
 * Put a fake package manager on a `PATH` of our own, so the local spawn mode
 * can be driven as a whole — pre-flight, credential, banner, spawn, exit code —
 * without running a real development server.
 *
 * It stands in for `pnpm`, which is what {@link buildLaunchCommand} looks up,
 * and it records the argv, working directory and the four injected variables
 * to a file rather than to stdout: `runDevServer` spawns with
 * `stdio: 'inherit'`, so anything it printed would land in the test runner's
 * own output.
 *
 * @param {Fixture} fixture
 * @param {object} [options]
 * @param {number} [options.exitCode] status the fake exits with (default 0)
 * @returns {Promise<FakeDevServer>}
 */
async function createFakeDevServer(fixture, options = {}) {
  const binDir = path.join(fixture.base, `bin-${randomUUID()}`);
  await fs.promises.mkdir(binDir, { recursive: true });

  const dump = path.join(fixture.base, `dev-server-${randomUUID()}.txt`);
  const executable = path.join(binDir, 'pnpm');
  await fs.promises.writeFile(
    executable,
    [
      '#!/bin/sh',
      '{',
      '  echo "argv=$*"',
      '  echo "cwd=$(pwd)"',
      '  echo "NODE_OPTIONS=$NODE_OPTIONS"',
      '  echo "DEBUGGEN_INGEST_URL=$DEBUGGEN_INGEST_URL"',
      '  echo "DEBUGGEN_PROJECT_ROOT=$DEBUGGEN_PROJECT_ROOT"',
      '  echo "DEBUGGEN_TOKEN=${DEBUGGEN_TOKEN-<unset>}"',
      '} > "$DEV_INSTRUMENTED_DUMP"',
      'exit "${DEV_INSTRUMENTED_EXIT:-0}"',
      '',
    ].join('\n'),
    'utf8',
  );
  await fs.promises.chmod(executable, 0o755);

  return {
    binDir,
    env: {
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
      DEV_INSTRUMENTED_DUMP: dump,
      DEV_INSTRUMENTED_EXIT: String(options.exitCode ?? 0),
    },
    ran: () => fs.existsSync(dump),
    read: () => {
      const text = fs.readFileSync(dump, 'utf8');
      /** @type {Record<string, string>} */
      const record = {};
      for (const line of text.split('\n')) {
        const separator = line.indexOf('=');
        if (separator > 0) record[line.slice(0, separator)] = line.slice(separator + 1);
      }
      return record;
    },
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
    // transcribed at the top of this file from the protocol (AAP 0.4.2) and the
    // service's launcher. A rename on either side fails here.
    expect([...SERVICE_ROUTES]).toEqual([HEALTH, LAUNCH, STOP, CREDENTIAL]);
    expect([HEALTH, LAUNCH, STOP, CREDENTIAL]).toEqual([
      '/health',
      '/dev-server/launch',
      '/dev-server/stop',
      '/dev-server/credential',
    ]);
    expect(PROTOCOL_ROUTES.credential).toEqual({
      method: 'POST',
      path: '/dev-server/credential',
      authenticated: true,
      required: ['projectRoot'],
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
    expect(started.routes()).toEqual([`GET ${HEALTH}`, `POST ${LAUNCH}`, `POST ${STOP}`]);
    expect(started.requests[2]?.body).toEqual({ projectRoot: fixture.projectDir });
    expect(started.rejections).toEqual([]);
    expect(stdout.text()).toContain('stopped the dev server');
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
      // the project root, and nothing else: no launch, no stop, no retry.
      expect(service.routes()).toEqual([`GET ${HEALTH}`, `POST ${CREDENTIAL}`]);
      expect(service.rejections).toEqual([]);
      expect(service.requests[0]?.authorization).toBeUndefined();
      expect(service.requests[1]?.authorization).toBe(`Bearer ${EDITOR_TOKEN}`);
      expect(service.requests[1]?.body).toEqual({ projectRoot: fixture.projectDir });

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

      // The banner describes the credential by length and expiry only, and says
      // plainly that nothing revokes it when the child exits.
      const banner = squash(stdout.text());
      expect(banner).toContain(`DEBUGGEN_TOKEN <set, ${SERVER_AGENT_TOKEN.length} bytes>`);
      expect(banner).toContain(`expires ${new Date(service.expiresAt).toISOString()}`);
      expect(banner).toContain('This run is AUTHENTICATED');
      expect(banner).toContain('The service has no revoke route');
      expect(banner).toContain('the credential is not revoked when the dev server exits');
    },
  );

  /**
   * @typedef {object} SpawnRefusal
   * @property {string} name what goes wrong, for the test title
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

      const code = await main(['--spawn-local', '--service', base], context);

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

  it('documents the mode it implements: authenticated, service-dependent, expiring, never revoked', () => {
    const text = usage();
    const options = text.slice(text.indexOf('\nOptions\n'));
    const start = options.indexOf('  --spawn-local');
    const paragraph = squash(options.slice(start, options.indexOf('  --stop ', start)));

    // The claim and the behaviour asserted above have to stay the same claim.
    expect(paragraph).toContain(`through POST ${CREDENTIAL}`);
    expect(paragraph).toContain(
      `AUTHENTICATED: it needs the running service and ${AUTH_FILE_NAME}`,
    );
    expect(paragraph).toContain('when the credential cannot be obtained nothing is spawned');
    expect(paragraph).toContain('The credential expires at the time the banner shows');
    expect(paragraph).toContain(
      'the service has no revoke route, so it is not revoked when the child exits',
    );

    const walkthrough = squash(
      text.slice(text.indexOf('What it does (--spawn-local)'), text.indexOf('\nOptions\n')),
    );
    expect(walkthrough).toContain(`POST {service}${CREDENTIAL} with { projectRoot }`);
    expect(walkthrough).toContain(
      `This is an AUTHENTICATED run: it needs a running service and ${AUTH_FILE_NAME}`,
    );
    expect(walkthrough).toContain('the credential is not revoked when the child exits');

    // The exit-code table agrees that every --spawn-local failure precedes the
    // spawn.
    const exitCodes = squash(text.slice(text.indexOf('Exit codes')));
    expect(exitCodes).toContain(
      'in --spawn-local every such failure happens before the spawn, and the message says nothing was spawned',
    );

    // The claims of the unauthenticated mode this replaced are gone everywhere.
    for (const stale of [
      'WITHOUT a credential',
      'stays inert',
      'runs offline',
      'it does not require one',
      'nor a running service',
      'a note rather than a failure',
    ]) {
      expect(squash(text)).not.toContain(stale);
    }
  });
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

  it('redacts both credentials from the status phrase of a refused credential, launch or stop', async () => {
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
    } finally {
      await scripted.close();
    }
  });

  const spawns = it.skipIf(process.platform === 'win32');

  spawns(
    'reports a credential answer cut off mid-body as a pre-spawn failure, not a stack',
    async () => {
      const scripted = await startScriptedServer((_req, res, requestPath) => {
        if (requestPath === HEALTH) {
          res.writeHead(200, { 'content-type': 'application/json' });
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
    // The regression this guards: Node's signal watchers do not hold the event
    // loop open, so a foreground wait with nothing else pending used to exit
    // with status 13 the instant the launch was reported.
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(child.exitCode).toBeNull();
    expect(started.requests.some((request) => request.path === STOP)).toBe(false);

    child.kill('SIGINT');
    const result = await exited;

    expect(result).toEqual({ code: 0, signal: null });
    expect(started.routes()).toEqual([`GET ${HEALTH}`, `POST ${LAUNCH}`, `POST ${STOP}`]);
    expect(started.rejections).toEqual([]);
    expect(output).toContain('stopped the dev server');
    expect(output).not.toContain(EDITOR_TOKEN);
  });

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
