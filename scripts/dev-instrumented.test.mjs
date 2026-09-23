/**
 * Tests for `scripts/dev-instrumented.mjs`, the CLI that starts a development
 * server with the telemetry preload attached.
 *
 * The suite has two jobs, and both exist because the CLI is a *caller* of
 * contracts it does not own:
 *
 *  1. CALLER/DEFINER CONTRACT. {@link PROTOCOL_ROUTES} below is the definer
 *     side, transcribed from the protocol (AAP 0.4.2 `POST /dev-server/launch`
 *     `{ projectRoot, command? }` → `{ devServerUrl, pid }`,
 *     `POST /dev-server/stop`, `GET /health`; AAP 0.5.6 for who must present a
 *     credential). It is written from the specification and NEVER from the
 *     module under test — deriving the accepted routes from the caller's own
 *     exports would make the pair self-consistent and blind to exactly the
 *     drift this suite exists to catch. `SERVICE_ROUTES` is then asserted
 *     against it, so a rename on either side fails.
 *
 *     The definer is enforced the way a service enforces it: unknown path 404,
 *     wrong method 405, missing or wrong bearer credential 401, wrong
 *     content-type 415, and a body that is not exactly `{ projectRoot }` (plus
 *     the optional `command`) 400. Every rejection is recorded, and the
 *     end-to-end cases assert the caller provokes none of them.
 *
 *     `agrees with the protocol definition once it lands` closes the loop when
 *     the real definer exists: as soon as `packages/protocol/src/http.ts` or a
 *     route module under `apps/local-service/src/server/routes/` is present,
 *     that test reads it and requires the same three paths. At this boundary
 *     neither file is in the tree (the service is a later boundary's
 *     deliverable), which the test asserts explicitly rather than passing
 *     vacuously, and an in-process run against the real hono app with its auth
 *     middleware belongs to that boundary's own integration suite
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
  describeToken,
  isLoopbackHostname,
  launchDevServer,
  main,
  parseArgs,
  probeServiceReachability,
  resolveServiceBase,
  stopDevServer,
  usage,
} from './dev-instrumented.mjs';

/**
 * The definer's contract, transcribed from the protocol rather than imported
 * from the module under test.
 *
 * `authenticated` follows AAP 0.5.6: `GET /health` is one of the two
 * unauthenticated routes, and everything else requires a bearer credential —
 * for these two routes the editor credential the service wrote to
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
});

/** Every route of the contract, in the order the protocol table lists them. */
const ALL_PROTOCOL_ROUTES = Object.freeze([
  PROTOCOL_ROUTES.health,
  PROTOCOL_ROUTES.launch,
  PROTOCOL_ROUTES.stop,
]);

/** Shorthands for expectations, spelled from the contract above. */
const HEALTH = PROTOCOL_ROUTES.health.path;
const LAUNCH = PROTOCOL_ROUTES.launch.path;
const STOP = PROTOCOL_ROUTES.stop.path;

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
 * @returns {Promise<StubService>}
 */
