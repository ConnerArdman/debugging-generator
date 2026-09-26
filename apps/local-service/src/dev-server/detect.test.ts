/**
 * Tests for `./detect.ts`: dev-server detection — the loopback-only probe, the
 * one-file manifest read, framework-generic dev-script selection, the relaunch
 * command and its developer-facing hint, and the `detectDevServer` matrix.
 *
 * Six things are on trial here, each for a reason the plan states.
 *
 * - **The probe is loopback-only, and the refusal comes first.** A dev-server
 *   URL reaches this service over HTTP, so a probe that would dial any host
 *   turns the service into an outbound request engine for whoever can reach
 *   it. AAP §0.5.6 keeps the service local; the suite therefore pins not only
 *   the refusal but that the injected `FetchLike` was called **zero** times.
 * - **An answer is not an identity.** Any process can answer 404 or 500 on the
 *   session's port. Detection counts it as this project's dev server only on
 *   the framework's own response signature (`X-Powered-By: Next.js`, the
 *   `next-router-state-tree` token in `Vary`) and reports anything else as
 *   `occupied`, not launchable — even with a `server-agent` connected for the
 *   project, because that agent's dev server may be listening on another
 *   port. The signature is matched without a header value ever reaching the
 *   result or a log record.
 * - **The manifest read is private.** Exactly one project file is read —
 *   `<projectRoot>/package.json`, through the no-follow reader — and nothing of
 *   it survives beyond the four `TargetManifest` fields; no error echoes file
 *   content (AAP §0.5.2). Reader spies prove no `.env*` file and no lockfile is
 *   ever read through this module.
 * - **Selection is by shape.** A dev script is found by the binary and
 *   subcommand it invokes, never by a whole-command or project-specific
 *   literal, which is what lets detection work on any Next.js project
 *   (acceptance test 4, AAP §0.8.4).
 * - **The relaunch hint is a contract.** It is the text a developer reads when
 *   server spans are unavailable (AAP §0.5.5), so its command is asserted
 *   byte-for-byte per package manager, its `DEBUGGEN_TOKEN` is only ever a
 *   shell reference, and it stays one line within the readiness hint limit.
 * - **Degradation is data.** `detectDevServer` never throws: every degraded
 *   input resolves to a `DevServerDetection` with a note explaining it.
 *
 * Five habits in here are deliberate.
 *
 * 1. **No network, no child process.** Every collaborator is injected — a
 *    `FetchLike` stub, a `ManifestReader` spy, a `ServerAgentPresence` double,
 *    a sink-backed logger — so nothing dials a socket or spawns Next.js. The
 *    `NODE_OPTIONS` injection itself is the launcher's concern and its suite's.
 * 2. **Filesystem only under `os.tmpdir()`.** Each sandbox is an `mkdtemp`
 *    directory removed in `afterEach`; nothing is written into the repository
 *    or `~/.debuggen`.
 * 3. **Secret-shaped values are assembled at runtime.** `scripts/check-secrets.mjs`
 *    scans this tracked file, so planted tokens and credential-bearing URLs
 *    are built from fragments, never written as literals.
 * 4. **Fixture vocabulary is invented and generic.** No path, script,
 *    component or route belongs to the repository's demo target, which
 *    `scripts/check-no-hardcoding.mjs` guards (AAP §0.5.4); even the demo
 *    tree's path fragment asserted against is assembled at runtime.
 * 5. **The four environment names are written out by hand.** `detect.ts`
 *    states the launcher's `NODE_OPTIONS` / `DEBUGGEN_INGEST_URL` /
 *    `DEBUGGEN_PROJECT_ROOT` / `DEBUGGEN_TOKEN` contract privately (the
 *    launcher depends on it, never the reverse), so this list is an
 *    independent second copy: renaming a variable there without changing it
 *    here, where a reviewer sees it, fails this suite.
 *
 * @module
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

import { PACKAGE_MANAGERS } from '@debuggen/code-analysis';
import { READINESS_HINT_MAX_LENGTH } from '@debuggen/instrumentation';
import {
  DEBUGGEN_ERROR_CODES,
  DebuggenError,
  createConsoleLogger,
  isErr,
  ok,
} from '@debuggen/shared';
import type { DebuggenErrorCode, LogRecord, Logger, Result } from '@debuggen/shared';

import { isProductAuthoredText } from '../sessions/progress.js';
import {
  DEFAULT_PROBE_TIMEOUT_MS,
  DEV_SERVER_FRAMEWORKS,
  DEV_SERVER_IDENTITY_EVIDENCE,
  DEV_SERVER_PRELOAD_REASONS,
  FRAMEWORK_DEV_CLIS,
  LAUNCH_DEV_SERVER_COMMAND_TITLE,
  MAX_MANIFEST_BYTES,
  MAX_PROBE_TIMEOUT_MS,
  PACKAGE_MANAGER_SOURCES,
  PRELOAD_DEPENDENT_SIGNALS,
  RELAUNCH_PLACEHOLDERS,
  buildPreloadUnavailableSignals,
  buildRelaunchHint,
  detectDevServer,
  formatRelaunchCommand,
  packageManagerRunArgs,
  probeDevServer,
  readTargetManifest,
  selectDevScript,
} from './detect.js';
import type {
  DevScriptSelection,
  DevServerDetectDeps,
  DevServerDetection,
  FetchLike,
  FetchLikeResponse,
  KnownPackageManagerId,
  ManifestReader,
  PackageManagerId,
  PackageManagerResolver,
  RelaunchCommandInput,
  ServerAgentPresence,
} from './detect.js';

// ---------------------------------------------------------------------------
// Fixtures — invented, generic vocabulary only (habit 4)
// ---------------------------------------------------------------------------

/** A plausible absolute project root that no test creates or reads from disk. */
const PROJECT_ROOT = '/home/dev/acme-portal';

/** The resolved preload module the launcher would hand to detection. */
const PRELOAD_PATH = '/opt/debuggen/telemetry/register.mjs';

/** `pathToFileURL(PRELOAD_PATH).href`, written out independently. */
const PRELOAD_URL = 'file:///opt/debuggen/telemetry/register.mjs';

/** The service's own address; nothing listens on it during the suite. */
const SERVICE_CONFIG = { host: '127.0.0.1', port: 43117 } as const;

/** The ingest endpoint `SERVICE_CONFIG` composes to, written out independently. */
const INGEST_URL = 'http://127.0.0.1:43117/telemetry/ingest';

/** A loopback dev-server URL; every probe of it is answered by a stub. */
const DEV_URL = 'http://127.0.0.1:4100/';

/**
 * The response headers `next dev` sends on a page: both halves of the Next.js
 * signature (`X-Powered-By` and the router tokens in `Vary`) beside a header
 * that carries no identity.
 */
const NEXT_PAGE_HEADERS = Object.freeze({
  'x-powered-by': 'Next.js',
  vary: 'rsc, next-router-state-tree, next-router-prefetch, next-router-segment-prefetch, Accept-Encoding',
  'content-type': 'text/html; charset=utf-8',
});

/**
 * The headers of a generic process that is not a Next.js dev server — an
 * unrelated HTTP server holding the session's port.
 */
const UNRELATED_SERVER_HEADERS = Object.freeze({
  'x-powered-by': 'Express',
  vary: 'Origin, Accept-Encoding',
  'content-type': 'text/plain; charset=utf-8',
});

/**
 * The environment a preloaded dev server needs, in the order the relaunch
 * command assigns it — the independent second copy of the launcher's contract
 * (habit 5).
 */
const EXPECTED_PRELOAD_ENV_KEYS = [
  'NODE_OPTIONS',
  'DEBUGGEN_INGEST_URL',
  'DEBUGGEN_PROJECT_ROOT',
  'DEBUGGEN_TOKEN',
] as const;

/** The demo target's tree, assembled so this file never spells it (habit 4). */
const DEMO_TREE_FRAGMENT = ['apps', ['demo', 'app'].join('-')].join('/');

/** A generic Next.js project manifest with fields that must NOT be projected. */
const PORTAL_MANIFEST = Object.freeze({
  name: 'acme-portal',
  version: '2.3.0',
  private: true,
  description: 'Internal ordering portal for field technicians',
  packageManager: 'pnpm@10.4.1',
  scripts: {
    dev: 'next dev',
    build: 'next build',
    start: 'next start',
    lint: 'eslint .',
  },
  dependencies: { next: '16.1.0', react: '19.1.0', 'react-dom': '19.1.0' },
  devDependencies: { typescript: '6.0.3' },
});

/** The same project without a `packageManager` pin. */
const UNPINNED_MANIFEST = Object.freeze({
  name: 'acme-portal',
  scripts: { dev: 'next dev', build: 'next build' },
  dependencies: { next: '16.1.0' },
});

// ---------------------------------------------------------------------------
// Runtime-assembled planted values (habit 3)
// ---------------------------------------------------------------------------

/** The characters from `first` to `last`, inclusive, by code unit. */
function charRange(first: string, last: string): string {
  const start = first.charCodeAt(0);
  const end = last.charCodeAt(0);
  return Array.from({ length: end - start + 1 }, (_, offset) =>
    String.fromCharCode(start + offset),
  ).join('');
}

/** A 62-character alphabet, assembled rather than written out. */
const PLANTED_ALPHABET = charRange('A', 'Z') + charRange('a', 'z') + charRange('0', '9');

/**
 * A deterministic, dense value that cannot occur in any product output by
 * accident. Stepping by 7 (coprime with 62) visits distinct characters, so the
 * value is genuinely high-entropy — exactly the shape a credential has — while
 * the suite stays reproducible.
 */
function plantedValue(seed: number, length = 40): string {
  let value = '';
  for (let index = 0; index < length; index += 1) {
    value += PLANTED_ALPHABET.charAt((seed + index * 7) % PLANTED_ALPHABET.length);
  }
  return value;
}

/** A URL that embeds `user:password@`, built by concatenation. */
function credentialUrl(host: string): string {
  return 'http://' + ['someone', plantedValue(5, 12)].join(':') + '@' + host + '/';
}

/** Shannon entropy in bits per character, as `scripts/check-secrets.mjs` measures it. */
function shannonBitsPerChar(value: string): number {
  const counts = new Map<string, number>();
  for (const character of value) {
    counts.set(character, (counts.get(character) ?? 0) + 1);
  }
  let bits = 0;
  for (const count of counts.values()) {
    const probability = count / value.length;
    bits -= probability * Math.log2(probability);
  }
  return bits;
}

/**
 * Dense runs of at least 32 key-material characters above 4 bits/char — the
 * thresholds of the repository's secrets gate. `/` and `:` end a run, so
 * paths and URLs are measured segment by segment.
 */
function secretShapedRuns(text: string): string[] {
  return [...text.matchAll(/[A-Za-z0-9_+=-]{32,}/g)]
    .map((match) => match[0])
    .filter((run) => shannonBitsPerChar(run) > 4);
}

// ---------------------------------------------------------------------------
// Result and error helpers
// ---------------------------------------------------------------------------

/** The value of an `Ok`, or a test failure naming the `Err` that arrived instead. */
function expectOk<T>(result: Result<T, DebuggenError>): T {
  if (isErr(result)) {
    throw new Error(`expected Ok, received Err(${result.error.code}): ${result.error.message}`);
  }
  return result.value;
}

/**
 * The error of an `Err`, asserted to be a `DebuggenError` carrying an existing
 * `DEBUGGEN_ERROR_CODES` member — and the expected one.
 */
function expectTypedErr<T>(
  result: Result<T, DebuggenError>,
  code: DebuggenErrorCode,
): DebuggenError {
  if (!isErr(result)) {
    throw new Error(`expected Err(${code}), received Ok`);
  }
  expect(result.error).toBeInstanceOf(DebuggenError);
  expect(DEBUGGEN_ERROR_CODES).toContain(result.error.code);
  expect(result.error.code).toBe(code);
  return result.error;
}

/** The machine-readable reason a refusal carries in its details. */
function reasonOf(error: DebuggenError): unknown {
  return error.details?.['reason'];
}

/** Every textual surface of an error a developer or a log could see. */
function errorSurfaces(error: DebuggenError): string {
  return JSON.stringify({ message: error.message, hint: error.hint, details: error.details });
}

// ---------------------------------------------------------------------------
// Collaborator doubles
// ---------------------------------------------------------------------------

/** A logger whose records land in an array instead of the console. */
function recordingLogger(): { readonly logger: Logger; readonly records: LogRecord[] } {
  const records: LogRecord[] = [];
  const logger = createConsoleLogger({
    level: 'trace',
    sink: (record) => {
      records.push(record);
    },
  });
  return { logger, records };
}

/** A logger every method of which throws, including `child`. */
function failLogging(): never {
  throw new Error('the log sink is unavailable');
}
const THROWING_LOGGER: Logger = Object.freeze({
  level: 'trace',
  trace: failLogging,
  debug: failLogging,
  info: failLogging,
  warn: failLogging,
  error: failLogging,
  fatal: failLogging,
  child: failLogging,
});

/** A fetch stub that answers every request with `status` and no headers at all. */
function answering(status: number) {
  return vi.fn<FetchLike>(() => Promise.resolve({ status }));
}

/** A fetch stub that answers every request with `status` and real (undici) `headers`. */
function answeringAs(status: number, headers: Readonly<Record<string, string>>) {
  return vi.fn<FetchLike>(() => Promise.resolve({ status, headers: new Headers(headers) }));
}

/** A fetch stub that answers as `next dev` does: `status` with the Next.js signature. */
function answeringAsNext(status = 200) {
  return answeringAs(status, NEXT_PAGE_HEADERS);
}

/** The error undici produces for a refused connection: a `TypeError` whose `cause` is coded. */
function connectionRefusedError(): Error {
  const socketError = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:4100'), {
    code: 'ECONNREFUSED',
  });
  return new TypeError('fetch failed', { cause: socketError });
}

/** A fetch stub whose every request is refused at the transport. */
function refusing() {
  return vi.fn<FetchLike>(() => Promise.reject(connectionRefusedError()));
}

/** A clock that returns `readings` in order, repeating the last one. */
function steppingClock(...readings: number[]): () => number {
  let index = 0;
  return () => {
    const reading = readings[Math.min(index, readings.length - 1)] ?? 0;
    index += 1;
    return reading;
  };
}

/** A promise and the function that settles it. */
function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/** A reader spy that serves `manifest` as JSON text for any path. */
function servingManifest(manifest: unknown) {
  return vi.fn<ManifestReader>(() => JSON.stringify(manifest));
}

/** A reader spy that reads the real file, recording every path it was asked for. */
function spyingDiskReader() {
  return vi.fn<ManifestReader>((absolutePath) => readFileSync(absolutePath));
}

/** A `ServerAgentPresence` double backed by a spy the test can inspect. */
function presence(connected: boolean): {
  readonly serverAgents: ServerAgentPresence;
  readonly hasServerAgentForProject: Mock<(projectRoot: string) => boolean>;
} {
  const hasServerAgentForProject = vi.fn<(projectRoot: string) => boolean>(() => connected);
  return { serverAgents: { hasServerAgentForProject }, hasServerAgentForProject };
}

