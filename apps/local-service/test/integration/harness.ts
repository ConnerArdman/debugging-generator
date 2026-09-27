/**
 * The shared harness of the twelve `local-service-integration` suites
 * (`session-lifecycle`, `ws-protocol`, `telemetry-ingest`,
 * `pipeline-deterministic`, `cleanup-conflict`, `source-open`, `panel-fallback`,
 * `panel-data`, `binding`, `followup`, `auth`, `concurrency`; AAP §0.8.3).
 *
 * Every suite imports it as `./harness.js`. It is **not** a test file: the
 * Vitest project collects only `test/integration/**\/*.test.ts`, so this module
 * is compiled by `tsc -b`, linted and formatted like any source file, and then
 * merely imported. It declares no `describe`/`it`, imports nothing from
 * `vitest` and performs no work at load time — every export is a factory, a
 * type or a frozen constant.
 *
 * ## What it owns
 *
 * - **Boot through the real entry point.** {@link startHarness} calls
 *   `startService` from `src/main.ts` — the declared in-process entry point for
 *   exactly these suites — with an injected environment record, a fresh
 *   `fs.mkdtemp` `$DEBUGGEN_HOME`, `127.0.0.1:0`, a capturing logger and a
 *   deterministic clock. It never re-implements the boot order; booting through
 *   `startService` is what makes these tests integration tests rather than
 *   another copy of the colocated unit suites under `src/**`.
 * - **Transports, never shortcuts.** HTTP goes through protocol's `HttpClient`
 *   (paths from `HTTP_ROUTES`/`buildPath`, bodies schema-validated both ways),
 *   WebSocket traffic through protocol's `ReconnectingWsClient` over the
 *   workspace's `ws` dependency (URL from `resolveWsUrl`), and the two escape
 *   hatches — {@link Harness.rawFetch} and {@link Harness.rawSocket} — exist only
 *   for what those clients deliberately cannot express: a web `Origin`, a
 *   malformed body or frame, a missing credential, a missing hello.
 * - **Copy before mutate, and prove restoration.** The committed corpus under
 *   `test/fixtures/**` is never written. {@link copyFixtureProject} copies a
 *   project into an `fs.mkdtemp` directory, and {@link snapshotTree} /
 *   {@link assertTreeUnchanged} are the SHA-256, byte-for-byte evidence that the
 *   cleanup and follow-up suites rely on (AAP §0.5.1).
 * - **No secret literal.** Credential-shaped material is assembled at run time
 *   from fragments and `node:crypto` randomness by {@link randomSecretLike}, so
 *   `scripts/check-secrets.mjs` finds nothing in this tracked file (AAP §0.10).
 * - **Teardown that leaves nothing.** {@link Harness.stop} is idempotent and
 *   closes, in order, every socket the harness opened, the service, and every
 *   temporary directory; {@link Harness.assertNoLeaks} proves it. The project
 *   runs one file at a time in a forked worker, so a leaked handle stalls the
 *   gate — teardown here is part of the contract, not politeness. Vitest ends
 *   that worker with `SIGTERM`, so no process `'exit'` handler ever runs there:
 *   the stand-in dev CLI every harness of a file shares is removed by a
 *   teardown too — the one that releases the last live harness (see
 *   {@link standInDevServerCommand}).
 *
 * ## Model provider
 *
 * The default provider is the real **deterministic** provider selected by
 * `DEBUGGEN_PROVIDER=deterministic`: nothing leaves the machine and no
 * `ANTHROPIC_API_KEY` is needed or read (AAP §0.5.3, §0.8.3). A suite that must
 * force a rejection (`panel-fallback`, `pipeline-deterministic`) builds a
 * hand-written fake with {@link createScriptedProvider} and hands it to
 * {@link startHarness}, which routes it through `startService`'s own `provider`
 * seam. No recorded model response exists anywhere in this repository
 * (AAP §0.2.5): the `model-output-*.json` fixtures are authored inputs.
 *
 * ## Environment
 *
 * `process.env` is never read for configuration and never assigned: the
 * service's configuration comes from the record this module builds, and
 * `loadServiceConfig` by contract reads nothing else. A mutated global would leak
 * across the serialized suite files of the single worker.
 *
 * @example A suite's skeleton
 * ```ts
 * import { afterAll, beforeAll, expect, it } from 'vitest';
 * import { startHarness, type Harness } from './harness.js';
 *
 * let harness: Harness;
 * beforeAll(async () => {
 *   harness = await startHarness();
 * });
 * afterAll(async () => {
 *   await harness.assertNoLeaks();
 * });
 *
 * it('creates a session', async () => {
 *   const session = await harness.createSession({
 *     projectRoot: harness.requireProject().root,
 *     question: 'Why is the report slow to load?',
 *   });
 *   expect(session.status).toBeDefined();
 * });
 * ```
 */

import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { access, cp, mkdtemp, readdir, readlink, rm, stat } from 'node:fs/promises';
import { connect as connectTcp } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { DestinationStream } from 'pino';
import { WebSocket as NodeWebSocket } from 'ws';
import type { RawData } from 'ws';

import { parseInstrumentationPlanInput } from '@debuggen/instrumentation/schema';
import { createDeterministicProvider } from '@debuggen/model-provider';
import type { ModelProvider, ModelRequest, PromptStage } from '@debuggen/model-provider';
import { parsePanelSpecInput } from '@debuggen/panel-schema';
import {
  HTTP_ROUTES,
  HttpClient,
  ReconnectingWsClient,
  WS_CLOSE_UNAUTHORIZED,
  buildPath,
  createEnvelope,
  decodeMessage,
  describeZodIssues,
  encodeMessage,
  isAuthExemptOperation,
  isMessageOfType,
  resolveWsUrl,
} from '@debuggen/protocol';
import type {
  ConnectionState,
  CreateEnvelopeOptions,
  ErrorPayload,
  FetchLike,
  HttpOperationId,
  HttpRequestBody,
  HttpResponseBody,
  MessageHandler,
  MessagePayload,
  MessageType,
  ProtocolMessage,
  SendOutcome,
  SessionRecord,
  WebSocketConstructorLike,
  WebSocketLike,
  WsBackoffOptions,
  WsClientIdentity,
  WsEventMapLike,
  WsUnauthorizedDetail,
} from '@debuggen/protocol';
import {
  DebuggenError,
  LOG_LEVELS,
  LOG_LEVEL_VALUES,
  err,
  isErr,
  isWithin,
  newMessageId,
  newSessionId,
  ok,
  toPosix,
} from '@debuggen/shared';
import type { LogLevel, Logger, Result } from '@debuggen/shared';
import { readFileNoFollow, sha256Hex, sha256OfFile } from '@debuggen/shared/node';
import { parseTelemetryEventIngress } from '@debuggen/telemetry';
import type { TelemetryEventIngress } from '@debuggen/telemetry';

import {
  DEFAULT_HOST,
  DEFAULT_RETENTION_DAYS,
  EPHEMERAL_PORT,
  loadServiceConfig,
} from '../../src/config.js';
import type { ServiceConfig, ServiceConfigOverrides } from '../../src/config.js';
import { createServiceLogger, subsystemLogger } from '../../src/logging.js';
import { startService } from '../../src/main.js';
import type { ServiceHandle } from '../../src/main.js';
import { authFileSchema } from '../../src/server/auth.js';
import type {
  AuthService,
  IssuedCredential,
  PairingCode,
  RotationOutcome,
} from '../../src/server/auth.js';
import type { Store } from '../../src/store/db.js';
import { createModificationsRepo } from '../../src/store/modifications-repo.js';
import type { ModificationsRepo } from '../../src/store/modifications-repo.js';
import { createPanelsRepo } from '../../src/store/panels-repo.js';
import type { PanelsRepo } from '../../src/store/panels-repo.js';
import { createSessionsRepo } from '../../src/store/sessions-repo.js';
import type { SessionsRepo } from '../../src/store/sessions-repo.js';
import { createTelemetryRepo } from '../../src/store/telemetry-repo.js';
import type { TelemetryRepo } from '../../src/store/telemetry-repo.js';

/* -------------------------------------------------------------------------------------------------
 * Constants
 * ---------------------------------------------------------------------------------------------- */

/**
 * Every wait the harness performs, in milliseconds, as one named set.
 *
 * Twelve suites share these instead of scattering magic numbers. Every value is
 * comfortably under the 30 s `testTimeout`/`hookTimeout` the
 * `local-service-integration` project configures, so a harness wait always
 * fails with its own diagnostic before Vitest's generic timeout would.
 *
 * - `boot` — `startService` resolving a listening handle.
 * - `message` — one WebSocket frame, handshake barrier or log record.
 * - `request` — the default timeout of every harness `HttpClient` call.
 * - `capture` — a capture window opening or closing end to end.
 * - `pipeline` — a pipeline stage sequence reaching its next state.
 * - `socketClose` — one socket finishing its closing handshake at teardown.
 * - `teardown` — `ServiceHandle.close()` at teardown.
 * - `lateStart` — after `boot` has expired, the grace a still-running
 *   `startService` gets to settle before the harness stops waiting for it
 *   (see {@link settleLateStart}).
 * - `lateStartClose` — the bound on closing the handle such a late start
 *   produced. Deliberately shorter than `teardown`: a service that has only
 *   just bound its port holds no session, client or dev server, so its close
 *   is quick, and the whole failure path has to fit one hook.
 *
 * The failure path of a boot that times out runs inside one 30 s `beforeAll`:
 * `boot` + `lateStart` + `lateStartClose` = 15 + 3 + 7 = 25 s, which leaves 5 s
 * for the fixture copy made before the boot and the directory removal after
 * it. A late start that has not settled (or not closed) by then is not waited
 * for any longer: its directories are retained, and a continuation removes
 * them only once its shutdown is confirmed (see {@link releaseAfterLateStart}).
 */
export const HARNESS_TIMEOUTS = Object.freeze({
  boot: 15_000,
  message: 5_000,
  request: 15_000,
  capture: 10_000,
  pipeline: 20_000,
  socketClose: 2_000,
  teardown: 12_000,
  lateStart: 3_000,
  lateStartClose: 7_000,
});

/** The name of one {@link HARNESS_TIMEOUTS} entry. */
export type HarnessTimeoutName = keyof typeof HARNESS_TIMEOUTS;

/**
 * The fixtures' base epoch, `2026-09-19T12:00:00.000Z`, as documented in
 * `test/fixtures/README.md` ("Time"): every telemetry `startTime` there is this
 * value plus a per-event offset. The default harness clock is seeded with it,
 * and {@link readTelemetryBatch} refuses a batch that predates it, so a drifted
 * fixture fails here rather than deep inside a suite.
 */
export const FIXTURE_BASE_EPOCH_MS = 1_789_819_200_000;

/**
 * The committed fixture corpus, resolved from this module's own location —
 * never from `process.cwd()`, which differs between a root run and a
 * workspace-rooted one.
 */
export const FIXTURE_DIR: string = resolve(fileURLToPath(new URL('../fixtures/', import.meta.url)));

/**
 * The service's real versioned prompt tree (`apps/local-service/prompts`),
 * resolved from this module's location so the prompt loader and its
 * `manifest.json` work under Vitest, `tsx` and a built run alike.
 */
export const PROMPTS_DIR: string = resolve(
  fileURLToPath(new URL('../../prompts/', import.meta.url)),
);

/** The instrumentation-target corpus every session-creating suite copies. */
export const DEFAULT_FIXTURE_PROJECT = 'sample-project';

/** The prefix of the temporary `$DEBUGGEN_HOME` directories. */
const HOME_TEMP_PREFIX = 'debuggen-it-';

/** The prefix of the temporary directories fixture projects are copied into. */
const PROJECT_TEMP_PREFIX = 'debuggen-it-project-';

/** The `subsystem` binding of the records the harness's own clients emit. */
const HARNESS_SUBSYSTEM = 'harness';

/**
 * The reconnect curve of a harness WebSocket client: short and without jitter,
 * so a suite that provokes a reconnect observes it within a message timeout and
 * two runs schedule identically.
 */
const HARNESS_WS_BACKOFF: WsBackoffOptions = Object.freeze({
  initialMs: 50,
  maxMs: 1_000,
  factor: 2,
  jitter: 0,
});

/** The close code and reason a harness client sends when it is torn down. */
const NORMAL_CLOSURE = 1000;
const TEARDOWN_REASON = 'integration harness teardown';

/**
 * The message type of the handshake and flush barrier.
 *
 * The service never acknowledges a `client.hello`, and frames on one
 * connection are processed strictly in order. A client-sent service push is
 * refused on every authenticated connection with an `error` whose `ref` is the
 * refused frame's id, so sending one and awaiting that reply proves that the
 * hello — and every frame sent before the barrier — has been processed. The
 * barrier frames and their replies are kept out of every transcript.
 */
const BARRIER_MESSAGE_TYPE = 'target.request';

/** The Chrome extension-id alphabet: 32 characters from `a` to `p`. */
const EXTENSION_ID_ALPHABET = 'abcdefghijklmnop';

/** The length of a Chrome extension id. */
const EXTENSION_ID_LENGTH = 32;

/* -------------------------------------------------------------------------------------------------
 * Small utilities
 * ---------------------------------------------------------------------------------------------- */

/** A caught value, rendered as one line without quoting anything it carries. */
function describeCause(cause: unknown): string {
  if (cause instanceof Error) {
    return cause.message;
  }
  return typeof cause === 'string' ? cause : 'a non-error value was thrown';
}

/** Whether a value is a plain, non-array object. */
function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Resolves after `ms` milliseconds. */
function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => {
    setTimeout(resolveDelay, ms);
  });
}

/** What {@link withinDeadline} observed: the promise's value, or that the deadline came first. */
type DeadlineOutcome<T> = { readonly done: true; readonly value: T } | { readonly done: false };

/**
 * Races `promise` against a deadline. Expiry does not reject: it is reported as
 * `{ done: false }`, so a caller can tell "not yet" apart from "failed" and keep
 * waiting on the same promise elsewhere — which is what settling a late start
 * needs. The timer is always cleared, so an early settlement leaves nothing
 * scheduled.
 *
 * `promise` is observed here, so a rejection that arrives after the deadline is
 * handled rather than surfacing as an unhandled rejection; one that arrives
 * before it rejects the returned promise.
 */
