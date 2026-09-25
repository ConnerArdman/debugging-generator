/**
 * The typed transport between the `e2e` specs and the local coordination
 * service: every HTTP call and every WebSocket frame the suite needs goes
 * through this one module, so no spec and no sibling helper builds a client of
 * its own.
 *
 * ## What this module owns
 *
 * - {@link createServiceHandle} — a {@link ServiceHandle} over
 *   `@debuggen/protocol`'s `HttpClient`, authenticated with the editor
 *   credential and addressing every route by its operation id (never by a path
 *   literal). Every protocol `Err` becomes a thrown {@link ServiceCallError};
 *   the one-capture-per-project refusal becomes a {@link CaptureConflictError}
 *   naming the owning session.
 * - {@link createEditorClient} — an {@link EditorClientHandle}: an editor-role
 *   (`vscode`) `ReconnectingWsClient` that records every inbound envelope in
 *   order, so {@link EditorClientHandle.waitFor} resolves from what already
 *   arrived before it waits for what has not.
 * - The resolution helpers {@link debuggenHome}, {@link readEditorToken},
 *   {@link serviceBaseUrl} and {@link serviceWsUrl}.
 *
 * ## What this module never does
 *
 * 1. **It never starts a service.** The Playwright config's single `webServer`
 *    boots `node apps/local-service/dist/main.js` and health-checks
 *    `GET /health`; this module connects to that instance. A second service
 *    would own a second `$DEBUGGEN_HOME`, a second credential set and a second
 *    store, and every later assertion would be about the wrong process — so a
 *    silent `/health` is an actionable failure, never a reason to spawn one.
 * 2. **It never exposes a credential.** The editor credential is read from
 *    `$DEBUGGEN_HOME/auth.json` at run time and handed to the protocol clients
 *    through a lazy provider held in a module-private closure. No token,
 *    bearer string or connection string appears in this file, and no error
 *    message, log line or return value built here carries one (AAP §0.5.6).
 *    {@link ServiceHandle.pairComplete} returns the devtools credential to its
 *    caller only because that is the operation's whole answer.
 * 3. **It never writes.** It reads `auth.json` and nothing else — not even
 *    into `$DEBUGGEN_HOME` (AAP §0.5.1: helpers read, the product writes).
 * 4. **It never sleeps.** Waits are event-driven on recorded protocol messages
 *    (bounded by a deadline timer) or `expect.poll`; there is no
 *    `waitForTimeout`-style pause anywhere.
 * 5. **It never reconnects on its own.** Backoff belongs to the protocol client
 *    (`DEFAULT_WS_BACKOFF`), and a `4401` close is terminal for a credential.
 *
 * ## Relationship to `tests/browser/fixtures.ts`
 *
 * The `ServiceHandle` shape, `ServiceCallError`, the editor observer and its
 * buffer-first `waitFor` follow the pattern that file established, with the
 * same names wherever the two overlap. It is deliberately **not imported**: the
 * two projects have different app-start contracts (the browser suite serves a
 * preload-free copy of the fixture app, the e2e suite launches both apps
 * through the product's launcher with the telemetry preload), and its
 * `ServiceHandle` is a narrower type whose fixture keys would collide with
 * `tests/e2e/helpers/fixtures.ts`'s. Deliberate divergences, each with its
 * reason:
 *
 * - The protocol `HttpClient` is not exposed as `http`: {@link ServiceHandle.call}
 *   covers every operation, and keeping the client private keeps its
 *   credential source unreachable from spec code.
 * - The credential is re-read from `auth.json` on every call rather than once,
 *   so a mid-suite token rotation is survivable.
 * - Recorded frames are `{ index, receivedAt, message }` rather than the
 *   envelope flattened with `receivedAt`, with **absolute** indices that
 *   survive buffer overflow and `clear()`, so {@link EditorClientHandle.snapshotIndex}
 *   can mark a point that stays meaningful for the whole session.
 * - `waitFor`'s predicate receives `(payload, message)` and its options accept
 *   `sinceIndex`, because the e2e workflow driver scopes every wait to the
 *   messages that followed a mark instead of clearing the buffer mid-session.
 * - `getCurrentPanel` answers the `PanelSpec` (or `null`) rather than the
 *   response wrapper, and `getModifications`/`listSessions` likewise unwrap
 *   their arrays — the wrappers carry nothing else.
 *
 * This file declares no `test(...)`, `describe(...)` or fixture:
 * `tests/e2e/helpers/fixtures.ts` turns these handles into Playwright fixtures.
 */

import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { expect } from '@playwright/test';

import {
  CAPTURE_CONFLICT_ERROR_CODE,
  HttpClient,
  isCompatibleProtocolVersion,
  PROTOCOL_VERSION,
  ReconnectingWsClient,
  resolveWsUrl,
  WS_CLOSE_UNAUTHORIZED,
} from '@debuggen/protocol';
import type {
  CaptureStartResponse,
  CaptureStopResponse,
  ConnectionState,
  DataQuery,
  DataQuerySource,
  DataResult,
  DataResultFor,
  DevServerLaunchRequest,
  DevServerLaunchResponse,
  DevServerStopRequest,
  DevServerStopResponse,
  FetchLike,
  HealthResponse,
  HttpOperation,
  HttpRequestArgs,
  HttpResponseBody,
  MessageByType,
  MessagePayload,
  MessageType,
  ModificationRecord,
  PairCompleteResponse,
  PairStartResponse,
  PanelSpec,
  ProtocolMessage,
  SessionCreateRequest,
  SessionEndResponse,
  SessionRecord,
  WsUnauthorizedDetail,
} from '@debuggen/protocol';
import type { DebuggenError, Result } from '@debuggen/shared';

import {
  debuggenHome as configuredDebuggenHome,
  serviceUrl as configuredServiceUrl,
} from '../../../playwright.config';
import { repoRoot } from './repo';

/**
 * The request and response types of every {@link ServiceHandle} method,
 * re-exported from `@debuggen/protocol` (inferred from its schemas there, never
 * restated here) so a sibling helper can name them without a second import.
 */
export type {
  CaptureStartResponse,
  CaptureStopResponse,
  DataResultFor,
  DevServerLaunchRequest,
  DevServerLaunchResponse,
  DevServerStopRequest,
  DevServerStopResponse,
  HealthResponse,
  MessageByType,
  MessagePayload,
  MessageType,
  ModificationRecord,
  PairCompleteResponse,
  PairStartResponse,
  PanelSpec,
  SessionEndResponse,
  SessionRecord,
};

// ---------------------------------------------------------------------------
// Budgets and bounds — named once so no caller restates a magic number
// ---------------------------------------------------------------------------

/**
 * How long {@link ServiceHandle.expectHealthy} polls `GET /health` by default.
 * The config's `webServer` has already started the service before any test
 * runs, so this only covers a busy host.
 */
export const SERVICE_READY_TIMEOUT_MS = 30_000;

/** The bound on one `GET /health` probe inside {@link ServiceHandle.expectHealthy}. */
export const HEALTH_PROBE_TIMEOUT_MS = 2_000;

/** The `expect.poll` intervals every poll in this module uses. */
export const POLL_INTERVALS_MS: readonly number[] = [100, 250, 500, 1_000];

/**
 * How long a scope-checked call is retried while the service refuses the
 * project for scope (`PATH_OUTSIDE_PROJECT`, 403). An editor connection's workspace announcement is
 * recorded asynchronously and never acknowledged, so a call issued right after
 * the announcing socket opened can briefly be refused for scope.
 */
export const ANNOUNCEMENT_SETTLE_MS = 3_000;

/** The default budget of {@link EditorClientHandle.waitFor}. */
export const DEFAULT_WAIT_TIMEOUT_MS = 15_000;

/** How long {@link createEditorClient} waits for the socket to open. */
export const EDITOR_CONNECT_TIMEOUT_MS = 10_000;

/**
 * How long {@link createEditorClient} watches an open socket for a refusal.
 * The service answers an accepted `client.hello` with silence and a refused
 * one with a `4401` close shortly after `open`, so this window is the only
 * verdict signal there is. It ends early on any state change.
 */