/**
 * The collaborators a production caller wires, over the pinned portal
 * manifest: its `packageManager` field settles the manager, so no detection
 * path touches the filesystem.
 */
function portalDeps(overrides: DevServerDetectDeps = {}): DevServerDetectDeps {
  return {
    config: SERVICE_CONFIG,
    preloadPath: PRELOAD_PATH,
    readManifest: servingManifest(PORTAL_MANIFEST),
    now: steppingClock(10_000, 10_012),
    ...overrides,
  };
}

/**
 * The exact relaunch line, composed independently of `detect.ts` from the
 * launcher's documented shape: `cd`, `NODE_OPTIONS` **appended** with the
 * preload import, the ingest URL, the project root, the token as a shell
 * reference, then the runner.
 */
function expectedCommand(
  root: string,
  run: string,
  preloadWord: string = PRELOAD_URL,
  ingestWord: string = INGEST_URL,
): string {
  return (
    `cd ${root} && ` +
    'NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--import ' +
    preloadWord +
    '" ' +
    `DEBUGGEN_INGEST_URL=${ingestWord} ` +
    `DEBUGGEN_PROJECT_ROOT=${root} ` +
    'DEBUGGEN_TOKEN="$DEBUGGEN_TOKEN" ' +
    run
  );
}

// ---------------------------------------------------------------------------
// Sandboxes and global cleanup
// ---------------------------------------------------------------------------

const sandboxes: string[] = [];

/** A fresh directory under `os.tmpdir()`, removed after the test. */
function makeSandbox(): string {
  const directory = mkdtempSync(join(tmpdir(), 'debuggen-detect-'));
  sandboxes.push(directory);
  return directory;
}

/** Write `manifest` as the sandbox project's `package.json`. */
function writeManifest(root: string, manifest: unknown): void {
  writeFileSync(join(root, 'package.json'), JSON.stringify(manifest, null, 2));
}

/**
 * Whether this host can create a symbolic link in its temporary directory —
 * decided by trying, in a probe directory removed immediately, rather than by
 * platform name.
 */
function canCreateSymlinks(): boolean {
  const probeDirectory = mkdtempSync(join(tmpdir(), 'debuggen-detect-symlink-probe-'));
  try {
    writeFileSync(join(probeDirectory, 'target'), '');
    symlinkSync(join(probeDirectory, 'target'), join(probeDirectory, 'link'));
    return true;
  } catch {
    return false;
  } finally {
    rmSync(probeDirectory, { recursive: true, force: true });
  }
}
const SYMLINKS_UNAVAILABLE = !canCreateSymlinks();