async function withinDeadline<T>(promise: Promise<T>, ms: number): Promise<DeadlineOutcome<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<DeadlineOutcome<T>>((resolveExpired) => {
    timer = setTimeout(() => {
      resolveExpired({ done: false });
    }, ms);
  });
  try {
    return await Promise.race([
      promise.then((value): DeadlineOutcome<T> => ({ done: true, value })),
      expired,
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

/**
 * Invokes a `close()` so that a synchronous throw becomes a rejection: a
 * teardown step that collects outcomes with `Promise.allSettled` must see every
 * failure as a settled result, never as an exception that skips the steps
 * after it.
 */
function attemptClose(close: () => Promise<void>): Promise<void> {
  try {
    return Promise.resolve(close());
  } catch (cause) {
    return Promise.reject(cause instanceof Error ? cause : new Error(describeCause(cause)));
  }
}

/** Whether something exists at `path` (never following a final symlink's target). */
async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * A change notifier with race-free waits.
 *
 * {@link ChangeSignal.until} evaluates its check immediately — so a message
 * that already arrived resolves the wait at once — and again on every
 * {@link ChangeSignal.notify}. A check that throws rejects the wait with that
 * error; a wait that outlives its timeout rejects with the caller's diagnostic.
 */
class ChangeSignal {
  readonly #waiters = new Set<() => void>();

  /** Re-evaluates every pending wait. */
  notify(): void {
    for (const waiter of [...this.#waiters]) {
      waiter();
    }
  }

  /** The number of waits still pending: `0` once every wait has settled. */
  get pending(): number {
    return this.#waiters.size;
  }

  until<T>(check: () => T | undefined, timeoutMs: number, describe: () => string): Promise<T> {
    const immediate = check();
    if (immediate !== undefined) {
      return Promise.resolve(immediate);
    }
    return new Promise<T>((resolveWait, rejectWait) => {
      const settle = (): void => {
        clearTimeout(timer);
        this.#waiters.delete(waiter);
      };
      const timer = setTimeout(() => {
        settle();
        rejectWait(new Error(describe()));
      }, timeoutMs);
      const waiter = (): void => {
        let value: T | undefined;
        try {
          value = check();
        } catch (cause) {
          settle();
          rejectWait(cause instanceof Error ? cause : new Error(describeCause(cause)));
          return;
        }
        if (value !== undefined) {
          settle();
          resolveWait(value);
        }
      };
      this.#waiters.add(waiter);
    });
  }
}

/* -------------------------------------------------------------------------------------------------
 * The clock
 * ---------------------------------------------------------------------------------------------- */

/**
 * The deterministic clock the service is booted with.
 *
 * `now` is a property rather than a method so it can be handed to
 * `startService` unbound. Every read is strictly greater than the one before,
 * which keeps "created before" and ordering assertions exact; `advance` is how a
 * suite crosses an expiry (a pairing code's five minutes, a server-agent
 * credential's `expiresAt`, a retention window) without waiting for it.
 */
export interface HarnessClock {
  /** The current time in epoch milliseconds; each read then moves forward one step. */
  readonly now: () => number;
  /** The value the next {@link HarnessClock.now} returns, without consuming it. */
  readonly peek: () => number;
  /** Moves the clock forward by `ms` (non-negative) and returns the new time. */
  readonly advance: (ms: number) => number;
}

/**
 * Builds a monotonic counter clock.
 *
 * @param seedMs The first value `now()` returns. Defaults to
 * {@link FIXTURE_BASE_EPOCH_MS}.
 * @param stepMs How far each read moves the clock. Defaults to `1`.
 * @throws RangeError When either argument is not finite, or `stepMs` is not
 * positive.
 */
export function createHarnessClock(
  seedMs: number = FIXTURE_BASE_EPOCH_MS,
  stepMs = 1,
): HarnessClock {
  if (!Number.isFinite(seedMs) || !Number.isFinite(stepMs) || stepMs <= 0) {
    throw new RangeError('A harness clock needs a finite seed and a finite, positive step.');
  }
  let current = seedMs;
  return Object.freeze({
    now: (): number => {
      const value = current;
      current += stepMs;
      return value;
    },
    peek: (): number => current,
    advance: (ms: number): number => {
      if (!Number.isFinite(ms) || ms < 0) {
        throw new RangeError('A harness clock only moves forward, by a finite amount.');
      }
      current += ms;
      return current;
    },
  });
}

/* -------------------------------------------------------------------------------------------------
 * Fixtures
 * ---------------------------------------------------------------------------------------------- */

/**
 * What a committed JSON fixture must satisfy, per `test/fixtures/README.md`
 * ("File index" and "Shared conventions").
 *
 * - `telemetry-batch` — a bare `TelemetryEventIngress[]` array.
 * - `plan-input` / `panel-input` — a bare model authoring payload that the
 *   owning parser must accept or, for a rejection fixture, refuse.
 * - `expectation` — a wrapper object whose `description` names its contract.
 */
type FixtureContract =
  | { readonly kind: 'telemetry-batch' }
  | { readonly kind: 'plan-input'; readonly expect: 'accepted' | 'refused' }
  | { readonly kind: 'panel-input'; readonly expect: 'accepted' | 'refused' }
  | { readonly kind: 'expectation' };

/** The JSON fixtures the README indexes, with the contract each one is held to. */
const FIXTURE_CONTRACTS: Readonly<Record<string, FixtureContract>> = Object.freeze({
  'telemetry-trace-cross-tier.json': { kind: 'telemetry-batch' },
  'telemetry-renders-state.json': { kind: 'telemetry-batch' },
  'telemetry-requests-queries.json': { kind: 'telemetry-batch' },
  'telemetry-perf-errors.json': { kind: 'telemetry-batch' },
  'telemetry-volume-paging.json': { kind: 'telemetry-batch' },
  'ingest-redaction-input.json': { kind: 'telemetry-batch' },
  'model-output-invalid-plan.json': { kind: 'plan-input', expect: 'refused' },
  'model-output-invalid-panel.json': { kind: 'panel-input', expect: 'refused' },
  'model-output-valid-panel.json': { kind: 'panel-input', expect: 'accepted' },
  'model-output-panel-semantic-invalid.json': { kind: 'panel-input', expect: 'accepted' },
  'ingest-redaction-expected.json': { kind: 'expectation' },
  'panel-data-cases.json': { kind: 'expectation' },
  'panel-data-expected-trace-tree.json': { kind: 'expectation' },
});

/** Every JSON fixture the README indexes, in its own order. */
export const FIXTURE_FILES: readonly string[] = Object.freeze(Object.keys(FIXTURE_CONTRACTS));

/**
 * The absolute path of a file or directory inside {@link FIXTURE_DIR}.
 *
 * @throws Error When the segments resolve outside the fixture corpus (a `..`
 * traversal or an absolute segment).
 */
export function fixturePath(...segments: readonly string[]): string {
  const target = resolve(FIXTURE_DIR, ...segments);
  if (target !== FIXTURE_DIR && !target.startsWith(`${FIXTURE_DIR}${sep}`)) {
    throw new Error(`The fixture path ${segments.join('/')} leaves ${FIXTURE_DIR}.`);
  }
  return target;
}

/** Reads and parses one JSON fixture, failing with the fixture's name. */
function readJsonFixture(name: string): unknown {
  const path = fixturePath(name);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (cause) {
    throw new Error(`The fixture ${name} could not be read: ${describeCause(cause)}`, { cause });
  }
  try {
    const value: unknown = JSON.parse(text);
    return value;
  } catch (cause) {
    throw new Error(`The fixture ${name} is not valid JSON: ${describeCause(cause)}`, { cause });
  }
}

/**
 * Validates a telemetry batch fixture and returns its parsed events.
 *
 * Each element is parsed by the owning strict schema (through
 * `parseTelemetryEventIngress`), so a service-assigned field, an orphan flag or
 * a `request_key` in a committed batch fails here, naming the fixture and the
 * element index. Every `startTime` must also lie at or after
 * {@link FIXTURE_BASE_EPOCH_MS}, the README's single time base.
 */
function verifyTelemetryBatch(name: string, value: unknown): TelemetryEventIngress[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`The fixture ${name} must be a non-empty bare JSON array of ingress events.`);
  }
  const events: TelemetryEventIngress[] = [];
  const problems: string[] = [];
  value.forEach((element: unknown, index: number) => {
    const parsed = parseTelemetryEventIngress(element);
    if (isErr(parsed)) {
      problems.push(`[${String(index)}] ${parsed.error.message}`);
      return;
    }
    if (parsed.value.startTime < FIXTURE_BASE_EPOCH_MS) {
      problems.push(`[${String(index)}] startTime precedes the fixture base epoch`);
      return;
    }
    events.push(parsed.value);
  });
  if (problems.length > 0) {
    throw new Error(`The fixture ${name} drifted from its schema:\n${problems.join('\n')}`);
  }
  return events;
}

/** Holds one fixture to its {@link FixtureContract}. */
function verifyFixtureContract(name: string, contract: FixtureContract, value: unknown): void {
  switch (contract.kind) {
    case 'telemetry-batch':
      verifyTelemetryBatch(name, value);
      return;
    case 'plan-input': {
      const accepted = !isErr(parseInstrumentationPlanInput(value));
      verifyAuthoringExpectation(name, contract.expect, accepted);
      return;
    }
    case 'panel-input': {
      const accepted = !isErr(parsePanelSpecInput(value));
      verifyAuthoringExpectation(name, contract.expect, accepted);
      return;
    }
    case 'expectation':
      if (!isPlainObject(value) || typeof value['description'] !== 'string') {
        throw new Error(
          `The fixture ${name} must be a wrapper object whose "description" names its contract.`,
        );
      }
      return;
  }
}

/** Fails when an authoring fixture no longer meets its accepted/refused expectation. */
function verifyAuthoringExpectation(
  name: string,
  expected: 'accepted' | 'refused',
  accepted: boolean,
): void {
  if (expected === 'accepted' && !accepted) {
    throw new Error(`The fixture ${name} must parse through its authoring schema but is refused.`);
  }
  if (expected === 'refused' && accepted) {
    throw new Error(
      `The fixture ${name} must be refused by its authoring schema but now parses; a rejection test would pass vacuously.`,
    );
  }
}

/**
 * Reads a JSON fixture, holding it to its owning schema first.
 *
 * Telemetry batches are validated element by element, authoring payloads must
 * be accepted or refused by `parsePanelSpecInput` / `parseInstrumentationPlanInput`
 * as the README states, and the three expectation documents must be wrappers
 * with a `description`. A file the README does not index (for example
 * `sample-project/package.json`) is parsed without a contract. The committed
 * bytes are only ever read.
 *
 * The type argument is the caller's statement of the shape it reads; the
 * contract check is what makes that statement safe for the indexed fixtures.
 * Prefer {@link readTelemetryBatch} for batches, which returns parsed events.
 *
 * @param name The fixture path relative to {@link FIXTURE_DIR}.
 * @throws Error Naming the fixture when it is missing, not JSON, or drifted.
 */
export function readFixtureJson<T = unknown>(name: string): T {
  const value = readJsonFixture(name);
  const contract = FIXTURE_CONTRACTS[name];
  if (contract !== undefined) {
    verifyFixtureContract(name, contract, value);
  }
  return value as T;
}

/**
 * Reads a telemetry batch fixture as schema-parsed ingress events, ready to be
 * spread into `{ events }` (a `telemetry.event` frame) or
 * `{ projectRoot, events }` (`POST /telemetry/ingest`). Both bodies may also
 * carry the optional delivery context — `armedCaptureId`, the capture the
 * producer was armed for, and `droppedCount`, its loss report — which a
 * fixture batch never holds.
 *
 * @throws Error When `name` is not an indexed batch or the batch drifted.
 */
export function readTelemetryBatch(name: string): TelemetryEventIngress[] {
  const contract = FIXTURE_CONTRACTS[name];
  if (contract?.kind !== 'telemetry-batch') {
    throw new Error(`The fixture ${name} is not one of the indexed telemetry batches.`);
  }
  return verifyTelemetryBatch(name, readJsonFixture(name));
}

/* -------------------------------------------------------------------------------------------------
 * Tree snapshots and project copies
 * ---------------------------------------------------------------------------------------------- */

/**
 * A tree's content, keyed by project-relative POSIX path.
 *
 * Files map to the SHA-256 of their raw bytes; directories appear as
 * `<path>/` → `directory` (so an added or removed directory is a difference);
 * a symbolic link maps to `symlink:` plus the SHA-256 of its target text and is
 * never followed.
 */
export type TreeSnapshot = ReadonlyMap<string, string>;

/** How two {@link TreeSnapshot}s differ. */
export interface TreeDifference {
  /** Paths present now that the snapshot did not hold. */
  readonly added: readonly string[];
  /** Paths the snapshot held that are gone now. */
  readonly removed: readonly string[];
  /** Paths whose content, kind or link target changed. */
  readonly changed: readonly string[];
}

/** Walks `absolute` into `into`, keyed below `relative`. */
async function walkTree(root: string, relative: string, into: Map<string, string>): Promise<void> {
  const directory = relative === '' ? root : join(root, relative);
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  for (const entry of entries) {
    const key = relative === '' ? entry.name : `${relative}/${entry.name}`;
    const absolute = join(root, key);
    if (entry.isDirectory()) {
      into.set(`${key}/`, 'directory');
      await walkTree(root, key, into);
    } else if (entry.isSymbolicLink()) {
      into.set(key, `symlink:${sha256Hex(await readlink(absolute))}`);
    } else if (entry.isFile()) {
      into.set(key, await sha256OfFile(absolute));
    } else {
      into.set(key, 'special');
    }
  }
}

/**
 * Snapshots every entry under `root` — nothing is skipped, because the fixture
 * corpus holds no `node_modules` — hashing raw bytes with `sha256OfFile`.
 *
 * @param root An absolute directory path.
 */
export async function snapshotTree(root: string): Promise<TreeSnapshot> {
  const snapshot = new Map<string, string>();
  await walkTree(root, '', snapshot);
  return snapshot;
}

/** Compares two snapshots path by path. */
export function diffTreeSnapshots(before: TreeSnapshot, after: TreeSnapshot): TreeDifference {
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  for (const [path, digest] of after) {
    const previous = before.get(path);
    if (previous === undefined) {
      added.push(path);
    } else if (previous !== digest) {
      changed.push(path);
    }
  }
  for (const path of before.keys()) {
    if (!after.has(path)) {
      removed.push(path);
    }
  }
  return { added: added.sort(), removed: removed.sort(), changed: changed.sort() };
}

/**
 * Proves that `root` is byte-for-byte what `snapshot` recorded — the
 * restoration evidence of the cleanup and follow-up suites.
 *
 * @throws Error Naming every added, removed and changed path.
 */
export async function assertTreeUnchanged(root: string, snapshot: TreeSnapshot): Promise<void> {
  const difference = diffTreeSnapshots(snapshot, await snapshotTree(root));
  const lines = [
    ...difference.added.map((path) => `  added:   ${path}`),
    ...difference.removed.map((path) => `  removed: ${path}`),
    ...difference.changed.map((path) => `  changed: ${path}`),
  ];
  if (lines.length > 0) {
    throw new Error(`The tree at ${root} differs from its snapshot:\n${lines.join('\n')}`);
  }
}

/** A writable copy of a committed fixture project. */
export interface FixtureProjectCopy {
  /** The fixture directory name that was copied, for example `sample-project`. */
  readonly name: string;
  /**
   * The copy's root: an absolute, symlink-free POSIX path — the shape
   * `InstrumentationContext.projectRoot` and `session.create` require.
   */
  readonly root: string;
  /** The `fs.mkdtemp` directory holding the copy; removing it removes the copy. */
  readonly container: string;
  /** The copy's snapshot at copy time, equal to the committed fixture's. */
  readonly snapshot: TreeSnapshot;
  /** Removes the copy and its container. Idempotent. */
  readonly dispose: () => Promise<void>;
}

/**
 * Copies `test/fixtures/<name>` into a fresh `fs.mkdtemp` directory and
 * snapshots the copy (AAP §0.5.1: the committed corpus stays read-only).
 *
 * The copy is verified against the committed tree before it is returned, so a
 * suite that later compares against `snapshot` compares against the committed
 * bytes. {@link Harness.copyFixtureProject} tracks the copy for teardown; a copy
 * made through this standalone export is the caller's to `dispose()`.
 *
 * @param name A directory directly under {@link FIXTURE_DIR}.
 * @throws Error When `name` is not a fixture directory or the copy differs.
 */
export async function copyFixtureProject(
  name: string = DEFAULT_FIXTURE_PROJECT,
): Promise<FixtureProjectCopy> {
  const source = fixturePath(name);
  const sourceStat = await stat(source).catch((cause: unknown) => {
    throw new Error(`The fixture project ${name} does not exist: ${describeCause(cause)}`, {
      cause,
    });
  });
  if (!sourceStat.isDirectory()) {
    throw new Error(`The fixture project ${name} is not a directory.`);
  }

  const container = await mkdtemp(join(realpathSync(tmpdir()), PROJECT_TEMP_PREFIX));
  const dispose = async (): Promise<void> => {
    await rm(container, { recursive: true, force: true });
  };
  try {
    const root = join(container, basename(source));
    await cp(source, root, {
      recursive: true,
      errorOnExist: true,
      force: false,
      verbatimSymlinks: true,
    });
    const [committed, snapshot] = await Promise.all([snapshotTree(source), snapshotTree(root)]);
    const difference = diffTreeSnapshots(committed, snapshot);
    if (
      difference.added.length > 0 ||
      difference.removed.length > 0 ||
      difference.changed.length > 0
    ) {
      throw new Error(`The copy of the fixture project ${name} is not byte-identical.`);
    }
    return Object.freeze({ name, root: toPosix(root), container, snapshot, dispose });
  } catch (cause) {
    await dispose();
    throw cause;
  }
}

/* -------------------------------------------------------------------------------------------------
 * Secret-shaped material, assembled at run time
 * ---------------------------------------------------------------------------------------------- */

/** The credential shapes {@link randomSecretLike} can assemble. */
export const SECRET_LIKE_KINDS = Object.freeze([
  'bearer',
  'jwt',
  'provider-key',
  'connection-string',
] as const);

/** One of {@link SECRET_LIKE_KINDS}. */
export type SecretLikeKind = (typeof SECRET_LIKE_KINDS)[number];

/** Joins fragments; the split points are why this file holds no credential literal. */
function assemble(...fragments: readonly string[]): string {
  return fragments.join('');
}

/** `bytes` random bytes, base64url-encoded. */
function randomBase64Url(bytes: number): string {
  return randomBytes(bytes).toString('base64url');
}

/** `bytes` random bytes, hex-encoded. */
function randomHex(bytes: number): string {
  return randomBytes(bytes).toString('hex');
}

/** A JSON value, base64url-encoded — how a JOSE segment is built. */
function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

/**
 * Assembles a fresh credential-shaped string that the redaction rules and
 * `scripts/check-secrets.mjs` recognise, from fragments and `node:crypto`
 * randomness — never from a committed literal (AAP §0.10, §0.5.2).
 *
 * - `bearer` — an `Authorization` header value: the scheme word and a 43-character body.
 * - `jwt` — three base64url JOSE segments with a real JSON header.
 * - `provider-key` — a provider-key-prefixed opaque string.
 * - `connection-string` — a database URI carrying `user:password@`.
 *
 * Every call returns a new value, so a suite can prove that *its* value — not a
 * value some other code path also happens to produce — never reaches a log, the
 * store or an outbound payload.
 */
export function randomSecretLike(kind: SecretLikeKind): string {
  switch (kind) {
    case 'bearer':
      return assemble('Bear', 'er ', randomBase64Url(32));
    case 'jwt':
      return [
        base64UrlJson({ alg: 'HS256', typ: 'JWT' }),
        base64UrlJson({
          sub: assemble('harness-', randomHex(6)),
          iat: Math.floor(FIXTURE_BASE_EPOCH_MS / 1000),
        }),
        randomBase64Url(32),
      ].join('.');
    case 'provider-key':
      return assemble('s', 'k-', 'ant-', 'api03-', randomBase64Url(30));
    case 'connection-string':
      return assemble(
        'postgres',
        'ql',
        ':/',
        '/',
        assemble('harness_', randomHex(4)),
        ':',
        randomBase64Url(12),
        '@',
        '127.0.0.1',
        ':5432/',
        assemble('harness_', randomHex(4)),
      );
  }
}

/**
 * A fresh Chrome extension id: 32 characters from `a` to `p`, the shape Chrome
 * derives from an extension's key. Used to mint a scoped DevTools credential.
 */
export function newExtensionId(): string {
  const bytes = randomBytes(EXTENSION_ID_LENGTH);
  let id = '';
  for (const byte of bytes) {
    id += EXTENSION_ID_ALPHABET.charAt(byte % EXTENSION_ID_ALPHABET.length);
  }
  return id;
}

/** The `Origin` a Chrome extension's requests and upgrades carry. */
export function chromeExtensionOrigin(extensionId: string): string {
  return `chrome-extension://${extensionId}`;
}

/* -------------------------------------------------------------------------------------------------
 * The scripted model provider
 * ---------------------------------------------------------------------------------------------- */

/**
 * One scripted structured-output attempt.
 *
 * A step answers the next `generateStructured` call whose
 * `request.metadata.stage` equals `stage` (or any stage when `stage` is
 * omitted), exactly once. `raw` is the decoded answer handed to the
 * structured-output validator — typically a bare authoring payload read with
 * {@link readFixtureJson} — `text` an undecoded answer, and `failure` a call
 * that failed at the transport.
 */
export interface ScriptedStep {
  /** The pipeline stage this step answers; omitted, it answers any stage. */
  readonly stage?: PromptStage | undefined;
  /** The decoded answer, exactly as a provider's transport would hand it over. */
  readonly raw?: unknown;
  /** The undecoded answer text, for an answer that never became JSON. */
  readonly text?: string | undefined;
  /** A failed call: returned as the `Err`, never thrown. */
  readonly failure?: DebuggenError | undefined;
}

/** One call the scripted provider received, in order. */
export interface ScriptedProviderCall {
  /** Which interface method was called. */
  readonly method: 'generateText' | 'generateStructured' | 'callTools';
  /** The stage the request named. */
  readonly stage: PromptStage;
  /** The prompt version the request named. */
  readonly promptVersion: string;
  /** Whether a script step answered it (`false`: the fallback or a refusal did). */
  readonly scripted: boolean;
  /** The request itself. */
  readonly request: ModelRequest;
}

/** How {@link createScriptedProvider} answers what the script does not cover. */
export interface ScriptedProviderOptions {
  /**
   * The provider that answers unscripted calls. Defaults to the real
   * deterministic provider, so the stages a suite does not script run exactly
   * as they do under `DEBUGGEN_PROVIDER=deterministic`; `null` answers every
   * unscripted call with a `MODEL_UNAVAILABLE` failure instead.
   */
  readonly fallback?: ModelProvider | null | undefined;
  /** The provider id every scripted attempt reports. Defaults to `scripted`. */
  readonly id?: string | undefined;
  /** The model id every scripted attempt reports. Defaults to `scripted-model`. */
  readonly model?: string | undefined;
}

/** A scripted provider and the record of what it was asked. */
export interface ScriptedProvider {
  /** The provider to hand to {@link startHarness} as `provider`. */
  readonly provider: ModelProvider;
  /** Every call received, in order. */
  readonly calls: readonly ScriptedProviderCall[];
  /** How many script steps have not been served yet. */
  readonly remaining: () => number;
  /** Throws when a script step was never served — the flow did not ask for it. */
  readonly assertConsumed: () => void;
}

/** A script step whose answer is a committed authoring fixture, schema-checked on read. */
export function scriptedFixtureStep(stage: PromptStage, fixture: string): ScriptedStep {
  return { stage, raw: readFixtureJson(fixture) };
}

/**
 * Builds a hand-written fake satisfying `ModelProvider` structurally, for the
 * suites that must force a model rejection.
 *
 * It honours the interface's invariants rather than being cleverer than a real
 * provider: exactly one attempt per call, every method returns
 * `Promise<Result<…, DebuggenError>>` and never throws or rejects, and there is
 * no repair loop — that policy lives only in `generateStructuredWithRepair`,
 * which is what re-asks after a scripted invalid answer. Only
 * `generateStructured` is scripted; `generateText` and `callTools` go to the
 * fallback.
 *
 * @example Invalid panel first, valid panel on the repair
 * ```ts
 * const scripted = createScriptedProvider([
 *   scriptedFixtureStep('generate-panel', 'model-output-invalid-panel.json'),
 *   scriptedFixtureStep('generate-panel', 'model-output-valid-panel.json'),
 * ]);
 * const harness = await startHarness({ provider: scripted.provider });
 * ```
 */
export function createScriptedProvider(
  script: readonly ScriptedStep[],
  options: ScriptedProviderOptions = {},
): ScriptedProvider {
  const providerId = options.id ?? 'scripted';
  const model = options.model ?? 'scripted-model';
  const fallback = resolveFallbackProvider(options.fallback);
  const served: boolean[] = script.map(() => false);
  const calls: ScriptedProviderCall[] = [];

  const record = (
    method: ScriptedProviderCall['method'],
    request: ModelRequest,
    scripted: boolean,
  ): void => {
    calls.push({
      method,
      stage: request.metadata.stage,
      promptVersion: request.metadata.promptVersion,
      scripted,
      request,
    });
  };

  const unscripted = (method: ScriptedProviderCall['method'], stage: PromptStage): DebuggenError =>
    new DebuggenError(
      'MODEL_UNAVAILABLE',
      `The scripted provider has no step for ${method} at stage ${stage}.`,
      { details: { method, stage } },
    );

  const takeStep = (stage: PromptStage): ScriptedStep | undefined => {
    const index = script.findIndex(
      (step, position) =>
        served[position] === false && (step.stage === undefined || step.stage === stage),
    );
    if (index === -1) {
      return undefined;
    }
    served[index] = true;
    return script[index];
  };

  const generateStructured: ModelProvider['generateStructured'] = (schema, request) => {
    const step = takeStep(request.metadata.stage);
    record('generateStructured', request, step !== undefined);
    if (step === undefined) {
      return fallback === null
        ? Promise.resolve(err(unscripted('generateStructured', request.metadata.stage)))
        : guardProviderCall(() => fallback.generateStructured(schema, request));
    }
    if (step.failure !== undefined) {
      return Promise.resolve(err(step.failure));
    }
    return Promise.resolve(
      ok({
        raw: step.raw,
        model,
        providerId,
        ...(step.text === undefined ? {} : { text: step.text }),
      }),
    );
  };

  const provider: ModelProvider = {
    id: providerId,
    generateText: (request) => {
      record('generateText', request, false);
      return fallback === null
        ? Promise.resolve(err(unscripted('generateText', request.metadata.stage)))
        : guardProviderCall(() => fallback.generateText(request));
    },
    generateStructured,
    callTools: (request, tools) => {
      record('callTools', request, false);
      return fallback === null
        ? Promise.resolve(err(unscripted('callTools', request.metadata.stage)))
        : guardProviderCall(() => fallback.callTools(request, tools));
    },
  };

  return Object.freeze({
    provider,
    calls,
    remaining: (): number => served.filter((isServed) => !isServed).length,
    assertConsumed: (): void => {
      const pending = script
        .map((step, index) => ({ step, index }))
        .filter(({ index }) => served[index] === false)
        .map(({ step, index }) => `#${String(index)} (${step.stage ?? 'any stage'})`);
      if (pending.length > 0) {
        throw new Error(`Scripted provider steps were never served: ${pending.join(', ')}.`);
      }
    },
  });
}

/** The fallback a scripted provider delegates to: the real deterministic provider by default. */
function resolveFallbackProvider(fallback: ModelProvider | null | undefined): ModelProvider | null {
  if (fallback !== undefined) {
    return fallback;
  }
  const created = createDeterministicProvider();
  if (isErr(created)) {
    throw new Error(
      `The deterministic fallback provider could not be built: ${created.error.message}`,
      {
        cause: created.error,
      },
    );
  }
  return created.value;
}

/**
 * Runs a delegated provider call so that it honours the interface's
 * never-throws, never-rejects invariant even if the delegate breaks it.
 */
function guardProviderCall<V>(
  call: () => Promise<Result<V, DebuggenError>>,
): Promise<Result<V, DebuggenError>> {
  try {
    return call().catch((cause: unknown) => err(DebuggenError.from(cause, 'MODEL_UNAVAILABLE')));
  } catch (cause) {
    return Promise.resolve(err(DebuggenError.from(cause, 'MODEL_UNAVAILABLE')));
  }
}

/* -------------------------------------------------------------------------------------------------
 * The capturing logger
 * ---------------------------------------------------------------------------------------------- */

/** One record the service wrote, decoded from its pino JSON line. */
export interface CapturedLogRecord {
  /** The severity, mapped back from pino's number. */
  readonly level: LogLevel;
  /** The record's message. */
  readonly message: string;
  /** The record's epoch-millisecond timestamp. */
  readonly time: number;
  /** Every other key of the record: bindings and per-call fields, already scrubbed. */
  readonly fields: Readonly<Record<string, unknown>>;
  /** The exact line the logger wrote, for "appears nowhere" assertions. */
  readonly line: string;
}

/**
 * The service's root logger and everything it wrote.
 *
 * The logger is built by the service's own `createServiceLogger` — the same
 * level gate, scrubbing and redaction paths as production — with only its
 * destination replaced, so a privacy assertion ("no token, no SQL text, no
 * attribute value in any record") tests the real policy.
 */
export interface CapturedLogger {
  /** The root logger handed to `startService`. */
  readonly root: Logger;
  /** Every record written so far, in order. */
  readonly records: readonly CapturedLogRecord[];
  /** Every line written so far, joined by newlines: the haystack for a leak search. */
  readonly text: () => string;
  /** The records whose message equals `message`. */
  readonly withMessage: (message: string) => readonly CapturedLogRecord[];
  /** Forgets every record captured so far (the root logger keeps writing). */
  readonly clear: () => void;
}

/** Maps a pino level number back to its name. */
function levelOf(value: unknown): LogLevel {
  const found = LOG_LEVELS.find((level) => LOG_LEVEL_VALUES[level] === value);
  return found ?? 'info';
}

/** Decodes one pino line into a record. */
function decodeLogLine(line: string): CapturedLogRecord {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return { level: 'info', message: line, time: 0, fields: {}, line };
  }
  if (!isPlainObject(value)) {
    return { level: 'info', message: line, time: 0, fields: {}, line };
  }
  const { level, msg, time, ...fields } = value;
  return {
    level: levelOf(level),
    message: typeof msg === 'string' ? msg : '',
    time: typeof time === 'number' ? time : 0,
    fields,
    line,
  };
}

/** Builds the pino destination that captures, and the view over what it captured. */
function createCapturingSink(): {
  readonly destination: DestinationStream;
  readonly records: CapturedLogRecord[];
} {
  const records: CapturedLogRecord[] = [];
  const destination: DestinationStream = {
    write(chunk: string): void {
      for (const line of chunk.split('\n')) {
        if (line.trim().length > 0) {
          records.push(decodeLogLine(line));
        }
      }
    },
  };
  return { destination, records };
}

/* -------------------------------------------------------------------------------------------------
 * WebSocket: the tapped transport under protocol's client
 * ---------------------------------------------------------------------------------------------- */

/** One close a socket observed: the peer's (or the local) close code and reason. */
export interface WsCloseRecord {
  readonly code: number;
  readonly reason: string;
}

/**
 * Whether a close is the service's credential refusal — protocol's
 * `WS_CLOSE_UNAUTHORIZED` (4401), sent for a missing, late, malformed or
 * refused `client.hello` and for every socket a rotation revokes (AAP §0.5.6).
 */
export function isUnauthorizedClose(record: WsCloseRecord): boolean {
  return record.code === WS_CLOSE_UNAUTHORIZED;
}

/** What a tapped socket reports to the client wrapper that owns it. */
interface SocketTap {
  /** The `Origin` header to send on the upgrade, when the identity has one. */
  readonly origin: string | undefined;
  /** A new underlying socket was created (one per connection attempt). */
  attached(socket: NodeWebSocket): void;
  /** A text frame is about to be written. */
  outbound(frame: string): void;
  /** A frame arrived; `undefined` for a binary frame. */
  inbound(text: string | undefined): void;
  /** The socket closed. */
  closed(record: WsCloseRecord): void;
  /** The transport or a listener failed. */
  failed(message: string): void;
}

/** The listener sets of one tapped socket, one per event. */
type ListenerRegistry = {
  [K in keyof WsEventMapLike]: Set<(event: WsEventMapLike[K]) => void>;
};

/** A received `ws` frame as text. */
function rawDataToText(data: RawData): string {
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString('utf8');
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString('utf8');
  }
  return data.toString('utf8');
}

