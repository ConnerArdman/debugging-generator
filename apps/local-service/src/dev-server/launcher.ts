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
 * ## The environment contract: four injected variables
 *
 * {@link buildDevServerEnv} copies the service's environment for the child and
 * sets exactly four keys ({@link PRELOAD_ENV_KEYS}); every other variable
 * (`PATH`, `HOME`, a developer's `NEXT_OTEL_VERBOSE`, …) passes through
 * untouched:
 *
 * | Variable | Value |
 * | --- | --- |
 * | `NODE_OPTIONS` | the inherited value **with** `--import <preload file URL>` appended — never replaced |
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
 * {@link ServerAgentCredentialIssuer} (satisfied by `../server/auth.ts`, AAP
 * §0.5.6): a 32-byte CSPRNG token stored only as a SHA-256 hash with
 * `role: "server-agent"`, scoped to one `projectRoot`, and **revoked when the
 * launched process exits** — exactly once, whichever of the exit, `stop`,
 * `stopForSession` or `stopAll` paths gets there first. The token is a
 * capability: it lives in the child's environment and nowhere else in this
 * module's output — never in a log line, an error message, hint or details, a
 * {@link LaunchedDevServer} record, a detection, or any response other than the
 * credential route's own body. Child output is scrubbed of the token value
 * *before* it is logged or buffered, because a dev server may echo its
 * environment.
 *
 * ## The credential route, and the CLI mirror
 *
 * `POST /dev-server/credential` ({@link DEV_SERVER_CREDENTIAL_PATH}) mints a
 * time-bounded `server-agent` credential for a dev server the caller starts
 * itself. It is not part of `@debuggen/protocol`'s route table, so its path and
 * both body schemas are defined **here, once**; `../server/routes/dev-server.ts`
 * registers it (editor role only — it is not auth-exempt) and delegates to
 * {@link DevServerLauncher.issueCredential}. `scripts/dev-instrumented.mjs` is
 * the command-line mirror of this module (its default mode asks this launcher
 * to start the project through `POST /dev-server/launch`). **This file and
 * `../server/auth.ts` are the authority for the credential route and the token
 * shape**: a change to either is a change to both, and to that script, in the
 * same commit.
 *
 * ## Launch, readiness and shutdown
 *
 * {@link DevServerLauncher.launch} validates the project root, asks
 * `./detect.js` whether a dev server already answers (a preloaded one is
 * reused, an un-preloaded one is refused with the exact relaunch command rather
 * than a second server fighting for its port), resolves the command (the
 * request's, or the package manager plus dev script detection selected),
 * mints the credential, spawns the child **without a shell on POSIX**, streams
 * its output line-wise into the service log under `subsystem: "dev-server"`,
 * and waits — bounded — until the child prints its local loopback address (the
 * service's own port excluded) or, for a child that prints none, until the
 * requested URL answers a probe. Every failure is a typed `Err` with a
 * developer-facing hint (AAP §0.5.5); none leaves an orphan child or a live
 * credential behind. `stop` sends `SIGTERM` to the child's process group (a
 * real POSIX spawn leads its own group, so a framework's server worker is
 * reached too) and escalates to `SIGKILL` after a grace period; a child whose
 * leader exits on its own has its group reaped the same way. `stopForSession` ties a child's
 * lifetime to the session that launched it; `stopAll`/`dispose` are the first
 * step of `../main.ts`'s graceful shutdown.
 *
 * @example
 * ```ts
 * const launcher = createDevServerLauncher({
 *   config: { host: config.host, port: boundPort },
 *   logger,
 *   credentials: {
 *     issue: (input) => auth.issueServerAgentCredential(input),
 *     revoke: ({ projectRoot }) => auth.revokeServerAgentCredentials(projectRoot),
 *   },
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

import { spawn as nodeSpawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute as isNativeAbsolute, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  HTTP_OPERATIONS,
  HTTP_ROUTES,
  buildPath,
  describeZodIssues,
  epochMsSchema,
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
import { z } from 'zod';

import type { ServiceConfig } from '../config.js';
import { scrubLogMessage, subsystemLogger } from '../logging.js';
import {
  PRELOAD_DEPENDENT_SIGNALS,
  buildRelaunchHint,
  detectDevServer,
  packageManagerRunArgs,
  probeDevServer,
  type DevServerDetectDeps,
  type DevServerDetection,
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

/** How often readiness re-probes the dev server's URL, in milliseconds. */
export const DEFAULT_READY_POLL_INTERVAL_MS = 250;

/**
 * How long a stopping child has between `SIGTERM` and `SIGKILL`, in
 * milliseconds. Five seconds lets a framework flush and close its watchers.
 */
export const DEFAULT_STOP_GRACE_MS = 5_000;

/**
 * How long to wait for the `exit` event after `SIGKILL` before giving up on
 * observing it. `SIGKILL` cannot be ignored, so this only bounds a platform
 * that never reports the exit; the credential is revoked either way.
 */
const KILL_CONFIRM_MS = 2_000;

/**
 * Lifetime of a credential minted through {@link DEV_SERVER_CREDENTIAL_PATH},
 * in milliseconds.
 *
 * A launched child's credential is revoked when the child exits; a credential
 * for a process the caller starts itself cannot be tied to an exit this
 * service observes, so it carries an explicit expiry instead. Twelve hours
 * outlasts a working day of one dev server and bounds a forgotten one.
 */
export const DEFAULT_CLI_CREDENTIAL_TTL_MS = 12 * 60 * 60 * 1000;

/** How many lines of a child's output are kept for diagnostics. */
export const OUTPUT_TAIL_MAX_LINES = 100;

/** How many characters of a child's output are kept for diagnostics (64 KiB). */
export const OUTPUT_TAIL_MAX_CHARS = 64 * 1024;

/** How many tail lines a launch error carries in its `details`. */
const ERROR_TAIL_LINES = 20;

/** The longest single output line kept or logged; longer lines are truncated. */
const MAX_OUTPUT_LINE_LENGTH = 2_000;

/**
 * The longest unterminated output fragment held while waiting for a newline;
 * beyond it the fragment is emitted as a line, so a child that never prints a
 * newline cannot grow the buffer without bound.
 */
const MAX_PENDING_LINE_LENGTH = 8 * 1024;

/** What replaces the credential value wherever child output would carry it. */
const TOKEN_REDACTION = '[redacted]';

/** Appended to a truncated output line. */
const TRUNCATION_MARKER = '…';

/**
 * A loopback URL a dev server prints — `http://localhost:3000`,
 * `http://127.0.0.1:5173`, `https://[::1]:8443`. A generic address shape, never
 * a framework banner string, so readiness works for any dev server; a
 * non-loopback "Network" address is deliberately not matched. Global, so every
 * address on a line is considered (see {@link loopbackUrlIn}).
 */
const LOOPBACK_URL_PATTERN = /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):\d{1,5}(?![\d])/gi;

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

/** The longest project root either credential schema accepts (POSIX `PATH_MAX`). */
const MAX_PROJECT_ROOT_LENGTH = 4096;

/** The longest credential the response schema accepts; matches the protocol's opaque-token bound. */
const MAX_TOKEN_LENGTH = 512;

/** The highest TCP port. */
const MAX_TCP_PORT = 65_535;

/** How many ancestor directories the workspace preload candidate searches. */
const MAX_WORKSPACE_SEARCH_DEPTH = 8;

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

/** Input of {@link buildDevServerEnv}. */
export interface DevServerEnvInput {
  /** The environment the child inherits; read, never mutated. */
  readonly parentEnv: ParentEnvironment;
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
 * The launched child's environment: a copy of `parentEnv` with exactly the four
 * {@link PRELOAD_ENV_KEYS} set — `NODE_OPTIONS` appended with the preload's
 * `--import` flag (see {@link appendNodeOptions}), the other three assigned.
 *
 * Every other parent variable passes through byte for byte; none is deleted or
 * rewritten, `parentEnv` is never mutated, and `undefined` values are dropped
 * so the result is a clean `Record<string, string>`. A parent value for one of
 * the three `DEBUGGEN_*` keys is overwritten: those are per-launch wiring, and
 * a stale inherited credential must never reach the child.
 *
 * @param input The parent environment and the four values.
 * @returns A fresh environment object for `spawn`.
 * @throws DebuggenError `PROJECT_NOT_FOUND` for a relative project root, and
 * `CONFIG_INVALID` for an empty credential, a relative preload path or an
 * ingest endpoint that is not an absolute `http(s)` URL. No message, hint or
 * detail ever carries the credential.
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
  const caseInsensitive = (input.platform ?? process.platform) === 'win32';

  const entries: [string, string][] = [];
  let inheritedNodeOptions: string | undefined;
  for (const [name, value] of Object.entries(input.parentEnv)) {
    if (typeof value !== 'string') {
      continue;
    }
    const key = caseInsensitive ? canonicalWindowsKey(name) : name;
    if (key === PRELOAD_ENV_KEYS.nodeOptions) {
      inheritedNodeOptions = inheritedNodeOptions ?? value;
      continue;
    }
    if (
      key === PRELOAD_ENV_KEYS.ingestUrl ||
      key === PRELOAD_ENV_KEYS.token ||
      key === PRELOAD_ENV_KEYS.projectRoot
    ) {
      continue;
    }
    entries.push([name, value]);
  }

  // `Object.fromEntries` defines own data properties, so even a variable named
  // `__proto__` survives as data instead of being swallowed by a setter.
  const env: Record<string, string> = Object.fromEntries(entries);
  env[PRELOAD_ENV_KEYS.nodeOptions] = appendNodeOptions(inheritedNodeOptions, importFlag);
  env[PRELOAD_ENV_KEYS.ingestUrl] = input.ingestUrl;
  env[PRELOAD_ENV_KEYS.token] = input.token;
  env[PRELOAD_ENV_KEYS.projectRoot] = input.projectRoot;
  return env;
}

/**
 * On Windows, the upper-cased spelling of a variable that is one of the four
 * preload keys (so `Node_Options` folds into `NODE_OPTIONS`); any other name is
 * returned as it was, preserving the developer's casing.
 */
function canonicalWindowsKey(name: string): string {
  const upper = name.toUpperCase();
  return Object.values(PRELOAD_ENV_KEYS).some((key) => key === upper) ? upper : name;
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
 * The path of the one route this folder owns: `POST /dev-server/credential`,
 * which mints a time-bounded `server-agent` credential for a dev server the
 * caller starts itself.
 *
 * It is not an operation of `@debuggen/protocol`'s `HTTP_ROUTES` (that table's
 * seventeen routes contain no credential operation), so this literal is its
 * single definition. `../server/routes/dev-server.ts` registers it beside the
 * two table-driven dev-server operations, behind the bearer middleware with
 * the **editor** (`vscode`) role only — the route is not auth-exempt; the
 * protocol's `AUTH_EXEMPT_OPERATIONS` is exactly `health` and `pair.complete`.
 * {@link findCredentialRouteCollision} proves no protocol route claims it.
 */
export const DEV_SERVER_CREDENTIAL_PATH = '/dev-server/credential';

/** The method of {@link DEV_SERVER_CREDENTIAL_PATH}. */
export const DEV_SERVER_CREDENTIAL_METHOD = 'POST';

/**
 * The `POST /dev-server/credential` request body: `{ projectRoot }`, the
 * absolute root the credential will be scoped to. Strict: an unknown key is a
 * rejection. Rejections are constant sentences, so no value is ever echoed.
 */
export const devServerCredentialRequestSchema = z.strictObject({
  projectRoot: z
    .string({ error: 'expected a project root path' })
    .min(1, { error: 'expected a non-empty project root path' })
    .max(MAX_PROJECT_ROOT_LENGTH, {
      error: `expected a project root path of at most ${String(MAX_PROJECT_ROOT_LENGTH)} characters`,
    })
    .refine((value) => isAbsolutePath(value), { error: 'expected an absolute project root path' }),
});

/** The validated `POST /dev-server/credential` request body. */
export type DevServerCredentialRequest = z.infer<typeof devServerCredentialRequestSchema>;

/**
 * The `POST /dev-server/credential` response body: the credential, once, and
 * when it expires (epoch milliseconds, the protocol's canonical timestamp).
 * The only body in the product that carries a `server-agent` token.
 */
export const devServerCredentialResponseSchema = z.strictObject({
  token: z
    .string({ error: 'expected a credential' })
    .min(1, { error: 'expected a non-empty credential' })
    .max(MAX_TOKEN_LENGTH, {
      error: `expected a credential of at most ${String(MAX_TOKEN_LENGTH)} characters`,
    }),
  expiresAt: epochMsSchema,
});

/** The validated `POST /dev-server/credential` response body. */
export type DevServerCredentialResponse = z.infer<typeof devServerCredentialResponseSchema>;

/** The slice of a route definition {@link findCredentialRouteCollision} compares. */
export interface RoutePatternLike {
  readonly operation: string;
  readonly method: string;
  readonly pattern: string;
}

/**
 * The protocol operation whose route pattern would also match
 * {@link DEV_SERVER_CREDENTIAL_PATH}, or `undefined` when there is none — the
 * defensive check that keeps ownership of the path unambiguous if the protocol
 * table later grows. A `:param` segment matches any segment, and a match on
 * any method counts: two owners of one path is ambiguous whatever the verb.
 *
 * @param routes The table to check; defaults to every protocol route.
 * @returns The colliding operation id, if any.
 */
export function findCredentialRouteCollision(
  routes: Iterable<RoutePatternLike> = HTTP_OPERATIONS.map((operation) => HTTP_ROUTES[operation]),
): string | undefined {
  const target = pathSegments(DEV_SERVER_CREDENTIAL_PATH);
  for (const route of routes) {
    const segments = pathSegments(route.pattern);
    if (
      segments.length === target.length &&
      segments.every((segment, index) => segment.startsWith(':') || segment === target[index])
    ) {
      return route.operation;
    }
  }
  return undefined;
}

/** The non-empty segments of a route path. */
function pathSegments(path: string): string[] {
  return path.split('/').filter((segment) => segment.length > 0);
}

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

  const resolvePackage = options.resolvePackage ?? defaultPackageResolver(moduleUrl);
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
 * The default package resolver: `import.meta.resolve` when available (Node's
 * ESM resolver, honouring `exports`), else a `createRequire` rooted at this
 * module. Either may be missing under a bundler or test runner, which is why
 * both are feature-tested rather than assumed.
 */
function defaultPackageResolver(
  moduleUrl: string | undefined,
): (specifier: string) => string | undefined {
  return (specifier) => {
    const meta: { readonly resolve?: ((specifier: string) => unknown) | undefined } = import.meta;
    if (typeof meta.resolve === 'function') {
      try {
        const resolved = meta.resolve(specifier);
        if (typeof resolved === 'string' && resolved.startsWith('file:')) {
          return fileURLToPath(resolved);
        }
      } catch {
        // Fall through to the CommonJS resolver.
      }
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
  /** Its arguments, passed as an array — never re-joined into a shell string on POSIX. */
  readonly args: readonly string[];
  /**
   * Leading `NAME=value` assignments (`NODE_ENV=development next dev`), applied
   * to the child's environment before the preload variables, so an assigned
   * `NODE_OPTIONS` is appended to and an assigned `DEBUGGEN_*` is overridden.
   */
  readonly env: Readonly<Record<string, string>>;
}

/**
 * Parse a request's `command` with {@link splitCommandLine}: leading
 * environment assignments are separated out, the next word is the executable,
 * and the rest are its arguments. An unquoted shell operator (`&&`, `|`, `;`,
 * `>` …) is refused, because without a shell it would silently become an
 * argument: a command that needs one belongs in a `package.json` script.
 *
 * @param command The request's command line.
 * @returns The parsed command, or `DEV_SERVER_LAUNCH_FAILED` with the fix as its hint.
 */
export function parseLaunchCommand(command: string): Result<ParsedLaunchCommand, DebuggenError> {
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
    env.push([word.text.slice(0, equals), word.text.slice(equals + 1)]);
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

/** A refusal of a request's command; the command itself is never echoed. */
function commandError(reason: string, message: string): DebuggenError {
  return new DebuggenError('DEV_SERVER_LAUNCH_FAILED', message, {
    hint: 'Pass a single command such as "pnpm run dev" (quotes are honoured, nothing is expanded), or omit the command to use the dev script detected from package.json.',
    details: { reason },
  });
}

/**
 * Quote one argument for `cmd.exe`, which is what `spawn` hands a joined line
 * to when `shell: true` on Windows. Plain words pass unchanged; anything else
 * is double-quoted with inner quotes doubled.
 */
function quoteWindowsArgument(value: string): string {
  if (/^[A-Za-z0-9_@+:,./\\=-]+$/.test(value)) {
    return value;
  }
  return `"${value.replaceAll('"', '""')}"`;
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
   * An explicit expiry in epoch milliseconds. Absent for a launched child,
   * whose credential lives until {@link ServerAgentCredentialIssuer.revoke} is
   * called on its exit; present for {@link DEV_SERVER_CREDENTIAL_PATH}.
   */
  readonly expiresAt?: number | undefined;
}

/** What {@link ServerAgentCredentialIssuer.revoke} is told to revoke. */
export interface ServerAgentCredentialRevokeInput {
  /** The project root the credential was scoped to. */
  readonly projectRoot: string;
  /** The credential itself, for an issuer that revokes by token hash. */
  readonly token: string;
  /** The issuer's handle, when {@link ServerAgentCredential.credentialId} carried one. */
  readonly credentialId?: string | undefined;
}

/**
 * The access boundary's credential operations, as the launcher needs them —
 * satisfied by `../server/auth.ts` through a one-line adapter in `../main.ts`:
 *
 * ```ts
 * credentials: {
 *   issue: (input) => auth.issueServerAgentCredential(input),
 *   revoke: ({ projectRoot }) => auth.revokeServerAgentCredentials(projectRoot),
 * }
 * ```
 *
 * The implementation must honour AAP §0.5.6: a 32-byte CSPRNG token, stored
 * **only** as its SHA-256 hash in the `credentials` table with
 * `role: "server-agent"` and a scope of exactly that one `projectRoot`; ingest
 * is accepted only for that credential's project; and the credential stops
 * working when {@link revoke} is called (the launched process exited) or its
 * `expiresAt` passes. The launcher calls `revoke` exactly once per issued
 * credential. A `revoke` that throws, rejects or returns an `Err` result is
 * logged, never propagated: revocation runs on exit and shutdown paths that
 * must complete.
 */
export interface ServerAgentCredentialIssuer {
  issue(
    input: ServerAgentCredentialIssueInput,
  ): MaybePromise<Result<ServerAgentCredential, DebuggenError>>;
  revoke(input: ServerAgentCredentialRevokeInput): MaybePromise<unknown>;
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
  /** No stdin; stdout and stderr piped into the service log. */
  readonly stdio: readonly ['ignore', 'pipe', 'pipe'];
  /** `false` on POSIX; `true` on Windows, where `.cmd` shims need `cmd.exe`. */
  readonly shell: boolean;
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
 * Send a signal to the process group led by `pid` — `0` only tests whether any
 * member is alive — throwing an `ESRCH` error when the group is gone, as
 * `process.kill` does. Default: `process.kill(-pid, signal)`.
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
   * The environment a child inherits, before the four preload variables are
   * set. `../main.ts` passes the same environment it handed `loadServiceConfig`,
   * which keeps this module free of `process.env` reads; absent, the service
   * process's own environment is handed through — exactly what `spawn`
   * inherits when given no `env`.
   */
  readonly parentEnv?: ParentEnvironment | undefined;
  /** Default: `child_process.spawn`. */
  readonly spawnImpl?: SpawnLike | undefined;
  /** Default: `process.kill(-pid, signal)`. */
  readonly signalProcessGroup?: SignalProcessGroup | undefined;
  /** Default: `./detect.ts`'s {@link detectDevServer}. */
  readonly detect?: typeof detectDevServer | undefined;
  /** Default: `./detect.ts`'s {@link probeDevServer}. */
  readonly probe?: typeof probeDevServer | undefined;
  /** Forwarded to detection and probing: the server-agent registry, fetch, manifest reader… */
  readonly detectDeps?: LauncherDetectDeps | undefined;
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
  /** Default {@link DEFAULT_STOP_GRACE_MS}. */
  readonly stopGraceMs?: number | undefined;
  /** Default {@link DEFAULT_CLI_CREDENTIAL_TTL_MS}. */
  readonly cliCredentialTtlMs?: number | undefined;
  /** Default: the global `setTimeout`. */
  readonly setTimeoutImpl?: SetTimeoutLike | undefined;
  /** Default: the global `clearTimeout`. */
  readonly clearTimeoutImpl?: ClearTimeoutLike | undefined;
}

// ---------------------------------------------------------------------------
// Records and the launcher API
// ---------------------------------------------------------------------------

/** Where a launched child is in its life. */
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
  /** The session that launched it, when one did. */
  readonly sessionId?: string;
  /** Every session currently relying on it; it is stopped when the last one ends. */
  readonly sessionIds: readonly string[];
  /** The issuer's credential handle, when it returned one. */
  readonly credentialId?: string;
  /** Epoch milliseconds of the spawn. */
  readonly startedAt: number;
  readonly status: LaunchedDevServerStatus;
  /** The executable's name (no arguments). */
  readonly command: string;
  /** The `package.json` script it runs, when the command was derived from one. */
  readonly script?: string;
}

/** Input of {@link DevServerLauncher.launch}: the protocol request plus session context. */
export type DevServerLaunchInput = DevServerLaunchRequest & {
  /** The session the child's lifetime is tied to; see {@link DevServerLauncher.stopForSession}. */
  readonly sessionId?: string | undefined;
  /**
   * The session's dev-server URL, probed first (a server already answering
   * there is reused or refused) and polled for readiness after a spawn.
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
 * A dev server that already answers at the session's URL **with** the preload
 * attached, started outside this service (for instance with
 * `scripts/dev-instrumented.mjs --spawn-local` plus a credential). Nothing was
 * spawned, and the service owns no process for it — so there is no `pid`, and
 * `stop` does not touch it.
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
 * process the stop route can end. That case needs a `devServerUrl` in the
 * request, which only the session path supplies; the HTTP route passes none,
 * so its launches are always managed or refused.
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

/** The dev-server launcher. Every method is safe to call concurrently; none throws. */
export interface DevServerLauncher {
  /**
   * Make sure the project's dev server runs with the preload: reuse one this
   * launcher started, reuse an external preloaded one, refuse an un-preloaded
   * one with the relaunch command, or spawn one and wait until it answers.
   */
  launch(request: DevServerLaunchInput): Promise<Result<DevServerLaunchResult, DebuggenError>>;
  /**
   * Stop launched children matching the input (`SIGTERM`, then `SIGKILL` after
   * the grace period) and revoke their credentials. `stopped: false` — a
   * success — when nothing matched. Serves `POST /dev-server/stop`.
   */
  stop(input: DevServerStopInput): Promise<Result<{ readonly stopped: boolean }, DebuggenError>>;
  /**
   * Mint a time-bounded `server-agent` credential for a dev server the caller
   * starts itself — the logic behind {@link DEV_SERVER_CREDENTIAL_PATH}. The
   * route authorises (editor role and project scope); this validates and mints.
   */
  issueCredential(
    input: DevServerCredentialRequest,
  ): Promise<Result<DevServerCredentialResponse, DebuggenError>>;
  /**
   * The session ended or failed: release its hold on every child, stopping
   * each child no other session relies on and expiring its credential.
   */
  stopForSession(sessionId: string): Promise<void>;
  /** Stop every launched child. Idempotent; never throws. */
  stopAll(): Promise<void>;
  /** Stop everything and refuse further launches. Idempotent; never throws. */
  dispose(): Promise<void>;
  /** A snapshot of every launched child. */
  list(): readonly LaunchedDevServer[];
}

// ---------------------------------------------------------------------------
// Child output: control-sequence stripping, line splitting, the bounded tail
// ---------------------------------------------------------------------------

/**
 * Remove terminal control sequences from a line: ANSI CSI (`ESC [ … final`),
 * OSC (`ESC ] … BEL` or `ESC ] … ESC \`), two-character escapes, carriage
 * returns and other C0 controls except tab. Dev servers colour their output;
 * the service log and the URL matcher want the text.
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

/** The last lines of a child's output, bounded by line count and by characters. */
class OutputTail {
  readonly #lines: string[] = [];
  #chars = 0;

  push(line: string): void {
    this.#lines.push(line);
    this.#chars += line.length;
    while (
      this.#lines.length > OUTPUT_TAIL_MAX_LINES ||
      (this.#chars > OUTPUT_TAIL_MAX_CHARS && this.#lines.length > 1)
    ) {
      const dropped = this.#lines.shift();
      this.#chars -= dropped?.length ?? 0;
    }
  }

  /** The most recent `count` lines, oldest first. */
  last(count: number = OUTPUT_TAIL_MAX_LINES): readonly string[] {
    return Object.freeze(this.#lines.slice(-count));
  }
}

/**
 * The scrubber applied to every child output line before it is logged or kept:
 * the credential value replaced (before and after control sequences are
 * stripped, so colouring cannot hide it), the service's secret patterns
 * scrubbed, the length bounded.
 */
function createLineScrubber(token: string): (line: string) => string {
  const secret = token.length > 0 ? token : undefined;
  const hide = (text: string): string =>
    secret === undefined ? text : text.replaceAll(secret, TOKEN_REDACTION);
  return (line) => {
    const cleaned = scrubLogMessage(hide(stripControlSequences(hide(line)))).trimEnd();
    return cleaned.length > MAX_OUTPUT_LINE_LENGTH
      ? `${cleaned.slice(0, MAX_OUTPUT_LINE_LENGTH)}${TRUNCATION_MARKER}`
      : cleaned;
  };
}

/**
 * The first loopback URL in a scrubbed output line that is not the service's own
 * port, as `origin/`, or `undefined`.
 */
function loopbackUrlIn(line: string, servicePort: number): string | undefined {
  for (const match of line.matchAll(LOOPBACK_URL_PATTERN)) {
    let url: URL;
    try {
      url = new URL(match[0]);
    } catch {
      continue;
    }
    const port = Number(url.port);
    // The service's own port is never the dev server's: a child that echoes
    // its environment prints the ingest endpoint, and the preload may log it.
    if (Number.isInteger(port) && port >= 1 && port <= MAX_TCP_PORT && port !== servicePort) {
      return `${url.origin}/`;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Launched-child state
// ---------------------------------------------------------------------------

/** How a readiness wait ended. */
type ReadyOutcome =
  | { readonly kind: 'ready'; readonly url: string }
  | {
      readonly kind: 'exited';
      readonly code: number | null;
      readonly signal: NodeJS.Signals | null;
    }
  | { readonly kind: 'spawn-error'; readonly errorCode: string | undefined }
  | { readonly kind: 'timeout' };

/** A lifecycle event a readiness wait listens for. */
type ChildEvent =
  | { readonly kind: 'exit'; readonly code: number | null; readonly signal: NodeJS.Signals | null }
  | { readonly kind: 'spawn-error'; readonly errorCode: string | undefined }
  | { readonly kind: 'url' };

/** Everything the launcher tracks about one child. The credential is private to it. */
class ChildState {
  readonly key: string;
  readonly child: ChildProcessLike;
  readonly pid: number | undefined;
  readonly startedAt: number;
  readonly command: string;
  readonly script: string | undefined;
  readonly launchSessionId: string | undefined;
  readonly sessionIds = new Set<string>();
  readonly tail = new OutputTail();
  readonly credentialId: string | undefined;
  readonly scrub: (line: string) => string;
  readonly exited: Promise<void>;

  status: LaunchedDevServerStatus = 'starting';
  devServerUrl: string | undefined;
  seenUrl: string | undefined;
  hasExited = false;
  exitCode: number | null = null;
  exitSignal: NodeJS.Signals | null = null;
  stopRequested = false;
  terminating: Promise<boolean> | undefined;
  listener: ((event: ChildEvent) => void) | undefined;

  #token: string | undefined;
  #revocation: Promise<void> | undefined;
  #markExited: () => void = () => undefined;

  constructor(init: {
    readonly key: string;
    readonly child: ChildProcessLike;
    readonly startedAt: number;
    readonly command: string;
    readonly script: string | undefined;
    readonly sessionId: string | undefined;
    readonly token: string;
    readonly credentialId: string | undefined;
    readonly devServerUrl: string | undefined;
  }) {
    this.key = init.key;
    this.child = init.child;
    this.pid = validPid(init.child.pid);
    this.startedAt = init.startedAt;
    this.command = init.command;
    this.script = init.script;
    this.launchSessionId = init.sessionId;
    if (init.sessionId !== undefined) {
      this.sessionIds.add(init.sessionId);
    }
    this.#token = init.token;
    this.credentialId = init.credentialId;
    this.devServerUrl = init.devServerUrl;
    this.scrub = createLineScrubber(init.token);
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

  /**
   * Revoke this child's credential exactly once, whichever path asks first.
   * The token is dropped from this object as soon as revocation starts.
   */
  revokeOnce(revoke: (input: ServerAgentCredentialRevokeInput) => Promise<void>): Promise<void> {
    if (this.#revocation === undefined) {
      const token = this.#token;
      this.#token = undefined;
      this.#revocation =
        token === undefined
          ? Promise.resolve()
          : revoke({
              projectRoot: this.key,
              token,
              ...(this.credentialId === undefined ? {} : { credentialId: this.credentialId }),
            });
    }
    return this.#revocation;
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
      ...(this.credentialId === undefined ? {} : { credentialId: this.credentialId }),
      startedAt: this.startedAt,
      status: this.status,
      command: this.command,
      ...(this.script === undefined ? {} : { script: this.script }),
    });
  }
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
  readonly stopGraceMs: number;
  readonly cliCredentialTtlMs: number;
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
  readonly #detect: typeof detectDevServer;
  readonly #probe: typeof probeDevServer;
  readonly #now: () => number;
  readonly #setTimeout: SetTimeoutLike;
  readonly #clearTimeout: ClearTimeoutLike;

  readonly #registry = new Map<string, ChildState>();
  readonly #inflight = new Map<string, Promise<Result<DevServerLaunchResult, DebuggenError>>>();
  readonly #keyGenerations = new Map<string, number>();
  readonly #endedSessions = new Set<string>();
  readonly #reapers = new Set<Promise<void>>();
  #globalGeneration = 0;
  #disposed = false;
  #disposing: Promise<void> | undefined;

  constructor(deps: DevServerLauncherDeps) {
    this.#deps = deps;
    this.#parentLogger = deps.logger;
    this.#logger = bindLogger(deps.logger);
    this.#platform = deps.platform ?? process.platform;
    this.#spawn = deps.spawnImpl ?? defaultSpawn;
    // Process groups are a property of a real POSIX spawn: with the default
    // spawn the child leads its own group and a stop signals the whole tree;
    // an injected spawn (a test's fake child) gets group signalling only when
    // it injects the signaller too, so no fake pid is ever signalled for real.
    this.#signalGroup =
      deps.signalProcessGroup ??
      (deps.spawnImpl === undefined && this.#platform !== 'win32'
        ? defaultSignalProcessGroup
        : undefined);
    this.#detect = deps.detect ?? detectDevServer;
    this.#probe = deps.probe ?? probeDevServer;
    this.#now = deps.now ?? nowEpochMs;
    this.#setTimeout = deps.setTimeoutImpl ?? defaultSetTimeout;
    this.#clearTimeout = deps.clearTimeoutImpl ?? defaultClearTimeout;
    this.#settings = {
      readyTimeoutMs: positiveOr(deps.readyTimeoutMs, DEFAULT_READY_TIMEOUT_MS),
      pollIntervalMs: positiveOr(deps.readyPollIntervalMs, DEFAULT_READY_POLL_INTERVAL_MS),
      stopGraceMs: positiveOr(deps.stopGraceMs, DEFAULT_STOP_GRACE_MS),
      cliCredentialTtlMs: positiveOr(deps.cliCredentialTtlMs, DEFAULT_CLI_CREDENTIAL_TTL_MS),
    };

    const collision = findCredentialRouteCollision();
    if (collision !== undefined) {
      this.#log('warn', 'A protocol route collides with the dev-server credential route', {
        path: DEV_SERVER_CREDENTIAL_PATH,
        operation: collision,
      });
    }
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

      const existing = this.#registry.get(root.value.key);
      if (existing?.status === 'stopping') {
        await existing.terminating;
      }
      const reused = existing === undefined ? undefined : this.#reusable(existing, sessionId);
      if (reused !== undefined) {
        return ok(reused);
      }

      const pending = this.#inflight.get(root.value.key);
      if (pending !== undefined) {
        const outcome = await pending;
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
   * A ready child reused for another caller, recording the caller's session —
   * or `undefined` when the child is not (or no longer) ready to be reused.
   */
  #reusable(state: ChildState, sessionId: string | undefined): ManagedDevServerLaunch | undefined {
    const pid = state.pid;
    const devServerUrl = state.devServerUrl;
    if (
      state.status !== 'ready' ||
      state.hasExited ||
      pid === undefined ||
      devServerUrl === undefined
    ) {
      return undefined;
    }
    if (sessionId !== undefined) {
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
    });
    if (isErr(preload)) {
      this.#log('warn', 'The telemetry preload was not found; no dev server was launched', {
        projectRoot: root.key,
      });
      return preload;
    }
    const preloadPath = preload.value;

    // Detection first: never spawn a second server where one already answers.
    const requestedUrl = nonEmpty(request.devServerUrl);
    const detection = await this.#detect(
      { projectRoot: root.native, devServerUrl: requestedUrl },
      {
        ...this.#deps.detectDeps,
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
          "This project's dev server is already running without the Debug Generator preload, so a second one was not started on its port.",
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

    const command = this.#resolveCommand(request.command, detection);
    if (isErr(command)) {
      return command;
    }
    if (this.#isCancelled(ticket)) {
      return err(cancelledError());
    }

    // The credential: minted before the spawn, never handed to anything but the child.
    const credential = await this.#issue({ projectRoot: root.key });
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
    const credentialId = nonEmpty(credential.value.credentialId);
    const revokeUnused = (): Promise<void> =>
      this.#revoke({
        projectRoot: root.key,
        token,
        ...(credentialId === undefined ? {} : { credentialId }),
      });

    if (this.#isCancelled(ticket)) {
      await revokeUnused();
      return err(cancelledError());
    }

    let env: Record<string, string>;
    try {
      env = buildDevServerEnv({
        parentEnv: { ...(this.#deps.parentEnv ?? process.env), ...command.value.env },
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

    const useShell = this.#platform === 'win32';
    const file = useShell ? quoteWindowsArgument(command.value.file) : command.value.file;
    const args = useShell ? command.value.args.map(quoteWindowsArgument) : command.value.args;

    let child: ChildProcessLike;
    const startedAt = this.#now();
    try {
      child = this.#spawn(file, args, {
        cwd: root.native,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: useShell,
        windowsHide: true,
        detached: this.#signalGroup !== undefined,
      });
    } catch (error) {
      await revokeUnused();
      return err(spawnFailedError(command.value.file, errnoCodeOf(error), [], error));
    }

    const state = new ChildState({
      key: root.key,
      child,
      startedAt,
      command: executableName(command.value.file),
      script: command.value.script,
      sessionId,
      token,
      credentialId,
      devServerUrl: requestedUrl,
    });
    this.#attach(state);

    if (state.pid === undefined) {
      // A spawn with no pid failed (`ENOENT`, `EACCES`); the `error` event says why.
      const outcome = await this.#waitForReady(state, undefined);
      await state.revokeOnce((input) => this.#revoke(input));
      const errorCode = outcome.kind === 'spawn-error' ? outcome.errorCode : undefined;
      return err(
        spawnFailedError(command.value.file, errorCode, state.tail.last(ERROR_TAIL_LINES)),
      );
    }

    this.#registry.set(root.key, state);
    this.#log('info', 'Spawned a dev server with the telemetry preload attached', {
      projectRoot: root.key,
      pid: state.pid,
      command: state.command,
      ...(state.script === undefined ? {} : { script: state.script }),
      ...(sessionId === undefined ? {} : { sessionId }),
    });

    if (this.#isCancelled(ticket)) {
      await this.#terminate(state, 'cancelled');
      return err(cancelledError());
    }

    const outcome = await this.#waitForReady(state, requestedUrl);
    if (outcome.kind === 'ready' && !state.stopRequested && !state.hasExited) {
      state.status = 'ready';
      state.devServerUrl = outcome.url;
      this.#log('info', 'The launched dev server is ready', {
        projectRoot: root.key,
        pid: state.pid,
        devServerUrl: outcome.url,
        startupMs: Math.max(0, this.#now() - startedAt),
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

  /** Clean up after a failed start and describe why it failed. */
  async #failStartup(
    state: ChildState,
    outcome: ReadyOutcome,
    file: string,
  ): Promise<DebuggenError> {
    const stopped = state.stopRequested;
    state.status = 'failed';
    if (!state.hasExited) {
      await this.#terminate(state, outcome.kind === 'timeout' ? 'ready-timeout' : 'startup-failed');
    }
    await state.revokeOnce((input) => this.#revoke(input));
    this.#forget(state);

    const tail = [...state.tail.last(ERROR_TAIL_LINES)];
    if (stopped) {
      return cancelledError();
    }
    switch (outcome.kind) {
      case 'timeout':
        this.#log('warn', 'The launched dev server did not become ready in time; it was stopped', {
          projectRoot: state.key,
          pid: state.pid,
          timeoutMs: this.#settings.readyTimeoutMs,
        });
        return new DebuggenError(
          'DEV_SERVER_UNAVAILABLE',
          `The dev server did not answer within ${String(Math.round(this.#settings.readyTimeoutMs / 1000))} s of starting, so it was stopped.`,
          {
            hint: withOutputTail(
              'It never printed a local address and never answered a probe. If it prints its address late, or at a non-loopback address, set debuggen.devServerUrl to its local address and launch again.',
              tail,
            ),
            details: {
              reason: 'ready-timeout',
              timeoutMs: this.#settings.readyTimeoutMs,
              ...(state.seenUrl === undefined ? {} : { lastSeenUrl: state.seenUrl }),
              outputTail: tail,
            },
          },
        );
      case 'spawn-error':
        return spawnFailedError(file, outcome.errorCode, tail);
      case 'exited':
      case 'ready':
        this.#log('warn', 'The launched dev server exited before it was ready', {
          projectRoot: state.key,
          pid: state.pid,
          exitCode: state.exitCode,
          signal: state.exitSignal,
        });
        return new DebuggenError(
          'DEV_SERVER_LAUNCH_FAILED',
          state.exitCode === null
            ? `The dev server stopped${state.exitSignal === null ? '' : ` (${state.exitSignal})`} before it was ready.`
            : `The dev server exited with code ${String(state.exitCode)} before it was ready.`,
          {
            hint: withOutputTail(
              'Fix the problem its output reports (a missing dependency, a port in use, a build error), then launch the dev server again.',
              tail,
            ),
            details: {
              reason: 'exited-before-ready',
              exitCode: state.exitCode,
              signal: state.exitSignal,
              outputTail: tail,
            },
          },
        );
      default:
        return assertNever(outcome);
    }
  }

  /** The command to spawn: the request's, or the package manager plus the detected dev script. */
  #resolveCommand(
    requested: string | undefined,
    detection: DevServerDetection,
  ): Result<ResolvedCommand, DebuggenError> {
    if (requested !== undefined && requested.trim().length > 0) {
      const parsed = parseLaunchCommand(requested);
      return isErr(parsed) ? parsed : ok({ ...parsed.value, script: undefined });
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
    return ok({ file, args, env: {}, script });
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

  /** One scrubbed output line: kept in the tail, logged, and checked for the serving URL. */
  #recordOutput(state: ChildState, stream: 'stdout' | 'stderr', raw: string): void {
    const line = state.scrub(raw);
    if (line.trim().length === 0) {
      return;
    }
    state.tail.push(line);
    this.#log('info', 'dev-server output', {
      projectRoot: state.key,
      pid: state.pid,
      stream,
      line,
    });
    if (state.seenUrl === undefined) {
      const url = loopbackUrlIn(line, this.#deps.config.port);
      if (url !== undefined) {
        state.seenUrl = url;
        state.listener?.({ kind: 'url' });
      }
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
    void state.revokeOnce((input) => this.#revoke(input));
    if (!wasStopping) {
      // The leader is gone; anything it left in its group (a framework's
      // server worker) would keep the port and the old code. Reap it.
      this.#track(this.#reapGroup(state));
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
      void state.revokeOnce((input) => this.#revoke(input));
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
   * Wait until the child is ready, exits, fails to spawn, or the ready
   * timeout passes — whichever is first. Two routes to "ready":
   *
   * - **(a) the child reports it**: the first loopback URL it prints. Dev
   *   servers print their local address once they listen, so that line is the
   *   child's own evidence, and its URL is what the session records;
   * - **(b) polling**: for a child that prints no address, the requested
   *   `devServerUrl` is probed with the loopback-only probe every poll
   *   interval until any HTTP status answers. A URL the probe refuses (not
   *   loopback) is dropped, and the wait falls back to route (a).
   */
  #waitForReady(state: ChildState, requestedUrl: string | undefined): Promise<ReadyOutcome> {
    return new Promise<ReadyOutcome>((resolve) => {
      let settled = false;
      let probing = false;
      let fallbackUrl = requestedUrl;
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
        resolve(outcome);
      };

      const schedule = (): void => {
        if (settled || timers.poll !== undefined) {
          return;
        }
        timers.poll = {
          handle: this.#setTimeout(() => {
            timers.poll = undefined;
            void poll();
          }, this.#settings.pollIntervalMs),
        };
      };

      const poll = async (): Promise<void> => {
        if (settled || probing) {
          return;
        }
        if (state.seenUrl !== undefined) {
          finish({ kind: 'ready', url: state.seenUrl });
          return;
        }
        const url = fallbackUrl;
        if (url === undefined) {
          schedule();
          return;
        }
        probing = true;
        let probe: Awaited<ReturnType<typeof probeDevServer>> | undefined;
        try {
          probe = await this.#probe(url, {
            fetchImpl: this.#deps.detectDeps?.fetchImpl,
            probeTimeoutMs: this.#deps.detectDeps?.probeTimeoutMs,
            logger: this.#parentLogger,
            now: this.#now,
          });
        } catch {
          probe = undefined;
        } finally {
          probing = false;
        }
        if (settled) {
          return;
        }
        if (probe !== undefined && isErr(probe)) {
          // The requested URL may not be probed (not loopback); wait for the
          // child to print its own address instead.
          fallbackUrl = undefined;
        } else if (probe?.ok === true && probe.value.reachable) {
          finish({ kind: 'ready', url: probe.value.url });
          return;
        }
        schedule();
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
            if (state.seenUrl !== undefined) {
              finish({ kind: 'ready', url: state.seenUrl });
            }
            return;
          default:
            assertNever(event);
        }
      };
      timers.deadline = {
        handle: this.#setTimeout(() => {
          finish({ kind: 'timeout' });
        }, this.#settings.readyTimeoutMs),
      };
      void poll();
    });
  }

  /**
   * Stop a child: `SIGTERM` (to its process group when group signalling is
   * on, else to the child), then — once the grace period passes with the
   * leader or any group member still alive — `SIGKILL`. The credential is
   * revoked and the registry entry removed either way. Shared by every stop
   * path, so concurrent callers await one termination.
   *
   * @returns `true` when a live child was signalled.
   */
  #terminate(state: ChildState, reason: string): Promise<boolean> {
    state.terminating ??= this.#runTermination(state, reason);
    return state.terminating;
  }

  async #runTermination(state: ChildState, reason: string): Promise<boolean> {
    state.stopRequested = true;
    const pid = state.pid;
    if (pid === undefined || state.hasExited) {
      await state.revokeOnce((input) => this.#revoke(input));
      this.#forget(state);
      if (pid !== undefined) {
        await this.#reapGroup(state);
      }
      return false;
    }

    if (state.status !== 'failed') {
      state.status = 'stopping';
    }
    this.#sendSignal(state, 'SIGTERM');
    const graceful = await this.#waitUntil(
      () => state.hasExited && !this.#groupAlive(state),
      this.#settings.stopGraceMs,
    );
    let escalated = false;
    if (!graceful) {
      escalated = true;
      this.#sendSignal(state, 'SIGKILL');
      if (this.#platform === 'win32') {
        this.#killWindowsTree(pid);
      }
      await this.#waitUntil(() => state.hasExited, KILL_CONFIRM_MS);
    }

    await state.revokeOnce((input) => this.#revoke(input));
    this.#forget(state);
    this.#log(state.hasExited ? 'info' : 'warn', 'Stopped a launched dev server', {
      projectRoot: state.key,
      pid,
      reason,
      escalated,
      exitObserved: state.hasExited,
    });
    return true;
  }

  /**
   * After the leader exited on its own, end whatever it left in its process
   * group: `SIGTERM`, then `SIGKILL` if anything survives the grace period.
   */
  async #reapGroup(state: ChildState): Promise<void> {
    if (!this.#groupAlive(state)) {
      return;
    }
    this.#sendSignal(state, 'SIGTERM');
    const gone = await this.#waitUntil(() => !this.#groupAlive(state), this.#settings.stopGraceMs);
    if (!gone) {
      this.#sendSignal(state, 'SIGKILL');
    }
  }

  /**
   * Signal the child's process group when group signalling is on (the group
   * includes the leader), else — or when the group cannot be signalled — the
   * child alone.
   */
  #sendSignal(state: ChildState, signal: NodeJS.Signals): void {
    const pid = state.pid;
    if (pid !== undefined && this.#signalGroup !== undefined) {
      try {
        this.#signalGroup(pid, signal);
        return;
      } catch (error) {
        if (errnoCodeOf(error) === 'ESRCH' && state.hasExited) {
          return;
        }
      }
    }
    if (!state.hasExited) {
      try {
        state.child.kill(signal);
      } catch {
        // Delivery failed; the escalation step or the exit handler follows.
      }
    }
  }

  /** Whether any process in the child's group is alive (`false` without group signalling). */
  #groupAlive(state: ChildState): boolean {
    const pid = state.pid;
    if (pid === undefined || this.#signalGroup === undefined) {
      return false;
    }
    try {
      this.#signalGroup(pid, 0);
      return true;
    } catch (error) {
      return errnoCodeOf(error) === 'EPERM';
    }
  }

  /** End a process tree on Windows, where there are no process groups to signal. */
  #killWindowsTree(pid: number): void {
    try {
      const killer = this.#spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
        cwd: process.cwd(),
        env: stringEnvironment(this.#deps.parentEnv ?? process.env),
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
        windowsHide: true,
        detached: false,
      });
      killer.on('error', () => undefined);
    } catch {
      // `child.kill('SIGKILL')` already ran; this was the tree-wide backstop.
    }
  }

  /**
   * Resolve `true` as soon as `condition` holds, or `false` once `timeoutMs`
   * has elapsed. Elapsed time is the sum of the timer delays, so the bound
   * holds under an injected timer and a frozen clock alike.
   */
  #waitUntil(condition: () => boolean, timeoutMs: number): Promise<boolean> {
    if (condition()) {
      return Promise.resolve(true);
    }
    return new Promise<boolean>((resolve) => {
      let elapsed = 0;
      const step = (): void => {
        const delay = Math.max(1, Math.min(GROUP_POLL_INTERVAL_MS, timeoutMs - elapsed));
        this.#setTimeout(() => {
          elapsed += delay;
          if (condition()) {
            resolve(true);
          } else if (elapsed >= timeoutMs) {
            resolve(false);
          } else {
            step();
          }
        }, delay);
      };
      step();
    });
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

      const matches = [...this.#registry.values()].filter(
        (state) =>
          (key === undefined || state.key === key) &&
          (pid === undefined || state.pid === pid) &&
          (sessionId === undefined || state.sessionIds.has(sessionId)),
      );
      const outcomes = await Promise.all(
        matches.map((state) => this.#terminate(state, 'stop-requested')),
      );
      if (inflight !== undefined) {
        await inflight;
      }
      return ok({ stopped: inflight !== undefined || outcomes.some((stopped) => stopped) });
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

  async stopForSession(sessionId: string): Promise<void> {
    const id = nonEmpty(sessionId);
    if (id === undefined) {
      return;
    }
    this.#rememberEndedSession(id);
    const released: ChildState[] = [];
    for (const state of this.#registry.values()) {
      if (state.sessionIds.delete(id) && state.sessionIds.size === 0) {
        released.push(state);
      }
    }
    await Promise.allSettled(released.map((state) => this.#terminate(state, 'session-ended')));
  }

  async stopAll(): Promise<void> {
    this.#globalGeneration += 1;
    const states = [...this.#registry.values()];
    await Promise.allSettled(states.map((state) => this.#terminate(state, 'shutdown')));
  }

  dispose(): Promise<void> {
    this.#disposing ??= this.#runDispose();
    return this.#disposing;
  }

  async #runDispose(): Promise<void> {
    this.#disposed = true;
    await this.stopAll();
    // A launch that was between its credential and its spawn sees the bumped
    // generation and stops its own child; wait for it, then sweep once more.
    await Promise.allSettled([...this.#inflight.values()]);
    await this.stopAll();
    await Promise.allSettled([...this.#reapers]);
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
    const parsed = devServerCredentialRequestSchema.safeParse(input);
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
    const requestedExpiry = Math.floor(this.#now() + this.#settings.cliCredentialTtlMs);
    const issued = await this.#issue({ projectRoot, expiresAt: requestedExpiry });
    if (isErr(issued)) {
      return issued;
    }

    const body = devServerCredentialResponseSchema.safeParse({
      token: issued.value.token,
      expiresAt: issued.value.expiresAt ?? requestedExpiry,
    });
    if (!body.success) {
      await this.#revoke({
        projectRoot,
        token: issued.value.token,
        ...(issued.value.credentialId === undefined
          ? {}
          : { credentialId: issued.value.credentialId }),
      });
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

  /** Revoke a credential; never throws, and logs (without the token) when it could not. */
  async #revoke(input: ServerAgentCredentialRevokeInput): Promise<void> {
    try {
      const outcome = await this.#deps.credentials.revoke(input);
      if (isErrResult(outcome)) {
        this.#log('warn', 'A server-agent credential could not be revoked', {
          projectRoot: input.projectRoot,
        });
      }
    } catch (error) {
      this.#log('warn', 'Revoking a server-agent credential failed', {
        projectRoot: input.projectRoot,
        errorCode: errnoCodeOf(error),
      });
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

  /** Log through the subsystem logger; a failing logger never changes an outcome. */
  #log(level: 'info' | 'warn' | 'error', message: string, fields: Record<string, unknown>): void {
    try {
      this.#logger[level](message, fields);
    } catch {
      // Logging is diagnostic only.
    }
  }
}

// ---------------------------------------------------------------------------
// Module helpers
// ---------------------------------------------------------------------------

/** A command resolved for `spawn`, with the script it came from, if any. */
interface ResolvedCommand extends ParsedLaunchCommand {
  readonly script: string | undefined;
}

/** Bind the module's subsystem to a parent logger, falling back to the no-op logger. */
function bindLogger(parent: Logger | undefined): Logger {
  try {
    return subsystemLogger(parent ?? noopLogger, LOG_SUBSYSTEM);
  } catch {
    return noopLogger;
  }
}

/** A trimmed non-empty string, or `undefined`. */
function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed.length === 0 ? undefined : trimmed;
}

/** An environment's string-valued entries. */
function stringEnvironment(env: ParentEnvironment): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
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

/** A command that could not be started at all. */
function spawnFailedError(
  file: string,
  errorCode: string | undefined,
  outputTail: readonly string[],
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
      hint: withOutputTail(hint, outputTail),
      details: {
        reason: 'spawn-failed',
        ...(errorCode === undefined ? {} : { errorCode }),
        outputTail: [...outputTail],
      },
      ...(cause === undefined ? {} : { cause }),
    },
  );
}

/** How many trailing output lines a hint quotes. */
const HINT_TAIL_LINES = 5;

/** The longest quotation of output a hint carries, in characters. */
const HINT_TAIL_MAX_CHARS = 600;

/**
 * A hint followed by the last few lines the child printed — already scrubbed
 * of the credential and of secret patterns — so the developer sees the cause
 * where the failure is shown. The full tail travels in `details.outputTail`.
 */
function withOutputTail(hint: string, tail: readonly string[]): string {
  const lines = tail
    .slice(-HINT_TAIL_LINES)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) {
    return hint;
  }
  const quoted = lines.join(' | ');
  const bounded =
    quoted.length > HINT_TAIL_MAX_CHARS
      ? `${TRUNCATION_MARKER}${quoted.slice(-HINT_TAIL_MAX_CHARS)}`
      : quoted;
  return `${hint} Last output: ${bounded}`;
}

/** The default {@link SpawnLike}: `child_process.spawn` with the fixed stdio layout. */
const defaultSpawn: SpawnLike = (command, args, options) =>
  nodeSpawn(command, [...args], {
    cwd: options.cwd,
    env: { ...options.env },
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: options.shell,
    windowsHide: options.windowsHide,
    detached: options.detached,
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