afterEach(() => {
  for (const directory of sandboxes.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------
// probeDevServer
// ---------------------------------------------------------------------------

describe('probeDevServer', () => {
  describe('refuses every URL that is not a loopback http(s) address, before any request', () => {
    // The dev-server URL arrives over HTTP (the editor's setting, a launch
    // request). If the probe dialled whatever it was given, the service would
    // become an outbound request engine for anyone who can reach it; AAP
    // §0.5.6 keeps the service local, so refusal precedes the request and the
    // injected transport is never touched.
    const refusals: readonly {
      readonly label: string;
      readonly url: string;
      readonly reason: string;
    }[] = [
      { label: 'a LAN address', url: 'http://192.168.1.20:3000/', reason: 'non-loopback-host' },
      { label: 'a private 10/8 address', url: 'http://10.0.0.5/', reason: 'non-loopback-host' },
      {
        label: 'a public hostname',
        url: 'https://example.com/private?view=1',
        reason: 'non-loopback-host',
      },
      {
        label: 'a lookalike of localhost',
        url: 'http://localhost.example.org:3000/',
        reason: 'non-loopback-host',
      },
      {
        label: 'a lookalike of 127.0.0.1',
        url: 'http://127.0.0.1.example.net/',
        reason: 'non-loopback-host',
      },
      {
        label: 'another address in 127/8',
        url: 'http://127.0.0.2:3000/',
        reason: 'non-loopback-host',
      },
      { label: 'the wildcard address', url: 'http://0.0.0.0:3000/', reason: 'non-loopback-host' },
      {
        label: 'an IPv4-mapped IPv6 spelling',
        url: 'http://[::ffff:127.0.0.1]:3000/',
        reason: 'non-loopback-host',
      },
      { label: 'a file: URL', url: 'file:///etc/hosts', reason: 'unsupported-protocol' },
      { label: 'a ws: URL', url: 'ws://127.0.0.1:3000/', reason: 'unsupported-protocol' },
      {
        label: 'embedded credentials on a loopback host',
        url: credentialUrl('127.0.0.1:3000'),
        reason: 'credentials-in-url',
      },
      { label: 'a malformed string', url: 'not a url', reason: 'malformed-url' },
      { label: 'a scheme with an empty host', url: 'http://:3000/', reason: 'malformed-url' },
      { label: 'a protocol-relative URL', url: '//localhost:3000/', reason: 'malformed-url' },
      { label: 'an empty string', url: '', reason: 'malformed-url' },
      { label: 'whitespace only', url: '   ', reason: 'malformed-url' },
    ];

    it.each(refusals)(
      '$label → CONFIG_INVALID, and fetch is never called',
      async ({ url, reason }) => {
        const fetchImpl = answering(200);
        const { logger, records } = recordingLogger();

        const error = expectTypedErr(
          await probeDevServer(url, { fetchImpl, logger }),
          'CONFIG_INVALID',
        );

        expect(fetchImpl).toHaveBeenCalledTimes(0);
        expect(reasonOf(error)).toBe(reason);
        expect(error.hint).toMatch(/debuggen\.devServerUrl/);
        if (url.trim().length > 0) {
          // The refusal names the policy, never the URL it refused.
          expect(errorSurfaces(error)).not.toContain(url.trim());
          expect(JSON.stringify(records)).not.toContain(url.trim());
        }
      },
    );

    it('logs a refusal at debug with its code only', async () => {
      const { logger, records } = recordingLogger();

      await probeDevServer('https://example.com/', { fetchImpl: answering(200), logger });

      expect(records).toHaveLength(1);
      expect(records[0]?.level).toBe('debug');
      expect(records[0]?.fields).toMatchObject({ subsystem: 'dev-server', code: 'CONFIG_INVALID' });
    });
  });

  describe('accepts the three loopback spellings', () => {
    const accepted: readonly { readonly url: string; readonly probed: string }[] = [
      { url: 'http://127.0.0.1:4100/', probed: 'http://127.0.0.1:4100/' },
      { url: 'http://localhost:4100', probed: 'http://localhost:4100/' },
      { url: 'http://[::1]:4100/', probed: 'http://[::1]:4100/' },
      { url: 'https://localhost:4443/portal', probed: 'https://localhost:4443/portal' },
      { url: '  http://127.0.0.1:4100/  ', probed: 'http://127.0.0.1:4100/' },
    ];

    it.each(accepted)('$url is probed with one bounded GET', async ({ url, probed }) => {
      const fetchImpl = answering(200);

      const probe = expectOk(await probeDevServer(url, { fetchImpl }));

      expect(probe).toMatchObject({ url: probed, reachable: true, status: 200 });
      expect(probe.error).toBeUndefined();
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      const [input, init] = fetchImpl.mock.calls[0] ?? [];
      expect(input).toBe(probed);
      expect(init?.method).toBe('GET');
      // Redirects are not followed: a redirect to another host would be a
      // request this module never agreed to make.
      expect(init?.redirect).toBe('manual');
      expect(init?.signal).toBeInstanceOf(AbortSignal);
    });
  });

  it.each([200, 204, 301, 404, 500, 503])(
    'treats HTTP %i as reachable: a dev server answering at all is running',
    async (status) => {
      const probe = expectOk(await probeDevServer(DEV_URL, { fetchImpl: answering(status) }));

      expect(probe).toMatchObject({ url: DEV_URL, reachable: true, status });
      expect(probe.error).toBeUndefined();
    },
  );

  it('cancels an unread response body so the connection is released', async () => {
    const cancel = vi.fn(() => Promise.resolve());
    const fetchImpl = vi.fn<FetchLike>(() => Promise.resolve({ status: 200, body: { cancel } }));

    expectOk(await probeDevServer(DEV_URL, { fetchImpl }));

    expect(cancel).toHaveBeenCalledTimes(1);
  });

  describe('the framework signature: evidence of identity, never a recorded value', () => {
    it('recognises only the Next.js framework', () => {
      expect(DEV_SERVER_FRAMEWORKS).toEqual(['next']);
      expect(Object.isFrozen(DEV_SERVER_FRAMEWORKS)).toBe(true);
    });

    const signatures: readonly {
      readonly label: string;
      readonly headers: Readonly<Record<string, string>>;
    }[] = [
      { label: 'X-Powered-By: Next.js', headers: { 'x-powered-by': 'Next.js' } },
      { label: 'X-Powered-By in another case', headers: { 'X-Powered-By': 'NEXT.JS' } },
      {
        label: 'X-Powered-By naming Next.js among others',
        headers: { 'x-powered-by': 'Edge-Proxy, Next.js' },
      },
      {
        label: 'the router token in Vary (X-Powered-By disabled)',
        headers: { vary: 'rsc, next-router-state-tree, next-router-prefetch' },
      },
      {
        label: 'the router token in another case, padded',
        headers: { Vary: 'RSC ,  Next-Router-State-Tree , Accept-Encoding' },
      },
      { label: 'the router token alone', headers: { vary: 'next-router-state-tree' } },
      { label: 'both halves', headers: NEXT_PAGE_HEADERS },
    ];

    it.each(signatures.flatMap((entry) => [200, 404, 500].map((status) => ({ ...entry, status }))))(
      'HTTP $status with $label → framework "next"',
      async ({ headers, status }) => {
        const probe = expectOk(
          await probeDevServer(DEV_URL, { fetchImpl: answeringAs(status, headers) }),
        );

        expect(probe).toMatchObject({ url: DEV_URL, reachable: true, status, framework: 'next' });
      },
    );

    const unsigned: readonly {
      readonly label: string;
      readonly headers: Readonly<Record<string, string>>;
    }[] = [
      { label: 'no headers', headers: {} },
      { label: 'an unrelated server', headers: UNRELATED_SERVER_HEADERS },
      { label: 'X-Powered-By: next (no .js)', headers: { 'x-powered-by': 'next' } },
      {
        label: 'a Vary token that only contains the router token',
        headers: { vary: 'x-next-router-state-tree, next-router-state-tree-v2' },
      },
      {
        label: 'the router token in another header',
        headers: { 'x-router': 'next-router-state-tree' },
      },
      { label: 'an empty Vary', headers: { vary: '' } },
    ];

    it.each(unsigned)('$label → no framework, still reachable', async ({ headers }) => {
      const probe = expectOk(
        await probeDevServer(DEV_URL, { fetchImpl: answeringAs(404, headers) }),
      );

      expect(probe).toMatchObject({ url: DEV_URL, reachable: true, status: 404 });
      expect('framework' in probe).toBe(false);
    });

    it('reports no framework for a response without a headers object', async () => {
      const probe = expectOk(await probeDevServer(DEV_URL, { fetchImpl: answering(200) }));

      expect('framework' in probe).toBe(false);
    });

    const hostile: readonly {
      readonly label: string;
      readonly response: () => FetchLikeResponse;
    }[] = [
      {
        label: 'a headers.get that throws',
        response: () => ({
          status: 200,
          headers: {
            get: (): string | null => {
              throw new Error('header table unavailable');
            },
          },
        }),
      },
      {
        label: 'a headers getter that throws',
        response: () => ({
          status: 200,
          get headers(): never {
            throw new Error('headers unavailable');
          },
        }),
      },
      {
        label: 'a headers.get that answers a non-string',
        response: () =>
          ({
            status: 200,
            headers: { get: () => ['Next.js'] },
          }) as unknown as FetchLikeResponse,
      },
      {
        label: 'a headers object whose get is not a function',
        response: () =>
          ({ status: 200, headers: { get: 'Next.js' } }) as unknown as FetchLikeResponse,
      },
      { label: 'null headers', response: () => ({ status: 200, headers: null }) },
    ];

    it.each(hostile)(
      'tolerates $label: reachable, no framework, no crash',
      async ({ response }) => {
        const { logger, records } = recordingLogger();
        const fetchImpl = vi.fn<FetchLike>(() => Promise.resolve(response()));

        const probe = expectOk(await probeDevServer(DEV_URL, { fetchImpl, logger }));

        expect(probe).toMatchObject({ url: DEV_URL, reachable: true, status: 200 });
        expect('framework' in probe).toBe(false);
        expect(JSON.stringify(records)).not.toContain('unavailable');
      },
    );

    it('never stores, returns or logs a header value — only the framework name', async () => {
      const plantedPoweredBy = plantedValue(71, 24);
      const plantedVary = plantedValue(73, 24);
      const plantedCookie = plantedValue(79, 24);
      const { logger, records } = recordingLogger();

      const probe = expectOk(
        await probeDevServer(DEV_URL, {
          logger,
          fetchImpl: answeringAs(200, {
            'x-powered-by': `Next.js ${plantedPoweredBy}`,
            vary: `next-router-state-tree, ${plantedVary}`,
            'set-cookie': `session=${plantedCookie}`,
          }),
        }),
      );

      expect(probe.framework).toBe('next');
      const surfaces = JSON.stringify({ probe, records });
      for (const planted of [plantedPoweredBy, plantedVary, plantedCookie]) {
        expect(surfaces).not.toContain(planted);
      }
      expect(surfaces).not.toMatch(/next\.js|next-router-state-tree/i);
      const answered = records.find((record) => record.message === 'Dev-server probe answered');
      expect(answered?.fields).toMatchObject({ subsystem: 'dev-server', framework: 'next' });
    });
  });

  describe('a transport failure is an answer, not an error', () => {
    it('reports a refused connection as ok({ reachable: false }) with its errno code', async () => {
      const probe = expectOk(await probeDevServer(DEV_URL, { fetchImpl: refusing() }));

      expect(probe.reachable).toBe(false);
      expect(probe.status).toBeUndefined();
      expect(probe.error?.code).toBe('ECONNREFUSED');
      expect(probe.error?.message.length).toBeGreaterThan(0);
      // A fixed sentence, never the raw exception text.
      expect(probe.error?.message).not.toContain('fetch failed');
      expect(probe.error?.message).not.toContain('connect ECONNREFUSED');
    });

    it('reads a code carried on the error itself', async () => {
      const fetchImpl = vi.fn<FetchLike>(() =>
        Promise.reject(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })),
      );

      const probe = expectOk(await probeDevServer(DEV_URL, { fetchImpl }));

      expect(probe.error?.code).toBe('ECONNRESET');
      expect(probe.error?.message).not.toContain('socket hang up');
    });

    it('reports an AbortError as ABORTED', async () => {
      const abort = Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
      const fetchImpl = vi.fn<FetchLike>(() => Promise.reject(abort));

      const probe = expectOk(await probeDevServer(DEV_URL, { fetchImpl }));

      expect(probe).toMatchObject({ reachable: false, error: { code: 'ABORTED' } });
    });

    it('reports an uncoded failure as NETWORK_ERROR', async () => {
      const fetchImpl = vi.fn<FetchLike>(() => Promise.reject(new Error('opaque failure')));

      const probe = expectOk(await probeDevServer(DEV_URL, { fetchImpl }));

      expect(probe).toMatchObject({ reachable: false, error: { code: 'NETWORK_ERROR' } });
      expect(probe.error?.message).not.toContain('opaque failure');
    });

    it('ignores a code that is not errno-shaped rather than surfacing it', async () => {
      const fetchImpl = vi.fn<FetchLike>(() =>
        Promise.reject(Object.assign(new Error('odd'), { code: 'not a code; drop table' })),
      );

      const probe = expectOk(await probeDevServer(DEV_URL, { fetchImpl }));

      expect(probe.error?.code).toBe('NETWORK_ERROR');
    });

    it('treats a client that throws synchronously as unreachable, not as a crash', async () => {
      const fetchImpl = vi.fn<FetchLike>(() => {
        throw new TypeError('the client could not be constructed');
      });

      const probe = expectOk(await probeDevServer(DEV_URL, { fetchImpl }));

      expect(probe).toMatchObject({ reachable: false, error: { code: 'NETWORK_ERROR' } });
    });
  });

  describe('the timeout', () => {
    it('aborts a request that never settles once probeTimeoutMs elapses, leaking no timer', async () => {
      vi.useFakeTimers();
      try {
        const fetchImpl = vi.fn<FetchLike>(() => new Promise<FetchLikeResponse>(() => undefined));

        const pending = probeDevServer(DEV_URL, { fetchImpl, probeTimeoutMs: 250 });
        const signal = fetchImpl.mock.calls[0]?.[1]?.signal;
        expect(signal).toBeInstanceOf(AbortSignal);
        expect(signal?.aborted).toBe(false);

        await vi.advanceTimersByTimeAsync(249);
        expect(signal?.aborted).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect(signal?.aborted).toBe(true);

        const probe = expectOk(await pending);
        expect(probe.reachable).toBe(false);
        expect(probe.status).toBeUndefined();
        expect(probe.error?.code).toBe('TIMEOUT');
        expect(probe.error?.message).toContain('250 ms');
        // The timer is cleared whichever way the race ends.
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it('reports TIMEOUT, not ABORTED, when the client honours the abort by rejecting', async () => {
      // Node's fetch rejects with an AbortError when its signal fires. That
      // rejection happens after the timeout has already decided the race, and
      // it must be absorbed rather than escape as an unhandled rejection (which
      // Vitest would report as a failure of this test).
      vi.useFakeTimers();
      try {
        const fetchImpl = vi.fn<FetchLike>(
          (_input, init) =>
            new Promise<FetchLikeResponse>((_resolve, reject) => {
              init?.signal?.addEventListener('abort', () => {
                reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
              });
            }),
        );

        const pending = probeDevServer(DEV_URL, { fetchImpl, probeTimeoutMs: 100 });
        await vi.advanceTimersByTimeAsync(100);

        const probe = expectOk(await pending);
        expect(probe.error?.code).toBe('TIMEOUT');
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it('releases the body of a response that arrives after the timeout', async () => {
      vi.useFakeTimers();
      try {
        const late = deferred<FetchLikeResponse>();
        const cancel = vi.fn(() => Promise.resolve());
        const fetchImpl = vi.fn<FetchLike>(() => late.promise);

        const pending = probeDevServer(DEV_URL, { fetchImpl, probeTimeoutMs: 100 });
        await vi.advanceTimersByTimeAsync(100);
        const probe = expectOk(await pending);
        expect(probe.reachable).toBe(false);

        late.resolve({ status: 200, body: { cancel } });
        await vi.advanceTimersByTimeAsync(0);

        expect(cancel).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it.each([
      { label: 'absent', probeTimeoutMs: undefined },
      { label: 'zero', probeTimeoutMs: 0 },
      { label: 'negative', probeTimeoutMs: -5 },
      { label: 'NaN', probeTimeoutMs: Number.NaN },
      { label: 'infinite', probeTimeoutMs: Number.POSITIVE_INFINITY },
    ])('uses DEFAULT_PROBE_TIMEOUT_MS when the timeout is $label', async ({ probeTimeoutMs }) => {
      vi.useFakeTimers();
      try {
        const fetchImpl = vi.fn<FetchLike>(() => new Promise<FetchLikeResponse>(() => undefined));

        const pending = probeDevServer(DEV_URL, { fetchImpl, probeTimeoutMs });
        const signal = fetchImpl.mock.calls[0]?.[1]?.signal;

        await vi.advanceTimersByTimeAsync(DEFAULT_PROBE_TIMEOUT_MS - 1);
        expect(signal?.aborted).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect(signal?.aborted).toBe(true);
        expect(expectOk(await pending).error?.code).toBe('TIMEOUT');
      } finally {
        vi.useRealTimers();
      }
    });

    it('clamps an oversized timeout to MAX_PROBE_TIMEOUT_MS', async () => {
      vi.useFakeTimers();
      try {
        const fetchImpl = vi.fn<FetchLike>(() => new Promise<FetchLikeResponse>(() => undefined));

        const pending = probeDevServer(DEV_URL, { fetchImpl, probeTimeoutMs: 10 * 60_000 });
        const signal = fetchImpl.mock.calls[0]?.[1]?.signal;

        await vi.advanceTimersByTimeAsync(MAX_PROBE_TIMEOUT_MS - 1);
        expect(signal?.aborted).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect(signal?.aborted).toBe(true);
        expect(expectOk(await pending).error?.code).toBe('TIMEOUT');
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('durationMs', () => {
    it('is measured with the injected clock', async () => {
      const probe = expectOk(
        await probeDevServer(DEV_URL, {
          fetchImpl: answering(200),
          now: steppingClock(5_000, 5_042.5),
        }),
      );

      expect(probe.durationMs).toBe(42.5);
    });

    it.each([
      { label: 'runs backwards', now: steppingClock(5_000, 4_000) },
      { label: 'returns NaN', now: () => Number.NaN },
      { label: 'returns Infinity', now: () => Number.POSITIVE_INFINITY },
      {
        label: 'throws',
        now: (): number => {
          throw new Error('clock unavailable');
        },
      },
    ])('stays finite and non-negative when the clock $label', async ({ now }) => {
      const probe = expectOk(await probeDevServer(DEV_URL, { fetchImpl: answering(200), now }));

      expect(Number.isFinite(probe.durationMs)).toBe(true);
      expect(probe.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('is recorded on an unreachable probe too', async () => {
      const probe = expectOk(
        await probeDevServer(DEV_URL, { fetchImpl: refusing(), now: steppingClock(100, 103) }),
      );

      expect(probe).toMatchObject({ reachable: false, durationMs: 3 });
    });
  });

  describe('a URL query never leaves this module (AAP §0.5.2)', () => {
    const queryValue = plantedValue(11, 20);
    const url = `http://localhost:4100/catalog?session=${queryValue}#section-${queryValue}`;

    it('sends, returns and logs the origin and pathname only', async () => {
      const fetchImpl = answering(200);
      const { logger, records } = recordingLogger();

      const probe = expectOk(await probeDevServer(url, { fetchImpl, logger }));

      expect(probe.url).toBe('http://localhost:4100/catalog');
      expect(fetchImpl.mock.calls[0]?.[0]).toBe('http://localhost:4100/catalog');
      expect(JSON.stringify(probe)).not.toContain(queryValue);
      expect(records.length).toBeGreaterThan(0);
      expect(JSON.stringify(records)).not.toContain(queryValue);
    });

    it('keeps the query out of an unreachable probe and its log line as well', async () => {
      const { logger, records } = recordingLogger();

      const probe = expectOk(await probeDevServer(url, { fetchImpl: refusing(), logger }));

      expect(probe.reachable).toBe(false);
      expect(JSON.stringify(probe)).not.toContain(queryValue);
      expect(JSON.stringify(records)).not.toContain(queryValue);
    });
  });

  it('survives a logger that throws on every call', async () => {
    const probe = expectOk(
      await probeDevServer(DEV_URL, { fetchImpl: answering(200), logger: THROWING_LOGGER }),
    );

    expect(probe.reachable).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// readTargetManifest
// ---------------------------------------------------------------------------

describe('readTargetManifest', () => {
  it('projects a real package.json to exactly the TargetManifest fields', () => {
    const root = makeSandbox();
    writeManifest(root, PORTAL_MANIFEST);

    const manifest = expectOk(readTargetManifest(root));

    expect(manifest).toStrictEqual({
      name: 'acme-portal',
      scripts: {
        dev: 'next dev',
        build: 'next build',
        start: 'next start',
        lint: 'eslint .',
      },
      packageManagerField: 'pnpm@10.4.1',
      hasNextDependency: true,
    });
    expect(Object.keys(manifest).sort()).toEqual([
      'hasNextDependency',
      'name',
      'packageManagerField',
      'scripts',
    ]);
    // Nothing else survives: no dependency version map, no free text.
    const serialised = JSON.stringify(manifest);
    expect(serialised).not.toContain('16.1.0');
    expect(serialised).not.toContain('react-dom');
    expect(serialised).not.toContain(PORTAL_MANIFEST.description);
  });

  it('recognises next declared only as a devDependency', () => {
    const reader = servingManifest({
      scripts: { dev: 'next dev' },
      devDependencies: { next: '16.1.0' },
    });

    expect(expectOk(readTargetManifest(PROJECT_ROOT, { readManifest: reader }))).toStrictEqual({
      scripts: { dev: 'next dev' },
      hasNextDependency: true,
    });
  });

  it('omits absent or blank optional fields rather than inventing them', () => {
    const reader = servingManifest({
      name: '   ',
      packageManager: '',
      scripts: { dev: 'vite' },
      dependencies: { react: '19.1.0' },
    });

    const manifest = expectOk(readTargetManifest(PROJECT_ROOT, { readManifest: reader }));

    expect(manifest).toStrictEqual({ scripts: { dev: 'vite' }, hasNextDependency: false });
    expect('name' in manifest).toBe(false);
    expect('packageManagerField' in manifest).toBe(false);
  });

  it('drops non-string scripts values rather than coercing them', () => {
    const reader = servingManifest({
      scripts: {
        dev: 'next dev',
        port: 3000,
        enabled: true,
        disabled: null,
        steps: ['next build', 'next start'],
        nested: { run: 'next dev' },
      },
    });

    const manifest = expectOk(readTargetManifest(PROJECT_ROOT, { readManifest: reader }));

    expect(manifest.scripts).toStrictEqual({ dev: 'next dev' });
  });

  it.each([
    { label: 'an array', scripts: ['next dev'] },
    { label: 'a string', scripts: 'next dev' },
    { label: 'null', scripts: null },
    { label: 'a number', scripts: 42 },
  ])('treats scripts that are $label as no scripts', ({ scripts }) => {
    const reader = servingManifest({ name: 'acme-portal', scripts });

    expect(
      expectOk(readTargetManifest(PROJECT_ROOT, { readManifest: reader })).scripts,
    ).toStrictEqual({});
  });

  it('keeps a "__proto__" script as data, never as a prototype', () => {
    const reader = vi.fn<ManifestReader>(
      () => '{"scripts":{"__proto__":"next dev","dev":"next dev"}}',
    );

    const { scripts } = expectOk(readTargetManifest(PROJECT_ROOT, { readManifest: reader }));

    expect(Object.hasOwn(scripts, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(scripts)).toBe(Object.prototype);
    expect(scripts['dev']).toBe('next dev');
  });

  it('strips a UTF-8 byte-order mark, from bytes and from text alike', () => {
    const json = JSON.stringify({ scripts: { dev: 'next dev' } });
    const fromText = vi.fn<ManifestReader>(() => `\uFEFF${json}`);
    const fromBytes = vi.fn<ManifestReader>(() => new TextEncoder().encode(`\uFEFF${json}`));

    for (const readManifest of [fromText, fromBytes]) {
      expect(expectOk(readTargetManifest(PROJECT_ROOT, { readManifest })).scripts).toStrictEqual({
        dev: 'next dev',
      });
    }
  });

  describe('reads exactly one file (AAP §0.5.2)', () => {
    it('asks the reader for <projectRoot>/package.json once, and for nothing else', () => {
      const reader = servingManifest(PORTAL_MANIFEST);

      expectOk(readTargetManifest(PROJECT_ROOT, { readManifest: reader }));

      expect(reader).toHaveBeenCalledTimes(1);
      expect(reader).toHaveBeenCalledWith(join(PROJECT_ROOT, 'package.json'));
    });

    it('never touches a sibling .env file, even with the default reader', () => {
      const root = makeSandbox();
      writeManifest(root, PORTAL_MANIFEST);
      const planted = plantedValue(17);
      writeFileSync(join(root, '.env'), `${['SAMPLE', 'VALUE'].join('_')}=${planted}\n`);
      writeFileSync(join(root, '.env.local'), `${['OTHER', 'VALUE'].join('_')}=${planted}\n`);
      const reader = spyingDiskReader();

      const manifest = expectOk(readTargetManifest(root, { readManifest: reader }));

      expect(reader.mock.calls).toEqual([[join(root, 'package.json')]]);
      expect(JSON.stringify(manifest)).not.toContain(planted);
    });
  });

  describe('every failure is a typed Err, never a throw', () => {
    it.each(['relative/project', './acme-portal', '', '   '])(
      'refuses the relative project root %j without reading anything',
      (projectRoot) => {
        const reader = servingManifest(PORTAL_MANIFEST);

        const error = expectTypedErr(
          readTargetManifest(projectRoot, { readManifest: reader }),
          'PROJECT_NOT_FOUND',
        );

        expect(reasonOf(error)).toBe('relative-project-root');
        expect(reader).toHaveBeenCalledTimes(0);
      },
    );

    it('reports a missing package.json by path, suitable for downgrading to a note', () => {
      const root = makeSandbox();

      const error = expectTypedErr(readTargetManifest(root), 'PROJECT_NOT_FOUND');

      expect(reasonOf(error)).toBe('manifest-missing');
      expect(error.message).toContain(join(root, 'package.json'));
      expect(error.details?.['errno']).toBe('ENOENT');
    });

    it('reports a package.json that is a directory as unreadable', () => {
      const root = makeSandbox();
      mkdirSync(join(root, 'package.json'));

      const error = expectTypedErr(readTargetManifest(root), 'PROJECT_NOT_FOUND');

      expect(reasonOf(error)).toBe('manifest-unreadable');
    });

    it.each(['EACCES', 'EPERM'])('reports a reader failing with %s as unreadable', (code) => {
      const reader = vi.fn<ManifestReader>(() => {
        throw Object.assign(new Error(`${code}: permission denied, open`), { code });
      });

      const error = expectTypedErr(
        readTargetManifest(PROJECT_ROOT, { readManifest: reader }),
        'PROJECT_NOT_FOUND',
      );

      expect(reasonOf(error)).toBe('manifest-unreadable');
      expect(error.details?.['errno']).toBe(code);
    });

    it('never echoes the message of an uncoded reader failure', () => {
      const leaked = plantedValue(23);
      const reader = vi.fn<ManifestReader>(() => {
        throw new Error(`reader exploded near ${leaked}`);
      });

      const error = expectTypedErr(
        readTargetManifest(PROJECT_ROOT, { readManifest: reader }),
        'PROJECT_NOT_FOUND',
      );

      expect(reasonOf(error)).toBe('manifest-unreadable');
      expect(errorSurfaces(error)).not.toContain(leaked);
    });

    it('names the file of a malformed manifest but never echoes its content', () => {
      // V8's own JSON.parse message quotes the text around the offending
      // token, so an unquoted sentinel is exactly what a careless error would
      // leak.
      const root = makeSandbox();
      const sentinel = plantedValue(29, 24);
      writeFileSync(join(root, 'package.json'), `{"name": ${sentinel}, "scripts": {}}`);

      const error = expectTypedErr(readTargetManifest(root), 'PROJECT_NOT_FOUND');

      expect(reasonOf(error)).toBe('manifest-invalid-json');
      expect(error.message).toContain(join(root, 'package.json'));
      expect(errorSurfaces(error)).not.toContain(sentinel);
      expect(error.cause).toBeUndefined();
    });

    it.each(['[1, 2, 3]', 'null', '"next dev"', '42'])(
      'refuses the non-object manifest %s',
      (text) => {
        const reader = vi.fn<ManifestReader>(() => text);

        const error = expectTypedErr(
          readTargetManifest(PROJECT_ROOT, { readManifest: reader }),
          'PROJECT_NOT_FOUND',
        );

        expect(reasonOf(error)).toBe('manifest-not-object');
      },
    );
  });

  describe('the byte cap', () => {
    /** Valid JSON of exactly `bytes` UTF-8 bytes. */
    function manifestOfBytes(bytes: number): string {
      const prefix = '{"scripts":{"dev":"next dev"},"padding":"';
      const suffix = '"}';
      return prefix + 'x'.repeat(bytes - prefix.length - suffix.length) + suffix;
    }

    it('parses a manifest of exactly MAX_MANIFEST_BYTES bytes', () => {
      const reader = vi.fn<ManifestReader>(() => manifestOfBytes(MAX_MANIFEST_BYTES));

      expect(
        expectOk(readTargetManifest(PROJECT_ROOT, { readManifest: reader })).scripts,
      ).toStrictEqual({
        dev: 'next dev',
      });
    });

    it('refuses one byte more before parsing — even though it is valid JSON', () => {
      const reader = vi.fn<ManifestReader>(() => manifestOfBytes(MAX_MANIFEST_BYTES + 1));

      const error = expectTypedErr(
        readTargetManifest(PROJECT_ROOT, { readManifest: reader }),
        'PROJECT_NOT_FOUND',
      );

      expect(reasonOf(error)).toBe('manifest-too-large');
      expect(error.details?.['size']).toBe(MAX_MANIFEST_BYTES + 1);
    });

    it('counts UTF-8 bytes, not UTF-16 code units', () => {
      // "€" is one UTF-16 unit and three UTF-8 bytes: this text is well under
      // the cap in string length and over it in bytes.
      const text = `{"padding":"${'€'.repeat(Math.ceil(MAX_MANIFEST_BYTES / 3))}"}`;
      expect(text.length).toBeLessThan(MAX_MANIFEST_BYTES);
      const reader = vi.fn<ManifestReader>(() => text);

      const error = expectTypedErr(
        readTargetManifest(PROJECT_ROOT, { readManifest: reader }),
        'PROJECT_NOT_FOUND',
      );

      expect(reasonOf(error)).toBe('manifest-too-large');
    });

    it('applies to a byte buffer from the reader, and to a real file on disk', () => {
      const bytes = new TextEncoder().encode(manifestOfBytes(MAX_MANIFEST_BYTES + 1));
      const fromBytes = vi.fn<ManifestReader>(() => bytes);
      expect(
        reasonOf(
          expectTypedErr(
            readTargetManifest(PROJECT_ROOT, { readManifest: fromBytes }),
            'PROJECT_NOT_FOUND',
          ),
        ),
      ).toBe('manifest-too-large');

      const root = makeSandbox();
      writeFileSync(join(root, 'package.json'), bytes);
      expect(reasonOf(expectTypedErr(readTargetManifest(root), 'PROJECT_NOT_FOUND'))).toBe(
        'manifest-too-large',
      );
    });
  });

  describe('the default reader refuses to follow a symlinked package.json', () => {
    it.skipIf(SYMLINKS_UNAVAILABLE)(
      'surfaces the no-follow refusal as FS_UNSAFE_PATH rather than reading through the link',
      () => {
        const root = makeSandbox();
        const elsewhere = join(root, 'elsewhere');
        mkdirSync(elsewhere);
        const sentinel = plantedValue(31, 24);
        writeManifest(elsewhere, { name: sentinel, scripts: { dev: 'next dev' } });
        symlinkSync(join(elsewhere, 'package.json'), join(root, 'package.json'));

        const error = expectTypedErr(readTargetManifest(root), 'FS_UNSAFE_PATH');

        expect(reasonOf(error)).toBe('manifest-symlink');
        expect(error.details?.['errno']).toBe('ELOOP');
        expect(errorSurfaces(error)).not.toContain(sentinel);
      },
    );
  });
});

// ---------------------------------------------------------------------------
// selectDevScript
// ---------------------------------------------------------------------------

describe('selectDevScript', () => {
  // Selection is by the binary and subcommand a script invokes — `next`
  // followed by `dev` — and by the conventional `dev` name, never by a
  // whole-command literal or a project-specific script name. That shape rule
  // is what makes detection work on a Next.js project this suite has never
  // seen (acceptance test 4, AAP §0.8.4); every name below is invented.
  const cases: readonly {
    readonly label: string;
    readonly scripts: Readonly<Record<string, string>>;
    readonly expected: DevScriptSelection | undefined;
  }[] = [
    {
      label: 'a script named exactly "dev"',
      scripts: { dev: 'next dev' },
      expected: { name: 'dev', command: 'next dev' },
    },
    {
      label: '"dev" with flags beside a build script',
      scripts: { dev: 'next dev --turbo', build: 'next build' },
      expected: { name: 'dev', command: 'next dev --turbo' },
    },
    {
      label: '"dev" even when its command is not a framework command',
      scripts: { dev: 'vite', 'web:dev': 'next dev' },
      expected: { name: 'dev', command: 'vite' },
    },
    {
      label: 'no exact "dev": the script running the framework dev command',
      scripts: { start: 'next start', 'dev:web': 'next dev' },
      expected: { name: 'dev:web', command: 'next dev' },
    },
    {
      label: 'the framework command outranks a dev-prefixed name',
      scripts: { 'dev:docs': 'docs-site serve', serve: 'next dev -p 4000' },
      expected: { name: 'serve', command: 'next dev -p 4000' },
    },
    {
      label: 'an environment-wrapped invocation',
      scripts: { web: 'cross-env PORT=4000 next dev' },
      expected: { name: 'web', command: 'cross-env PORT=4000 next dev' },
    },
    {
      label: 'a package-runner invocation',
      scripts: { local: 'npx next dev' },
      expected: { name: 'local', command: 'npx next dev' },
    },
    {
      label: 'a direct path to the framework binary',
      scripts: { 'start:local': 'node node_modules/next/dist/bin/next dev' },
      expected: { name: 'start:local', command: 'node node_modules/next/dist/bin/next dev' },
    },
    {
      label: 'a Windows shim of the binary',
      scripts: { win: 'node_modules\\.bin\\next.cmd dev' },
      expected: { name: 'win', command: 'node_modules\\.bin\\next.cmd dev' },
    },
    {
      label: 'a flag between the binary and the subcommand',
      scripts: { inspect: 'next --inspect dev' },
      expected: { name: 'inspect', command: 'next --inspect dev' },
    },
    {
      label: 'a chained command whose second step is the dev command',
      scripts: { fresh: 'next build && next dev' },
      expected: { name: 'fresh', command: 'next build && next dev' },
    },
    {
      label: 'a quoted invocation',
      scripts: { quoted: '"next" "dev"' },
      expected: { name: 'quoted', command: '"next" "dev"' },
    },
    {
      label: 'the dev-prefixed name when no command matches',
      scripts: { 'dev:api': 'tsx watch server.ts', start: 'node server.js' },
      expected: { name: 'dev:api', command: 'tsx watch server.ts' },
    },
    {
      label: 'a blank "dev" is skipped in favour of a runnable one',
      scripts: { dev: '   ', 'dev:web': 'next dev' },
      expected: { name: 'dev:web', command: 'next dev' },
    },
    {
      label: 'only production commands',
      scripts: { build: 'next build', start: 'next start' },
      expected: undefined,
    },
    {
      label: 'near misses that are not the framework dev command',
      scripts: { a: 'next-dev', b: 'nextdev', c: 'echo next and dev', d: 'next build dev-assets' },
      expected: undefined,
    },
    { label: 'a blank "dev" alone', scripts: { dev: '' }, expected: undefined },
    { label: 'empty scripts', scripts: {}, expected: undefined },
  ];

  it.each(cases)('$label', ({ scripts, expected }) => {
    expect(selectDevScript({ scripts })).toStrictEqual(expected);
  });

  describe('several matching scripts have a deterministic, documented winner', () => {
    // Documented rule: among framework-command scripts, the first by name in
    // code-unit order wins — independent of declaration order and of locale.
    const webDev = ['web:dev', 'next dev'] as const;
    const preview = ['b-preview', 'next dev -p 4001'] as const;
    const appDev = ['app:dev', 'next dev --turbo'] as const;
    const entries = [webDev, preview, appDev] as const;

    it('chooses the first by code-unit name order, whatever the declaration order', () => {
      const orders = [entries, [appDev, preview, webDev], [preview, appDev, webDev]] as const;

      for (const order of orders) {
        const scripts = Object.fromEntries(order);
        expect(selectDevScript({ scripts })).toStrictEqual({
          name: 'app:dev',
          command: 'next dev --turbo',
        });
      }
    });

    it('returns the same answer on repeated calls', () => {
      const scripts = Object.fromEntries(entries);
      const answers = Array.from({ length: 5 }, () => selectDevScript({ scripts }));

      for (const answer of answers) {
        expect(answer).toStrictEqual(answers[0]);
      }
    });

    it('orders by code unit, not by locale: an uppercase name sorts before a lowercase one', () => {
      expect(
        selectDevScript({ scripts: { serve: 'next dev', Preview: 'next dev' } }),
      ).toStrictEqual({
        name: 'Preview',
        command: 'next dev',
      });
    });

    it('applies the same ordering to the dev-prefixed fallback', () => {
      expect(
        selectDevScript({
          scripts: { 'dev:worker': 'tsx watch worker.ts', 'dev:api': 'tsx watch api.ts' },
        }),
      ).toStrictEqual({ name: 'dev:api', command: 'tsx watch api.ts' });
    });
  });
});

// ---------------------------------------------------------------------------
// formatRelaunchCommand, packageManagerRunArgs and buildRelaunchHint
// ---------------------------------------------------------------------------

describe('formatRelaunchCommand', () => {
  const devScript: DevScriptSelection = { name: 'dev', command: 'next dev' };

  /** One row per package manager with a runner binary. */
  const runners: readonly {
    readonly packageManager: KnownPackageManagerId;
    readonly run: string;
    readonly args: readonly string[];
  }[] = [
    { packageManager: 'pnpm', run: 'pnpm run dev', args: ['pnpm', 'run', 'dev'] },
    { packageManager: 'npm', run: 'npm run dev', args: ['npm', 'run', 'dev'] },
    // Yarn runs a script by name; there is no `run` word.
    { packageManager: 'yarn', run: 'yarn dev', args: ['yarn', 'dev'] },
    { packageManager: 'bun', run: 'bun run dev', args: ['bun', 'run', 'dev'] },
  ];

  it('covers every package manager of the code-analysis vocabulary', () => {
    expect(new Set(runners.map((row) => row.packageManager))).toEqual(
      new Set(PACKAGE_MANAGERS.filter((id) => id !== 'unknown')),
    );
  });

  it.each(runners)('renders the exact $packageManager command', ({ packageManager, run }) => {
    const command = formatRelaunchCommand({
      projectRoot: PROJECT_ROOT,
      packageManager,
      devScript,
      preloadUrl: PRELOAD_URL,
      ingestUrl: INGEST_URL,
    });

    expect(command).toBe(expectedCommand(PROJECT_ROOT, run));
  });

  it.each(runners)(
    'packageManagerRunArgs matches the $packageManager runner form, as a frozen vector',
    ({ packageManager, args }) => {
      const vector = packageManagerRunArgs(packageManager, 'dev');

      expect(vector).toEqual(args);
      expect(Object.isFrozen(vector)).toBe(true);
    },
  );

  it('invents no binary for an unknown package manager', () => {
    const command = formatRelaunchCommand({
      projectRoot: PROJECT_ROOT,
      packageManager: 'unknown',
      devScript,
      preloadUrl: PRELOAD_URL,
      ingestUrl: INGEST_URL,
    });

    expect(command).toBe(expectedCommand(PROJECT_ROOT, '<package-manager> run dev'));
    expect(command).not.toMatch(/(?:^|\s)(?:pnpm|npm|yarn|bun)(?:\s|$)/);
    expect(packageManagerRunArgs('unknown', 'dev')).toBeUndefined();
  });

  it('renders the <dev-script> placeholder when no script was selected', () => {
    const command = formatRelaunchCommand({ projectRoot: PROJECT_ROOT, packageManager: 'pnpm' });

    expect(command.startsWith(`cd ${PROJECT_ROOT} && `)).toBe(true);
    expect(command.endsWith(`pnpm run ${RELAUNCH_PLACEHOLDERS.devScript}`)).toBe(true);
  });

  it('renders shell references for a preload and an ingest URL it was not given', () => {
    const command = formatRelaunchCommand({
      projectRoot: PROJECT_ROOT,
      packageManager: 'npm',
      devScript,
    });

    expect(command).toBe(
      expectedCommand(
        PROJECT_ROOT,
        'npm run dev',
        RELAUNCH_PLACEHOLDERS.preloadUrl,
        `"${RELAUNCH_PLACEHOLDERS.ingestUrl}"`,
      ),
    );
  });

  it.each([
    { label: 'an http: preload URL', preloadUrl: 'http://127.0.0.1:4100/register.mjs' },
    { label: 'a bare path', preloadUrl: PRELOAD_PATH },
    { label: 'a malformed preload URL', preloadUrl: 'file://[' },
  ])('ignores $label: only a file: URL is imported', ({ preloadUrl }) => {
    const command = formatRelaunchCommand({
      projectRoot: PROJECT_ROOT,
      packageManager: 'npm',
      devScript,
      preloadUrl,
      ingestUrl: INGEST_URL,
    });

    expect(command).toContain(`--import ${RELAUNCH_PLACEHOLDERS.preloadUrl}"`);
  });

  it.each([
    { label: 'an ftp: ingest URL', ingestUrl: 'ftp://127.0.0.1/telemetry/ingest' },
    { label: 'an ingest URL with credentials', ingestUrl: credentialUrl('127.0.0.1:43117') },
    { label: 'a malformed ingest URL', ingestUrl: 'not a url' },
  ])('ignores $label: only a credential-free http(s) endpoint is rendered', ({ ingestUrl }) => {
    const command = formatRelaunchCommand({
      projectRoot: PROJECT_ROOT,
      packageManager: 'npm',
      devScript,
      preloadUrl: PRELOAD_URL,
      ingestUrl,
    });

    expect(command).toContain(`DEBUGGEN_INGEST_URL="${RELAUNCH_PLACEHOLDERS.ingestUrl}"`);
    expect(command).not.toContain(ingestUrl);
  });

  describe('the environment contract mirrors the launcher', () => {
    const command = formatRelaunchCommand({
      projectRoot: PROJECT_ROOT,
      packageManager: 'pnpm',
      devScript,
      preloadUrl: PRELOAD_URL,
      ingestUrl: INGEST_URL,
    });

    it('assigns exactly the four preload variables, in order', () => {
      const assigned = [...command.matchAll(/(?:^|\s)([A-Z][A-Z0-9_]*)=/g)].map(
        (match) => match[1],
      );

      expect(assigned).toEqual([...EXPECTED_PRELOAD_ENV_KEYS]);
    });

    it('appends to NODE_OPTIONS with an --import of the file: preload URL, never replacing it', () => {
      expect(command).toContain(
        'NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--import ' + PRELOAD_URL + '"',
      );
    });

    it('points DEBUGGEN_INGEST_URL at the ingest endpoint and DEBUGGEN_PROJECT_ROOT at the project', () => {
      expect(command).toContain(`DEBUGGEN_INGEST_URL=${INGEST_URL} `);
      expect(command).toContain(`DEBUGGEN_PROJECT_ROOT=${PROJECT_ROOT} `);
    });
  });

  describe('it is one deterministic line', () => {
    it.each([
      { label: 'a plain root', projectRoot: PROJECT_ROOT, rootWord: PROJECT_ROOT },
      {
        label: 'a root with a space',
        projectRoot: '/home/dev/field portal',
        rootWord: "'/home/dev/field portal'",
      },
      {
        label: 'a root with a quote',
        projectRoot: "/home/dev/o'brien-portal",
        rootWord: "'/home/dev/o'\\''brien-portal'",
      },
      {
        label: 'a root with a newline',
        projectRoot: '/home/dev/odd\nname',
        rootWord: "$'/home/dev/odd\\x0aname'",
      },
    ])('quotes $label as one shell word', ({ projectRoot, rootWord }) => {
      const input: RelaunchCommandInput = {
        projectRoot,
        packageManager: 'pnpm',
        devScript,
        preloadUrl: PRELOAD_URL,
        ingestUrl: INGEST_URL,
      };

      const command = formatRelaunchCommand(input);

      expect(command).toBe(expectedCommand(rootWord, 'pnpm run dev'));
      expect(command).not.toMatch(/[\r\n]/);
      expect(formatRelaunchCommand(input)).toBe(command);
    });

    it('percent-encodes shell-active characters of a preload URL so they stay inert', () => {
      const command = formatRelaunchCommand({
        projectRoot: PROJECT_ROOT,
        packageManager: 'pnpm',
        devScript,
        preloadUrl: 'file:///opt/debuggen/$HOME/`id`/register.mjs',
      });

      expect(command).toContain('--import file:///opt/debuggen/%24HOME/%60id%60/register.mjs"');
    });
  });

  it('never spells the demo target tree', () => {
    const command = formatRelaunchCommand({
      projectRoot: PROJECT_ROOT,
      packageManager: 'pnpm',
      devScript,
    });

    expect(command).not.toContain(DEMO_TREE_FRAGMENT);
  });
});

describe('buildRelaunchHint', () => {
  const devScript: DevScriptSelection = { name: 'dev', command: 'next dev' };

  /** Every combination of package manager, script and URL knowledge a hint can be built from. */
  const inputs: readonly RelaunchCommandInput[] = PACKAGE_MANAGERS.flatMap(
    (packageManager: PackageManagerId) =>
      [undefined, devScript].flatMap((script) =>
        [false, true].map((withUrls): RelaunchCommandInput => ({
          projectRoot: PROJECT_ROOT,
          packageManager,
          devScript: script,
          ...(withUrls ? { preloadUrl: PRELOAD_URL, ingestUrl: INGEST_URL } : {}),
        })),
      ),
  );

  it('leads with the token-free editor command, then offers the exact command', () => {
    const input: RelaunchCommandInput = {
      projectRoot: PROJECT_ROOT,
      packageManager: 'yarn',
      devScript,
      preloadUrl: PRELOAD_URL,
      ingestUrl: INGEST_URL,
    };

    const hint = buildRelaunchHint(input);

    expect(hint).toContain(`"${LAUNCH_DEV_SERVER_COMMAND_TITLE}"`);
    expect(hint.indexOf(LAUNCH_DEV_SERVER_COMMAND_TITLE)).toBeLessThan(hint.indexOf('cd '));
    expect(hint.endsWith(`: ${expectedCommand(PROJECT_ROOT, 'yarn dev')}`)).toBe(true);
    expect(hint).toMatch(/server and database spans cannot be captured/i);
  });

  it('tells the developer what to fill in when the manager and script are unknown', () => {
    const hint = buildRelaunchHint({ projectRoot: PROJECT_ROOT, packageManager: 'unknown' });

    expect(hint).toContain(
      `${RELAUNCH_PLACEHOLDERS.packageManager} with this project's package manager`,
    );
    expect(hint).toContain(
      `${RELAUNCH_PLACEHOLDERS.devScript} with the script that starts its dev server`,
    );
    expect(hint).toContain(
      'after exporting DEBUGGEN_PRELOAD_URL, DEBUGGEN_INGEST_URL and DEBUGGEN_TOKEN',
    );
    expect(hint).toContain(PROJECT_ROOT);
    expect(hint).toContain(LAUNCH_DEV_SERVER_COMMAND_TITLE);
  });

  it('still says what to do without a dev script', () => {
    const hint = buildRelaunchHint({ projectRoot: PROJECT_ROOT, packageManager: 'npm' });

    expect(hint).toContain(`Run "${LAUNCH_DEV_SERVER_COMMAND_TITLE}" in VS Code`);
    expect(hint).toContain(`npm run ${RELAUNCH_PLACEHOLDERS.devScript}`);
  });

  it('asks only for DEBUGGEN_TOKEN when both URLs are concrete', () => {
    const hint = buildRelaunchHint({
      projectRoot: PROJECT_ROOT,
      packageManager: 'pnpm',
      devScript,
      preloadUrl: PRELOAD_URL,
      ingestUrl: INGEST_URL,
    });

    expect(hint).toContain('after exporting DEBUGGEN_TOKEN (');
    expect(hint).not.toContain('exporting DEBUGGEN_PRELOAD_URL');
  });

  describe('token safety: DEBUGGEN_TOKEN is only ever a shell reference', () => {
    const labelled = inputs.map((input) => ({
      input,
      label: [
        input.packageManager,
        input.devScript?.name ?? 'no script',
        input.preloadUrl === undefined ? 'shell references' : 'concrete URLs',
      ].join(' / '),
    }));

    it.each(labelled)('holds for $label', ({ input }) => {
      for (const text of [formatRelaunchCommand(input), buildRelaunchHint(input)]) {
        const assignments = [...text.matchAll(/DEBUGGEN_TOKEN=(\S*)/g)].map((match) => match[1]);
        expect(assignments.length).toBeGreaterThan(0);
        for (const value of assignments) {
          expect(value).toBe(`"${RELAUNCH_PLACEHOLDERS.token}"`);
        }
        expect(secretShapedRuns(text)).toEqual([]);
      }
    });

    it('the secret-shape detector is not vacuous', () => {
      expect(secretShapedRuns(`DEBUGGEN_TOKEN=${plantedValue(41)}`)).toHaveLength(1);
    });

    it('never picks a token up from the environment', () => {
      const planted = plantedValue(43);
      vi.stubEnv('DEBUGGEN_TOKEN', planted);

      for (const input of inputs) {
        expect(formatRelaunchCommand(input)).not.toContain(planted);
        expect(buildRelaunchHint(input)).not.toContain(planted);
      }
    });
  });

  it('is one line within READINESS_HINT_MAX_LENGTH, byte-identical across calls', () => {
    for (const input of inputs) {
      const hint = buildRelaunchHint(input);

      expect(hint).not.toMatch(/[\r\n]/);
      expect(hint.length).toBeLessThanOrEqual(READINESS_HINT_MAX_LENGTH);
      expect(buildRelaunchHint(input)).toBe(hint);
      expect(hint).not.toContain(DEMO_TREE_FRAGMENT);
    }
  });

  it('drops the manual command, keeping the editor action, when a long root would overflow the limit', () => {
    const projectRoot = `/home/dev/${'nested/'.repeat(200)}portal`;

    const hint = buildRelaunchHint({ projectRoot, packageManager: 'pnpm', devScript });

    expect(hint.length).toBeLessThanOrEqual(READINESS_HINT_MAX_LENGTH);
    expect(hint).toContain(LAUNCH_DEV_SERVER_COMMAND_TITLE);
    expect(hint).not.toContain(projectRoot);
    expect(hint).not.toMatch(/[\r\n]/);
  });

  it('keeps a pathological root with a newline on one line', () => {
    const hint = buildRelaunchHint({
      projectRoot: '/home/dev/odd\nname',
      packageManager: 'pnpm',
      devScript,
    });

    expect(hint).not.toMatch(/[\r\n]/);
  });
});

// ---------------------------------------------------------------------------
// Relaunch text provenance (CWE-209): what this module composes is proven
// ---------------------------------------------------------------------------

describe('relaunch text provenance', () => {
  it('registers every relaunch hint it composes, and nothing that merely resembles one', () => {
    const devScript: DevScriptSelection = { name: 'dev', command: 'next dev' };

    for (const packageManager of PACKAGE_MANAGERS) {
      const input: RelaunchCommandInput = {
        projectRoot: PROJECT_ROOT,
        packageManager,
        devScript,
        preloadUrl: PRELOAD_URL,
        ingestUrl: INGEST_URL,
      };
      const hint = buildRelaunchHint(input);

      expect(isProductAuthoredText(hint), hint).toBe(true);
      // Exact text only: an adapter's relaunch text quoting the same command,
      // or the hint with anything appended, is not the product's.
      expect(isProductAuthoredText(`Restart with: ${formatRelaunchCommand(input)}`)).toBe(false);
      expect(isProductAuthoredText(`${hint} ?token=zz-private`)).toBe(false);
    }
  });

  it('registers a detection’s relaunch hint and the gap reasons readiness quotes', async () => {
    const { serverAgents } = presence(false);
    const detections = [
      await detectDevServer(
        { projectRoot: PROJECT_ROOT, devServerUrl: DEV_URL },
        portalDeps({ fetchImpl: answering(200), serverAgents }),
      ),
      await detectDevServer(
        { projectRoot: PROJECT_ROOT, devServerUrl: DEV_URL },
        portalDeps({ fetchImpl: refusing(), serverAgents }),
      ),
    ];

    for (const detection of detections) {
      expect(detection.preloadAttached).toBe(false);
      expect(isProductAuthoredText(detection.relaunchHint)).toBe(true);

      const unavailable = buildPreloadUnavailableSignals(detection);
      expect(unavailable.length).toBeGreaterThan(0);
      for (const entry of unavailable) {
        expect(isProductAuthoredText(entry.reason), entry.reason).toBe(true);
        expect(isProductAuthoredText(entry.hint)).toBe(true);
      }
    }
  });

  it('never proves a hint a caller supplied on a detection it built itself', () => {
    const foreign = 'Restart with: cd /home/dev/acme-portal && SECRET=zz-private pnpm dev';
    const unavailable = buildPreloadUnavailableSignals({
      running: true,
      preloadAttached: false,
      preloadReason: 'no-server-agent-connection',
      relaunchHint: foreign,
    });

    expect(unavailable.length).toBeGreaterThan(0);
    for (const entry of unavailable) {
      // The reason is this module's own; the hint is relayed, never registered.
      expect(isProductAuthoredText(entry.reason)).toBe(true);
      expect(entry.hint).toBe(foreign);
      expect(isProductAuthoredText(entry.hint)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// detectDevServer
// ---------------------------------------------------------------------------

describe('detectDevServer', () => {
  describe('the four states', () => {
    it('running with a server-agent connected: preload attached, nothing to launch', async () => {
      const { serverAgents, hasServerAgentForProject } = presence(true);
      const fetchImpl = answeringAsNext(200);

      const detection = await detectDevServer(
        { projectRoot: PROJECT_ROOT, devServerUrl: DEV_URL },
        portalDeps({ fetchImpl, serverAgents }),
      );

      expect(detection).toMatchObject({
        projectRoot: PROJECT_ROOT,
        devServerUrl: DEV_URL,
        running: true,
        // The signature identifies the server; the connection only attaches the preload.
        identifiedBy: 'framework-signature',
        preloadAttached: true,
        preloadReason: 'server-agent-connected',
        canLaunch: false,
        packageManager: 'pnpm',
        packageManagerSource: 'manifest-field',
        devScript: { name: 'dev', command: 'next dev' },
        probe: { url: DEV_URL, reachable: true, status: 200, framework: 'next', durationMs: 12 },
      });
      expect('occupied' in detection).toBe(false);
      expect(detection.notes).toEqual([]);
      expect(hasServerAgentForProject).toHaveBeenCalledWith(PROJECT_ROOT);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(detection.relaunchHint).toContain('already runs with the Debug Generator preload');
      expect(buildPreloadUnavailableSignals(detection)).toEqual([]);
    });

    it('running without a server-agent: the exact relaunch command readiness reports (AAP §0.5.5)', async () => {
      const { serverAgents } = presence(false);

      const detection = await detectDevServer(
        { projectRoot: PROJECT_ROOT, devServerUrl: DEV_URL },
        portalDeps({ fetchImpl: answeringAsNext(200), serverAgents }),
      );

      expect(detection).toMatchObject({
        running: true,
        identifiedBy: 'framework-signature',
        preloadAttached: false,
        preloadReason: 'no-server-agent-connection',
        canLaunch: false,
      });
      expect('occupied' in detection).toBe(false);
      expect(detection.relaunchCommand).toBe(expectedCommand(PROJECT_ROOT, 'pnpm run dev'));
      expect(detection.relaunchHint).toMatch(
        /^This project's dev server is running without the Debug Generator preload/,
      );
      expect(detection.relaunchHint.endsWith(`: ${detection.relaunchCommand}`)).toBe(true);
      expect(detection.relaunchHint).toContain(
        `Stop it, then run "${LAUNCH_DEV_SERVER_COMMAND_TITLE}"`,
      );
      expect(detection.relaunchHint.length).toBeLessThanOrEqual(READINESS_HINT_MAX_LENGTH);
      expect(buildRelaunchHint(detection)).toBe(detection.relaunchHint);
      expect(detection.notes).toEqual([
        expect.stringMatching(/no server-agent connection exists for this project/),
      ]);

      // What src/instrumentation/readiness.ts turns into UnavailableSignal
      // entries: one per preload-dependent signal, every hint the same command.
      const unavailable = buildPreloadUnavailableSignals(detection);
      expect(unavailable.map((entry) => entry.signal)).toEqual([...PRELOAD_DEPENDENT_SIGNALS]);
      for (const entry of unavailable) {
        expect(entry.hint).toBe(detection.relaunchHint);
        expect(entry.reason).toBe('no dev-server preload is attached for this project');
      }
    });

    it('not running, dev script found: launchable', async () => {
      const { serverAgents } = presence(false);

      const detection = await detectDevServer(
        { projectRoot: PROJECT_ROOT, devServerUrl: DEV_URL },
        portalDeps({ fetchImpl: refusing(), serverAgents }),
      );

      expect(detection).toMatchObject({
        running: false,
        preloadAttached: false,
        preloadReason: 'not-running',
        canLaunch: true,
        devScript: { name: 'dev', command: 'next dev' },
        probe: { url: DEV_URL, reachable: false, error: { code: 'ECONNREFUSED' } },
      });
      // Nothing answered, so nothing holds the address and nothing was identified.
      expect('occupied' in detection).toBe(false);
      expect('identifiedBy' in detection).toBe(false);
      expect(detection.relaunchHint).toMatch(
        /^No dev server with the Debug Generator preload is running/,
      );
      expect(detection.notes).toEqual([
        expect.stringMatching(/^No dev server answered at http:\/\/127\.0\.0\.1:4100\//),
      ]);
      expect(buildPreloadUnavailableSignals(detection)[0]?.reason).toBe(
        'no dev server with the preload is running for this project',
      );
    });

    it('not running because no URL is known: nothing is probed, still launchable', async () => {
      const fetchImpl = answering(200);

      const detection = await detectDevServer(
        { projectRoot: PROJECT_ROOT },
        portalDeps({ fetchImpl }),
      );

      expect(fetchImpl).toHaveBeenCalledTimes(0);
      expect(detection).toMatchObject({
        running: false,
        preloadReason: 'not-running',
        canLaunch: true,
      });
      expect('probe' in detection).toBe(false);
      expect('devServerUrl' in detection).toBe(false);
      expect(detection.notes).toEqual([expect.stringMatching(/No dev-server URL is known/)]);
    });

    it('not running, no dev script: not launchable, with a note saying why', async () => {
      const detection = await detectDevServer(
        { projectRoot: PROJECT_ROOT, devServerUrl: DEV_URL },
        portalDeps({
          fetchImpl: refusing(),
          readManifest: servingManifest({
            packageManager: 'npm@10.9.0',
            scripts: { build: 'next build', start: 'next start' },
            dependencies: { next: '16.1.0' },
          }),
        }),
      );

      expect(detection).toMatchObject({ running: false, canLaunch: false, packageManager: 'npm' });
      expect('devScript' in detection).toBe(false);
      expect(detection.relaunchCommand.endsWith(`npm run ${RELAUNCH_PLACEHOLDERS.devScript}`)).toBe(
        true,
      );
      expect(detection.notes).toContainEqual(expect.stringMatching(/declares no dev script/));
    });

    it('not running, no manifest: not launchable, with a note saying why', async () => {
      const root = makeSandbox();

      const detection = await detectDevServer(
        { projectRoot: root, devServerUrl: DEV_URL },
        { fetchImpl: refusing() },
      );

      expect(detection).toMatchObject({
        running: false,
        canLaunch: false,
        packageManager: 'unknown',
        packageManagerSource: 'unknown',
      });
      expect('devScript' in detection).toBe(false);
      expect(detection.notes).toContainEqual(
        expect.stringMatching(/package\.json was not used: No package\.json was found/),
      );
      expect(detection.relaunchCommand).toContain(`${RELAUNCH_PLACEHOLDERS.packageManager} run`);
    });

    it('notes a manifest that does not declare next', async () => {
      const detection = await detectDevServer(
        { projectRoot: PROJECT_ROOT },
        portalDeps({
          readManifest: servingManifest({ packageManager: 'bun@1.2.0', scripts: { dev: 'vite' } }),
        }),
      );

      expect(detection.canLaunch).toBe(true);
      expect(detection.notes).toContainEqual(
        expect.stringMatching(/does not list next as a dependency/),
      );
    });

    it('reports every preload reason from the documented vocabulary', async () => {
      const reasons = new Set<string>();
      const scenarios: readonly DevServerDetectDeps[] = [
        portalDeps({ fetchImpl: answeringAsNext(200), serverAgents: presence(true).serverAgents }),
        portalDeps({ fetchImpl: answeringAsNext(200), serverAgents: presence(false).serverAgents }),
        portalDeps({ fetchImpl: refusing(), serverAgents: presence(false).serverAgents }),
        portalDeps({ fetchImpl: answeringAsNext(200) }),
      ];

      for (const deps of scenarios) {
        const detection = await detectDevServer(
          { projectRoot: PROJECT_ROOT, devServerUrl: DEV_URL },
          deps,
        );
        reasons.add(detection.preloadReason);
      }

      expect([...reasons].sort()).toEqual([...DEV_SERVER_PRELOAD_REASONS].sort());
    });
  });

  describe('preload evidence comes only from the ServerAgentPresence port', () => {
    it('reports "unknown" for a running server when no registry is injected, without throwing', async () => {
      const detection = await detectDevServer(
        { projectRoot: PROJECT_ROOT, devServerUrl: DEV_URL },
        portalDeps({ fetchImpl: answeringAsNext(200) }),
      );

      expect(detection).toMatchObject({
        running: true,
        identifiedBy: 'framework-signature',
        preloadAttached: false,
        preloadReason: 'unknown',
        canLaunch: false,
      });
      expect('occupied' in detection).toBe(false);
      expect(detection.relaunchHint).toMatch(/could not be confirmed/);
      expect(detection.notes).toContainEqual(
        expect.stringMatching(/No server-agent registry was available/),
      );
    });

    it('reports "not-running" when nothing answered, whatever the registry says', async () => {
      const { serverAgents } = presence(true);

      const detection = await detectDevServer(
        { projectRoot: PROJECT_ROOT, devServerUrl: DEV_URL },
        portalDeps({ fetchImpl: refusing(), serverAgents }),
      );

      expect(detection).toMatchObject({
        running: false,
        preloadAttached: false,
        preloadReason: 'not-running',
      });
      expect(detection.notes).toContainEqual(
        expect.stringMatching(
          /A server-agent is connected for this project, but no dev server answered/,
        ),
      );
    });

    it('does not treat a truthy non-boolean registry answer as a connection', async () => {
      // A JavaScript implementation of the port could answer `1`; only `true` is evidence.
      const serverAgents: ServerAgentPresence = {
        hasServerAgentForProject: () => 1 as unknown as boolean,
      };

      const detection = await detectDevServer(
        { projectRoot: PROJECT_ROOT, devServerUrl: DEV_URL },
        portalDeps({ fetchImpl: answeringAsNext(200), serverAgents }),
      );

      expect(detection.preloadAttached).toBe(false);
      expect(detection.preloadReason).toBe('no-server-agent-connection');
      expect(detection.identifiedBy).toBe('framework-signature');
    });

    it('reads hasServerAgentForProject only, even from a registry that can describe its connection', async () => {
      const hasServerAgentForProject = vi.fn<(projectRoot: string) => boolean>(() => true);
      // The client registry also answers serverAgentForProject; detection must not ask it.
      const serverAgentForProject = vi.fn<(projectRoot: string) => unknown>(() =>
        ok({ online: true, connectedAt: 1 }),
      );
      const registry = { hasServerAgentForProject, serverAgentForProject };

      const detection = await detectDevServer(
        { projectRoot: PROJECT_ROOT, devServerUrl: DEV_URL },
        portalDeps({ fetchImpl: answeringAsNext(200), serverAgents: registry }),
      );

      expect(detection).toMatchObject({
        running: true,
        identifiedBy: 'framework-signature',
        preloadAttached: true,
      });
      expect(hasServerAgentForProject).toHaveBeenCalledTimes(1);
      expect(serverAgentForProject).toHaveBeenCalledTimes(0);
    });
  });

  describe("server identity: an answer is this project's dev server only on evidence", () => {
    /** The occupied hint's opening, independent of the relaunch command it quotes. */
    const OCCUPIED_OPENING = /^Another process answers at this project's dev-server address/;

    /** The fixed occupied note for an unsigned answer with `status` at {@link DEV_URL}. */
    function unsignedNote(status: number): string {
      return `Something answered at ${DEV_URL} with HTTP ${status}, but the response carries no Next.js signature, so it is not identifiable as this project's dev server and is treated as another process holding the address.`;
    }

    /** The sentence the occupied note adds when a server-agent is connected for the project. */
    const AGENT_ELSEWHERE =
      " A server-agent is connected for this project, but the process answering at that URL was not identified, so the agent's dev server may be listening at a different address; check that debuggen.devServerUrl names it.";

    it.each([404, 500])(
      'an unidentified HTTP %i is occupied: not running, not launchable, not "running without the preload"',
      async (status) => {
        const { serverAgents } = presence(false);

        const detection = await detectDevServer(
          { projectRoot: PROJECT_ROOT, devServerUrl: DEV_URL },
          portalDeps({ fetchImpl: answeringAs(status, UNRELATED_SERVER_HEADERS), serverAgents }),
        );

        expect(detection).toMatchObject({
          devServerUrl: DEV_URL,
          running: false,
          occupied: true,
          preloadAttached: false,
          preloadReason: 'not-running',
          // The portal manifest has a dev script; the occupied address alone blocks the launch.
          devScript: { name: 'dev', command: 'next dev' },
          canLaunch: false,
          probe: { url: DEV_URL, reachable: true, status },
        });
        expect('identifiedBy' in detection).toBe(false);
        expect(detection.notes).toEqual([unsignedNote(status)]);

        expect(detection.relaunchHint).toMatch(OCCUPIED_OPENING);
        expect(detection.relaunchHint).not.toMatch(/running without the Debug Generator preload/);
        expect(detection.relaunchHint).toContain(
          `Stop the process holding that address, or set debuggen.devServerUrl to this project's dev-server address, then run "${LAUNCH_DEV_SERVER_COMMAND_TITLE}"`,
        );
        expect(detection.relaunchHint.endsWith(`: ${detection.relaunchCommand}`)).toBe(true);
        expect(detection.relaunchHint.length).toBeLessThanOrEqual(READINESS_HINT_MAX_LENGTH);
        expect(buildRelaunchHint(detection)).toBe(detection.relaunchHint);

        const unavailable = buildPreloadUnavailableSignals(detection);
        expect(unavailable.map((entry) => entry.signal)).toEqual([...PRELOAD_DEPENDENT_SIGNALS]);
        for (const entry of unavailable) {
          expect(entry.reason).toBe(
            'another process holds the dev-server address for this project',
          );
          expect(entry.hint).toBe(detection.relaunchHint);
        }
      },
    );

    it('treats an answer without a headers object as unidentified too', async () => {
      const detection = await detectDevServer(
        { projectRoot: PROJECT_ROOT, devServerUrl: DEV_URL },
        portalDeps({ fetchImpl: answering(200), serverAgents: presence(false).serverAgents }),
      );

      expect(detection).toMatchObject({ running: false, occupied: true, canLaunch: false });
    });

    it('reports an unsigned answer as occupied when no registry is injected, naming no connection', async () => {
      const detection = await detectDevServer(
        { projectRoot: PROJECT_ROOT, devServerUrl: DEV_URL },
        portalDeps({ fetchImpl: answeringAs(404, UNRELATED_SERVER_HEADERS) }),
      );

      expect(detection).toMatchObject({
        running: false,
        occupied: true,
        preloadReason: 'not-running',
        canLaunch: false,
      });
      expect(detection.notes).toEqual([unsignedNote(404)]);
    });

    it('keeps both notes when an occupied address meets a registry that throws', async () => {
      const detection = await detectDevServer(
        { projectRoot: PROJECT_ROOT, devServerUrl: DEV_URL },
        portalDeps({
          fetchImpl: answeringAs(500, UNRELATED_SERVER_HEADERS),
          serverAgents: {
            hasServerAgentForProject: () => {
              throw new Error('registry offline');
            },
          },
        }),
      );

      expect(detection).toMatchObject({ running: false, occupied: true, canLaunch: false });
      expect(detection.notes).toEqual([
        expect.stringMatching(/server-agent registry could not be queried/),
        unsignedNote(500),
      ]);
    });

    it.each([404, 500])(
      'identifies a Next.js dev server answering HTTP %i by its signature: running without the preload',
      async (status) => {
        const detection = await detectDevServer(
          { projectRoot: PROJECT_ROOT, devServerUrl: DEV_URL },
          portalDeps({
            fetchImpl: answeringAsNext(status),
            serverAgents: presence(false).serverAgents,
          }),
        );

        expect(detection).toMatchObject({
          running: true,
          identifiedBy: 'framework-signature',
          preloadReason: 'no-server-agent-connection',
          canLaunch: false,
          probe: { status, framework: 'next' },
        });
        expect('occupied' in detection).toBe(false);
      },
    );

    it.each([404, 500])(
      'never lets a connected server-agent vouch for an unsigned HTTP %i: occupied, not launchable, the note names the agent',
      async (status) => {
        // The agent is connected for the project, but its dev server may be on
        // another port: presence says nothing about who holds this address.
        const { serverAgents, hasServerAgentForProject } = presence(true);

        const detection = await detectDevServer(
          { projectRoot: PROJECT_ROOT, devServerUrl: DEV_URL },
          portalDeps({ fetchImpl: answeringAs(status, UNRELATED_SERVER_HEADERS), serverAgents }),
        );

        expect(detection).toMatchObject({
          devServerUrl: DEV_URL,
          running: false,
          occupied: true,
          preloadAttached: false,
          preloadReason: 'not-running',
          devScript: { name: 'dev', command: 'next dev' },
          canLaunch: false,
          probe: { url: DEV_URL, reachable: true, status },
        });
        expect('identifiedBy' in detection).toBe(false);
        expect('framework' in (detection.probe ?? {})).toBe(false);
        expect(hasServerAgentForProject).toHaveBeenCalledTimes(1);
        expect(detection.notes).toEqual([`${unsignedNote(status)}${AGENT_ELSEWHERE}`]);
        expect(detection.relaunchHint).toMatch(OCCUPIED_OPENING);
        expect(detection.relaunchHint).not.toMatch(/already runs with the Debug Generator preload/);
        expect(buildPreloadUnavailableSignals(detection)[0]?.reason).toBe(
          'another process holds the dev-server address for this project',
        );
      },
    );

    it('treats a headerless answer as occupied even with a server-agent connected', async () => {
      const detection = await detectDevServer(
        { projectRoot: PROJECT_ROOT, devServerUrl: DEV_URL },
        portalDeps({ fetchImpl: answering(200), serverAgents: presence(true).serverAgents }),
      );

      expect(detection).toMatchObject({
        running: false,
        occupied: true,
        preloadAttached: false,
        canLaunch: false,
      });
      expect(detection.notes).toEqual([`${unsignedNote(200)}${AGENT_ELSEWHERE}`]);
    });

    it.each([200, 404, 500])(
      'identifies a signed HTTP %i with a server-agent connected: running with the preload attached',
      async (status) => {
        const detection = await detectDevServer(
          { projectRoot: PROJECT_ROOT, devServerUrl: DEV_URL },
          portalDeps({
            fetchImpl: answeringAsNext(status),
            serverAgents: presence(true).serverAgents,
          }),
        );

        expect(detection).toMatchObject({
          running: true,
          identifiedBy: 'framework-signature',
          preloadAttached: true,
          preloadReason: 'server-agent-connected',
          canLaunch: false,
          probe: { status, framework: 'next' },
        });
        expect('occupied' in detection).toBe(false);
        expect(detection.notes).toEqual([]);
      },
    );

    it('identifies the server by its signature alone when no registry is injected', async () => {
      const detection = await detectDevServer(
        { projectRoot: PROJECT_ROOT, devServerUrl: DEV_URL },
        portalDeps({ fetchImpl: answeringAs(200, { vary: 'rsc, next-router-state-tree' }) }),
      );

      expect(detection).toMatchObject({
        running: true,
        identifiedBy: 'framework-signature',
        preloadAttached: false,
        preloadReason: 'unknown',
      });
      expect('occupied' in detection).toBe(false);
    });

    it('holds its invariants across every probe and registry combination', async () => {
      const probes: readonly (() => FetchLike)[] = [
        () => answering(200),
        () => answeringAs(404, UNRELATED_SERVER_HEADERS),
        () => answeringAsNext(500),
        () => refusing(),
      ];
      const registries: readonly {
        readonly make: () => ServerAgentPresence | undefined;
        readonly connected: boolean;
      }[] = [
        { make: () => undefined, connected: false },
        { make: () => presence(true).serverAgents, connected: true },
        { make: () => presence(false).serverAgents, connected: false },
        {
          make: () => ({
            hasServerAgentForProject: () => {
              throw new Error('registry offline');
            },
          }),
          connected: false,
        },
      ];

      for (const probe of probes) {
        for (const registry of registries) {
          const detection = await detectDevServer(
            { projectRoot: PROJECT_ROOT, devServerUrl: DEV_URL },
            portalDeps({ fetchImpl: probe(), serverAgents: registry.make() }),
          );
          const answered = detection.probe?.reachable === true;
          const signed = detection.probe?.framework !== undefined;

          // Identity is the signature, whatever the registry says.
          expect(detection.running).toBe(answered && signed);
          expect('identifiedBy' in detection).toBe(detection.running);
          if (detection.identifiedBy !== undefined) {
            expect(DEV_SERVER_IDENTITY_EVIDENCE).toContain(detection.identifiedBy);
          }
          expect(detection.occupied === true).toBe(answered && !signed);
          expect('occupied' in detection).toBe(detection.occupied === true);
          expect(detection.preloadAttached).toBe(detection.running && registry.connected);
          if (!detection.running) {
            expect(detection.preloadReason).toBe('not-running');
          }
          if (detection.occupied === true) {
            expect(detection.canLaunch).toBe(false);
          }
          expect(detection.relaunchHint.length).toBeLessThanOrEqual(READINESS_HINT_MAX_LENGTH);
        }
      }
    });

    it('lists the framework signature as the only identity evidence', () => {
      expect(DEV_SERVER_IDENTITY_EVIDENCE).toEqual(['framework-signature']);
      expect(Object.isFrozen(DEV_SERVER_IDENTITY_EVIDENCE)).toBe(true);
    });

    it('records no header value in the detection or any log record', async () => {
      const plantedPoweredBy = plantedValue(83, 24);
      const plantedCookie = plantedValue(89, 24);
      const { logger, records } = recordingLogger();

      for (const [headers, serverAgents] of [
        [
          { 'x-powered-by': `Next.js ${plantedPoweredBy}`, 'set-cookie': `sid=${plantedCookie}` },
          presence(false).serverAgents,
        ],
        [
          { 'x-powered-by': `Relay ${plantedPoweredBy}`, 'set-cookie': `sid=${plantedCookie}` },
          presence(false).serverAgents,
        ],
        // The agent-aware occupied note is fixed text too.
        [
          { 'x-powered-by': `Relay ${plantedPoweredBy}`, 'set-cookie': `sid=${plantedCookie}` },
          presence(true).serverAgents,
        ],
      ] as const) {
        const detection = await detectDevServer(
          { projectRoot: PROJECT_ROOT, devServerUrl: DEV_URL },
          portalDeps({ fetchImpl: answeringAs(404, headers), serverAgents, logger }),
        );

        const surfaces = JSON.stringify({ detection, records });
        expect(surfaces).not.toContain(plantedPoweredBy);
        expect(surfaces).not.toContain(plantedCookie);
        expect(surfaces).not.toMatch(/Relay/);
      }

      const finished = records.filter(
        (record) => record.message === 'Dev-server detection finished',
      );
      expect(finished.map((record) => record.fields)).toEqual([
        expect.objectContaining({
          running: true,
          identifiedBy: 'framework-signature',
          occupied: false,
        }),
        expect.objectContaining({ running: false, identifiedBy: undefined, occupied: true }),
        expect.objectContaining({
          running: false,
          identifiedBy: undefined,
          occupied: true,
          preloadAttached: false,
        }),
      ]);
    });

    it('keeps the occupied hint within the limit for a very long project root', async () => {
      const projectRoot = `/home/dev/${'nested/'.repeat(200)}portal`;

      const detection = await detectDevServer(
        { projectRoot, devServerUrl: DEV_URL },
        portalDeps({
          fetchImpl: answeringAs(404, UNRELATED_SERVER_HEADERS),
          serverAgents: presence(false).serverAgents,
        }),
      );

      expect(detection.occupied).toBe(true);
      expect(detection.relaunchHint).toMatch(OCCUPIED_OPENING);
      expect(detection.relaunchHint).toContain(LAUNCH_DEV_SERVER_COMMAND_TITLE);
      expect(detection.relaunchHint).not.toContain(projectRoot);
      expect(detection.relaunchHint.length).toBeLessThanOrEqual(READINESS_HINT_MAX_LENGTH);
    });

    it('reads a hand-built detection with or without occupied, as existing callers build them', () => {
      const facts = {
        running: false,
        preloadAttached: false,
        preloadReason: 'not-running',
        relaunchHint: 'Run the editor command.',
      } as const;

      expect(buildPreloadUnavailableSignals(facts)[0]?.reason).toBe(
        'no dev server with the preload is running for this project',
      );
      expect(buildPreloadUnavailableSignals({ ...facts, occupied: true })[0]?.reason).toBe(
        'another process holds the dev-server address for this project',
      );

      const detection: DevServerDetection = {
        projectRoot: PROJECT_ROOT,
        running: false,
        occupied: true,
        preloadAttached: false,
        preloadReason: 'not-running',
        packageManager: 'pnpm',
        packageManagerSource: 'manifest-field',
        relaunchCommand: expectedCommand(PROJECT_ROOT, 'pnpm run dev'),
        relaunchHint: '',
        canLaunch: false,
        notes: [],
      };
      expect(buildRelaunchHint(detection)).toMatch(OCCUPIED_OPENING);
    });
  });

  describe('never throws: degradation is data', () => {
    const cases: readonly {
      readonly label: string;
      readonly input: { readonly projectRoot: string; readonly devServerUrl?: string };
      readonly deps: () => DevServerDetectDeps;
      readonly note: RegExp;
    }[] = [
      {
        label: 'an unreadable manifest',
        input: { projectRoot: PROJECT_ROOT, devServerUrl: DEV_URL },
        deps: () =>
          portalDeps({
            fetchImpl: answering(200),
            serverAgents: presence(true).serverAgents,
            readManifest: () => {
              throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
            },
          }),
        note: /package\.json was not used: .*not readable/,
      },
      {
        label: 'a rejecting fetch',
        input: { projectRoot: PROJECT_ROOT, devServerUrl: DEV_URL },
        deps: () => portalDeps({ fetchImpl: refusing() }),
        note: /No dev server answered at .*Connection refused/,
      },
      {
        label: 'a fetch that throws synchronously',
        input: { projectRoot: PROJECT_ROOT, devServerUrl: DEV_URL },
        deps: () =>
          portalDeps({
            fetchImpl: () => {
              throw new TypeError('no transport');
            },
          }),
        note: /No dev server answered at .*The request failed before an HTTP response arrived/,
      },
      {
        label: 'a package-manager resolver that throws',
        input: { projectRoot: PROJECT_ROOT },
        deps: () =>
          portalDeps({
            resolvePackageManager: () => {
              throw new Error('summary unavailable');
            },
          }),
        note: /injected package-manager resolver failed/,
      },
      {
        label: 'a server-agent registry that throws',
        input: { projectRoot: PROJECT_ROOT, devServerUrl: DEV_URL },
        deps: () =>
          portalDeps({
            fetchImpl: answeringAsNext(200),
            serverAgents: {
              hasServerAgentForProject: () => {
                throw new Error('registry offline');
              },
            },
          }),
        note: /server-agent registry could not be queried/,
      },
      {
        label: 'a relative project root',
        input: { projectRoot: 'relative/project', devServerUrl: DEV_URL },
        deps: () => portalDeps({ fetchImpl: answering(200) }),
        note: /package manager was not detected because the project root is not absolute/,
      },
      {
        label: 'a non-loopback dev-server URL',
        input: { projectRoot: PROJECT_ROOT, devServerUrl: 'http://192.168.1.20:3000/' },
        deps: () => portalDeps({ fetchImpl: answering(200) }),
        note: /dev-server URL was not probed: Only a loopback dev server/,
      },
      {
        label: 'a relative preload path',
        input: { projectRoot: PROJECT_ROOT },
        deps: () => portalDeps({ preloadPath: 'telemetry/register.mjs' }),
        note: /preload path supplied to detection is not absolute/,
      },
      {
        label: 'a service host that forms no URL',
        input: { projectRoot: PROJECT_ROOT },
        deps: () => portalDeps({ config: { host: 'not a host', port: 43117 } }),
        note: /do not form a valid ingest URL/,
      },
    ];

    it.each(cases)('resolves with a note for $label', async ({ input, deps, note }) => {
      const detection = await detectDevServer(input, deps());

      expect(detection.notes).toContainEqual(expect.stringMatching(note));
      expect(typeof detection.relaunchCommand).toBe('string');
      expect(detection.relaunchHint.length).toBeLessThanOrEqual(READINESS_HINT_MAX_LENGTH);
      expect(DEV_SERVER_PRELOAD_REASONS).toContain(detection.preloadReason);
      expect(PACKAGE_MANAGER_SOURCES).toContain(detection.packageManagerSource);
    });

    it('resolves when every collaborator fails at once', async () => {
      const detection = await detectDevServer(
        { projectRoot: PROJECT_ROOT, devServerUrl: DEV_URL },
        {
          fetchImpl: refusing(),
          readManifest: () => {
            throw new Error('unreadable');
          },
          serverAgents: {
            hasServerAgentForProject: () => {
              throw new Error('registry offline');
            },
          },
          resolvePackageManager: () => {
            throw new Error('summary unavailable');
          },
          logger: THROWING_LOGGER,
          now: () => {
            throw new Error('clock unavailable');
          },
          preloadPath: 'relative/register.mjs',
          config: { host: 'not a host', port: 1 },
        },
      );

      expect(detection).toMatchObject({ running: false, canLaunch: false, preloadAttached: false });
      expect(detection.notes.length).toBeGreaterThanOrEqual(5);
    });

    it('a throwing logger changes nothing about the answer', async () => {
      const quiet = await detectDevServer(
        { projectRoot: PROJECT_ROOT, devServerUrl: DEV_URL },
        portalDeps({ fetchImpl: answering(200), serverAgents: presence(false).serverAgents }),
      );
      const noisy = await detectDevServer(
        { projectRoot: PROJECT_ROOT, devServerUrl: DEV_URL },
        portalDeps({
          fetchImpl: answering(200),
          serverAgents: presence(false).serverAgents,
          logger: THROWING_LOGGER,
        }),
      );

      expect(noisy).toStrictEqual(quiet);
    });

    it('falls back to an honest degraded answer when a collaborator fails in an unanticipated way', async () => {
      const { logger, records } = recordingLogger();
      const deps: DevServerDetectDeps = {
        ...portalDeps({ fetchImpl: answering(200), logger }),
        get serverAgents(): ServerAgentPresence | undefined {
          throw new Error('registry wiring failed');
        },
      };

      const detection = await detectDevServer(
        { projectRoot: PROJECT_ROOT, devServerUrl: DEV_URL },
        deps,
      );

      expect(detection).toMatchObject({
        projectRoot: PROJECT_ROOT,
        running: false,
        preloadAttached: false,
        preloadReason: 'unknown',
        packageManager: 'unknown',
        packageManagerSource: 'unknown',
        canLaunch: false,
      });
      expect(detection.notes).toEqual([expect.stringMatching(/detection failed unexpectedly/)]);
      expect(detection.relaunchCommand).toContain(`cd ${PROJECT_ROOT} && `);
      const warning = records.find((record) => record.level === 'warn');
      expect(warning?.fields).toMatchObject({ subsystem: 'dev-server', errorClass: 'Error' });
      expect(JSON.stringify(records)).not.toContain('registry wiring failed');
    });
  });

  describe('the result is plain, credential-free data', () => {
    it.each([
      { label: 'an identified dev server', fetchImpl: () => answeringAsNext(200) },
      {
        label: 'an occupied address',
        fetchImpl: () => answeringAs(404, UNRELATED_SERVER_HEADERS),
      },
    ])(
      'for $label, survives a JSON round trip unchanged and carries no token, Authorization or environment value',
      async ({ fetchImpl }) => {
        const plantedToken = plantedValue(47);
        const plantedIngest = `http://127.0.0.1:1/${plantedValue(53, 16)}`;
        vi.stubEnv('DEBUGGEN_TOKEN', plantedToken);
        vi.stubEnv('DEBUGGEN_INGEST_URL', plantedIngest);
        vi.stubEnv('DEBUGGEN_PROJECT_ROOT', `/srv/${plantedValue(59, 16)}`);
        const queryValue = plantedValue(61, 20);
        const { logger, records } = recordingLogger();

        const detection = await detectDevServer(
          { projectRoot: PROJECT_ROOT, devServerUrl: `http://localhost:4100/?ref=${queryValue}` },
          portalDeps({
            fetchImpl: fetchImpl(),
            serverAgents: presence(false).serverAgents,
            logger,
          }),
        );

        const serialised = JSON.stringify(detection);
        expect(JSON.parse(serialised)).toStrictEqual(detection);
        for (const planted of [plantedToken, plantedIngest, queryValue, plantedValue(59, 16)]) {
          expect(serialised).not.toContain(planted);
          expect(JSON.stringify(records)).not.toContain(planted);
        }
        expect(serialised).not.toMatch(/authorization|bearer/i);
        expect(detection.devServerUrl).toBe('http://localhost:4100/');
        expect(secretShapedRuns(serialised)).toEqual([]);
      },
    );

    it('logs one info line under the dev-server subsystem', async () => {
      const { logger, records } = recordingLogger();

      await detectDevServer(
        { projectRoot: PROJECT_ROOT, devServerUrl: DEV_URL },
        portalDeps({
          fetchImpl: answeringAsNext(200),
          serverAgents: presence(true).serverAgents,
          logger,
        }),
      );

      const info = records.filter((record) => record.level === 'info');
      expect(info).toHaveLength(1);
      expect(info[0]?.fields).toMatchObject({
        subsystem: 'dev-server',
        projectRoot: PROJECT_ROOT,
        running: true,
        identifiedBy: 'framework-signature',
        occupied: false,
        preloadAttached: true,
        preloadReason: 'server-agent-connected',
      });
    });

    it('renders the ingest URL from the service config, bracketing an IPv6 host', async () => {
      const detection = await detectDevServer(
        { projectRoot: PROJECT_ROOT },
        portalDeps({ config: { host: '::1', port: 43117 } }),
      );

      expect(detection.relaunchCommand).toContain(
        "DEBUGGEN_INGEST_URL='http://[::1]:43117/telemetry/ingest'",
      );
    });

    it('prefers an explicit ingestUrl over one derived from the config', async () => {
      const detection = await detectDevServer(
        { projectRoot: PROJECT_ROOT },
        portalDeps({ ingestUrl: 'http://localhost:43118/telemetry/ingest' }),
      );

      expect(detection.relaunchCommand).toContain(
        'DEBUGGEN_INGEST_URL=http://localhost:43118/telemetry/ingest ',
      );
    });

    it('renders shell references when neither preload path nor service address is known', async () => {
      const detection = await detectDevServer(
        { projectRoot: PROJECT_ROOT },
        { readManifest: servingManifest(PORTAL_MANIFEST) },
      );

      expect(detection.relaunchCommand).toBe(
        expectedCommand(
          PROJECT_ROOT,
          'pnpm run dev',
          RELAUNCH_PLACEHOLDERS.preloadUrl,
          `"${RELAUNCH_PLACEHOLDERS.ingestUrl}"`,
        ),
      );
    });
  });

  describe('package-manager precedence, reused from @debuggen/code-analysis', () => {
    /** The portal manifest pinned to yarn, so every higher route has something to beat. */
    const YARN_PINNED = { ...UNPINNED_MANIFEST, packageManager: 'yarn@4.5.0' };

    it('an injected ProjectSummary value wins over the manifest packageManager field', async () => {
      const resolvePackageManager = vi.fn<PackageManagerResolver>(() => 'npm');

      const detection = await detectDevServer(
        { projectRoot: PROJECT_ROOT },
        portalDeps({
          readManifest: servingManifest(YARN_PINNED),
          projectSummary: { packageManager: 'bun' },
          resolvePackageManager,
        }),
      );

      expect(detection).toMatchObject({
        packageManager: 'bun',
        packageManagerSource: 'project-summary',
      });
      expect(detection.relaunchCommand.endsWith(' bun run dev')).toBe(true);
      // The summary settles it; the resolver is not even consulted.
      expect(resolvePackageManager).toHaveBeenCalledTimes(0);
    });

    it('an injected resolver answers when the summary does not, and sees the projected manifest', async () => {
      const resolvePackageManager = vi.fn<PackageManagerResolver>(() => 'npm');

      const detection = await detectDevServer(
        { projectRoot: PROJECT_ROOT },
        portalDeps({
          readManifest: servingManifest(YARN_PINNED),
          projectSummary: { packageManager: 'unknown' },
          resolvePackageManager,
        }),
      );

      expect(detection).toMatchObject({
        packageManager: 'npm',
        packageManagerSource: 'project-summary',
      });
      const received = resolvePackageManager.mock.calls[0]?.[0];
      expect(received?.projectRoot).toBe(PROJECT_ROOT);
      expect(received?.manifest?.packageManagerField).toBe('yarn@4.5.0');
    });

    it.each([
      { label: 'returns undefined', answer: undefined },
      { label: 'returns "unknown"', answer: 'unknown' as const },
      // A JavaScript caller can hand back anything; only the vocabulary counts.
      {
        label: 'returns a value outside the vocabulary',
        answer: 'deno' as unknown as PackageManagerId,
      },
    ])('falls through to the manifest field when the resolver $label', async ({ answer }) => {
      const detection = await detectDevServer(
        { projectRoot: PROJECT_ROOT },
        portalDeps({
          readManifest: servingManifest(YARN_PINNED),
          resolvePackageManager: () => answer,
        }),
      );

      expect(detection).toMatchObject({
        packageManager: 'yarn',
        packageManagerSource: 'manifest-field',
      });
      expect(detection.relaunchCommand.endsWith(' yarn dev')).toBe(true);
    });

    it('detects a single lockfile by existence alone — it is never read through the manifest reader', async () => {
      const root = makeSandbox();
      writeManifest(root, UNPINNED_MANIFEST);
      writeFileSync(join(root, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n");
      const planted = plantedValue(67);
      writeFileSync(join(root, '.env'), `${['SAMPLE', 'VALUE'].join('_')}=${planted}\n`);
      const readManifest = spyingDiskReader();

      const detection = await detectDevServer(
        { projectRoot: root },
        { readManifest, config: SERVICE_CONFIG, preloadPath: PRELOAD_PATH },
      );

      expect(detection).toMatchObject({
        packageManager: 'pnpm',
        packageManagerSource: 'code-analysis',
      });
      expect(readManifest.mock.calls).toEqual([[join(root, 'package.json')]]);
      expect(JSON.stringify(detection)).not.toContain(planted);
    });

    it('answers "unknown" for two lockfiles, which identify nothing', async () => {
      const root = makeSandbox();
      writeManifest(root, UNPINNED_MANIFEST);
      writeFileSync(join(root, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n");
      writeFileSync(join(root, 'yarn.lock'), '# yarn lockfile v1\n');
      const readManifest = spyingDiskReader();

      const detection = await detectDevServer({ projectRoot: root }, { readManifest });

      expect(detection).toMatchObject({
        packageManager: 'unknown',
        packageManagerSource: 'unknown',
      });
      expect(detection.relaunchCommand).toContain(
        `${RELAUNCH_PLACEHOLDERS.packageManager} run dev`,
      );
      expect(detection.notes).toContainEqual(
        expect.stringMatching(/package manager could not be determined/),
      );
      expect(readManifest.mock.calls).toEqual([[join(root, 'package.json')]]);
    });

    it('answers "unknown" with a note when nothing is available', async () => {
      const root = makeSandbox();
      writeManifest(root, UNPINNED_MANIFEST);
      const readManifest = spyingDiskReader();

      const detection = await detectDevServer({ projectRoot: root }, { readManifest });

      expect(detection).toMatchObject({
        packageManager: 'unknown',
        packageManagerSource: 'unknown',
      });
      expect(detection.notes).toContainEqual(
        expect.stringMatching(/package manager could not be determined/),
      );
      expect(readManifest).toHaveBeenCalledTimes(1);
    });
  });

  describe('against a real project on disk, with the default reader', () => {
    it('detects a generic project end to end without any injected reader', async () => {
      const root = makeSandbox();
      writeManifest(root, {
        name: 'field-scheduler',
        packageManager: 'npm@10.9.0',
        scripts: { build: 'next build', 'web:dev': 'next dev --port 4200' },
        dependencies: { next: '16.1.0' },
      });

      const detection = await detectDevServer(
        { projectRoot: root, devServerUrl: 'http://localhost:4200/' },
        { fetchImpl: refusing(), config: SERVICE_CONFIG, preloadPath: PRELOAD_PATH },
      );

      expect(detection).toMatchObject({
        running: false,
        canLaunch: true,
        packageManager: 'npm',
        packageManagerSource: 'manifest-field',
        devScript: { name: 'web:dev', command: 'next dev --port 4200' },
      });
      expect(detection.relaunchCommand.endsWith(' npm run web:dev')).toBe(true);
      expect(detection.relaunchCommand).toContain(`DEBUGGEN_PROJECT_ROOT=`);
      expect(detection.relaunchCommand).not.toContain(DEMO_TREE_FRAGMENT);
    });

    it.skipIf(SYMLINKS_UNAVAILABLE)('downgrades a symlinked package.json to a note', async () => {
      const root = makeSandbox();
      const elsewhere = join(root, 'elsewhere');
      mkdirSync(elsewhere);
      writeManifest(elsewhere, { scripts: { dev: 'next dev' }, dependencies: { next: '16.1.0' } });
      symlinkSync(join(elsewhere, 'package.json'), join(root, 'package.json'));

      const detection = await detectDevServer({ projectRoot: root }, {});

      expect(detection.canLaunch).toBe(false);
      expect('devScript' in detection).toBe(false);
      expect(detection.notes).toContainEqual(
        expect.stringMatching(/is a symbolic link; it is not followed/),
      );
    });
  });
});

describe('detectDevServer: the dev-server script names', () => {
  it('lists only the scripts that start a dev server, frozen, never a command', async () => {
    const detection = await detectDevServer({ projectRoot: PROJECT_ROOT }, portalDeps());

    // `build`, `start` and `lint` are declared too, but none starts a dev server.
    expect(detection.devServerScripts).toStrictEqual(['dev']);
    expect(Object.isFrozen(detection.devServerScripts)).toBe(true);
    const serialised = JSON.stringify(detection.devServerScripts);
    for (const command of Object.values(PORTAL_MANIFEST.scripts)) {
      expect(serialised).not.toContain(command);
    }
  });

  it('holds the selected dev script and every script running next dev, never deploy, lint or postinstall', async () => {
    const readManifest = servingManifest({
      scripts: {
        dev: 'next dev',
        'dev:web': 'next dev',
        deploy: 'vercel deploy --prod',
        lint: 'eslint .',
        postinstall: 'node ./scripts/setup.js',
      },
      dependencies: { next: '16.1.0' },
    });

    const detection = await detectDevServer(
      { projectRoot: PROJECT_ROOT },
      portalDeps({ readManifest }),
    );

    expect(detection.devServerScripts).toStrictEqual(['dev', 'dev:web']);
    expect(detection.devScript).toStrictEqual({ name: 'dev', command: 'next dev' });
  });

  it('counts the selected dev script even when it was chosen by its name alone', async () => {
    const readManifest = servingManifest({
      scripts: {
        dev: 'node ./scripts/serve.mjs',
        'web:dev': 'cross-env PORT=4000 next dev',
        build: 'next build',
      },
      dependencies: { next: '16.1.0' },
    });

    const detection = await detectDevServer(
      { projectRoot: PROJECT_ROOT },
      portalDeps({ readManifest }),
    );

    expect(detection.devScript?.name).toBe('dev');
    expect(detection.devServerScripts).toStrictEqual(['dev', 'web:dev']);
  });

  it('skips blank and non-string scripts and orders names by code unit, not by locale', async () => {
    const readManifest = servingManifest({
      scripts: {
        'web:dev': 'next dev',
        Zeta: 'next dev --turbopack',
        alpha: 'eslint .',
        '~local': 'cross-env PORT=4000 next dev',
        build: 'next build',
        blank: '   ',
        empty: '',
        count: 3,
        nested: { dev: 'next dev' },
      },
      dependencies: { next: '16.1.0' },
    });

    const detection = await detectDevServer(
      { projectRoot: PROJECT_ROOT },
      portalDeps({ readManifest }),
    );

    expect(detection.devServerScripts).toStrictEqual(['Zeta', 'web:dev', '~local']);
    expect(detection.devScript).toStrictEqual({ name: 'Zeta', command: 'next dev --turbopack' });
  });

  it('is present and empty for a manifest that declares no runnable script', async () => {
    const detection = await detectDevServer(
      { projectRoot: PROJECT_ROOT },
      portalDeps({ readManifest: servingManifest({ name: 'acme-portal', scripts: {} }) }),
    );

    expect(detection.devServerScripts).toStrictEqual([]);
    expect(detection.canLaunch).toBe(false);
  });

  it('is present and empty for a manifest whose scripts start no dev server', async () => {
    const detection = await detectDevServer(
      { projectRoot: PROJECT_ROOT },
      portalDeps({
        readManifest: servingManifest({
          name: 'acme-portal',
          scripts: { build: 'next build', start: 'next start', deploy: 'vercel deploy' },
        }),
      }),
    );

    expect(detection.devServerScripts).toStrictEqual([]);
    expect(detection).not.toHaveProperty('devScript');
    expect(detection.canLaunch).toBe(false);
  });

  it.each([
    { label: 'unreadable', code: 'EACCES' },
    { label: 'missing', code: 'ENOENT' },
  ])('is absent when package.json is $label', async ({ code }) => {
    const detection = await detectDevServer(
      { projectRoot: PROJECT_ROOT },
      portalDeps({
        readManifest: () => {
          throw Object.assign(new Error('not available'), { code });
        },
      }),
    );

    expect('devServerScripts' in detection).toBe(false);
  });

  it('is absent from the degraded answer of an unanticipated failure', async () => {
    const deps: DevServerDetectDeps = {
      ...portalDeps(),
      get serverAgents(): ServerAgentPresence | undefined {
        throw new Error('registry wiring failed');
      },
    };

    const detection = await detectDevServer(
      { projectRoot: PROJECT_ROOT, devServerUrl: DEV_URL },
      deps,
    );

    expect(detection.preloadReason).toBe('unknown');
    expect('devServerScripts' in detection).toBe(false);
  });

  it('reads the names from a real package.json on disk', async () => {
    const root = makeSandbox();
    writeManifest(root, {
      scripts: { 'web:dev': 'next dev --port 4200', build: 'next build' },
      dependencies: { next: '16.1.0' },
    });

    const detection = await detectDevServer(
      { projectRoot: root },
      { config: SERVICE_CONFIG, preloadPath: PRELOAD_PATH },
    );

    expect(detection.devServerScripts).toStrictEqual(['web:dev']);
    expect(JSON.parse(JSON.stringify(detection))).toStrictEqual(detection);
  });
});

describe('FRAMEWORK_DEV_CLIS', () => {
  it('is the frozen table of framework dev CLIs the launcher and selectDevScript share', () => {
    expect(Object.isFrozen(FRAMEWORK_DEV_CLIS)).toBe(true);
    expect(FRAMEWORK_DEV_CLIS).toStrictEqual([
      { framework: 'next', binary: 'next', subcommand: 'dev', packageBin: 'next/dist/bin/next' },
    ]);
    for (const entry of FRAMEWORK_DEV_CLIS) {
      expect(Object.isFrozen(entry)).toBe(true);
      expect(DEV_SERVER_FRAMEWORKS).toContain(entry.framework);
    }
  });

  it("drives selectDevScript: each entry's CLI, bare or run by Node from node_modules, selects a script", () => {
    for (const entry of FRAMEWORK_DEV_CLIS) {
      for (const command of [
        `${entry.binary} ${entry.subcommand}`,
        `node node_modules/${entry.packageBin} ${entry.subcommand}`,
      ]) {
        expect(selectDevScript({ scripts: { web: command } })).toStrictEqual({
          name: 'web',
          command,
        });
      }
      expect(selectDevScript({ scripts: { web: `${entry.binary} build` } })).toBeUndefined();
    }
  });
});