/**
 * The `WebSocketConstructorLike` handed to `ReconnectingWsClient`: the
 * workspace's `ws` socket behind the client's four-event surface, with every
 * frame, close and failure reported to `tap`.
 *
 * It adds no behaviour of its own — the client's handshake, queueing and
 * reconnect logic run unchanged — and it is what lets the harness record the
 * transcript byte-for-byte, send the `Origin` header a DevTools identity needs
 * (the client's constructor signature has no place for one) and write a
 * deliberately malformed frame on the live socket.
 */
function createTappedSocketConstructor(tap: SocketTap): WebSocketConstructorLike {
  return class TappedSocket implements WebSocketLike {
    readonly #socket: NodeWebSocket;

    readonly #listeners: ListenerRegistry = {
      open: new Set(),
      message: new Set(),
      close: new Set(),
      error: new Set(),
    };

    constructor(url: string, protocols?: string | string[]) {
      const headers = tap.origin === undefined ? {} : { origin: tap.origin };
      this.#socket = new NodeWebSocket(url, protocols ?? [], headers);
      tap.attached(this.#socket);
      this.#socket.on('open', () => {
        this.#emit('open', { type: 'open' });
      });
      this.#socket.on('message', (data: RawData, isBinary: boolean) => {
        const text = isBinary ? undefined : rawDataToText(data);
        tap.inbound(text);
        this.#emit('message', { data: text ?? data });
      });
      this.#socket.on('close', (code: number, reason: Buffer) => {
        const record = { code, reason: reason.toString('utf8') };
        tap.closed(record);
        this.#emit('close', record);
      });
      this.#socket.on('error', (error: Error) => {
        tap.failed(error.message);
        this.#emit('error', { message: error.message });
      });
    }

    get readyState(): number {
      return this.#socket.readyState;
    }

    addEventListener<K extends keyof WsEventMapLike>(
      type: K,
      listener: (event: WsEventMapLike[K]) => void,
    ): void {
      this.#listeners[type].add(listener);
    }

    removeEventListener<K extends keyof WsEventMapLike>(
      type: K,
      listener: (event: WsEventMapLike[K]) => void,
    ): void {
      this.#listeners[type].delete(listener);
    }

    send(data: string): void {
      tap.outbound(data);
      this.#socket.send(data);
    }

    close(code?: number, reason?: string): void {
      this.#socket.close(code, reason);
    }

    #emit<K extends keyof WsEventMapLike>(type: K, event: WsEventMapLike[K]): void {
      for (const listener of [...this.#listeners[type]]) {
        try {
          listener(event);
        } catch (cause) {
          tap.failed(`a ${type} listener threw: ${describeCause(cause)}`);
        }
      }
    }
  };
}