async function startStubService(options = {}) {
  const implemented = options.implemented ?? ALL_PROTOCOL_ROUTES;
  const launchStatus = options.launchStatus ?? 200;
  const stopStatus = options.stopStatus ?? 200;
  const launchBody = options.launchBody ?? LAUNCHED;

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
    `${JSON.stringify({ name: 'target-app', private: true, scripts: { dev: 'next dev' } }, null, 2)}\n`,
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
 * can be driven as a whole — probe, banner, spawn, exit code — without running
 * a real development server.
 *
 * It stands in for `pnpm`, which is what {@link buildLaunchCommand} looks up,
 * and it records the argv, working directory and the three injected variables
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
 * "no local service is running" cases, which are the point of the local spawn
 * mode.
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

describe('the route contract the caller is held to', () => {
  it('matches the protocol, route for route', () => {
    // Left side: the caller's exported list. Right side: the contract
    // transcribed from AAP 0.4.2 at the top of this file. A rename on either
    // side fails here.
    expect([...SERVICE_ROUTES]).toEqual([HEALTH, LAUNCH, STOP]);
    expect([HEALTH, LAUNCH, STOP]).toEqual(['/health', '/dev-server/launch', '/dev-server/stop']);
  });

  it('contains no invented credential route and no route override', () => {
    // The defect this guards: three guessed credential endpoints plus a
    // DEBUGGEN_CREDENTIAL_PATH override, none of which the service defines.
    for (const invented of [
      '/dev-server/credential',
      '/credentials/server-agent',
      '/dev-server/token',
      'DEBUGGEN_CREDENTIAL_PATH',
    ]) {
      expect(SCRIPT_SOURCE).not.toContain(invented);
    }
  });

  it('agrees with the protocol definition once it lands', async () => {
    // The definer of these routes is `packages/protocol/src/http.ts` and the
    // service's route module. Neither is in the tree at this boundary, so this
    // test records that fact today and turns into a cross-file agreement check
    // the moment either file appears - no edit required.
    /** @type {string[]} */
    const definers = [];
    for (const candidate of [
      'packages/protocol/src/http.ts',
      'apps/local-service/src/server/routes/dev-server.ts',
    ]) {
      if (fs.existsSync(path.join(REPO_ROOT, candidate))) definers.push(candidate);
    }

    if (definers.length === 0) {
      const message = [
        'No protocol/service definer of the dev-server routes exists yet.',
        'When packages/protocol/src/http.ts or',
        'apps/local-service/src/server/routes/dev-server.ts lands, this test',
        'requires it to declare every path in PROTOCOL_ROUTES, and the',
        "service boundary's own integration suite must drive this CLI across",
        'HTTP into the real authorised handler.',
      ].join(' ');
      expect(definers, message).toEqual([]);
      return;
    }

    for (const definer of definers) {
      const source = await fs.promises.readFile(path.join(REPO_ROOT, definer), 'utf8');
      for (const route of ALL_PROTOCOL_ROUTES) {
        expect(source, `${definer} must declare ${route.path}`).toContain(route.path);
      }
    }
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
  it('attaches the preload and the ingest URL and carries no credential', () => {
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

  it('carries a credential through when one is supplied', () => {
    // The builder stays general - a credential belongs in the child's
    // environment when the caller has one - even though the CLI's local spawn
    // never has one, because only the service's launcher mints them.
    const childEnv = buildChildEnv({
      preloadUrl: 'file:///tmp/register.mjs',
      base: 'http://127.0.0.1:43117',
      projectRoot: '/tmp/target',
      token: 'server-agent-credential',
      env: { PATH: '/usr/bin' },
    });

    expect(childEnv.DEBUGGEN_TOKEN).toBe('server-agent-credential');
    // Described by length only: a credential never reaches a terminal or a log.
    expect(describeToken(childEnv.DEBUGGEN_TOKEN)).toBe(
      `<set, ${'server-agent-credential'.length} bytes>`,
    );
    expect(describeToken(undefined)).toContain('--spawn-local');
    // What the absence costs, stated as what actually happens: with no
    // credential the preload reports itself inert and installs nothing, so no
    // ingest is attempted and there is nothing for the service to reject.
    expect(describeToken(undefined)).toContain('inert');
  });

  // The spawn is exercised through a fake `pnpm` on a `PATH` of the test's own,
  // which POSIX shells can execute directly; `buildLaunchCommand` resolves
  // `pnpm.cmd` through `PATHEXT` on Windows and `wrapForPlatform` runs it
  // through the command interpreter, which this fake is not.
  const spawns = it.skipIf(process.platform === 'win32');

  spawns(
    'starts the dev server with no local service running, because the mode asks it for nothing',
    async () => {
      // No `auth.json` either: this mode reads no credential, so neither the
      // service nor the session home is a precondition for it. That is the
      // whole claim the help text makes about it.
      const fixture = await createFixture({ withCredential: false });
      const dev = await createFakeDevServer(fixture);
      const base = await closedServiceAddress();
      const { context, stdout, stderr } = contextFor(fixture, dev.env);

      const code = await main(['--spawn-local', '--service', base], context);

      // The dev server's own status, not a pre-flight failure of this command.
      expect(code).toBe(0);
      expect(stderr.text()).toBe('');
      expect(dev.ran()).toBe(true);

      const recorded = dev.read();
      expect(recorded.argv).toBe('--filter target-app dev');
      expect(recorded.cwd).toBe(fs.realpathSync(fixture.root));
      expect(recorded.NODE_OPTIONS).toBe(`--import ${fixture.preloadUrl}`);
      expect(recorded.DEBUGGEN_INGEST_URL).toBe(`${base}${INGEST_PATH}`);
      expect(recorded.DEBUGGEN_PROJECT_ROOT).toBe(fixture.projectDir);
      expect(recorded.DEBUGGEN_TOKEN).toBe('<unset>');

      // The unreachable service is reported, and reported as a note: the run
      // is complete, not degraded.
      const banner = squash(stdout.text());
      expect(banner).toContain(`${base} (not answering)`);
      expect(banner).toContain(
        'That does not stop this mode and nothing was skipped because of it',
      );
      expect(banner).toContain('no server or database spans will be recorded');
    },
  );

  spawns('asks a running service nothing except whether it is answering', async () => {
    service = await startStubService();
    const fixture = await createFixture();
    const dev = await createFakeDevServer(fixture);
    const { context, stdout } = contextFor(fixture, dev.env);

    const code = await main(['--spawn-local', '--service', service.base], context);

    expect(code).toBe(0);
    // No launch, no stop, no credential: the liveness route and nothing else.
    expect(service.routes()).toEqual([`GET ${HEALTH}`]);
    expect(service.rejections).toEqual([]);
    expect(service.requests.every((request) => request.authorization === undefined)).toBe(true);
    expect(stdout.text()).not.toContain('not answering');
    expect(dev.read().DEBUGGEN_TOKEN).toBe('<unset>');
  });

  spawns('exits with the dev server’s status rather than one of its own', async () => {
    const fixture = await createFixture({ withCredential: false });
    const dev = await createFakeDevServer(fixture, { exitCode: 7 });
    const base = await closedServiceAddress();
    const { context, stderr } = contextFor(fixture, dev.env);

    const code = await main(['--spawn-local', '--service', base], context);

    // 7 is the child's; 2 would be this command reporting a failure of its own,
    // which is what an unreachable service used to produce here.
    expect(code).toBe(7);
    expect(code).not.toBe(2);
    expect(stderr.text()).toBe('');
  });

  it('reports the service probe instead of failing on it, and never rejects', async () => {
    service = await startStubService();

    await expect(probeServiceReachability(service.base)).resolves.toEqual({ reachable: true });
    expect(service.routes()).toEqual([`GET ${HEALTH}`]);

    const closed = await closedServiceAddress();
    const unreachable = await probeServiceReachability(closed);

    expect(unreachable.reachable).toBe(false);
    expect(unreachable.detail).toContain(`${closed}${HEALTH}`);
  });

  it('documents the mode it implements: credential-free, inert, and independent of the service', () => {
    const text = usage();
    const options = text.slice(text.indexOf('\nOptions\n'));
    const start = options.indexOf('  --spawn-local');
    const paragraph = squash(options.slice(start, options.indexOf('  --stop ', start)));

    // The claim and the behaviour asserted above have to stay the same claim:
    // this paragraph once promised an offline mode that a mandatory health
    // probe then refused to run.
    expect(paragraph).toContain('WITHOUT a credential');
    expect(paragraph).toContain('stays inert');
    expect(paragraph).toContain('it does not require one');
    expect(paragraph).toContain('the mode runs offline');

    // And the exit-code table has to agree about which modes a service that is
    // not answering is fatal for.
    const exitCodes = squash(text.slice(text.indexOf('Exit codes')));
    expect(exitCodes).toContain(
      'In --spawn-local a service that is not answering is a note rather than a failure',
    );
    expect(squash(text)).toContain(`it needs neither ${AUTH_FILE_NAME} nor a running service`);
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