export const HELLO_VERDICT_GRACE_MS = 500;

/**
 * How many envelopes an {@link EditorClientHandle} retains. On overflow the
 * oldest are dropped (and counted in {@link EditorClientHandle.dropped});
 * indices stay absolute, so a mark taken before the overflow still scopes a
 * wait correctly, and a timeout names how many older frames were dropped.
 */
export const EDITOR_CLIENT_MAX_RECORDED = 10_000;

/** How many protocol-error descriptions an {@link EditorClientHandle} keeps (the most recent). */
export const EDITOR_CLIENT_MAX_PROTOCOL_ERRORS = 50;

/**
 * The page cap of {@link ServiceHandle.queryAllPanelData}. A paging bug (an
 * offset that never advances to `null`) fails loudly at this many pages
 * instead of looping; pass `maxPages` to raise it for a deliberately tiny
 * `limit`.
 */
export const PANEL_DATA_MAX_PAGES = 1_000;

/** The file the service writes the editor credential to, inside `$DEBUGGEN_HOME`. */
export const EDITOR_CREDENTIAL_FILE = 'auth.json';

/** The `auth.json` format version this module understands (the service's `AUTH_FILE_VERSION`). */
const EDITOR_CREDENTIAL_FILE_VERSION = 1;

/** The service's own ceiling on a presented credential's length (`tokenSchema`). */
const MAX_CREDENTIAL_LENGTH = 512;

/** The product default home, used only when neither the environment nor the config names one. */
const PRODUCT_DEFAULT_HOME_SEGMENT = '.debuggen';

// ---------------------------------------------------------------------------
// Small total helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A non-empty trimmed string, else `undefined` (the config's `readEnv` rule). */
function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === '' ? undefined : trimmed;
}

/** The HTTP status a protocol client error recorded in its details, if any. */
function statusOf(error: DebuggenError): number | undefined {
  const details: unknown = error.details;
  return isRecord(details) && typeof details.status === 'number' ? details.status : undefined;
}