/** Waits for `socket` to finish closing, terminating it once `timeoutMs` has passed. */
async function settleSocket(socket: NodeWebSocket, timeoutMs: number): Promise<boolean> {
  if (socket.readyState === NodeWebSocket.CLOSED) {
    return true;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const settled = await new Promise<boolean>((resolveSettled) => {
    socket.once('close', () => {
      resolveSettled(true);
    });
    timer = setTimeout(() => {
      resolveSettled(false);
    }, timeoutMs);
    if (socket.readyState === NodeWebSocket.OPEN) {
      socket.close(NORMAL_CLOSURE, TEARDOWN_REASON);
    }
  });
  clearTimeout(timer);
  if (!settled) {
    socket.terminate();
  }
  return settled;
}

/* -------------------------------------------------------------------------------------------------
 * WebSocket: the harness client
 * ---------------------------------------------------------------------------------------------- */

/** A frame handed to the client, with the id it was stamped with. */
export interface SendReceipt {
  /** The frame's envelope id — the `ref` any `error` reply about it carries. */
  readonly id: string;
  /** Whether the frame was written, queued, or refused locally. */
  readonly result: Result<SendOutcome, DebuggenError>;
}

/** A narrowed protocol message: for a concrete `K`, the same type as protocol's `MessageByType<K>`. */
export type HarnessMessage<K extends MessageType> = Extract<ProtocolMessage, { type: K }>;

/**
 * A protocol `ReconnectingWsClient` connected to the harness's service, with
 * everything it did recorded.
 *
 * Transcripts hold parsed, validated protocol messages; the handshake/flush
 * barrier frames and their `error` replies are excluded from all of them, so a
 * suite sees exactly the traffic it caused.
 */
export interface HarnessWsClient {
  /** The identity announced in `client.hello`. */
  readonly identity: WsClientIdentity;
  /** The wrapped client, for anything the wrapper does not surface. */
  readonly client: ReconnectingWsClient;
  /** Every underlying `ws` socket, one per connection attempt, oldest first. */
  readonly sockets: readonly NodeWebSocket[];
  /** Every frame written to the socket, the `client.hello` of each connection included. */
  readonly sent: readonly ProtocolMessage[];
  /** Every validated inbound frame, in arrival order. */
  readonly received: readonly ProtocolMessage[];
  /** Every socket close observed — `WS_CLOSE_UNAUTHORIZED` (4401) for a refused hello. */
  readonly closes: readonly WsCloseRecord[];
  /** Every failure reported through the client's `onProtocolError` hook. */
  readonly protocolErrors: readonly DebuggenError[];
  /** Every refusal reported through `onUnauthorized`, including a local "no credential". */
  readonly unauthorized: readonly WsUnauthorizedDetail[];
  /** Every connection state the client moved through. */
  readonly states: readonly ConnectionState[];
  /** Transport failures and listener failures, as one-line descriptions. */
  readonly transportErrors: readonly string[];
  /** The client's current state. */
  readonly state: ConnectionState;
  /**
   * Whether the service has provably processed this connection's hello: the
   * handshake barrier was answered on the current connection.
   */
  readonly authenticated: boolean;
  /** Typed subscription, as `ReconnectingWsClient.on`, with barrier replies filtered out. */
  on<K extends MessageType>(type: K, handler: MessageHandler<K>): () => void;
  /** Sends one frame, stamping (or keeping) its envelope id. */
  send<K extends MessageType>(
    type: K,
    payload: MessagePayload<K>,
    options?: CreateEnvelopeOptions,
  ): SendReceipt;
  /**
   * Writes bytes on the live socket, bypassing the client — for a deliberately
   * malformed frame. Recorded in no transcript.
   *
   * @throws Error When no socket is open.
   */
  sendRaw(data: string | Uint8Array): void;
  /** The `error` replies whose `ref` names `frameId`. */
  errorsFor(frameId: string): readonly ErrorPayload[];
  /**
   * Sends the barrier and waits for its reply, proving that every frame sent
   * before it has been processed.
   *
   * @returns `true` when answered; `false` when the connection closed first.
   * @throws Error When neither happened within `timeoutMs`.
   */
  flush(timeoutMs?: number): Promise<boolean>;
  /**
   * Resolves with the first close at index `from` or later (default `0`),
   * immediately when one is already recorded.
   */
  waitForClose(timeoutMs?: number, from?: number): Promise<WsCloseRecord>;
  /** Race-free wait on this client's recorded state; see {@link waitFor}. */
  until<T>(check: () => T | undefined, timeoutMs: number, describe: () => string): Promise<T>;
  /** Closes the client and waits for its sockets to finish closing. Idempotent. */
  close(): Promise<void>;
  /** A one-paragraph summary of what this client saw, for failure messages. */
  describe(): string;
}

/** How {@link Harness.ws} opens a client. */
export interface HarnessWsOptions extends WsClientIdentity {
  /**
   * The credential presented in `client.hello`. Defaults to the editor
   * credential; `null` presents none, which the client refuses locally
   * (recorded in `unauthorized`) — use {@link Harness.rawSocket} to observe the
   * service's own refusal of a missing or malformed hello.
   */
  readonly token?: string | null | undefined;
  /** The `Origin` header of the upgrade: `chrome-extension://<id>` for a DevTools identity. */
  readonly origin?: string | undefined;
  /**
   * Whether to wait for the handshake barrier before resolving. Defaults to
   * `true`, which is what makes an editor connection's announced workspace
   * usable by the very next HTTP request.
   */
  readonly awaitAuthentication?: boolean | undefined;
  /** Overrides the harness's short, jitter-free reconnect curve. */
  readonly backoff?: WsBackoffOptions | undefined;
  /** How long to wait for the connection and the barrier. Defaults to `message`. */
  readonly timeoutMs?: number | undefined;
}

/** Everything {@link openWsClient} needs from the harness. */
interface WsClientContext {
  readonly wsUrl: string;
  readonly logger: Logger;
  readonly defaultToken: () => string;
  /** Tracks the client for teardown the moment it exists, before any wait can fail. */
  readonly register: (client: HarnessWsClient) => void;
}

/** Opens one {@link HarnessWsClient}. */
async function openWsClient(
  context: WsClientContext,
  options: HarnessWsOptions,
): Promise<HarnessWsClient> {
  const identity: WsClientIdentity = {
    client: options.client,
    ...(options.projectRoot === undefined ? {} : { projectRoot: options.projectRoot }),
    ...(options.tabId === undefined ? {} : { tabId: options.tabId }),
  };
  const token = options.token === undefined ? context.defaultToken() : options.token;
  const timeoutMs = options.timeoutMs ?? HARNESS_TIMEOUTS.message;

  const signal = new ChangeSignal();
  const sent: ProtocolMessage[] = [];
  const received: ProtocolMessage[] = [];
  const closes: WsCloseRecord[] = [];
  const protocolErrors: DebuggenError[] = [];
  const unauthorized: WsUnauthorizedDetail[] = [];
  const states: ConnectionState[] = [];
  const transportErrors: string[] = [];
  const sockets: NodeWebSocket[] = [];
  const barrierIds = new Set<string>();
  const answeredBarriers = new Set<string>();
  let authenticatedSocket: NodeWebSocket | undefined;
  let closing: Promise<void> | undefined;

  const isBarrierReply = (message: ProtocolMessage): boolean =>
    isMessageOfType(message, 'error') &&
    message.payload.ref !== undefined &&
    barrierIds.has(message.payload.ref);

  const tap: SocketTap = {
    origin: options.origin,
    attached: (socket) => {
      sockets.push(socket);
      signal.notify();
    },
    outbound: (frame) => {
      const decoded = decodeMessage(frame);
      if (!isErr(decoded) && !barrierIds.has(decoded.value.id)) {
        sent.push(decoded.value);
      }
    },
    inbound: () => {
      signal.notify();
    },
    closed: (record) => {
      closes.push(record);
      authenticatedSocket = undefined;
      signal.notify();
    },
    failed: (message) => {
      transportErrors.push(message);
      signal.notify();
    },
  };

  const client = new ReconnectingWsClient({
    url: context.wsUrl,
    webSocketConstructor: createTappedSocketConstructor(tap),
    identity,
    token: () => token ?? undefined,
    backoff: options.backoff ?? HARNESS_WS_BACKOFF,
    random: () => 1,
    logger: context.logger,
    onStateChange: (state) => {
      states.push(state);
      signal.notify();
    },
    onMessage: (message) => {
      if (isBarrierReply(message)) {
        if (isMessageOfType(message, 'error') && message.payload.ref !== undefined) {
          answeredBarriers.add(message.payload.ref);
        }
      } else {
        received.push(message);
      }
      signal.notify();
    },
    onProtocolError: (error) => {
      protocolErrors.push(error);
      signal.notify();
    },
    onUnauthorized: (detail) => {
      unauthorized.push(detail);
      authenticatedSocket = undefined;
      signal.notify();
    },
  });
  if (client.configurationError !== undefined) {
    throw new Error(
      `The harness WebSocket client refused its URL: ${client.configurationError.message}`,
    );
  }

  const currentSocket = (): NodeWebSocket | undefined => sockets[sockets.length - 1];

  const describeClient = (): string => {
    const types = received.map((message) => message.type).join(', ') || 'none';
    const closed =
      closes.map((record) => `${String(record.code)} ${record.reason}`).join('; ') || 'none';
    return `client ${identity.client} is ${client.state}; received [${types}]; closes [${closed}]; transport errors [${transportErrors.join('; ') || 'none'}]`;
  };

  const barrier = async (waitMs: number): Promise<boolean> => {
    const socket = currentSocket();
    const closesBefore = closes.length;
    const id = newMessageId();
    barrierIds.add(id);
    const outcome = client.send(BARRIER_MESSAGE_TYPE, { sessionId: newSessionId() }, { id });
    if (isErr(outcome) || outcome.value !== 'sent') {
      return false;
    }
    const answered = await signal.until(
      () => {
        if (answeredBarriers.has(id)) {
          return true;
        }
        return closes.length > closesBefore ? false : undefined;
      },
      waitMs,
      () =>
        `The handshake barrier was not answered within ${String(waitMs)} ms: ${describeClient()}`,
    );
    if (answered && socket !== undefined && socket === currentSocket()) {
      authenticatedSocket = socket;
    }
    return answered;
  };

  const harnessClient: HarnessWsClient = {
    identity,
    client,
    sockets,
    sent,
    received,
    closes,
    protocolErrors,
    unauthorized,
    states,
    transportErrors,
    get state(): ConnectionState {
      return client.state;
    },
    get authenticated(): boolean {
      const socket = currentSocket();
      return (
        authenticatedSocket !== undefined &&
        authenticatedSocket === socket &&
        socket.readyState === NodeWebSocket.OPEN
      );
    },
    on: (type, handler) =>
      client.on(type, (message) => {
        if (!isBarrierReply(message)) {
          handler(message);
        }
      }),
    send: (type, payload, sendOptions) => {
      const id = sendOptions?.id ?? newMessageId();
      return { id, result: client.send(type, payload, { ...sendOptions, id }) };
    },
    sendRaw: (data) => {
      const socket = currentSocket();
      if (socket?.readyState !== NodeWebSocket.OPEN) {
        throw new Error(`sendRaw needs an open socket: ${describeClient()}`);
      }
      socket.send(data);
    },
    errorsFor: (frameId) =>
      received.flatMap((message) =>
        isMessageOfType(message, 'error') && message.payload.ref === frameId
          ? [message.payload]
          : [],
      ),
    flush: (waitMs = HARNESS_TIMEOUTS.message) => barrier(waitMs),
    waitForClose: (waitMs = HARNESS_TIMEOUTS.message, from = 0) =>
      signal.until(
        () => closes[from],
        waitMs,
        () => `No close at index ${String(from)} within ${String(waitMs)} ms: ${describeClient()}`,
      ),
    until: (check, waitMs, describe) => signal.until(check, waitMs, describe),
    close: () => {
      closing ??= (async (): Promise<void> => {
        client.close(NORMAL_CLOSURE, TEARDOWN_REASON);
        await Promise.all(
          sockets.map((socket) => settleSocket(socket, HARNESS_TIMEOUTS.socketClose)),
        );
        signal.notify();
      })();
      return closing;
    },
    describe: describeClient,
  };

  context.register(harnessClient);
  try {
    client.connect();
    const opened = await signal.until(
      () => {
        if (client.state === 'open') {
          return true;
        }
        return closes.length > 0 || unauthorized.length > 0 || protocolErrors.length > 0
          ? false
          : undefined;
      },
      timeoutMs,
      () =>
        `The WebSocket connection did not open within ${String(timeoutMs)} ms: ${describeClient()}`,
    );
    if (opened && options.awaitAuthentication !== false) {
      await barrier(timeoutMs);
    }
  } catch (cause) {
    // A client that never settled must not keep reconnecting behind the suite.
    await harnessClient.close();
    throw cause;
  }
  return harnessClient;
}

/**
 * Resolves with the first received message of `type` that satisfies
 * `predicate`, searching the transcript first — so a message that already
 * arrived resolves at once and no arrival can be missed.
 *
 * The predicate receives the message's transcript index, which is how a suite
 * waits for a message *after* a point: `(m, i) => i >= mark`.
 *
 * @throws Error After `timeoutMs`, naming the awaited type and listing every
 * type actually received — a diagnosable timeout in a serialized run.
 */
export function waitFor<K extends MessageType>(
  client: HarnessWsClient,
  type: K,
  predicate?: (message: HarnessMessage<K>, index: number) => boolean,
  timeoutMs: number = HARNESS_TIMEOUTS.message,
): Promise<HarnessMessage<K>> {
  return client.until(
    () => {
      for (const [index, message] of client.received.entries()) {
        if (isMessageOfType(message, type) && (predicate?.(message, index) ?? true)) {
          return message;
        }
      }
      return undefined;
    },
    timeoutMs,
    () =>
      `Timed out after ${String(timeoutMs)} ms waiting for a "${type}" message; ${client.describe()}`,
  );
}

/**
 * Polls `probe` until it answers something other than `undefined` — for state
 * that has no message to wait on (a store row, a file on disk).
 *
 * @throws Error After `timeoutMs`, naming `description`.
 */
export async function waitUntil<T>(
  probe: () => T | undefined | Promise<T | undefined>,
  description: string,
  timeoutMs: number = HARNESS_TIMEOUTS.message,
  intervalMs = 20,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) {
      return value;
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out after ${String(timeoutMs)} ms waiting until ${description}.`);
    }
    await delay(intervalMs);
  }
}

/* -------------------------------------------------------------------------------------------------
 * WebSocket: the raw socket
 * ---------------------------------------------------------------------------------------------- */

/** How {@link Harness.rawSocket} opens a bare socket. */
export interface RawSocketOptions {
  /** The `Origin` header of the upgrade — a web origin to prove the 403 refusal. */
  readonly origin?: string | undefined;
  /** Extra upgrade headers. */
  readonly headers?: Readonly<Record<string, string>> | undefined;
  /**
   * A path other than protocol's `WS_PATH`, for a deliberately off-route
   * upgrade. Omitted, the URL is exactly `resolveWsUrl(harness.url)`.
   */
  readonly path?: string | undefined;
}

/**
 * A bare `ws` socket to the service that sends **no** `client.hello` of its
 * own — for observing the `CLIENT_HELLO_TIMEOUT_MS` refusal, a refused upgrade,
 * or a byte-level malformed first frame.
 */
export interface HarnessRawSocket {
  /** The underlying socket. */
  readonly socket: NodeWebSocket;
  /** Every inbound text frame, verbatim. */
  readonly frames: readonly string[];
  /** The inbound frames that decoded as protocol messages. */
  readonly messages: readonly ProtocolMessage[];
  /** Every close observed. */
  readonly closes: readonly WsCloseRecord[];
  /** Transport failures, verbatim. */
  readonly errors: readonly string[];
  /** The HTTP status of a refused upgrade (`403` for a web origin), when there was one. */
  readonly upgradeStatus: number | undefined;
  /** Resolves `true` once open, `false` when the upgrade failed or the socket closed first. */
  waitForOpen(timeoutMs?: number): Promise<boolean>;
  /** Resolves with the first close, immediately when already recorded. */
  waitForClose(timeoutMs?: number): Promise<WsCloseRecord>;
  /** Resolves with the first decoded message satisfying `predicate`. */
  waitForMessage(
    predicate: (message: ProtocolMessage) => boolean,
    timeoutMs?: number,
  ): Promise<ProtocolMessage>;
  /** Writes bytes verbatim. */
  send(data: string | Uint8Array): void;
  /** Builds a protocol frame with `createEnvelope` and writes it; returns the frame id. */
  sendMessage<K extends MessageType>(
    type: K,
    payload: MessagePayload<K>,
    options?: CreateEnvelopeOptions,
  ): string;
  /** Closes the socket and waits for it. Idempotent. */
  close(): Promise<void>;
}

/** The HTTP status `ws` reports for a refused upgrade, read from its error message. */
const UNEXPECTED_RESPONSE_PATTERN = /Unexpected server response: (\d{3})/u;

/** Opens one {@link HarnessRawSocket} against `wsUrl`. */
function openRawSocket(wsUrl: string, options: RawSocketOptions): HarnessRawSocket {
  const url = new URL(wsUrl);
  if (options.path !== undefined) {
    url.pathname = options.path;
  }
  const headers: Record<string, string> = { ...options.headers };
  const socket = new NodeWebSocket(url.toString(), [], {
    headers,
    ...(options.origin === undefined ? {} : { origin: options.origin }),
  });
  const signal = new ChangeSignal();
  const frames: string[] = [];
  const messages: ProtocolMessage[] = [];
  const closes: WsCloseRecord[] = [];
  const errors: string[] = [];
  let upgradeStatus: number | undefined;
  let opened = false;
  let closing: Promise<void> | undefined;

  socket.on('open', () => {
    opened = true;
    signal.notify();
  });
  socket.on('message', (data: RawData, isBinary: boolean) => {
    if (!isBinary) {
      const text = rawDataToText(data);
      frames.push(text);
      const decoded = decodeMessage(text);
      if (!isErr(decoded)) {
        messages.push(decoded.value);
      }
    }
    signal.notify();
  });
  socket.on('close', (code: number, reason: Buffer) => {
    closes.push({ code, reason: reason.toString('utf8') });
    signal.notify();
  });
  socket.on('error', (error: Error) => {
    errors.push(error.message);
    const status = UNEXPECTED_RESPONSE_PATTERN.exec(error.message)?.[1];
    if (status !== undefined) {
      upgradeStatus = Number(status);
    }
    signal.notify();
  });

  const describeSocket = (): string =>
    `raw socket readyState ${String(socket.readyState)}; frames ${String(frames.length)}; closes [${closes
      .map((record) => `${String(record.code)} ${record.reason}`)
      .join('; ')}]; errors [${errors.join('; ')}]`;

  return {
    socket,
    frames,
    messages,
    closes,
    errors,
    get upgradeStatus(): number | undefined {
      return upgradeStatus;
    },
    waitForOpen: (timeoutMs = HARNESS_TIMEOUTS.message) =>
      signal.until(
        () => {
          if (opened) {
            return true;
          }
          return closes.length > 0 || errors.length > 0 ? false : undefined;
        },
        timeoutMs,
        () => `The raw socket did not open within ${String(timeoutMs)} ms: ${describeSocket()}`,
      ),
    waitForClose: (timeoutMs = HARNESS_TIMEOUTS.message) =>
      signal.until(
        () => closes[0],
        timeoutMs,
        () => `The raw socket did not close within ${String(timeoutMs)} ms: ${describeSocket()}`,
      ),
    waitForMessage: (predicate, timeoutMs = HARNESS_TIMEOUTS.message) =>
      signal.until(
        () => messages.find(predicate),
        timeoutMs,
        () => `No matching frame within ${String(timeoutMs)} ms: ${describeSocket()}`,
      ),
    send: (data) => {
      socket.send(data);
    },
    sendMessage: (type, payload, envelopeOptions) => {
      const message = createEnvelope(type, payload, envelopeOptions);
      // `createEnvelope` answers `MessageByType<K>`, which for a concrete `K`
      // is one member of `ProtocolMessage`; the compiler cannot relate the
      // unresolved generic to the union (see protocol's `isMessageOfType`).
      socket.send(encodeMessage(message as ProtocolMessage));
      return message.id;
    },
    close: () => {
      closing ??= settleSocket(socket, HARNESS_TIMEOUTS.socketClose).then(() => {
        signal.notify();
      });
      return closing;
    },
  };
}

/* -------------------------------------------------------------------------------------------------
 * The harness: options, surface and private helpers
 * ---------------------------------------------------------------------------------------------- */

/** How {@link startHarness} boots the service. */
export interface HarnessOptions {
  /**
   * Environment entries merged **over** the harness's base record (see
   * {@link startHarness}). An entry set to `undefined` unsets that key. The
   * record is handed to `loadServiceConfig` and `startService`; `process.env`
   * is never read or written.
   */
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
  /**
   * The model provider. `'deterministic'` (the default) is the real
   * rules-based provider the configuration selects; a {@link ModelProvider} —
   * typically `createScriptedProvider(...).provider` — is routed through
   * `startService`'s own `provider` seam.
   */
  readonly provider?: 'deterministic' | ModelProvider | undefined;
  /**
   * The service clock. Defaults to {@link createHarnessClock} seeded at
   * {@link FIXTURE_BASE_EPOCH_MS}, exposed as {@link Harness.clock}.
   */
  readonly now?: (() => number) | undefined;
  /** The prompt directory. Defaults to the committed {@link PROMPTS_DIR}. */
  readonly promptsDir?: string | undefined;
  /**
   * The fixture project copied for the suite, exposed as {@link Harness.project}
   * and announced by an editor connection before `startHarness` resolves.
   * Defaults to {@link DEFAULT_FIXTURE_PROJECT}; `false` copies nothing.
   */
  readonly fixtureProject?: string | false | undefined;
  /** Typed configuration overrides, applied after the environment record. */
  readonly overrides?: ServiceConfigOverrides | undefined;
}

/** The store-side views a suite reads assertions from, over the service's own store. */
export interface HarnessRepos {
  readonly sessions: SessionsRepo;
  readonly telemetry: TelemetryRepo;
  readonly modifications: ModificationsRepo;
  readonly panels: PanelsRepo;
}

/** Per-call transport options of the harness's convenience flows and {@link Harness.http}. */
export interface HarnessCallOptions {
  /**
   * The bearer credential. Omitted, the editor credential — and the flow first
   * makes sure a live editor connection announces the session's project, which
   * editor HTTP requests require (AAP §0.5.6). `null` sends none.
   */
  readonly token?: string | null | undefined;
  /** The `Origin` header — `chrome-extension://<id>` for a DevTools credential. */
  readonly origin?: string | undefined;
  /**
   * The inspected tab a DevTools call acts for, sent as protocol's acting-tab
   * header — which the service requires on every DevTools session request and
   * refuses from any other credential. Omitted, no header is sent.
   */
  readonly tabId?: number | undefined;
  /**
   * The read proof a DevTools read presents as protocol's read-proof header —
   * {@link DevtoolsCredential.readProof}, which the service requires on every
   * DevTools read. Used only by the flows that read (`waitForSession`).
   * Omitted, no header is sent.
   */
  readonly readProof?: string | undefined;
  /** Overrides the `request` timeout for this call. */
  readonly timeoutMs?: number | undefined;
}

/** A DevTools credential and the extension identity it is scoped to. */
export interface DevtoolsCredential {
  /** The extension id the credential was issued to. */
  readonly extensionId: string;
  /** `chrome-extension://<extensionId>` — the only origin the credential is accepted from. */
  readonly origin: string;
  /** The plaintext credential. */
  readonly token: string;
  /**
   * The read proof issued with the credential, which every DevTools read
   * (`session.get`, `panel.get`, `panel.getById`, `modifications.list`) must
   * present as protocol's read-proof header, `Origin` or not.
   */
  readonly readProof: string;
  /** When the credential stops being accepted, where it expires at all. */
  readonly expiresAt?: number | undefined;
}

/** A connected DevTools client together with the credential it presented. */
export interface DevtoolsConnection {
  readonly client: HarnessWsClient;
  readonly credential: DevtoolsCredential;
}

/** How {@link Harness.connectDevtools} opens a DevTools client. */
export interface DevtoolsConnectOptions {
  /** The inspected tab the client speaks for. */
  readonly tabId: number;
  /** An existing credential; omitted, one is issued through the real auth service. */
  readonly credential?: DevtoolsCredential | undefined;
  /** How long to wait for the connection and the barrier. */
  readonly timeoutMs?: number | undefined;
}

/** What `session.bind` is sent with. */
export type BindTabPayload = MessagePayload<'session.bind'>;

/** The outcome of one `telemetry.event` frame, read after the ordering barrier. */
export interface AgentIngestOutcome {
  /** The frame id, which any `error` reply carries as its `ref`. */
  readonly id: string;
  /** What the client reported for the send itself. */
  readonly sent: Result<SendOutcome, DebuggenError>;
  /**
   * Whether the ordering barrier behind the frame was answered — `true` means
   * the service finished handling the frame before `errors` was read.
   */
  readonly settled: boolean;
  /** Every `error` the service answered the frame with — empty for an accepted batch. */
  readonly errors: readonly ErrorPayload[];
}

/** What {@link Harness.ingestFromServerAgent} posts. */
export interface ServerAgentIngest {
  /** The server-agent credential, scoped to `projectRoot`. */
  readonly token: string;
  /** The project the spans belong to. */
  readonly projectRoot: string;
  /** The batch, as the Node preload would send it. */
  readonly events: readonly TelemetryEventIngress[];
  /** An `Origin` header, to prove a server-agent credential is refused from any origin. */
  readonly origin?: string | undefined;
}

/**
 * Where {@link Harness.rawFetch} sends: an operation id (path parameter-free),
 * an operation with its path parameters, or a path relative to the service URL
 * for a deliberately off-route request. The first two build the path with
 * protocol's `buildPath`.
 */
export type RawFetchTarget =
  | HttpOperationId
  | {
      readonly operation: HttpOperationId;
      readonly params?: Readonly<Record<string, string>> | undefined;
    }
  | { readonly path: string };

/** How {@link Harness.rawFetch} builds its request. */
export interface RawFetchInit {
  /** The method; defaults to the route's own, or `GET` for a bare path. */
  readonly method?: string | undefined;
  /**
   * The bearer credential. Omitted, the editor credential — except for an
   * auth-exempt operation, which is sent without one. `null` sends none.
   */
  readonly token?: string | null | undefined;
  /** The `Origin` header, for example a web origin to prove the 403 refusal. */
  readonly origin?: string | undefined;
  /** Extra headers, lowercase or not. */
  readonly headers?: Readonly<Record<string, string>> | undefined;
  /**
   * The body. A string is sent verbatim — the way to send a malformed body —
   * and anything else is JSON-encoded.
   */
  readonly body?: unknown;
  /** Overrides the `request` timeout. */
  readonly timeoutMs?: number | undefined;
}

/** A raw response, read in full so no body stream outlives the call. */
export interface RawFetchResponse {
  readonly status: number;
  /** The response headers, for asserting the **absence** of `Access-Control-Allow-Origin`. */
  readonly headers: Headers;
  /** The body as text. */
  readonly text: string;
  /** The body parsed as JSON, or `undefined` when it is not JSON. */
  readonly json: unknown;
}

/** What {@link Harness.stop} released, and anything it could not. */
export interface HarnessStopReport {
  /** `true` when `problems` is empty. */
  readonly clean: boolean;
  /** One line per handle, socket or directory that was not released. */
  readonly problems: readonly string[];
}

/** A running service and every way a suite talks to it. */
export interface Harness {
  /** The service's base URL, `http://127.0.0.1:<port>`. */
  readonly url: string;
  /** The ephemeral port the service bound. */
  readonly port: number;
  /** The WebSocket URL, derived with `resolveWsUrl(url)`. */
  readonly wsUrl: string;
  /** The temporary `$DEBUGGEN_HOME`, removed by {@link Harness.stop}. */
  readonly home: string;
  /** The effective configuration (its `port` is the bound port). */
  readonly config: ServiceConfig;
  /** The environment record the service was booted with. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The handle `startService` returned. */
  readonly service: ServiceHandle;
  /** The service's own access boundary — the instance its routes authorize through. */
  readonly auth: AuthService;
  /** The service's store. */
  readonly store: Store;
  /** Assertion-side repositories over {@link Harness.store}. */
  readonly repos: HarnessRepos;
  /** The service's session manager. */
  readonly manager: ServiceHandle['manager'];
  /** The injected clock, or `undefined` when {@link HarnessOptions.now} replaced it. */
  readonly clock: HarnessClock | undefined;
  /** The service clock, whichever it is. */
  readonly now: () => number;
  /** The service's root logger and every record it wrote. */
  readonly logger: CapturedLogger;
  /** The current editor credential, re-read after every rotation. */
  readonly editorToken: string;
  /** The default fixture project copy, or `undefined` when none was requested. */
  readonly project: FixtureProjectCopy | undefined;
  /** The default fixture project copy. @throws Error When none was requested. */
  requireProject(): FixtureProjectCopy;

  /**
   * A protocol `HttpClient` against the service. Omitted, the editor
   * credential; `null`, no `Authorization` header at all.
   */
  http(token?: string | null, options?: { readonly origin?: string | undefined }): HttpClient;
  /** The escape hatch for requests `HttpClient` deliberately cannot express. */
  rawFetch(target: RawFetchTarget, init?: RawFetchInit): Promise<RawFetchResponse>;

  /** Opens a protocol WebSocket client, tracked for teardown. */
  ws(options: HarnessWsOptions): Promise<HarnessWsClient>;
  /**
   * The live editor connection announcing `projectRoot` (or a folder containing
   * it), opening one when none is authenticated.
   */
  editor(projectRoot: string): Promise<HarnessWsClient>;
  /** Issues a DevTools credential and opens a DevTools client presenting it. */
  connectDevtools(options: DevtoolsConnectOptions): Promise<DevtoolsConnection>;
  /** Opens a bare socket that sends no `client.hello`, tracked for teardown. */
  rawSocket(options?: RawSocketOptions): HarnessRawSocket;

  /** Issues a DevTools credential through the real auth service. */
  issueDevtoolsCredential(extensionId?: string): DevtoolsCredential;
  /** Issues a server-agent credential scoped to one project. */
  issueServerAgentCredential(projectRoot: string, expiresAt?: number): IssuedCredential;
  /** Mints a pairing code through the real auth service. */
  startPairing(): PairingCode;
  /** Runs the whole pairing flow over HTTP: editor starts it, the extension origin redeems it. */
  pairDevtools(extensionId?: string): Promise<DevtoolsCredential>;
  /** Rotates every credential, then re-reads the regenerated editor credential. */
  rotateAll(): RotationOutcome;
  /** Re-reads the editor credential from `auth.json` and returns it. */
  refreshEditorToken(): string;

  /**
   * `devServer.launch` for a project — by default with
   * {@link standInDevServerCommand}, so the fixture itself is never executed.
   * The launched child is stopped by the service at teardown.
   */
  launchDevServer(
    projectRoot: string,
    options?: HarnessCallOptions & { readonly command?: string | undefined },
  ): Promise<Result<HttpResponseBody<'devServer.launch'>, DebuggenError>>;
  /** `session.create` through `HttpClient`. @throws Error On any refusal, naming its code. */
  createSession(
    body: HttpRequestBody<'session.create'>,
    options?: HarnessCallOptions,
  ): Promise<SessionRecord>;
  /**
   * Polls `session.get` until the record satisfies `predicate` — how a suite
   * waits for the pipeline to reach a state (`ready`, `generated`, `failed`)
   * without reaching into the store or the state machine.
   *
   * @throws Error After `timeoutMs` (default `pipeline`), naming the last
   * status and progress seen; or at once when `session.get` is refused.
   */
  waitForSession(
    sessionId: string,
    predicate: (record: SessionRecord) => boolean,
    options?: HarnessCallOptions,
  ): Promise<SessionRecord>;
  /** Sends `session.bind` and resolves with `session.bound`, or the `error` reply. */
  bindTab(
    client: HarnessWsClient,
    payload: BindTabPayload,
    timeoutMs?: number,
  ): Promise<Result<HarnessMessage<'session.bound'>, ErrorPayload>>;
  /** Sends one `telemetry.event` frame and reports it after the ordering barrier. */
  ingestFromAgent(
    client: HarnessWsClient,
    events: readonly TelemetryEventIngress[],
  ): Promise<AgentIngestOutcome>;
  /** Posts a server-agent batch to the ingest route. */
  ingestFromServerAgent(
    ingest: ServerAgentIngest,
  ): Promise<Result<HttpResponseBody<'telemetry.event'>, DebuggenError>>;
  /**
   * `capture.start`. A `409` is a failure whose `details.owningSessionId`
   * names the holder — see {@link owningSessionIdOf}.
   */
  startCapture(
    sessionId: string,
    options?: HarnessCallOptions,
  ): Promise<Result<HttpResponseBody<'capture.start'>, DebuggenError>>;
  /** `capture.stop`. */
  stopCapture(
    sessionId: string,
    options?: HarnessCallOptions,
  ): Promise<Result<HttpResponseBody<'capture.stop'>, DebuggenError>>;
  /** `session.end`, which runs cleanup. */
  endSession(
    sessionId: string,
    options?: HarnessCallOptions,
  ): Promise<Result<HttpResponseBody<'session.end'>, DebuggenError>>;

  /** Copies another fixture project, tracked for teardown. */
  copyFixtureProject(name?: string): Promise<FixtureProjectCopy>;
  /** Releases everything, in order. Idempotent; never rejects. */
  stop(): Promise<HarnessStopReport>;
  /** Stops, then throws unless every socket, the listener and every directory is gone. */
  assertNoLeaks(): Promise<void>;
}

/**
 * The `owningSessionId` a `capture.start` 409 carries, read from the
 * failure's details — `undefined` for any other failure.
 */
export function owningSessionIdOf(error: DebuggenError): string | undefined {
  const details: unknown = error.details;
  if (!isPlainObject(details)) {
    return undefined;
  }
  const owner = details.owningSessionId;
  return typeof owner === 'string' ? owner : undefined;
}

/**
 * The stand-in dev server's source: listen on an ephemeral loopback port,
 * print the address the way `next dev` does (which is what the launcher waits
 * for), answer every request `200`, and exit on `SIGTERM`.
 */
const STAND_IN_DEV_SERVER_SOURCE = [
  'const server = require("node:http").createServer((request, response) => {',
  ' response.end("ok"); });',
  'server.listen(0, "127.0.0.1", () => {',
  ' console.log("Local: http://127.0.0.1:" + String(server.address().port)); });',
  'process.on("SIGTERM", () => { server.close(() => process.exit(0)); });',
  '',
].join('\n');

/**
 * The stand-in dev CLI's source: a supervisor that serves nothing and runs the
 * server as a separate process, as `next dev` runs `next-server` — this very
 * interpreter on {@link STAND_IN_DEV_SERVER_SEGMENTS}, with the inherited
 * environment (so the launcher's `NODE_OPTIONS` preload reaches it) and the
 * inherited stdio (so its address line reaches the launcher). The preload's
 * process gate (`classifyPreloadProcess` in `@debuggen/telemetry`) keeps a
 * `next dev` supervisor inert and installs in the process that serves, so the
 * stand-in has to split the two exactly as the framework does. `SIGTERM` is
 * forwarded, and the supervisor exits once the server has.
 */
const STAND_IN_DEV_CLI_SOURCE = [
  'const { spawn } = require("node:child_process");',
  'const { join } = require("node:path");',
  'const server = spawn(process.execPath, [join(__dirname, "..", "server", "lib", "start-server.js")],',
  ' { stdio: "inherit" });',
  'server.on("error", () => { process.exit(1); });',
  'server.on("exit", (code, signal) => { process.exit(code ?? (signal === null ? 1 : 0)); });',
  'process.on("SIGTERM", () => { server.kill("SIGTERM"); });',
  '',
].join('\n');

/** The framework CLI's path under a `node_modules` directory, as the launcher accepts it. */
const STAND_IN_DEV_CLI_SEGMENTS = ['node_modules', 'next', 'dist', 'bin', 'next'] as const;

/**
 * The stand-in server's path under the stand-in package — where Next.js keeps
 * the entry its dev CLI runs the server from — which the CLI source spells
 * relative to its own directory.
 */
const STAND_IN_DEV_SERVER_SEGMENTS = ['dist', 'server', 'lib', 'start-server.js'] as const;

/**
 * The stand-in package's own manifest. The CLI has no extension, so Node takes
 * its module format from the nearest `package.json`; writing one beside it
 * keeps the CommonJS source above CommonJS whatever lies above the temp dir.
 */
const STAND_IN_DEV_CLI_MANIFEST = `${JSON.stringify({ name: 'next', private: true, type: 'commonjs' })}\n`;

/** The prefix of the private directory the stand-in CLI is written into. */
const STAND_IN_DEV_CLI_PREFIX = 'debuggen-stand-in-dev-cli-';

/** A written stand-in CLI: its private `mkdtemp` directory, and the CLI's path inside it. */
interface StandInDevCli {
  readonly root: string;
  readonly path: string;
}

/**
 * The stand-in CLI written and not yet handed to a release. `undefined` before
 * the first {@link standInDevServerCommand}, and again from the moment the last
 * live harness releases it — so a later call writes a fresh directory rather
 * than returning one that release is about to remove.
 */
let writtenStandInDevCli: StandInDevCli | undefined;

/**
 * How many harnesses are live: {@link startHarness} takes one lease once its
 * home exists and returns it exactly once, when that harness is released —
 * by {@link Harness.stop} or by the release after a failed start.
 */
let liveHarnessLeases = 0;

/** Whether the process-exit backstop is registered: at most once per module instance. */
let standInExitBackstopRegistered = false;

/**
 * Registers, once, the backstop that removes a stand-in CLI still held when
 * the process exits normally — plain Node, or a pool that lets its workers
 * exit. It is only a backstop: under the `forks` pool Vitest ends the worker
 * with `SIGTERM`, which runs no `'exit'` handler, so the removal that counts is
 * the one {@link releaseStandInLease} hands to the last harness's release.
 */
function registerStandInExitBackstop(): void {
  if (standInExitBackstopRegistered) {
    return;
  }
  standInExitBackstopRegistered = true;
  process.once('exit', () => {
    const written = writtenStandInDevCli;
    writtenStandInDevCli = undefined;
    if (written !== undefined) {
      rmSync(written.root, { recursive: true, force: true });
    }
  });
}

/**
 * The stand-in CLI's path, writing it on first use — synchronously, once per
 * lifetime of the live harnesses — into a private `mkdtemp` directory as
 * `<dir>/node_modules/next/dist/bin/next`, mode `0o644` (owned by this user
 * and writable by nobody else, which is what the launcher's trust check
 * requires of a framework CLI), beside the package's own `package.json` and
 * the server it runs, `dist/server/lib/start-server.js`.
 *
 * The directory belongs to the live harnesses, not to the process: the release
 * that returns the last lease removes it (see {@link releaseStandInLease}). A
 * directory written while no harness is live is removed by the next such
 * release, and a write that fails part-way removes what it had created.
 */
function standInDevCli(): string {
  if (writtenStandInDevCli !== undefined) {
    return writtenStandInDevCli.path;
  }
  const root = mkdtempSync(join(realpathSync(tmpdir()), STAND_IN_DEV_CLI_PREFIX));
  const path = join(root, ...STAND_IN_DEV_CLI_SEGMENTS);
  const packageRoot = join(root, 'node_modules', 'next');
  const serverPath = join(packageRoot, ...STAND_IN_DEV_SERVER_SEGMENTS);
  try {
    mkdirSync(join(path, '..'), { recursive: true });
    mkdirSync(join(serverPath, '..'), { recursive: true });
    writeFileSync(join(packageRoot, 'package.json'), STAND_IN_DEV_CLI_MANIFEST, { mode: 0o644 });
    writeFileSync(serverPath, STAND_IN_DEV_SERVER_SOURCE, { mode: 0o644 });
    writeFileSync(path, STAND_IN_DEV_CLI_SOURCE, { mode: 0o644 });
  } catch (cause) {
    rmSync(root, { recursive: true, force: true });
    throw cause;
  }
  writtenStandInDevCli = Object.freeze({ root, path });
  registerStandInExitBackstop();
  return path;
}

/** Takes one lease on the stand-in CLI for a harness whose home now exists. */
function acquireStandInLease(): void {
  liveHarnessLeases += 1;
}

/**
 * Returns one lease. When it was the last, the stand-in CLI written so far is
 * forgotten at once and its directory returned, for the caller's release to
 * remove with its own directories — after its service's shutdown is
 * confirmed, and so after the launcher has sent `SIGTERM` to every stand-in
 * dev server that service started (a close that rejects or overruns retains
 * it and reports it, like the rest). Removing it cannot disturb an earlier
 * harness whose close is still pending: a stand-in child that is running has
 * already read its script, and a closing service launches none.
 *
 * @returns The stand-in directory to remove, or `undefined` while another
 *   harness is live or when none was written.
 */
function releaseStandInLease(): string | undefined {
  liveHarnessLeases = Math.max(0, liveHarnessLeases - 1);
  if (liveHarnessLeases > 0) {
    return undefined;
  }
  const written = writtenStandInDevCli;
  writtenStandInDevCli = undefined;
  return written?.root;
}

/**
 * A `devServer.launch` command line that starts a **stand-in** dev server:
 * this very interpreter (`process.execPath`, so no `PATH` lookup happens in
 * the child's injected environment, and the service's own Node, which the
 * launcher's command policy accepts) running a few lines of Node that play
 * the framework's dev CLI — written to a private
 * `node_modules/next/dist/bin/next` and run with `dev`, exactly as the
 * end-to-end sample app borrows a real `next` bin. Like `next dev`, that CLI
 * only supervises: it runs the server as a second process, where the preload
 * installs (see {@link STAND_IN_DEV_CLI_SOURCE}). The server listens on an
 * ephemeral loopback port and prints the address the way `next dev` does,
 * which is what the launcher waits for.
 *
 * `session.create` needs a dev-server URL (`DEV_SERVER_UNAVAILABLE` otherwise),
 * and the fixture projects are never installed or executed; this is how a suite
 * gives a session a live dev server through the real launcher, preload
 * attached, without running a byte of the fixture. The child answers every
 * request `200` and exits on `SIGTERM`, which the launcher sends to the whole
 * process group at teardown.
 *
 * Call it while a harness is live — every call then returns the same command
 * until the last live harness is released, whose teardown removes the CLI's
 * directory once its service has stopped; the first call after that writes a
 * fresh one. A command obtained earlier must not outlive that release.
 *
 * @throws Error When the interpreter's path or the stand-in CLI's path
 * contains a single quote, which the launcher's POSIX-style tokenizer could
 * not carry inside `'…'`.
 */
export function standInDevServerCommand(): string {
  const executable = process.execPath;
  if (executable.includes("'")) {
    throw new Error('The Node executable path contains a single quote.');
  }
  const cli = standInDevCli();
  if (cli.includes("'")) {
    throw new Error('The stand-in dev CLI path contains a single quote.');
  }
  return `'${executable}' '${cli}' dev`;
}

/** The base environment record, with the suite's entries merged over it. */
function buildServiceEnv(
  home: string,
  options: HarnessOptions,
): Readonly<Record<string, string | undefined>> {
  return Object.freeze({
    DEBUGGEN_PROVIDER: 'deterministic',
    DEBUGGEN_HOME: home,
    DEBUGGEN_HOST: DEFAULT_HOST,
    DEBUGGEN_PORT: String(EPHEMERAL_PORT),
    DEBUGGEN_LOG_LEVEL: 'debug',
    DEBUGGEN_RETENTION_DAYS: String(DEFAULT_RETENTION_DAYS),
    DEBUGGEN_PROMPTS_DIR: options.promptsDir ?? PROMPTS_DIR,
    ...options.env,
  });
}

/**
 * Reads the editor credential the way the service wrote it: `auth.json`,
 * opened without following a symlink and validated by the service's own
 * schema. Never quotes the file's content in an error.
 */
function readEditorToken(authFilePath: string): string {
  let text: string;
  try {
    text = readFileNoFollow(authFilePath).toString('utf8');
  } catch (cause) {
    throw new Error(`The editor credential file could not be read: ${describeCause(cause)}`, {
      cause,
    });
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('The editor credential file is not JSON.');
  }
  const parsed = authFileSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(
      `The editor credential file is malformed: ${describeZodIssues(parsed.error.issues)}`,
    );
  }
  return parsed.data.token;
}

/** A `FetchLike` over Node's global `fetch`, adding an `Origin` header when one is given. */
function harnessFetch(origin: string | undefined): FetchLike {
  if (origin === undefined) {
    return (url, init) => fetch(url, init);
  }
  return (url, init) => fetch(url, { ...init, headers: { ...init?.headers, origin } });
}

/** Encodes a {@link RawFetchInit.body}: a string verbatim, anything else as JSON. */
function encodeRawBody(body: unknown): string | undefined {
  if (body === undefined) {
    return undefined;
  }
  return typeof body === 'string' ? body : JSON.stringify(body);
}

/** Resolves a {@link RawFetchTarget} to a path and the method its route declares. */
function resolveRawTarget(target: RawFetchTarget): {
  readonly path: string;
  readonly method: string;
  readonly authExempt: boolean;
} {
  if (typeof target === 'string') {
    const route = HTTP_ROUTES[target];
    return {
      path: buildPath(target),
      method: route.method,
      authExempt: isAuthExemptOperation(target),
    };
  }
  if ('path' in target) {
    return { path: target.path, method: 'GET', authExempt: false };
  }
  const route = HTTP_ROUTES[target.operation];
  return {
    path: buildPath(target.operation, target.params),
    method: route.method,
    authExempt: isAuthExemptOperation(target.operation),
  };
}