/** A string field of a protocol client error's details, if present. */
function detailString(error: DebuggenError, key: string): string | undefined {
  const details: unknown = error.details;
  if (!isRecord(details)) {
    return undefined;
  }
  const value = details[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * Run a promise-returning builder so a synchronous throw (a refused
 * configuration) surfaces as a rejection, like every other failure of the
 * factory that calls it.
 */
function rejectOnThrow<T>(build: () => Promise<T>): Promise<T> {
  try {
    return build();
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error(String(error)));
  }
}

/** `Type×count` pairs in first-arrival order, for diagnostics that must never print payloads. */
function summarizeTypes(types: readonly string[]): string {
  if (types.length === 0) {
    return 'no messages at all';
  }
  const counts = new Map<string, number>();
  for (const type of types) {
    counts.set(type, (counts.get(type) ?? 0) + 1);
  }
  return [...counts].map(([type, count]) => `${type}×${String(count)}`).join(', ');
}

// ---------------------------------------------------------------------------
// Resolution: the service home, the editor credential, the service origin
// ---------------------------------------------------------------------------

/**
 * Expand a leading `~` the way `apps/local-service/src/config.ts` does (`~`
 * and `~/…` against the account's home directory; `~other` refused) and
 * require an absolute result, because the service refuses any other value and
 * a relative path here would name a directory the service never used.
 */
function expandHome(value: string, origin: string): string {
  if (value === '~' || value.startsWith('~/') || value.startsWith('~\\')) {
    const home = os.homedir();
    return path.normalize(value === '~' ? home : path.join(home, value.slice(2)));
  }
  if (value.startsWith('~')) {
    throw new Error(
      `${origin} names another account's home (${value}); the service refuses that form, so no service can be using it. Use an absolute path or one starting with ~/.`,
    );
  }
  if (!path.isAbsolute(value)) {
    throw new Error(
      `${origin} is not absolute (${value}); the service refuses a relative DEBUGGEN_HOME, so no service can be using it. Use an absolute path or one starting with ~/.`,
    );
  }
  return path.normalize(value);
}

/**
 * The `$DEBUGGEN_HOME` of the service under test.
 *
 * Resolved at call time, in this order:
 *
 * 1. `DEBUGGEN_HOME` from the environment (trimmed; empty counts as unset) —
 *    CI sets it to `${{ runner.temp }}/debuggen` and parallel clones set it per
 *    clone;
 * 2. the Playwright config's `debuggenHome` export — the value its `webServer`
 *    hands the service when the environment names none
 *    (`<repo>/test-results/debuggen-home`);
 * 3. the product default `~/.debuggen` (mirroring `apps/local-service/src/config.ts`),
 *    reachable only if the config ever stops exporting a value.
 *
 * Step 2 is a deliberate divergence from the product's own "environment, else
 * `~/.debuggen`" rule: the suite's service does not run with the product
 * default, and reading `~/.debuggen/auth.json` would present a credential that
 * service never minted.
 *
 * @throws When the selected value is a form the service itself refuses.
 */
export function debuggenHome(): string {
  const fromEnv = nonEmpty(process.env.DEBUGGEN_HOME);
  if (fromEnv !== undefined) {
    return expandHome(fromEnv, 'DEBUGGEN_HOME');
  }
  const fromConfig = nonEmpty(configuredDebuggenHome);
  if (fromConfig !== undefined) {
    return expandHome(fromConfig, "The Playwright config's debuggenHome");
  }
  return path.join(os.homedir(), PRODUCT_DEFAULT_HOME_SEGMENT);
}

/** Options of {@link readEditorToken}. */
export interface ReadEditorTokenOptions {
  /** The service home to read `auth.json` from; defaults to {@link debuggenHome}. */
  readonly home?: string | undefined;
}

/**
 * Read the editor (`vscode`-role) credential the service wrote to
 * `$DEBUGGEN_HOME/auth.json` — `{ version: 1, token, issuedAt }`, written
 * `0600` on first start and rewritten on rotation.
 *
 * Only the file's shape is checked. No error raised here quotes the file's
 * contents or any field value: each names the resolved home, the fact that the
 * service writes the file on first start, and the likely cause.
 *
 * @returns The credential. Callers hand it to a protocol client and nowhere
 * else — never to a log, an assertion message or a report attachment.
 * @throws When the file is missing, unreadable or not the shape the service writes.
 */
export async function readEditorToken(options: ReadEditorTokenOptions = {}): Promise<string> {
  const home = options.home ?? debuggenHome();
  const file = path.join(home, EDITOR_CREDENTIAL_FILE);
  const cause = `The service writes it on first start into its own DEBUGGEN_HOME; the likely cause is that the running service uses a different DEBUGGEN_HOME than ${home} (a reused local service started from another shell, or a mismatched DEBUGGEN_HOME), or that it has not started yet.`;

  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    const code = isRecord(error) && typeof error.code === 'string' ? error.code : 'unknown error';
    // A filesystem error names the path and the errno, never file contents.
    throw new Error(`The editor credential file ${file} could not be read (${code}). ${cause}`, {
      cause: error,
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Deliberately unbound and not attached as a cause: V8's `SyntaxError`
    // quotes a slice of the text it failed on, which here is the credential file.
    throw new Error(
      `The editor credential file ${file} is not valid JSON. ${cause} If the service is running with this home, restart it so it rewrites the file.`,
    );
  }

  const credential = credentialOf(parsed);
  if ('problem' in credential) {
    throw new Error(
      `The editor credential file ${file} ${credential.problem}. ${cause} If the service is running with this home, rebuild with \`pnpm build\` and restart it.`,
    );
  }
  return credential.token;
}

/**
 * The credential of a parsed `auth.json`, or a description of why its shape
 * is not the one the service writes. Descriptions name fields, never values.
 */
function credentialOf(parsed: unknown): { readonly token: string } | { readonly problem: string } {
  if (!isRecord(parsed)) {
    return { problem: 'is not a JSON object' };
  }
  if (parsed.version !== EDITOR_CREDENTIAL_FILE_VERSION) {
    return {
      problem: `carries a \`version\` other than ${String(EDITOR_CREDENTIAL_FILE_VERSION)} (a service build newer or older than these helpers)`,
    };
  }
  const token = parsed.token;
  if (typeof token !== 'string') {
    return { problem: 'carries no string `token` field' };
  }
  if (token.length === 0 || token.length > MAX_CREDENTIAL_LENGTH) {
    return {
      problem: `carries a \`token\` outside the service's 1–${String(MAX_CREDENTIAL_LENGTH)} character range`,
    };
  }
  return { token };
}

/** Overrides of {@link serviceBaseUrl}. */
export interface ServiceUrlOverrides {
  /**
   * An explicit service origin — `tests/e2e/helpers/fixtures.ts` passes the
   * project's `use.serviceUrl` here, so a per-project override wins.
   */
  readonly baseUrl?: string | undefined;
}

/**
 * The service origin, for example `http://127.0.0.1:43117`, without a trailing
 * slash.
 *
 * The explicit override (the Playwright project's `use.serviceUrl`) wins;
 * otherwise the config's `serviceUrl` export, which is itself
 * `DEBUGGEN_HOST`/`DEBUGGEN_PORT` over the documented defaults — read from
 * there so the default port is written in exactly one place. The protocol
 * client validates the result (loopback only, no path) when a handle or client
 * is created.
 */
export function serviceBaseUrl(overrides: ServiceUrlOverrides = {}): string {
  const selected = nonEmpty(overrides.baseUrl) ?? configuredServiceUrl;
  return selected.replace(/\/+$/u, '');
}

/**
 * The editor WebSocket endpoint for a service origin, derived by the
 * protocol's own `resolveWsUrl` (never by concatenating `/ws`).
 *
 * @throws When the protocol refuses the origin (not loopback, a path, userinfo…).
 */
export function serviceWsUrl(baseUrl: string = serviceBaseUrl()): string {
  const resolved = resolveWsUrl(baseUrl);
  if (!resolved.ok) {
    throw new Error(
      `The service origin ${baseUrl} was refused for the WebSocket endpoint: ${resolved.error.message}. Point DEBUGGEN_HOST/DEBUGGEN_PORT (or the project's use.serviceUrl) at the loopback service the config's webServer started.`,
    );
  }
  return resolved.value;
}

/**
 * Where the protocol clients get their credential: re-read from `auth.json`
 * on every call, so a rotation mid-suite is survivable, and held only in this
 * closure. A read failure is not thrown into the protocol client (which would
 * reduce it to "the credential provider failed"); it is recorded here and
 * appended to the resulting `UNAUTHORIZED` error by {@link ServiceCallError}.
 */
interface CredentialSource {
  /** The provider handed to `HttpClient` and `ReconnectingWsClient`. */
  readonly provider: () => Promise<string | undefined>;
  /** The actionable account of the last failed read, if the last read failed. */
  problem(): string | undefined;
  /** The home the credential is read from (a path, never a secret). */
  readonly home: string;
}

function createCredentialSource(home: string, explicit: string | undefined): CredentialSource {
  let lastProblem: string | undefined;
  if (explicit !== undefined) {
    return {
      provider: () => Promise.resolve(explicit),
      problem: () => undefined,
      home,
    };
  }
  return {
    provider: async () => {
      try {
        const token = await readEditorToken({ home });
        lastProblem = undefined;
        return token;
      } catch (error) {
        lastProblem = error instanceof Error ? error.message : String(error);
        return undefined;
      }
    },
    problem: () => lastProblem,
    home,
  };
}

// ---------------------------------------------------------------------------
// Failures: every protocol `Err` becomes one of these
// ---------------------------------------------------------------------------

/** What a failed call was about, beyond the protocol error itself. */
interface ServiceCallContext {
  /** The session the call addressed, when it addressed one. */
  readonly sessionId?: string | undefined;
  /** A plain-language lead for the message, placed before the protocol account. */
  readonly lead?: string | undefined;
  /** The credential source's account of a failed `auth.json` read, for `UNAUTHORIZED`. */
  readonly credentialProblem?: string | undefined;
}

/**
 * A failed service call, carrying the protocol error's `code`, `message` and
 * `hint`, the operation id and the session id — and nothing else: no
 * credential, no request body, no response payload.
 */
export class ServiceCallError extends Error {
  /** The operation id that failed, for example `session.create`. */
  readonly operation: string;
  /** The protocol error code, for example `SESSION_INVALID_STATE`. */
  readonly code: string;
  /** The HTTP status, when the service answered with one. */
  readonly status: number | undefined;
  /** The developer-facing hint, when the protocol client derived one. */
  readonly hint: string | undefined;
  /** The session the call addressed, when it addressed one. */
  readonly sessionId: string | undefined;

  constructor(operation: string, error: DebuggenError, context: ServiceCallContext = {}) {
    const status = statusOf(error);
    const hint = typeof error.hint === 'string' && error.hint !== '' ? error.hint : undefined;
    const scope = context.sessionId === undefined ? '' : ` for session ${context.sessionId}`;
    const lead = context.lead === undefined ? '' : `${context.lead}. `;
    const httpStatus = status === undefined ? '' : ` (HTTP ${String(status)})`;
    const hintText = hint === undefined ? '' : ` — ${hint}`;
    const credential =
      error.code === 'UNAUTHORIZED' && context.credentialProblem !== undefined
        ? ` Credential: ${context.credentialProblem}`
        : '';
    super(
      `${operation}${scope} failed with ${error.code}${httpStatus}: ${lead}${error.message}${hintText}${credential}`,
    );
    this.name = 'ServiceCallError';
    this.operation = operation;
    this.code = error.code;
    this.status = status;
    this.hint = hint;
    this.sessionId = context.sessionId;
  }
}

/**
 * `capture.start` refused because another session already holds the capture
 * for the same project (AAP §0.4.2: at most one capture per project; the
 * service answers `409 { owningSessionId }`). Thrown by
 * {@link ServiceHandle.startCapture} so a spec fails fast naming the owner
 * instead of waiting on a `capture.started` that will never come.
 */
export class CaptureConflictError extends ServiceCallError {
  /** The session that holds the project's capture. */
  readonly owningSessionId: string;

  constructor(error: DebuggenError, sessionId: string, owningSessionId: string) {
    super('capture.start', error, {
      sessionId,
      lead: `another session (${owningSessionId}) already holds the capture for this project — end it, or let the session tracker end it, before starting another capture`,
    });
    this.name = 'CaptureConflictError';
    this.owningSessionId = owningSessionId;
  }
}

// ---------------------------------------------------------------------------
// Handle types — inferred from the protocol, never restated
// ---------------------------------------------------------------------------

/** The `session.create` request body (`{ projectRoot, question, target? }`). */
export type SessionCreateInput = SessionCreateRequest;

/** A `DataQuery` naming one source, so its result type follows the source. */
export type DataQueryFor<S extends DataQuerySource> = DataQuery & { readonly source: S };

/** The one `DataResult` member that carries a page echo (`total`, `limit`, `offset`, `nextOffset`). */
export type PagedDataResult = Extract<DataResult, { readonly nextOffset: unknown }>;

/**
 * The sources whose result is a page of items — `spans`, `events`, `renders`,
 * `requests`, `queries`, `stateTransitions`, `metrics` — derived from the
 * protocol's `DataResult` so a new source cannot be forgotten here.
 */
export type PagedDataSource = PagedDataResult['source'];

/** The sources whose result is a single object with no page: `trace`, `componentTree`, `graph`. */
export type SingleValueDataSource = Exclude<DataQuerySource, PagedDataSource>;

/** The item array of a paged source's result (each member names its items after its source). */
export type PagedItemsOf<S extends PagedDataSource> =
  DataResultFor<S> extends Readonly<Record<S, infer Items>> ? Items : never;

/** One item of a paged source's result. */
export type PagedItemOf<S extends PagedDataSource> =
  PagedItemsOf<S> extends readonly (infer Item)[] ? Item : never;

/** Everything {@link ServiceHandle.queryAllPanelData} collected by walking the pages. */
export interface PanelDataCollection<S extends PagedDataSource> {
  /** The source that was walked. */
  readonly source: S;
  /** Every item, in the service's order, from the query's starting offset to the end. */
  readonly items: readonly PagedItemOf<S>[];
  /** The `total` every page reported (it is asserted stable across pages). */
  readonly total: number;
  /** How many pages were requested. */
  readonly pages: number;
  /** The page size the service applied (the first page's `limit` echo). */
  readonly pageSize: number;
}

/** Options of {@link ServiceHandle.queryAllPanelData}. */
export interface QueryAllPanelDataOptions {
  /** The page cap; defaults to {@link PANEL_DATA_MAX_PAGES}. */
  readonly maxPages?: number | undefined;
}

/** Options of {@link ServiceHandle.expectHealthy}. */
export interface ExpectHealthyOptions {
  /** How long to poll; defaults to {@link SERVICE_READY_TIMEOUT_MS}. */
  readonly timeoutMs?: number | undefined;
}

/** Options a long-running call accepts (the protocol client has no default timeout). */
export interface ServiceCallOptions {
  /** An upper bound for the request; unbounded when omitted. */
  readonly timeoutMs?: number | undefined;
}

/** Typed client of the local service the config's `webServer` started (never spawned here). */
export interface ServiceHandle {
  /** The service origin, for example `http://127.0.0.1:43117`. */
  readonly baseUrl: string;
  /** The editor WebSocket endpoint, derived by `resolveWsUrl`. */
  readonly wsUrl: string;
  /** The service's `$DEBUGGEN_HOME`, where `auth.json` is read. */
  readonly debuggenHome: string;
  /**
   * Any operation, answered as the protocol client's `Result` rather than
   * thrown — for a spec asserting a refusal (`!result.ok`, `result.error.code`).
   */
  call<O extends HttpOperation>(
    operation: O,
    args?: HttpRequestArgs<O>,
  ): Promise<Result<HttpResponseBody<O>, DebuggenError>>;
  /** One `GET /health` (exempt from authentication). */
  health(): Promise<HealthResponse>;
  /**
   * Poll `GET /health` with `expect.poll` until the service answers, then
   * require a compatible protocol version. Raises the actionable "service not
   * answering" failure (is it built, did `pnpm build` run, is `DEBUGGEN_PORT`
   * overridden?) — it never starts a service.
   */
  expectHealthy(options?: ExpectHealthyOptions): Promise<HealthResponse>;
  /**
   * `POST /sessions`. The project must lie under a workspace folder a live
   * editor connection announced, and the service must already know its dev
   * server (launch it first with {@link launchDevServer}). A scope refusal
   * right after the announcing socket opened is retried for
   * {@link ANNOUNCEMENT_SETTLE_MS}.
   */
  createSession(input: SessionCreateInput): Promise<SessionRecord>;
  /** `POST /sessions/:id/question` — a follow-up question; the service decides the path. */
  askFollowUp(sessionId: string, question: string): Promise<SessionRecord>;
  /** `GET /sessions/:id`. */
  getSession(sessionId: string): Promise<SessionRecord>;
  /** `GET /sessions`, unwrapped to the array. */
  listSessions(): Promise<readonly SessionRecord[]>;
  /**
   * `POST /sessions/:id/capture/start`.
   *
   * @throws {CaptureConflictError} When another session holds the project's capture.
   */
  startCapture(sessionId: string): Promise<CaptureStartResponse>;
  /** `POST /sessions/:id/capture/stop` — answers once the window closed (`{ summary }`). */
  stopCapture(sessionId: string): Promise<CaptureStopResponse>;
  /** `POST /sessions/:id/end` — awaits cleanup; `conflict` is a successful answer. */
  endSession(sessionId: string): Promise<SessionEndResponse>;
  /** `GET /sessions/:id/panel` — the current panel, or `null` when none was generated yet. */
  getCurrentPanel(sessionId: string): Promise<PanelSpec | null>;
  /** `GET /sessions/:id/panels/:panelId`. */
  getPanel(sessionId: string, panelId: string): Promise<PanelSpec>;
  /** `GET /sessions/:id/modifications`, unwrapped to the array (in application order). */
  getModifications(sessionId: string): Promise<readonly ModificationRecord[]>;
  /**
   * One page of `POST /sessions/:id/panel-data`, typed by the query's source
   * so the `DataResult` discriminant narrows at the call site.
   */
  queryPanelData<S extends DataQuerySource>(
    sessionId: string,
    query: DataQueryFor<S>,
  ): Promise<DataResultFor<S>>;
  /**
   * Every page of a paged source: walks `nextOffset` until it is `null`,
   * asserts the collected count against `total` (and `total` stable across
   * pages), and fails at `maxPages`. Calling it with `trace`, `componentTree`
   * or `graph` — single objects with no page — is a type error.
   */
  queryAllPanelData<S extends PagedDataSource>(
    sessionId: string,
    query: DataQueryFor<S>,
    options?: QueryAllPanelDataOptions,
  ): Promise<PanelDataCollection<S>>;
  /** `POST /pair/start` (editor credential required) — the one-time code for the panel's `PairDialog`. */
  pairStart(): Promise<PairStartResponse>;
  /**
   * `POST /pair/complete` — exported for completeness only. The devtools
   * credential's scope is derived from the requesting **origin**, and the
   * service refuses any origin other than `chrome-extension://<id>`: a call
   * from Node is refused, and could never yield a credential the extension can
   * use. The real flow is driven by `tests/e2e/helpers/chrome.ts` through the
   * extension's own service worker. The answer's credential must never be
   * logged, asserted on by value or attached to a report.
   */
  pairComplete(code: string): Promise<PairCompleteResponse>;
  /**
   * `POST /dev-server/launch` — the typed call only; the lifecycle policy
   * (when to launch, preload verification, stop on teardown) belongs to
   * `demo-app.ts` and `sample-app.ts`. Scope refusals right after an editor
   * connection opened are retried like {@link createSession}'s.
   */
  launchDevServer(
    input: DevServerLaunchRequest,
    options?: ServiceCallOptions,
  ): Promise<DevServerLaunchResponse>;
  /** `POST /dev-server/stop` — `{ stopped: false }` (nothing was running) is a successful answer. */
  stopDevServer(
    input: DevServerStopRequest,
    options?: ServiceCallOptions,
  ): Promise<DevServerStopResponse>;
  /**
   * Open an editor-role WebSocket against this service with this handle's
   * credential source (see {@link createEditorClient}).
   */
  connectEditor(options?: EditorClientConnectOptions): Promise<EditorClientHandle>;
}

/** Options of {@link createServiceHandle}. */
export interface ServiceHandleOptions {
  /** The service origin; defaults to {@link serviceBaseUrl}. */
  readonly baseUrl?: string | undefined;
  /**
   * An explicit editor credential. Omit it in the suite: the handle then
   * re-reads `auth.json` on every call. When given, it is kept in this
   * module's closure only.
   */
  readonly token?: string | undefined;
  /** A transport for the protocol client; defaults to the global `fetch`. */
  readonly fetch?: FetchLike | undefined;
  /** The service home to read `auth.json` from; defaults to {@link debuggenHome}. */
  readonly home?: string | undefined;
}

// ---------------------------------------------------------------------------
// ServiceHandle — reuses the running service; never spawns one
// ---------------------------------------------------------------------------

/** Whether a page belongs to the source that was queried. */
function isResultFor<S extends DataQuerySource>(
  result: DataResult,
  source: S,
): result is DataResultFor<S> {
  return result.source === source;
}

/**
 * Whether a refusal is the service's scope refusal of the editor credential
 * (`PATH_OUTSIDE_PROJECT`, 403). The protocol client reports every 401/403
 * with an unauthorized-family code — it normalises the service's
 * `PATH_OUTSIDE_PROJECT` to `UNAUTHORIZED` so the user interfaces can offer
 * pairing or rotation — so the refusal is recognised by its status: for an
 * editor credential calling from Node (no `Origin`, the `vscode` role these
 * routes admit), a 403 on a scope-checked route has no other cause. A `401`
 * (a credential the service did not issue) is not a scope refusal and is
 * never retried. The service's own code is accepted too, should the client
 * ever pass it through.
 */
function isScopeRefusal(error: DebuggenError): boolean {
  if (error.code === 'PATH_OUTSIDE_PROJECT') {
    return true;
  }
  return error.code === 'UNAUTHORIZED' && statusOf(error) === 403;
}

/** Whether a result carries a page echo (`total`, `limit`, `offset`, `nextOffset`). */
function isPagedResult(result: DataResult): result is PagedDataResult {
  return 'nextOffset' in result;
}

/** The items of one page, by its source (each member names its items after its source). */
function pageItems(page: PagedDataResult): readonly unknown[] {
  switch (page.source) {
    case 'spans':
      return page.spans;
    case 'events':
      return page.events;
    case 'renders':
      return page.renders;
    case 'requests':
      return page.requests;
    case 'queries':
      return page.queries;
    case 'stateTransitions':
      return page.stateTransitions;
    case 'metrics':
      return page.metrics;
    default: {
      const unhandled: never = page;
      throw new Error(`pageItems: unhandled paged source in ${JSON.stringify(unhandled)}`);
    }
  }
}

/** The actionable account of a silent `/health`. */
function notAnsweringMessage(baseUrl: string, timeoutMs: number, lastProblem: string): string {
  return [
    `The local service at ${baseUrl} did not answer GET /health within ${String(timeoutMs)} ms (last: ${lastProblem}).`,
    "These helpers never start a service: the Playwright config's webServer runs `node apps/local-service/dist/main.js`.",
    'Check that it is built (`pnpm build`, or `pnpm --filter @debuggen/local-service... build`), that the webServer started (its output precedes the test output),',
    `and that DEBUGGEN_HOST/DEBUGGEN_PORT (or the project's use.serviceUrl) agree with the service the config started (${configuredServiceUrl}).`,
  ].join(' ');
}

/**
 * Create a {@link ServiceHandle} for the service the config's `webServer`
 * started. Nothing is contacted here — `tests/e2e/helpers/fixtures.ts`
 * follows it with {@link ServiceHandle.expectHealthy}, so an unbuilt or
 * absent service fails once, with the actionable message.
 *
 * @returns A rejected promise when the protocol client refuses the origin.
 */
export function createServiceHandle(options: ServiceHandleOptions = {}): Promise<ServiceHandle> {
  return rejectOnThrow(() => Promise.resolve(buildServiceHandle(options)));
}

function buildServiceHandle(options: ServiceHandleOptions): ServiceHandle {
  const baseUrl = serviceBaseUrl({ baseUrl: options.baseUrl });
  const wsUrl = serviceWsUrl(baseUrl);
  const home = options.home ?? debuggenHome();
  const credentials = createCredentialSource(home, options.token);
  const http = new HttpClient({
    baseUrl,
    token: credentials.provider,
    fetch: options.fetch,
  });
  if (http.configurationError !== undefined) {
    throw new Error(
      `The service origin ${baseUrl} was refused by the protocol client: ${http.configurationError.message}. Point DEBUGGEN_HOST/DEBUGGEN_PORT (or the project's use.serviceUrl) at the loopback service the config's webServer started.`,
    );
  }

  /** Convert a protocol `Err` into a thrown {@link ServiceCallError}; the only exit for a failure. */
  const unwrap = <T>(
    operation: HttpOperation,
    result: Result<T, DebuggenError>,
    context: ServiceCallContext = {},
  ): T => {
    if (result.ok) {
      return result.value;
    }
    throw new ServiceCallError(operation, result.error, {
      ...context,
      credentialProblem: credentials.problem(),
    });
  };

  const call = <O extends HttpOperation>(
    operation: O,
    args?: HttpRequestArgs<O>,
  ): Promise<Result<HttpResponseBody<O>, DebuggenError>> => http.request(operation, args);

  /**
   * A scope-checked call: retried with `expect.poll` while the service refuses
   * the project for scope, because the announcing editor connection's scope is
   * registered asynchronously and never acknowledged. A refused request did no
   * work, so repeating it is safe; any other answer ends the retry at once.
   * See {@link isScopeRefusal} for how the refusal is recognised.
   */
  const callScoped = async <O extends HttpOperation>(
    operation: O,
    args: HttpRequestArgs<O>,
    projectRoot: string,
  ): Promise<HttpResponseBody<O>> => {
    const latest: { result: Result<HttpResponseBody<O>, DebuggenError> } = {
      result: await call(operation, args),
    };
    const refusedForScope = (): boolean => !latest.result.ok && isScopeRefusal(latest.result.error);
    if (!refusedForScope()) {
      return unwrap(operation, latest.result);
    }
    let lead: string | undefined;
    try {
      await expect
        .poll(
          async () => {
            latest.result = await call(operation, args);
            return refusedForScope();
          },
          {
            message: `${operation} for ${projectRoot} kept being refused for scope (403)`,
            timeout: ANNOUNCEMENT_SETTLE_MS,
            intervals: [...POLL_INTERVALS_MS],
          },
        )
        .toBe(false);
    } catch {
      lead = `the service kept refusing ${projectRoot} with 403 for ${String(ANNOUNCEMENT_SETTLE_MS)} ms; for the editor credential that means no live editor connection announced a workspace folder containing it — connect one first (createEditorClient / connectEditor announce the repository root by default; pass projectRoot for a project outside the repository)`;
    }
    return unwrap(operation, latest.result, { lead });
  };

  const handle: ServiceHandle = {
    baseUrl,
    wsUrl,
    debuggenHome: home,
    call,

    async health() {
      return unwrap('health', await http.health({ timeoutMs: HEALTH_PROBE_TIMEOUT_MS }));
    },

    async expectHealthy(healthOptions = {}) {
      const timeoutMs = healthOptions.timeoutMs ?? SERVICE_READY_TIMEOUT_MS;
      // Written from the poll's callback, so held in an object that flow
      // analysis does not narrow at its declaration.
      const probe: { answer: HealthResponse | undefined; problem: string } = {
        answer: undefined,
        problem: 'nothing answered',
      };
      try {
        await expect
          .poll(
            async () => {
              const result = await http.health({ timeoutMs: HEALTH_PROBE_TIMEOUT_MS });
              if (result.ok) {
                probe.answer = result.value;
                return true;
              }
              probe.problem = `${result.error.code}: ${result.error.message}`;
              return false;
            },
            {
              message: `GET /health at ${baseUrl}`,
              timeout: timeoutMs,
              intervals: [...POLL_INTERVALS_MS],
            },
          )
          .toBe(true);
      } catch {
        throw new Error(notAnsweringMessage(baseUrl, timeoutMs, probe.problem));
      }
      const answer = probe.answer;
      if (answer === undefined) {
        throw new Error(notAnsweringMessage(baseUrl, timeoutMs, probe.problem));
      }
      if (!isCompatibleProtocolVersion(answer.protocolVersion)) {
        throw new Error(
          `The service at ${baseUrl} speaks protocol ${answer.protocolVersion}, which these helpers (protocol ${PROTOCOL_VERSION}) do not: a stale service is running — stop it, or rebuild with \`pnpm build\` and let the config's webServer start it.`,
        );
      }
      return answer;
    },

    createSession(input) {
      return callScoped('session.create', { body: input }, input.projectRoot);
    },

    async askFollowUp(sessionId, question) {
      return unwrap(
        'session.question',
        await call('session.question', { params: { id: sessionId }, body: { question } }),
        { sessionId },
      );
    },

    async getSession(sessionId) {
      return unwrap('session.get', await call('session.get', { params: { id: sessionId } }), {
        sessionId,
      });
    },

    async listSessions() {
      return unwrap('session.list', await call('session.list')).sessions;
    },

    async startCapture(sessionId) {
      const result = await http.startCapture(sessionId);
      if (!result.ok && result.error.code === CAPTURE_CONFLICT_ERROR_CODE) {
        const owner = detailString(result.error, 'owningSessionId');
        if (owner !== undefined) {
          throw new CaptureConflictError(result.error, sessionId, owner);
        }
      }
      return unwrap('capture.start', result, { sessionId });
    },

    async stopCapture(sessionId) {
      return unwrap(
        'capture.stop',
        await call('capture.stop', { params: { id: sessionId }, body: {} }),
        { sessionId },
      );
    },

    async endSession(sessionId) {
      return unwrap(
        'session.end',
        await call('session.end', { params: { id: sessionId }, body: {} }),
        { sessionId },
      );
    },

    async getCurrentPanel(sessionId) {
      return unwrap('panel.get', await call('panel.get', { params: { id: sessionId } }), {
        sessionId,
      }).panel;
    },

    async getPanel(sessionId, panelId) {
      return unwrap(
        'panel.getById',
        await call('panel.getById', { params: { id: sessionId, panelId } }),
        { sessionId },
      ).panel;
    },

    async getModifications(sessionId) {
      return unwrap(
        'modifications.list',
        await call('modifications.list', { params: { id: sessionId } }),
        { sessionId },
      ).modifications;
    },

    async queryPanelData<S extends DataQuerySource>(sessionId: string, query: DataQueryFor<S>) {
      const result = unwrap(
        'panel.data',
        await call('panel.data', { params: { id: sessionId }, body: query }),
        { sessionId },
      );
      if (!isResultFor(result, query.source)) {
        throw new Error(
          `panel.data for session ${sessionId} answered a ${result.source} result to a ${query.source} query.`,
        );
      }
      return result;
    },

    async queryAllPanelData<S extends PagedDataSource>(
      sessionId: string,
      query: DataQueryFor<S>,
      allOptions: QueryAllPanelDataOptions = {},
    ): Promise<PanelDataCollection<S>> {
      const maxPages = allOptions.maxPages ?? PANEL_DATA_MAX_PAGES;
      const label = `queryAllPanelData(${query.source}) for session ${sessionId}`;
      if (!Number.isInteger(maxPages) || maxPages < 1) {
        throw new Error(`${label}: maxPages must be a positive integer.`);
      }
      if (query.limit === 0) {
        throw new Error(
          `${label}: limit 0 is a count-only request with no pages to walk — use queryPanelData for it.`,
        );
      }
      const startOffset = query.offset ?? 0;
      const items: unknown[] = [];
      let offset = startOffset;
      let total: number | undefined;
      let pageSize: number | undefined;
      let pages = 0;
      for (;;) {
        if (pages >= maxPages) {
          throw new Error(
            `${label}: still paging after ${String(maxPages)} pages (offset ${String(offset)} of ${String(total)}); the service's nextOffset never reached null — a paging bug, or raise maxPages for a deliberately tiny limit.`,
          );
        }
        const answer: DataResult = await handle.queryPanelData(sessionId, { ...query, offset });
        pages += 1;
        if (!isPagedResult(answer)) {
          throw new Error(`${label}: the service answered a ${answer.source} result with no page.`);
        }
        const page = answer;
        if (page.offset !== offset) {
          throw new Error(
            `${label}: the service echoed offset ${String(page.offset)} for a request at offset ${String(offset)}.`,
          );
        }
        if (total === undefined) {
          total = page.total;
          pageSize = page.limit;
        } else if (page.total !== total) {
          throw new Error(
            `${label}: total changed from ${String(total)} to ${String(page.total)} while paging — the source is still growing; walk the pages of a stopped capture.`,
          );
        }
        items.push(...pageItems(page));
        if (page.nextOffset === null) {
          break;
        }
        if (page.nextOffset <= offset) {
          throw new Error(
            `${label}: nextOffset ${String(page.nextOffset)} does not advance past offset ${String(offset)}.`,
          );
        }
        offset = page.nextOffset;
      }
      const expected = Math.max(0, total - startOffset);
      if (items.length !== expected) {
        throw new Error(
          `${label}: collected ${String(items.length)} item(s) over ${String(pages)} page(s), but total ${String(total)} from offset ${String(startOffset)} implies ${String(expected)}.`,
        );
      }
      return {
        source: query.source,
        // The pages were checked to be of `query.source`, so their items are that source's items.
        items: items as PagedItemOf<S>[],
        total,
        pages,
        pageSize: pageSize ?? items.length,
      };
    },

    async pairStart() {
      return unwrap('pair.start', await call('pair.start', { body: {} }));
    },

    async pairComplete(code) {
      return unwrap('pair.complete', await http.pairComplete(code));
    },

    launchDevServer(input, callOptions = {}) {
      return callScoped(
        'devServer.launch',
        { body: input, timeoutMs: callOptions.timeoutMs },
        input.projectRoot,
      );
    },

    stopDevServer(input, callOptions = {}) {
      return callScoped(
        'devServer.stop',
        { body: input, timeoutMs: callOptions.timeoutMs },
        input.projectRoot,
      );
    },

    connectEditor(connectOptions = {}) {
      return connectEditorClient(baseUrl, wsUrl, credentials, connectOptions);
    },
  };
  return handle;
}

// ---------------------------------------------------------------------------
// EditorClientHandle — the recording editor-role WebSocket client
// ---------------------------------------------------------------------------

/**
 * One inbound envelope an {@link EditorClientHandle} recorded, in arrival
 * order: the validated protocol message (`{ id, type, sessionId?, ts,
 * payload }`, `ts` being the sender's epoch-millisecond timestamp), when this
 * process received it, and its absolute position in the recording.
 */
export interface RecordedEnvelope {
  /** The absolute position: 0 for the first envelope ever recorded, never reused. */
  readonly index: number;
  /** When this process received the frame (epoch milliseconds). */
  readonly receivedAt: number;
  /** The validated envelope. */
  readonly message: ProtocolMessage;
}

/** Scopes a read or a wait to the envelopes recorded at or after an index. */
export interface SinceIndexOptions {
  /**
   * An index from {@link EditorClientHandle.snapshotIndex}; `0` (the default)
   * means everything still retained.
   */
  readonly sinceIndex?: number | undefined;
}

/** Options of {@link EditorClientHandle.waitFor}. */
export interface EditorWaitOptions extends SinceIndexOptions {
  /** The wait's budget; defaults to {@link DEFAULT_WAIT_TIMEOUT_MS}. */
  readonly timeoutMs?: number | undefined;
}

/** A match condition over one message type: `(payload, message) => boolean`. */
export type MessagePredicate<K extends MessageType> = (
  payload: MessagePayload<K>,
  message: MessageByType<K>,
) => boolean;

/** One row of the message-type timeline — types, counts and times only, never payloads. */
export interface MessageTypeTimelineEntry {
  /** The message type. */
  readonly type: MessageType;
  /** How many envelopes of this type were recorded in the window. */
  readonly count: number;
  /** When the first of them was received (epoch milliseconds). */
  readonly firstReceivedAt: number;
  /** When the last of them was received (epoch milliseconds). */
  readonly lastReceivedAt: number;
}

/** Connection options shared by {@link createEditorClient} and {@link ServiceHandle.connectEditor}. */
export interface EditorClientConnectOptions {
  /**
   * The project root announced in `client.hello`; defaults to the repository
   * root. The `vscode` role may only act on project roots under a folder its
   * live connections announced, and the suite drives sessions for both
   * `apps/demo-app` and `tests/fixtures/sample-next-app`, so the repository
   * root is what covers both.
   */
  readonly projectRoot?: string | undefined;
  /** How long to wait for the socket to open; defaults to {@link EDITOR_CONNECT_TIMEOUT_MS}. */
  readonly connectTimeoutMs?: number | undefined;
  /** How many envelopes to retain; defaults to {@link EDITOR_CLIENT_MAX_RECORDED}. */
  readonly maxRecorded?: number | undefined;
}

/** Options of {@link createEditorClient}. */
export interface EditorClientOptions extends EditorClientConnectOptions {
  /** The service origin; defaults to {@link serviceBaseUrl}. */
  readonly baseUrl?: string | undefined;
  /** An explicit editor credential; omit it to re-read `auth.json` on every connection attempt. */
  readonly token?: string | undefined;
  /** The service home to read `auth.json` from; defaults to {@link debuggenHome}. */
  readonly home?: string | undefined;
}

/**
 * A connected editor-role (`vscode`) WebSocket observer that records every
 * inbound envelope, in order, from the moment it connects.
 */
export interface EditorClientHandle {
  /** The project root announced in `client.hello`. */
  readonly projectRoot: string;
  /** The WebSocket endpoint (a URL without credentials). */
  readonly url: string;
  /** The protocol client's connection state. */
  state(): ConnectionState;
  /**
   * Resolve with the first envelope of `type` matching `predicate`, searching
   * the **already-recorded** envelopes from `sinceIndex` first and only then
   * waiting for new ones — the service broadcasts `session.created`,
   * `session.progress` and even `instrumentation.ready` faster than a spec can
   * call this, so a future-only wait would deadlock the suite.
   *
   * Rejects on timeout with the message **types** (and counts) received since
   * `sinceIndex` — never payloads — so "timed out" reads as "got
   * `instrumentation.failed`, not `instrumentation.ready`". Rejects at once
   * when the credential was refused (`4401`) or the client was closed.
   */
  waitFor<K extends MessageType>(
    type: K,
    predicate?: MessagePredicate<K>,
    options?: EditorWaitOptions,
  ): Promise<MessageByType<K>>;
  /**
   * Resolve when no envelope of `type` matching `predicate` is recorded (from
   * `sinceIndex`, counting those already recorded) within `withinMs`; reject
   * naming the index and session of the one that arrived.
   */
  expectNoMessage<K extends MessageType>(
    type: K,
    predicate: MessagePredicate<K> | undefined,
    withinMs: number,
    options?: SinceIndexOptions,
  ): Promise<void>;
  /** Resolve with the next envelope recorded after the call, or `undefined` after `withinMs`. */
  next(withinMs: number): Promise<RecordedEnvelope | undefined>;
  /** Every retained envelope of `type` (from `sinceIndex`), oldest first. */
  messagesOf<K extends MessageType>(
    type: K,
    options?: SinceIndexOptions,
  ): readonly MessageByType<K>[];
  /** The most recent retained envelope of `type` matching `predicate`, if any. */
  lastOf<K extends MessageType>(
    type: K,
    predicate?: MessagePredicate<K>,
  ): MessageByType<K> | undefined;
  /** Every retained envelope (from `sinceIndex`) with its index and arrival time, oldest first. */
  entries(options?: SinceIndexOptions): readonly RecordedEnvelope[];
  /**
   * The message-type timeline (type, count, first and last arrival) of the
   * retained envelopes from `sinceIndex`, in first-arrival order — the
   * credential-free diagnostic `fixtures.ts` attaches on failure.
   */
  timeline(options?: SinceIndexOptions): readonly MessageTypeTimelineEntry[];
  /**
   * The index the next envelope will get. Take it before an action and pass it
   * as `sinceIndex` to wait only for what follows.
   */
  snapshotIndex(): number;
  /** How many envelopes were dropped on overflow of the retention cap. */
  dropped(): number;
  /** The recent protocol errors (a frame that failed validation…), most recent last; never payloads. */
  protocolErrors(): readonly string[];
  /** Forget every retained envelope; indices keep counting, so earlier marks stay valid. */
  clear(): void;
  /**
   * Close the socket (the service releases this connection's workspace
   * announcement), reject every pending wait and clear every timer.
   * Idempotent.
   */
  close(): void;
}

/**
 * Narrow a recorded message to one type. Spelled as an intersection with
 * `MessageByType<K>` (identical to the union member for every concrete `K`),
 * because TypeScript cannot relate a generic `Extract<ProtocolMessage, …>` to
 * `MessageByType<K>`.
 */
function isOfType<K extends MessageType>(
  message: ProtocolMessage,
  type: K,
): message is ProtocolMessage & MessageByType<K> {
  return message.type === type;
}

/** A `sinceIndex` value, validated: a non-negative integer (default 0). */
function sinceIndexOf(options: SinceIndexOptions | undefined, label: string): number {
  const since = options?.sinceIndex ?? 0;
  if (!Number.isInteger(since) || since < 0) {
    throw new Error(`${label}: sinceIndex must be a non-negative integer.`);
  }
  return since;
}

/**
 * Open an editor-role WebSocket against a running service and record every
 * inbound envelope.
 *
 * The protocol client is constructed with Node 24's **global** `WebSocket`
 * (which is what keeps a `ws` dependency out of `tests/`), the identity
 * `{ client: 'vscode', projectRoot }` and the lazy credential provider; it
 * sends `client.hello` as frame 0 itself and adds `version: PROTOCOL_VERSION`
 * to it — the identity type carries no `version` field, so this module does
 * not (and cannot) restate one. Backoff and the send queue are the protocol
 * client's (`DEFAULT_WS_BACKOFF`); this module adds no reconnect policy.
 *
 * @throws When the socket does not open in time, or the service refuses the
 * credential with `4401` (terminal: the protocol client does not retry it).
 */
export function createEditorClient(options: EditorClientOptions = {}): Promise<EditorClientHandle> {
  return rejectOnThrow(() => {
    const baseUrl = serviceBaseUrl({ baseUrl: options.baseUrl });
    const wsUrl = serviceWsUrl(baseUrl);
    const credentials = createCredentialSource(options.home ?? debuggenHome(), options.token);
    return connectEditorClient(baseUrl, wsUrl, credentials, options);
  });
}

async function connectEditorClient(
  baseUrl: string,
  wsUrl: string,
  credentials: CredentialSource,
  options: EditorClientConnectOptions,
): Promise<EditorClientHandle> {
  const projectRoot = options.projectRoot ?? repoRoot();
  const connectTimeoutMs = options.connectTimeoutMs ?? EDITOR_CONNECT_TIMEOUT_MS;
  const maxRecorded = options.maxRecorded ?? EDITOR_CLIENT_MAX_RECORDED;
  if (!Number.isInteger(maxRecorded) || maxRecorded < 1) {
    throw new Error('createEditorClient: maxRecorded must be a positive integer.');
  }

  // The recording: `recorded[0]` has absolute index `firstRetained`, and the
  // next envelope gets `nextIndex`. Overflow and `clear()` advance
  // `firstRetained`; indices are never reused.
  const recorded: RecordedEnvelope[] = [];
  const counters = { firstRetained: 0, nextIndex: 0, dropped: 0 };
  const protocolErrorLog: string[] = [];
  const listeners = new Set<() => void>();
  // Mutated from the client's callbacks and from `close()`, so held in an
  // object that flow analysis does not narrow.
  const live: {
    state: ConnectionState;
    unauthorized: WsUnauthorizedDetail | undefined;
    closed: boolean;
  } = { state: 'connecting', unauthorized: undefined, closed: false };

  const notify = (): void => {
    for (const listener of [...listeners]) {
      listener();
    }
  };

  /**
   * Resolve on the next recorded envelope, state change, refusal or close —
   * or when `ms` elapses. The timer is the wait's deadline, not a pause: it
   * is cleared the moment anything happens.
   */
  const nextChange = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        listeners.delete(done);
        resolve();
      };
      const timer = setTimeout(done, Math.max(0, ms));
      listeners.add(done);
    });

  const unauthorizedError = (detail: WsUnauthorizedDetail): Error => {
    const problem = credentials.problem();
    return new Error(
      [
        `The service closed the editor connection with ${String(detail.code)}${detail.code === WS_CLOSE_UNAUTHORIZED ? ' (unauthorized)' : ''}: ${detail.reason}.`,
        `The editor credential was rejected — check that $DEBUGGEN_HOME (${credentials.home}) matches the running service's (the Playwright config's webServer hands it ${configuredDebuggenHome}); a rotated token is picked up by a new connection, but the protocol client treats 4401 as terminal for this one and does not retry.`,
        problem === undefined ? '' : `Credential: ${problem}`,
      ]
        .filter((part) => part !== '')
        .join(' '),
    );
  };

  const client = new ReconnectingWsClient({
    url: wsUrl,
    webSocketConstructor: WebSocket,
    identity: { client: 'vscode', projectRoot },
    token: credentials.provider,
    onStateChange: (next) => {
      live.state = next;
      notify();
    },
    onMessage: (message) => {
      if (live.closed) {
        return;
      }
      recorded.push({ index: counters.nextIndex, receivedAt: Date.now(), message });
      counters.nextIndex += 1;
      if (recorded.length > maxRecorded) {
        recorded.shift();
        counters.firstRetained += 1;
        counters.dropped += 1;
      }
      notify();
    },
    onProtocolError: (error) => {
      protocolErrorLog.push(`${error.code}: ${error.message}`);
      if (protocolErrorLog.length > EDITOR_CLIENT_MAX_PROTOCOL_ERRORS) {
        protocolErrorLog.shift();
      }
    },
    onUnauthorized: (detail) => {
      live.unauthorized = detail;
      notify();
    },
  });
  if (client.configurationError !== undefined) {
    throw new Error(
      `The editor WebSocket could not be configured for ${baseUrl}: ${client.configurationError.message}`,
    );
  }
  const url = client.url ?? wsUrl;
  client.connect();
  live.state = client.state;

  const connectDeadline = Date.now() + connectTimeoutMs;
  while (live.state !== 'open' && live.unauthorized === undefined && Date.now() < connectDeadline) {
    await nextChange(connectDeadline - Date.now());
  }
  // An accepted `client.hello` is acknowledged with silence and a refused one
  // with a 4401 close shortly after `open`; watch the open socket briefly for
  // that verdict (the wait ends early on any state change).
  const verdictDeadline = Date.now() + HELLO_VERDICT_GRACE_MS;
  while (live.state === 'open' && live.unauthorized === undefined && Date.now() < verdictDeadline) {
    await nextChange(verdictDeadline - Date.now());
  }
  if (live.unauthorized !== undefined) {
    const refusal = unauthorizedError(live.unauthorized);
    live.closed = true;
    client.close();
    throw refusal;
  }
  if (live.state !== 'open') {
    live.closed = true;
    client.close();
    throw new Error(
      `The editor WebSocket to ${url} did not open within ${String(connectTimeoutMs)} ms (state ${live.state}, last close code ${String(client.lastCloseCode)}). These helpers never start a service: check that the config's webServer is running a service built with \`pnpm build\` at ${baseUrl}.`,
    );
  }

  /** The position in `recorded` of an absolute index at or after the retained window's start. */
  const positionOf = (index: number): number =>
    Math.max(index, counters.firstRetained) - counters.firstRetained;

  /** The first match at or after `from`, and the index to resume scanning at. */
  const scan = <K extends MessageType>(
    from: number,
    type: K,
    predicate: MessagePredicate<K> | undefined,
  ): {
    readonly match: MessageByType<K> | undefined;
    readonly index: number;
    readonly resume: number;
  } => {
    for (let position = positionOf(from); position < recorded.length; position += 1) {
      const entry = recorded[position];
      if (entry === undefined) {
        continue;
      }
      const message = entry.message;
      if (
        isOfType(message, type) &&
        (predicate === undefined || predicate(message.payload, message))
      ) {
        return { match: message, index: entry.index, resume: entry.index + 1 };
      }
    }
    return { match: undefined, index: -1, resume: counters.nextIndex };
  };

  const entriesFrom = (since: number): RecordedEnvelope[] => recorded.slice(positionOf(since));

  /** The credential-free account of a window: types and counts, dropped frames, protocol errors. */
  const describeWindow = (since: number): string => {
    const window = entriesFrom(since);
    const parts = [`received ${summarizeTypes(window.map((entry) => entry.message.type))}`];
    const unavailable = counters.firstRetained - since;
    if (unavailable > 0) {
      parts.push(
        `${String(unavailable)} earlier message(s) in this window are no longer retained (dropped on overflow of ${String(maxRecorded)} or cleared)`,
      );
    }
    parts.push(`connection ${live.state}`);
    if (protocolErrorLog.length > 0) {
      parts.push(`recent protocol errors: ${protocolErrorLog.slice(-3).join(' | ')}`);
    }
    return parts.join('; ');
  };

  const closedError = (activity: string): Error =>
    new Error(`The editor client was closed while ${activity}.`);

  const handle: EditorClientHandle = {
    projectRoot,
    url,

    state: () => live.state,

    async waitFor<K extends MessageType>(
      type: K,
      predicate?: MessagePredicate<K>,
      waitOptions?: EditorWaitOptions,
    ): Promise<MessageByType<K>> {
      const since = sinceIndexOf(waitOptions, `waitFor(${type})`);
      const limit = waitOptions?.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
      const deadline = Date.now() + limit;
      let cursor = since;
      for (;;) {
        const { match, resume } = scan(cursor, type, predicate);
        if (match !== undefined) {
          return match;
        }
        cursor = resume;
        if (live.unauthorized !== undefined) {
          throw unauthorizedError(live.unauthorized);
        }
        if (live.closed) {
          throw closedError(`waiting for ${type}`);
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          const ofType = entriesFrom(since).filter((entry) => entry.message.type === type).length;
          throw new Error(
            `Timed out after ${String(limit)} ms waiting for ${type}${predicate === undefined ? '' : ' matching the predicate'} on the editor connection (since index ${String(since)}: ${String(ofType)} ${type} message(s) arrived but none matched; ${describeWindow(since)}).`,
          );
        }
        await nextChange(remaining);
      }
    },

    async expectNoMessage<K extends MessageType>(
      type: K,
      predicate: MessagePredicate<K> | undefined,
      withinMs: number,
      quietOptions?: SinceIndexOptions,
    ): Promise<void> {
      const since = sinceIndexOf(quietOptions, `expectNoMessage(${type})`);
      const deadline = Date.now() + withinMs;
      for (;;) {
        const { match, index } = scan(since, type, predicate);
        if (match !== undefined) {
          throw new Error(
            `Expected no ${type}${predicate === undefined ? '' : ' matching the predicate'} within ${String(withinMs)} ms since index ${String(since)}, but one was recorded at index ${String(index)}${match.sessionId === undefined ? '' : ` for session ${match.sessionId}`}.`,
          );
        }
        if (live.closed) {
          throw closedError(`asserting that no ${type} arrives`);
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          return;
        }
        await nextChange(remaining);
      }
    },

    async next(withinMs) {
      const target = counters.nextIndex;
      const deadline = Date.now() + withinMs;
      while (counters.nextIndex <= target && !live.closed && Date.now() < deadline) {
        await nextChange(deadline - Date.now());
      }
      return target >= counters.firstRetained
        ? recorded[target - counters.firstRetained]
        : undefined;
    },

    messagesOf<K extends MessageType>(type: K, readOptions?: SinceIndexOptions) {
      const since = sinceIndexOf(readOptions, `messagesOf(${type})`);
      const matching: MessageByType<K>[] = [];
      for (const entry of entriesFrom(since)) {
        const message = entry.message;
        if (isOfType(message, type)) {
          matching.push(message);
        }
      }
      return matching;
    },

    lastOf<K extends MessageType>(type: K, predicate?: MessagePredicate<K>) {
      for (let position = recorded.length - 1; position >= 0; position -= 1) {
        const message = recorded[position]?.message;
        if (
          message !== undefined &&
          isOfType(message, type) &&
          (predicate === undefined || predicate(message.payload, message))
        ) {
          return message;
        }
      }
      return undefined;
    },

    entries(readOptions) {
      return entriesFrom(sinceIndexOf(readOptions, 'entries'));
    },

    timeline(readOptions) {
      const rows = new Map<MessageType, { count: number; first: number; last: number }>();
      for (const entry of entriesFrom(sinceIndexOf(readOptions, 'timeline'))) {
        const row = rows.get(entry.message.type);
        if (row === undefined) {
          rows.set(entry.message.type, {
            count: 1,
            first: entry.receivedAt,
            last: entry.receivedAt,
          });
        } else {
          row.count += 1;
          row.last = entry.receivedAt;
        }
      }
      return [...rows].map(([type, row]) => ({
        type,
        count: row.count,
        firstReceivedAt: row.first,
        lastReceivedAt: row.last,
      }));
    },

    snapshotIndex: () => counters.nextIndex,

    dropped: () => counters.dropped,

    protocolErrors: () => [...protocolErrorLog],

    clear() {
      recorded.length = 0;
      counters.firstRetained = counters.nextIndex;
    },

    close() {
      if (live.closed) {
        return;
      }
      live.closed = true;
      client.close();
      // Wake every pending wait so it rejects and clears its own deadline timer.
      notify();
      listeners.clear();
    },
  };
  return handle;
}