/** Whether a TCP connection to `host:port` is refused — the listener's absence. */
function probeListener(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolveProbe) => {
    const socket = connectTcp({ host, port });
    const finish = (refused: boolean): void => {
      clearTimeout(timer);
      socket.destroy();
      resolveProbe(refused);
    };
    const timer = setTimeout(() => {
      finish(false);
    }, timeoutMs);
    socket.once('connect', () => {
      finish(false);
    });
    socket.once('error', () => {
      finish(true);
    });
  });
}

/**
 * Removes a harness-owned temporary directory, refusing anything outside the
 * real temporary root — a guard against a suite that overrode `DEBUGGEN_HOME`
 * or handed over a foreign path.
 */
async function removeTempDirectory(path: string, problems: string[]): Promise<void> {
  const tempRoot = toPosix(realpathSync(tmpdir()));
  const target = toPosix(resolve(path));
  if (target === tempRoot || !isWithin(tempRoot, target)) {
    problems.push(`refused to remove ${target}: it is not inside ${tempRoot}`);
    return;
  }
  try {
    await rm(target, { recursive: true, force: true });
  } catch (cause) {
    problems.push(`could not remove ${target}: ${describeCause(cause)}`);
    return;
  }
  if (await pathExists(target)) {
    problems.push(`${target} still exists after removal`);
  }
}

/* -------------------------------------------------------------------------------------------------
 * Teardown and late-start settlement
 *
 * Extracted from startHarness so the failure paths — a close that rejects, a
 * start that outlives its boot timeout — can be driven with fakes in
 * harness.test.ts instead of by provoking them in a real service.
 * ---------------------------------------------------------------------------------------------- */

/** A socket as teardown inspects it: only whether it finished closing. */
export interface ReleasableSocket {
  /** The `ws` ready state; a released socket is `WebSocket.CLOSED` (`3`). */
  readonly readyState: number;
}

/** A WebSocket client as teardown releases it. Every {@link HarnessWsClient} is one. */
export interface ReleasableWsClient {
  /** The announced identity, which names the client in a problem line. */
  readonly identity: Pick<WsClientIdentity, 'client' | 'tabId'>;
  /** Every socket the client opened; each must be closed once `close()` has settled. */
  readonly sockets: readonly ReleasableSocket[];
  /** Closes the client and waits for its sockets. */
  close(): Promise<void>;
}

/** A bare socket as teardown releases it. Every {@link HarnessRawSocket} is one. */
export interface ReleasableRawSocket {
  /** The underlying socket, which must be closed once `close()` has settled. */
  readonly socket: ReleasableSocket;
  /** Closes the socket and waits for it. */
  close(): Promise<void>;
}

/** A service as teardown releases it. Every `ServiceHandle` is one. */
export type ReleasableService = Pick<ServiceHandle, 'close'>;

/** Everything {@link releaseHarnessResources} releases, listed in the order it releases them. */
export interface HarnessResources {
  /** The protocol clients, closed first and concurrently. */
  readonly clients: readonly ReleasableWsClient[];
  /** The bare sockets, closed next and concurrently. */
  readonly rawSockets: readonly ReleasableRawSocket[];
  /** The running service, closed after every socket; `undefined` when none started. */
  readonly handle: ReleasableService | undefined;
  /**
   * Harness-owned temporary directories, removed last and one at a time. Each
   * must lie inside the operating system's temporary root; anything else is
   * refused and reported rather than removed.
   */
  readonly directories: readonly string[];
  /** The bound on the service's close. Defaults to `HARNESS_TIMEOUTS.teardown`. */
  readonly handleCloseTimeoutMs?: number | undefined;
}

/**
 * What {@link releaseHarnessResources} did. The directories are removed only
 * once the service's shutdown is confirmed — its `close()` resolved — because a
 * service whose close rejected or is still running may keep its store open in
 * the temporary home, or its listener bound, and removing the sandbox under it
 * is exactly the orphan the teardown exists to prevent.
 */
export interface HarnessRelease {
  /**
   * One line per resource not released now: every rejected close, socket left
   * open, service close that rejected or overran its bound, directory not
   * removed — and one `retained …` line per directory kept for an unconfirmed
   * shutdown. Empty when everything was released.
   */
  readonly problems: readonly string[];
  /** The directories kept because the service's shutdown was not confirmed. */
  readonly retained: readonly string[];
  /**
   * Present only when the service's `close()` was still pending at its bound:
   * resolves once that close settles, having removed the retained directories
   * if it resolved, or kept them (and reported so) if it rejected. Never
   * rejects; `undefined` when nothing was deferred.
   */
  readonly deferred: Promise<HarnessStopReport> | undefined;
}

/** Names one protocol client in a teardown problem line: its position, kind and tab. */
function describeReleasableClient(client: ReleasableWsClient, index: number): string {
  const tab = client.identity.tabId === undefined ? '' : `, tab ${String(client.identity.tabId)}`;
  return `WebSocket client #${String(index + 1)} (${client.identity.client}${tab})`;
}

/** Removes each directory in turn, guarded on its own; every failure becomes one line. */
async function removeDirectories(
  directories: readonly string[],
  problems: string[],
): Promise<void> {
  for (const directory of directories) {
    try {
      await removeTempDirectory(directory, problems);
    } catch (cause) {
      problems.push(`could not remove ${directory}: ${describeCause(cause)}`);
    }
  }
}

/** One `retained …` problem line per directory kept for an unconfirmed shutdown. */
function retainedLines(directories: readonly string[], reason: string): string[] {
  return directories.map((directory) => `retained ${toPosix(resolve(directory))}: ${reason}`);
}

/** A frozen {@link HarnessStopReport} over `problems`. */
function stopReport(problems: readonly string[]): HarnessStopReport {
  const frozen = Object.freeze([...problems]);
  return Object.freeze({ clean: frozen.length === 0, problems: frozen });
}

/**
 * Releases a harness's resources in the order the teardown contract names —
 * protocol clients, bare sockets, the service, then the directories — and
 * reports every one it could not release.
 *
 * Every step runs whatever happened before it: closes are collected with
 * `Promise.allSettled`, so one rejected close neither aborts the others nor
 * skips the service close, and each removal is guarded on its own. The result
 * is therefore a complete inventory — one line per rejected close (naming the
 * client or raw socket), per socket left open, for a service close that
 * rejected or overran its bound, and per directory not removed.
 *
 * The directories are removed only after a **confirmed** shutdown: no service,
 * or a `close()` that resolved within its bound. A close that rejected leaves
 * the service's state unknown, so its directories are retained and reported,
 * never removed. A close still pending at its bound retains them too, and
 * {@link HarnessRelease.deferred} removes them once that close resolves.
 *
 * @returns What was released, retained and deferred. Never rejects.
 *
 * @example Releasing what a partially started harness acquired
 * ```ts
 * const release = await releaseHarnessResources({
 *   clients,
 *   rawSockets,
 *   handle,
 *   directories: [projectContainer, home],
 * });
 * if (release.deferred !== undefined) {
 *   void release.deferred.then(reportDeferredRelease);
 * }
 * ```
 */
export async function releaseHarnessResources(
  resources: HarnessResources,
): Promise<HarnessRelease> {
  const problems: string[] = [];

  const clientCloses = await Promise.allSettled(
    resources.clients.map((client) => attemptClose(() => client.close())),
  );
  for (const [index, client] of resources.clients.entries()) {
    const label = describeReleasableClient(client, index);
    const outcome = clientCloses[index];
    if (outcome?.status === 'rejected') {
      problems.push(`closing ${label} failed: ${describeCause(outcome.reason)}`);
    }
    for (const socket of client.sockets) {
      if (socket.readyState !== NodeWebSocket.CLOSED) {
        problems.push(`${label} still has a socket in readyState ${String(socket.readyState)}`);
      }
    }
  }

  const rawCloses = await Promise.allSettled(
    resources.rawSockets.map((raw) => attemptClose(() => raw.close())),
  );
  for (const [index, raw] of resources.rawSockets.entries()) {
    const label = `raw socket #${String(index + 1)}`;
    const outcome = rawCloses[index];
    if (outcome?.status === 'rejected') {
      problems.push(`closing ${label} failed: ${describeCause(outcome.reason)}`);
    }
    if (raw.socket.readyState !== NodeWebSocket.CLOSED) {
      problems.push(`${label} is still in readyState ${String(raw.socket.readyState)}`);
    }
  }

  // `confirmed` unless the service's close rejected or overran its bound: only
  // a close that resolved proves nothing it opened can still use the sandbox.
  let pendingClose: Promise<void> | undefined;
  let closeRejected = false;
  const service = resources.handle;
  if (service !== undefined) {
    const timeoutMs = resources.handleCloseTimeoutMs ?? HARNESS_TIMEOUTS.teardown;
    const closing = attemptClose(() => service.close());
    try {
      const closed = await withinDeadline(closing, timeoutMs);
      if (!closed.done) {
        pendingClose = closing;
        problems.push(`ServiceHandle.close() did not resolve within ${String(timeoutMs)} ms`);
      }
    } catch (cause) {
      closeRejected = true;
      problems.push(`ServiceHandle.close() rejected: ${describeCause(cause)}`);
    }
  }

  if (!closeRejected && pendingClose === undefined) {
    await removeDirectories(resources.directories, problems);
    return Object.freeze({
      problems: Object.freeze(problems),
      retained: Object.freeze([]),
      deferred: undefined,
    });
  }

  const retained = Object.freeze([...resources.directories]);
  if (closeRejected) {
    problems.push(
      ...retainedLines(
        retained,
        'the service close rejected, so its shutdown is unconfirmed; remove it by hand once the process has exited',
      ),
    );
    return Object.freeze({ problems: Object.freeze(problems), retained, deferred: undefined });
  }

  problems.push(
    ...retainedLines(
      retained,
      'the service close is still pending; it is removed once that close resolves',
    ),
  );
  const deferred = (pendingClose ?? Promise.resolve())
    .then(
      async (): Promise<HarnessStopReport> => {
        const later: string[] = [];
        await removeDirectories(retained, later);
        return stopReport(later);
      },
      (cause: unknown): HarnessStopReport =>
        stopReport([
          `ServiceHandle.close() rejected after its bound: ${describeCause(cause)}`,
          ...retainedLines(
            retained,
            'the service close rejected, so its shutdown is unconfirmed; remove it by hand once the process has exited',
          ),
        ]),
    )
    .catch((cause: unknown) =>
      stopReport([`releasing after the pending service close failed: ${describeCause(cause)}`]),
    );
  return Object.freeze({ problems: Object.freeze(problems), retained, deferred });
}

/** How long {@link settleLateStart} waits, in milliseconds. */
export interface LateStartOptions {
  /** How much longer the start may take to settle. `startHarness` uses `HARNESS_TIMEOUTS.lateStart`. */
  readonly graceMs: number;
  /**
   * How long closing the handle a late start produced may take.
   * `startHarness` uses `HARNESS_TIMEOUTS.lateStartClose`.
   */
  readonly closeTimeoutMs: number;
}

/**
 * How a late start's whole lifecycle ended, once it has: whether its shutdown
 * is confirmed, and every failure along the way.
 */
export interface LateStartFinish {
  /**
   * `true` only for a confirmed shutdown: `startService` refused (it releases
   * everything it acquired before returning `Err`), or the handle it produced
   * closed — its `close()` resolved. A start that rejected, or a handle whose
   * `close()` rejected, leaves the service's state unknown: `false`.
   */
  readonly stopped: boolean;
  /** One line per failure: a late refusal or rejection, or a close that rejected. */
  readonly problems: readonly string[];
}

/** What {@link settleLateStart} established about a start that outlived its boot timeout. */
export interface LateStartSettlement {
  /**
   * `true` when the start's shutdown was confirmed within the bounds (see
   * {@link LateStartFinish.stopped}): nothing it opened can still write into,
   * or listen from, the sandbox, so the sandbox may be removed now. `false`
   * when it may still be running — it has not settled, its close is pending,
   * or it settled without a confirmed shutdown: the sandbox must then be
   * retained, and {@link releaseAfterLateStart} removes it only if
   * {@link LateStartSettlement.finished} eventually confirms the shutdown.
   */
  readonly stopped: boolean;
  /**
   * One line per failure observed within the bounds: a late rejection or
   * refusal, a close that rejected, or the start or its close overrunning.
   */
  readonly problems: readonly string[];
  /**
   * Resolves, with no time bound, once the start has settled and any handle it
   * produced has finished closing. Never rejects; already resolved when the
   * start settled and closed within the bounds.
   */
  readonly finished: Promise<LateStartFinish>;
}

/** How a start that outlived its boot timeout ended. */
type LateStartOutcome =
  | { readonly kind: 'started'; readonly handle: ReleasableService }
  | { readonly kind: 'refused'; readonly error: DebuggenError }
  | { readonly kind: 'rejected'; readonly cause: unknown };

/**
 * Settles a `startService` call that did not resolve within its boot timeout,
 * so the caller removes the sandbox only once nothing that start opened can
 * still use it.
 *
 * Both a fulfilment and a rejection handler are attached to `starting` before
 * anything is awaited, and a rejecting `close()` is caught, so no late
 * rejection is ever unhandled, whenever it arrives. Then:
 *
 * - the start is given `graceMs` more to settle, and a handle it produces
 *   `closeTimeoutMs` to close; a refusal, or a close that resolved, is a
 *   confirmed shutdown — `stopped`;
 * - a start that rejected, or a handle whose close rejected, settled without a
 *   confirmed shutdown — not `stopped`, and its sandbox is never removed;
 * - a start (or close) that overruns is not waited for — not `stopped` — and
 *   {@link LateStartSettlement.finished} is the continuation to hang the
 *   sandbox's removal on: see {@link releaseAfterLateStart}.
 *
 * @returns The settlement. Never rejects.
 *
 * @example Releasing a sandbox after a start outlived its boot timeout
 * ```ts
 * const late = await settleLateStart(starting, {
 *   graceMs: HARNESS_TIMEOUTS.lateStart,
 *   closeTimeoutMs: HARNESS_TIMEOUTS.lateStartClose,
 * });
 * if (late.stopped) {
 *   await releaseHarnessResources({ clients: [], rawSockets: [], handle: undefined, directories });
 * } else {
 *   void releaseAfterLateStart(late, directories).then(reportDeferredRelease);
 * }
 * ```
 */
export async function settleLateStart(
  starting: Promise<Result<ReleasableService, DebuggenError>>,
  options: LateStartOptions,
): Promise<LateStartSettlement> {
  const outcome = starting.then(
    (late): LateStartOutcome =>
      isErr(late)
        ? { kind: 'refused', error: late.error }
        : { kind: 'started', handle: late.value },
    (cause: unknown): LateStartOutcome => ({ kind: 'rejected', cause }),
  );
  const finished: Promise<LateStartFinish> = outcome
    .then(async (late): Promise<LateStartFinish> => {
      if (late.kind === 'refused') {
        return lateStartFinish(true, [
          `startService refused to start after its boot timeout (${late.error.code}): ${late.error.message}`,
        ]);
      }
      if (late.kind === 'rejected') {
        return lateStartFinish(false, [
          `startService rejected after its boot timeout: ${describeCause(late.cause)}`,
        ]);
      }
      const handle = late.handle;
      try {
        await attemptClose(() => handle.close());
        return lateStartFinish(true, []);
      } catch (cause) {
        return lateStartFinish(false, [
          `the service that started after its boot timeout did not close: ${describeCause(cause)}`,
        ]);
      }
    })
    .catch((cause: unknown) =>
      lateStartFinish(false, [`settling the late start failed: ${describeCause(cause)}`]),
    );

  const settledInGrace = await withinDeadline(outcome, options.graceMs);
  if (!settledInGrace.done) {
    return Object.freeze({
      stopped: false,
      problems: Object.freeze([
        `startService had still not settled ${String(options.graceMs)} ms after its boot timeout`,
      ]),
      finished,
    });
  }
  const closedInTime = await withinDeadline(finished, options.closeTimeoutMs);
  if (!closedInTime.done) {
    return Object.freeze({
      stopped: false,
      problems: Object.freeze([
        `the service that started after its boot timeout did not close within ${String(options.closeTimeoutMs)} ms`,
      ]),
      finished,
    });
  }
  return Object.freeze({
    stopped: closedInTime.value.stopped,
    problems: closedInTime.value.problems,
    finished,
  });
}

/** A frozen {@link LateStartFinish}. */
function lateStartFinish(stopped: boolean, problems: readonly string[]): LateStartFinish {
  return Object.freeze({ stopped, problems: Object.freeze([...problems]) });
}

/**
 * The continuation of a late start {@link settleLateStart} could not confirm
 * stopped in time: waits, with no bound, for the start to finish and its
 * handle to close, and removes the directories retained for it only when that
 * shutdown is confirmed. A start that rejected, or a close that rejected,
 * leaves them in place, each reported as retained.
 *
 * @returns Every failure of the late start and of the removal, plus one
 *   `retained …` line per directory kept. Never rejects.
 */
export async function releaseAfterLateStart(
  settlement: LateStartSettlement,
  directories: readonly string[],
): Promise<HarnessStopReport> {
  const finish = await settlement.finished;
  if (!finish.stopped) {
    return stopReport([
      ...finish.problems,
      ...retainedLines(
        directories,
        'the late service start ended without a confirmed shutdown; remove it by hand once the process has exited',
      ),
    ]);
  }
  const removal = await releaseHarnessResources({
    clients: [],
    rawSockets: [],
    handle: undefined,
    directories,
  });
  return stopReport([...finish.problems, ...removal.problems]);
}

/** The `code` of the process warning a problematic deferred release is reported with. */
const DEFERRED_RELEASE_WARNING_CODE = 'DEBUGGEN_HARNESS_DEFERRED_RELEASE';

/**
 * Reports the outcome of a detached release — {@link releaseAfterLateStart},
 * or the {@link HarnessRelease.deferred} removal behind a pending service
 * close. Nothing awaits either continuation — the suite has already had its
 * report — so a process warning, which the worker prints to stderr, is the
 * channel that keeps a retained directory or an unclosed service visible.
 */
function reportDeferredRelease(report: HarnessStopReport): void {
  if (!report.clean) {
    process.emitWarning(
      `A deferred integration-harness release finished with problems:\n- ${report.problems.join('\n- ')}`,
      { code: DEFERRED_RELEASE_WARNING_CODE },
    );
  }
}

/** Hands a release's deferred removal, when there is one, to {@link reportDeferredRelease}. */
function watchDeferredRelease(release: HarnessRelease): void {
  if (release.deferred !== undefined) {
    void release.deferred.then(reportDeferredRelease);
  }
}

/* -------------------------------------------------------------------------------------------------
 * startHarness
 * ---------------------------------------------------------------------------------------------- */

/**
 * Boots the service in process through `startService` and returns every way a
 * suite talks to it.
 *
 * The environment record handed to `loadServiceConfig` and `startService` is
 * `DEBUGGEN_PROVIDER=deterministic`, `DEBUGGEN_HOME=<fresh mkdtemp>`,
 * `DEBUGGEN_HOST=127.0.0.1`, `DEBUGGEN_PORT=0` (an ephemeral port, never the
 * product default the Playwright projects occupy), `DEBUGGEN_LOG_LEVEL=debug`,
 * `DEBUGGEN_RETENTION_DAYS=30` and `DEBUGGEN_PROMPTS_DIR=<the committed prompts>`,
 * with {@link HarnessOptions.env} merged over it. Everything the service
 * persists — `sessions.sqlite`, `auth.json`, `backups/`, `index/` — lands in the
 * temporary home.
 *
 * Before resolving, the default fixture project is copied and an editor
 * connection announcing it is authenticated, so the next editor HTTP request is
 * already in scope. A boot that fails part-way releases everything it acquired
 * before rethrowing; when that release reports problems, the rethrown error
 * lists them and carries the original failure as its `cause`.
 *
 * A `startService` that outlives `HARNESS_TIMEOUTS.boot` is settled with
 * {@link settleLateStart} before anything is removed. Unless its shutdown is
 * confirmed within `HARNESS_TIMEOUTS.lateStart` (and its handle's close within
 * `HARNESS_TIMEOUTS.lateStartClose`), the temporary home and fixture copies are
 * retained — the error names them — and {@link releaseAfterLateStart} removes
 * them only once that shutdown is confirmed.
 *
 * Teardown ({@link Harness.stop}, and the release after a failed start) removes
 * the directories only after the service's `close()` resolved; a close that
 * rejects or overruns retains them and reports each one (see
 * {@link releaseHarnessResources}). The release of the last live harness also
 * removes the stand-in dev CLI, under the same rule (see
 * {@link standInDevServerCommand}).
 *
 * @throws Error When the configuration is refused, the service does not start
 * within `HARNESS_TIMEOUTS.boot`, or the editor connection is not accepted.
 */
export async function startHarness(options: HarnessOptions = {}): Promise<Harness> {
  const home = await mkdtemp(join(realpathSync(tmpdir()), HOME_TEMP_PREFIX));
  // Returned exactly once, by `releaseAll`, whichever path releases this harness.
  acquireStandInLease();
  let leaseReturned = false;
  const clients: HarnessWsClient[] = [];
  const rawSockets: HarnessRawSocket[] = [];
  const projects: FixtureProjectCopy[] = [];
  let handle: ServiceHandle | undefined;
  // What the boot-timeout path found before the failure reached the catch below.
  const startProblems: string[] = [];
  // Set once a still-running late start owns the directories: they are then
  // removed by its continuation, never by the catch below.
  let directoriesHandedOver = false;

  // Teardown, in the order the contract names: sockets, the service, then the
  // directories (only after a confirmed shutdown). Never rejects: every failure
  // becomes one line of the report, and a removal deferred behind a pending
  // service close is reported through `watchDeferredRelease` when it finishes.
  const releaseAll = async (keepDirectories = false): Promise<readonly string[]> => {
    // The lease is returned before anything is awaited, so a harness started
    // while this release is under way writes a fresh stand-in CLI. The
    // directory of the last lease joins the list even when this harness's own
    // are handed to a late start's continuation: that start never reached a
    // harness a suite could launch a stand-in dev server through.
    let standInRoot: string | undefined;
    if (!leaseReturned) {
      leaseReturned = true;
      standInRoot = releaseStandInLease();
    }
    const directories = keepDirectories ? [] : [...projects.map((copy) => copy.container), home];
    if (standInRoot !== undefined) {
      directories.push(standInRoot);
    }
    const release = await releaseHarnessResources({ clients, rawSockets, handle, directories });
    watchDeferredRelease(release);
    return release.problems;
  };

  try {
    const env = buildServiceEnv(home, options);
    const loaded = loadServiceConfig(env, options.overrides);
    if (isErr(loaded)) {
      throw new Error(
        `The harness configuration was refused (${loaded.error.code}): ${loaded.error.message}`,
        { cause: loaded.error },
      );
    }

    // The service's own logger factory — same level gate, scrubbing and
    // redaction as production — with only its destination replaced.
    const sink = createCapturingSink();
    const root = createServiceLogger(loaded.value, { destination: sink.destination });
    const logger: CapturedLogger = Object.freeze({
      root,
      records: sink.records,
      text: () => sink.records.map((record) => record.line).join('\n'),
      withMessage: (message: string) => sink.records.filter((record) => record.message === message),
      clear: () => {
        sink.records.length = 0;
      },
    });
    const harnessLogger = subsystemLogger(root, HARNESS_SUBSYSTEM);

    let clock: HarnessClock | undefined;
    let now: () => number;
    if (options.now === undefined) {
      clock = createHarnessClock();
      now = clock.now;
    } else {
      now = options.now;
    }

    if (options.fixtureProject !== false) {
      projects.push(await copyFixtureProject(options.fixtureProject ?? DEFAULT_FIXTURE_PROJECT));
    }
    const project = projects[0];

    const starting = startService({
      env,
      overrides: options.overrides,
      logger: root,
      now,
      provider: typeof options.provider === 'object' ? options.provider : undefined,
    });
    // A rejection within the boot window rejects here and is released below; a
    // start that outlives it is settled before anything it may use is removed.
    const booted = await withinDeadline(starting, HARNESS_TIMEOUTS.boot);
    if (!booted.done) {
      const bootTimeout = new Error(
        `startService did not resolve within ${String(HARNESS_TIMEOUTS.boot)} ms`,
      );
      const late = await settleLateStart(starting, {
        graceMs: HARNESS_TIMEOUTS.lateStart,
        closeTimeoutMs: HARNESS_TIMEOUTS.lateStartClose,
      });
      startProblems.push(...late.problems);
      if (late.stopped) {
        throw bootTimeout;
      }
      // The late start may still be opening the store in `home` or binding its
      // listener, or it ended without a confirmed shutdown: removing the
      // sandbox now could pull it out from under a service that still uses it.
      const retained = [...projects.map((copy) => copy.container), home];
      directoriesHandedOver = true;
      void releaseAfterLateStart(late, retained).then(reportDeferredRelease);
      throw new Error(
        `${bootTimeout.message}; its temporary directories are retained until its shutdown is confirmed: ${retained.join(', ')}`,
        { cause: bootTimeout },
      );
    }
    const started = booted.value;
    if (isErr(started)) {
      throw new Error(
        `startService refused to start (${started.error.code}): ${started.error.message}`,
        { cause: started.error },
      );
    }
    handle = started.value;
    const service = started.value;

    const resolvedWsUrl = resolveWsUrl(service.url);
    if (isErr(resolvedWsUrl)) {
      throw new Error(`The service URL has no WebSocket form: ${resolvedWsUrl.error.message}`);
    }
    const wsUrl = resolvedWsUrl.value;
    let editorToken = readEditorToken(service.config.authFilePath);

    const repos: HarnessRepos = Object.freeze({
      sessions: createSessionsRepo({ store: service.store, logger: harnessLogger, now }),
      telemetry: createTelemetryRepo({ store: service.store, logger: harnessLogger }),
      modifications: createModificationsRepo({ store: service.store, logger: harnessLogger, now }),
      panels: createPanelsRepo({ store: service.store, logger: harnessLogger, now }),
    });

    // The project each harness-created session acts on, so an editor-credential
    // call can first make sure a live editor connection announces it.
    const sessionProjects = new Map<string, string>();

    const wsContext: WsClientContext = {
      wsUrl,
      logger: harnessLogger,
      defaultToken: () => editorToken,
      register: (client) => {
        clients.push(client);
      },
    };

    const http = (
      token?: string | null,
      httpOptions?: { readonly origin?: string | undefined },
    ): HttpClient =>
      new HttpClient({
        baseUrl: service.url,
        token: token === undefined ? editorToken : (token ?? undefined),
        fetch: harnessFetch(httpOptions?.origin),
        logger: harnessLogger,
        defaultTimeoutMs: HARNESS_TIMEOUTS.request,
      });

    const callClient = (callOptions: HarnessCallOptions | undefined): HttpClient =>
      http(callOptions?.token, { origin: callOptions?.origin });

    const editor = async (projectRoot: string): Promise<HarnessWsClient> => {
      const live = clients.find(
        (client) =>
          client.identity.client === 'vscode' &&
          client.identity.projectRoot !== undefined &&
          isWithin(client.identity.projectRoot, projectRoot) &&
          client.authenticated,
      );
      if (live !== undefined) {
        return live;
      }
      const opened = await openWsClient(wsContext, { client: 'vscode', projectRoot });
      if (!opened.authenticated) {
        throw new Error(
          `The editor connection announcing ${projectRoot} was not accepted: ${opened.describe()}`,
        );
      }
      return opened;
    };

    const announceFor = async (
      sessionId: string,
      callOptions: HarnessCallOptions | undefined,
    ): Promise<void> => {
      const projectRoot = sessionProjects.get(sessionId);
      if (callOptions?.token === undefined && projectRoot !== undefined) {
        await editor(projectRoot);
      }
    };

    const issueDevtoolsCredential = (
      extensionId: string = newExtensionId(),
    ): DevtoolsCredential => {
      const issued = service.auth.issueDevtoolsCredential(extensionId);
      if (isErr(issued)) {
        throw new Error(
          `The DevTools credential was refused (${issued.error.code}): ${issued.error.message}`,
          { cause: issued.error },
        );
      }
      return Object.freeze({
        extensionId,
        origin: chromeExtensionOrigin(extensionId),
        token: issued.value.token,
        readProof: issued.value.readProof,
        expiresAt: issued.value.expiresAt,
      });
    };

    const rawFetch = async (
      target: RawFetchTarget,
      init: RawFetchInit = {},
    ): Promise<RawFetchResponse> => {
      const resolved = resolveRawTarget(target);
      const token =
        init.token === undefined
          ? resolved.authExempt
            ? undefined
            : editorToken
          : (init.token ?? undefined);
      const body = encodeRawBody(init.body);
      const headers: Record<string, string> = {};
      if (token !== undefined) {
        headers.authorization = `Bearer ${token}`;
      }
      if (init.origin !== undefined) {
        headers.origin = init.origin;
      }
      if (body !== undefined) {
        headers['content-type'] = 'application/json';
      }
      for (const [name, value] of Object.entries(init.headers ?? {})) {
        headers[name.toLowerCase()] = value;
      }
      const response = await fetch(new URL(resolved.path, service.url), {
        method: init.method ?? resolved.method,
        headers,
        ...(body === undefined ? {} : { body }),
        signal: AbortSignal.timeout(init.timeoutMs ?? HARNESS_TIMEOUTS.request),
      });
      const text = await response.text();
      let json: unknown;
      try {
        json = text.length === 0 ? undefined : JSON.parse(text);
      } catch {
        json = undefined;
      }
      return { status: response.status, headers: response.headers, text, json };
    };

    let stopping: Promise<HarnessStopReport> | undefined;
    const stop = (): Promise<HarnessStopReport> => {
      stopping ??= releaseAll().then(
        (problems) => Object.freeze({ clean: problems.length === 0, problems }),
        (cause: unknown) =>
          Object.freeze({ clean: false, problems: [`teardown failed: ${describeCause(cause)}`] }),
      );
      return stopping;
    };

    const harness: Harness = {
      url: service.url,
      port: service.port,
      wsUrl,
      home,
      config: service.config,
      env,
      service,
      auth: service.auth,
      store: service.store,
      repos,
      manager: service.manager,
      clock,
      now,
      logger,
      get editorToken(): string {
        return editorToken;
      },
      project,
      requireProject: () => {
        if (project === undefined) {
          throw new Error('This harness was started with fixtureProject: false.');
        }
        return project;
      },

      http,
      rawFetch,

      ws: (wsOptions) => openWsClient(wsContext, wsOptions),
      editor,
      connectDevtools: async (connectOptions) => {
        const credential = connectOptions.credential ?? issueDevtoolsCredential();
        const client = await openWsClient(wsContext, {
          client: 'devtools',
          tabId: connectOptions.tabId,
          token: credential.token,
          origin: credential.origin,
          timeoutMs: connectOptions.timeoutMs,
        });
        if (!client.authenticated) {
          throw new Error(`The DevTools connection was not accepted: ${client.describe()}`);
        }
        return { client, credential };
      },
      rawSocket: (rawOptions = {}) => {
        const raw = openRawSocket(wsUrl, rawOptions);
        rawSockets.push(raw);
        return raw;
      },

      issueDevtoolsCredential,
      issueServerAgentCredential: (projectRoot, expiresAt) => {
        const issued = service.auth.issueServerAgentCredential({ projectRoot, expiresAt });
        if (isErr(issued)) {
          throw new Error(
            `The server-agent credential was refused (${issued.error.code}): ${issued.error.message}`,
            { cause: issued.error },
          );
        }
        return issued.value;
      },
      startPairing: () => {
        const pairing = service.auth.startPairing();
        if (isErr(pairing)) {
          throw new Error(
            `Pairing could not start (${pairing.error.code}): ${pairing.error.message}`,
            { cause: pairing.error },
          );
        }
        return pairing.value;
      },
      pairDevtools: async (extensionId = newExtensionId()) => {
        const started = await http().request('pair.start', { body: {} });
        if (isErr(started)) {
          throw new Error(
            `pair.start was refused (${started.error.code}): ${started.error.message}`,
            { cause: started.error },
          );
        }
        const origin = chromeExtensionOrigin(extensionId);
        const completed = await http(null, { origin }).pairComplete(started.value.code);
        if (isErr(completed)) {
          throw new Error(
            `pair.complete was refused (${completed.error.code}): ${completed.error.message}`,
            { cause: completed.error },
          );
        }
        return Object.freeze({
          extensionId,
          origin,
          token: completed.value.token,
          readProof: completed.value.readProof,
        });
      },
      rotateAll: () => {
        const rotated = service.auth.rotateAll();
        if (isErr(rotated)) {
          throw new Error(`Rotation failed (${rotated.error.code}): ${rotated.error.message}`, {
            cause: rotated.error,
          });
        }
        editorToken = readEditorToken(service.config.authFilePath);
        return rotated.value;
      },
      refreshEditorToken: () => {
        editorToken = readEditorToken(service.config.authFilePath);
        return editorToken;
      },

      launchDevServer: async (projectRoot, launchOptions) => {
        if (launchOptions?.token === undefined) {
          await editor(projectRoot);
        }
        return callClient(launchOptions).request('devServer.launch', {
          body: { projectRoot, command: launchOptions?.command ?? standInDevServerCommand() },
          timeoutMs: launchOptions?.timeoutMs,
        });
      },
      createSession: async (body, callOptions) => {
        if (callOptions?.token === undefined) {
          await editor(body.projectRoot);
        }
        const created = await callClient(callOptions).request('session.create', {
          body,
          timeoutMs: callOptions?.timeoutMs,
        });
        if (isErr(created)) {
          throw new Error(
            `session.create was refused (${created.error.code}): ${created.error.message}`,
            { cause: created.error },
          );
        }
        sessionProjects.set(created.value.id, created.value.projectRoot);
        return created.value;
      },
      waitForSession: async (sessionId, predicate, callOptions) => {
        await announceFor(sessionId, callOptions);
        const client = callClient(callOptions);
        const timeoutMs = callOptions?.timeoutMs ?? HARNESS_TIMEOUTS.pipeline;
        let last: SessionRecord | undefined;
        try {
          return await waitUntil(
            async () => {
              const fetched = await client.request('session.get', {
                params: { id: sessionId },
                tabId: callOptions?.tabId,
                readProof: callOptions?.readProof,
              });
              if (isErr(fetched)) {
                throw new Error(
                  `session.get was refused (${fetched.error.code}): ${fetched.error.message}`,
                  { cause: fetched.error },
                );
              }
              last = fetched.value;
              return predicate(fetched.value) ? fetched.value : undefined;
            },
            `session ${sessionId} satisfies the predicate`,
            timeoutMs,
            50,
          );
        } catch (cause) {
          if (last === undefined) {
            throw cause;
          }
          throw new Error(
            `${describeCause(cause)} The last record seen had status "${last.status}".`,
            { cause },
          );
        }
      },
      bindTab: (client, payload, timeoutMs = HARNESS_TIMEOUTS.message) => {
        const mark = client.received.length;
        const receipt = client.send('session.bind', payload);
        if (isErr(receipt.result)) {
          return Promise.reject(
            new Error(`session.bind could not be sent: ${receipt.result.error.message}`),
          );
        }
        return client.until<Result<HarnessMessage<'session.bound'>, ErrorPayload>>(
          () => {
            const refusal = client.errorsFor(receipt.id)[0];
            if (refusal !== undefined) {
              return err(refusal);
            }
            for (const [index, message] of client.received.entries()) {
              if (
                index >= mark &&
                isMessageOfType(message, 'session.bound') &&
                message.payload.tabId === payload.tabId
              ) {
                return ok(message);
              }
            }
            return undefined;
          },
          timeoutMs,
          () =>
            `No session.bound for tab ${String(payload.tabId)} within ${String(timeoutMs)} ms: ${client.describe()}`,
        );
      },
      ingestFromAgent: async (client, events) => {
        const receipt = client.send('telemetry.event', { events: [...events] });
        const settled = isErr(receipt.result) ? false : await client.flush();
        return {
          id: receipt.id,
          sent: receipt.result,
          settled,
          errors: client.errorsFor(receipt.id),
        };
      },
      ingestFromServerAgent: (ingest) =>
        http(ingest.token, { origin: ingest.origin }).request('telemetry.event', {
          body: { projectRoot: ingest.projectRoot, events: [...ingest.events] },
        }),
      startCapture: async (sessionId, callOptions) => {
        await announceFor(sessionId, callOptions);
        return callClient(callOptions).request('capture.start', {
          params: { id: sessionId },
          body: {},
          timeoutMs: callOptions?.timeoutMs,
          tabId: callOptions?.tabId,
        });
      },
      stopCapture: async (sessionId, callOptions) => {
        await announceFor(sessionId, callOptions);
        return callClient(callOptions).request('capture.stop', {
          params: { id: sessionId },
          body: {},
          timeoutMs: callOptions?.timeoutMs,
          tabId: callOptions?.tabId,
        });
      },
      endSession: async (sessionId, callOptions) => {
        await announceFor(sessionId, callOptions);
        return callClient(callOptions).request('session.end', {
          params: { id: sessionId },
          body: {},
          timeoutMs: callOptions?.timeoutMs,
          tabId: callOptions?.tabId,
        });
      },

      copyFixtureProject: async (name = DEFAULT_FIXTURE_PROJECT) => {
        const copy = await copyFixtureProject(name);
        projects.push(copy);
        return copy;
      },
      stop,
      assertNoLeaks: async () => {
        const report = await stop();
        const problems = [...report.problems];
        const refused = await probeListener(
          service.host,
          service.port,
          HARNESS_TIMEOUTS.socketClose,
        );
        if (!refused) {
          problems.push(
            `the service still accepts connections on ${service.host}:${String(service.port)}`,
          );
        }
        if (problems.length > 0) {
          throw new Error(`The harness leaked:\n- ${problems.join('\n- ')}`);
        }
      },
    };

    if (project !== undefined) {
      await editor(project.root);
    }
    return harness;
  } catch (cause) {
    const problems = [...startProblems, ...(await releaseAll(directoriesHandedOver))];
    if (problems.length === 0) {
      throw cause;
    }
    throw new Error(
      `${describeCause(cause)}\nReleasing what the failed start had acquired reported:\n- ${problems.join('\n- ')}`,
      { cause },
    );
  }
}
