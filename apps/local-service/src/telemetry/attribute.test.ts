/**
 * Colocated tests for `./attribute.ts`: the **attribution decision table** of
 * telemetry ingest.
 *
 * What is on trial is the gate itself, in isolation — which session and which
 * capture window a batch belongs to, or why it belongs to none:
 *
 * 1. **Browser origin.** A relayed batch belongs to the session its tab is
 *    bound to, and only while that session has an open capture window — and,
 *    when the batch names the capture its agent was armed for, only if that is
 *    the open one (`stale-capture`: a late batch is refused, never relabelled).
 * 2. **Server origin and credential scope (AAP §0.5.6).** A preload batch
 *    belongs to the capture owner of the project its credential is scoped to,
 *    and the project the body names must be *exactly* that project after POSIX
 *    normalisation — never a subtree, never a prefix-sharing sibling. When the
 *    body names the capture its spans were recorded in, that must be the
 *    owner's open capture (`stale-capture` again), on both owner lookups.
 * 3. **Per-event stamping.** Identity is added, nothing else changes, the input
 *    is never touched, `ingestSeq` is left to the store, and the tier gate keeps
 *    a page from reporting server or database spans (and a dev server from
 *    reporting browser ones). The one time test, `pre-capture`, drops the
 *    page's replayed `navigation` and `paint` entries that ended before the
 *    capture's recorded start — and nothing else, on no other kind or tier.
 * 4. **Failure discipline and privacy.** No input throws or rejects, every
 *    refusal is an `Err` carrying a closed-vocabulary code and a closed-
 *    vocabulary reason, and no rejected value — an event name, an attribute, a
 *    URL, a project path, a store error's text — reaches an error or a log line.
 *
 * Deliberately **not** covered here: redaction before persistence and the
 * end-to-end ingest path against a real store. Those belong to
 * `apps/local-service/test/integration/telemetry-ingest.test.ts`; repeating them
 * would make two suites fail for one defect.
 *
 * ## Fixture conventions
 *
 * The two collaborators are driven through the narrow structural ports the
 * module declares (`SessionsRepoLike`, `SessionManagerLike`), implemented here
 * as in-file fakes that **record every call**, so a case can assert what the
 * gate asked as well as what it answered. Nothing opens a database, a socket or
 * a server, nothing is module-mocked, and the clock is injected: the
 * `local-service` Vitest project is hermetic by contract.
 *
 * Every name is invented and generic (`/tmp/project-one`, `operation`): nothing
 * here names a component, symbol or route of any real project, the same rule the
 * product source lives under (AAP §0.5.4). Identifiers come from
 * `@debuggen/shared`'s minting functions, tiers and kinds from
 * `@debuggen/telemetry`'s vocabularies, and error codes are checked against
 * `DEBUGGEN_ERROR_CODES` rather than restated.
 */

import { describe, expect, it } from 'vitest';

import {
  DEBUGGEN_ERROR_CODES,
  DebuggenError,
  err,
  isErr,
  isOk,
  newCaptureId,
  newEventId,
  newProducerId,
  newSessionId,
  newSpanId,
  newTraceId,
  ok,
} from '@debuggen/shared';
import type {
  CaptureId,
  LogFields,
  LogLevel,
  Logger,
  ProducerId,
  Result,
  SessionId,
} from '@debuggen/shared';
import {
  TELEMETRY_KINDS,
  TELEMETRY_TIERS,
  allowedTiersFor,
  parseTelemetryEvent,
  parseTelemetryEventIngress,
} from '@debuggen/telemetry';
import type { TelemetryEventIngress, TelemetryKind, TelemetryTier } from '@debuggen/telemetry';

import {
  ATTRIBUTION_DROP_DETAIL_KEY,
  ATTRIBUTION_SUBSYSTEM,
  DROP_REASONS,
  DROP_REASON_ERROR_CODES,
  INGEST_ORIGINS,
  TIER_BY_ORIGIN,
  attributionDropReason,
  createIngestAttributor,
  isDropReason,
} from './attribute.js';
import type {
  ActiveCaptureLike,
  AttributedEvent,
  AttributionOutcome,
  BindingLike,
  CaptureOwnerLike,
  CapturingSessionsQuery,
  DropReason,
  IngestAttribution,
  IngestAttributor,
  IngestContext,
  IngestOrigin,
  ListedSessionLike,
  SessionLike,
  SessionManagerLike,
  SessionPageLike,
  SessionsRepoLike,
} from './attribute.js';

/* -------------------------------------------------------------------------------------------------
 * Fixture constants
 * ---------------------------------------------------------------------------------------------- */

/** The injected clock's only reading: no case depends on wall time. */
const FIXED_NOW = 1_700_000_000_000;

/** The clock every attributor in this file is built with. */
const fixedClock = (): number => FIXED_NOW;

/**
 * The epoch millisecond event start times are offset from: inside the window
 * the ingress schema accepts, and fixed rather than read from a clock.
 */
const BASE_TIME = 1_768_000_000_000;

/** The project most cases work in. Invented, and outside any real checkout. */
const PROJECT_ONE = '/tmp/project-one';

/** A second, unrelated project. */
const PROJECT_TWO = '/tmp/project-two';

/** The inspected tab most browser cases are relayed for. */
const TAB_ID = 7;

/** The producer id the contexts announce unless a case is about a mismatch. */
const PRODUCER: ProducerId = newProducerId();

/**
 * The segments of the privacy sentinel, joined at run time.
 *
 * Assembled rather than written as one literal so the privacy assertions can
 * look for **each part** of it — a truncated or partially quoted value is still
 * a leak — and so the repository's secret scanner never sees a token-shaped
 * literal in this file.
 */
const SENTINEL_SEGMENTS: readonly string[] = ['marrowfen', 'quillbright', 'thistledown'];

/** The value that must never reach a log record or an error payload. */
const SENTINEL = `${SENTINEL_SEGMENTS.join('-')}-must-not-leak`;

/* -------------------------------------------------------------------------------------------------
 * Reason bookkeeping
 * ---------------------------------------------------------------------------------------------- */

/**
 * Every drop reason a case in this file produced, batch-level and per-event.
 * The last block asserts it is contained in the closed `DROP_REASONS` tuple.
 */
const observedReasons = new Set<string>();

/* -------------------------------------------------------------------------------------------------
 * Recording logger
 * ---------------------------------------------------------------------------------------------- */

/** One line a logger received, with its child bindings merged in. */
interface RecordedLine {
  readonly level: LogLevel;
  readonly message: string;
  readonly fields: LogFields;
}

/** A logger that records instead of writing, plus views of what it recorded. */
interface LogCapture {
  readonly logger: Logger;
  readonly lines: RecordedLine[];
  /** Every recorded line as one searchable string. */
  text(): string;
}

/**
 * A `Logger` that records every line, merging child bindings exactly as a real
 * child logger does. Reads no clock, so the recording is deterministic.
 */
function recordingLogger(): LogCapture {
  const lines: RecordedLine[] = [];

  const make = (bindings: LogFields): Logger => {
    const write =
      (level: LogLevel) =>
      (message: string, fields?: LogFields): void => {
        lines.push({ level, message, fields: { ...bindings, ...(fields ?? {}) } });
      };

    return {
      level: 'trace',
      trace: write('trace'),
      debug: write('debug'),
      info: write('info'),
      warn: write('warn'),
      error: write('error'),
      fatal: write('fatal'),
      child: (more: LogFields): Logger => make({ ...bindings, ...more }),
    };
  };

  return { logger: make({}), lines, text: () => JSON.stringify(lines) };
}

/** A logger every method of which throws: logging must never decide anything. */
function throwingLogger(): Logger {
  const fail = (): never => {
    throw new Error('logger unavailable');
  };
  const logger: Logger = {
    level: 'trace',
    trace: fail,
    debug: fail,
    info: fail,
    warn: fail,
    error: fail,
    fatal: fail,
    child: (): Logger => logger,
  };
  return logger;
}

/* -------------------------------------------------------------------------------------------------
 * Fake ports
 * ---------------------------------------------------------------------------------------------- */

/** Every call the fake repository received, per method, in call order. */
interface RepoCalls {
  readonly getBindingByTab: number[];
  readonly get: SessionId[];
  readonly getActiveCapture: SessionId[];
  readonly list: CapturingSessionsQuery[];
}

/** What a fake repository is built from; every behaviour can be overridden. */
interface FakeRepoSpec {
  /** Tab → session bindings. */
  readonly bindings?: readonly (readonly [number, SessionId])[];
  /** Session records by id. */
  readonly sessions?: readonly SessionLike[];
  /** Session → open capture windows. */
  readonly activeCaptures?: readonly (readonly [SessionId, CaptureId])[];
  /** The sessions the fallback's `list` pages through (all of them capturing). */
  readonly listed?: readonly ListedSessionLike[];
  /** `false` omits `list` entirely, as a repository without it would. */
  readonly withList?: boolean;
  readonly getBindingByTab?: (tabId: number) => Result<BindingLike | undefined>;
  readonly get?: (id: SessionId) => Result<SessionLike | undefined>;
  readonly getActiveCapture?: (sessionId: SessionId) => Result<ActiveCaptureLike | undefined>;
  readonly list?: (query: CapturingSessionsQuery) => Result<SessionPageLike>;
}

/** A fake repository and the calls it recorded. */
interface FakeRepo extends SessionsRepoLike {
  readonly calls: RepoCalls;
}

/**
 * A `SessionsRepoLike` over in-memory tables, answering `ok(undefined)` for a
 * missing row exactly as the real repository does, and recording every call.
 */
function fakeRepo(spec: FakeRepoSpec = {}): FakeRepo {
  const calls: RepoCalls = { getBindingByTab: [], get: [], getActiveCapture: [], list: [] };
  const bindings = new Map<number, SessionId>(spec.bindings ?? []);
  const records = new Map<SessionId, SessionLike>(
    (spec.sessions ?? []).map((record) => [record.id, record] as const),
  );
  const captures = new Map<SessionId, CaptureId>(spec.activeCaptures ?? []);
  const listed = spec.listed ?? [];

  const list = (query: CapturingSessionsQuery): Result<SessionPageLike> => {
    calls.list.push(query);
    if (spec.list !== undefined) {
      return spec.list(query);
    }
    return ok({
      items: listed.slice(query.offset, query.offset + query.limit),
      total: listed.length,
    });
  };

  return {
    calls,
    getBindingByTab: (tabId: number): Result<BindingLike | undefined> => {
      calls.getBindingByTab.push(tabId);
      if (spec.getBindingByTab !== undefined) {
        return spec.getBindingByTab(tabId);
      }
      const sessionId = bindings.get(tabId);
      return ok(sessionId === undefined ? undefined : { sessionId });
    },
    get: (id: SessionId): Result<SessionLike | undefined> => {
      calls.get.push(id);
      if (spec.get !== undefined) {
        return spec.get(id);
      }
      return ok(records.get(id));
    },
    getActiveCapture: (sessionId: SessionId): Result<ActiveCaptureLike | undefined> => {
      calls.getActiveCapture.push(sessionId);
      if (spec.getActiveCapture !== undefined) {
        return spec.getActiveCapture(sessionId);
      }
      const captureId = captures.get(sessionId);
      return ok(captureId === undefined ? undefined : { capture: { id: captureId } });
    },
    ...(spec.withList === false ? {} : { list }),
  };
}

/** A fake session manager and the project roots it was asked about. */
interface FakeManager extends SessionManagerLike {
  readonly calls: string[];
}

/**
 * A `SessionManagerLike` answering from `answer`, recording every project root
 * it was asked about — which is how a case proves the gate asked with the
 * normalised key, or did not ask at all.
 */
function fakeManager(answer: (projectRoot: string) => CaptureOwnerLike | undefined): FakeManager {
  const calls: string[] = [];
  return {
    calls,
    captureOwnerForProject: (projectRoot: string): CaptureOwnerLike | undefined => {
      calls.push(projectRoot);
      return answer(projectRoot);
    },
  };
}

/* -------------------------------------------------------------------------------------------------
 * Event fixtures
 * ---------------------------------------------------------------------------------------------- */

/** A per-file counter, so every fixture carries a distinct `seq` and start time. */
let fixtureOrdinal = 0;

/**
 * The first kind of the imported vocabulary that may be reported in `tier`, so
 * a fixture is always a legal kind/tier pair without restating the table.
 */
function kindFor(tier: TelemetryTier): TelemetryKind {
  const kind = TELEMETRY_KINDS.find((candidate) => allowedTiersFor(candidate).includes(tier));
  if (kind === undefined) {
    return expect.unreachable(`no kind may be reported in the ${tier} tier`);
  }
  return kind;
}

/**
 * A valid {@link TelemetryEventIngress}: fresh hex trace and span ids, an epoch
 * millisecond start time **with a fractional part**, a fractional duration, a
 * legal kind for the tier, and none of the three fields only the service may
 * set (`sessionId`, `captureId`, `ingestSeq`).
 *
 * @param overrides Fields to replace; `kind` follows `tier` unless given.
 */
function makeIngress(overrides: Partial<TelemetryEventIngress> = {}): TelemetryEventIngress {
  fixtureOrdinal += 1;
  const tier = overrides.tier ?? 'browser';

  return {
    id: newEventId(),
    traceId: newTraceId(),
    spanId: newSpanId(),
    kind: kindFor(tier),
    name: 'operation',
    startTime: BASE_TIME + fixtureOrdinal + 0.123_456_789,
    duration: 12.625,
    tier,
    attributes: {},
    status: 'ok',
    producerId: PRODUCER,
    seq: fixtureOrdinal,
    ...overrides,
  };
}

/**
 * An ingress event with every optional field populated — `parentSpanId`, a
 * nested `attributes` record, `source` and `redacted` — for the fidelity cases.
 */
function richIngress(tier: TelemetryTier = 'browser'): TelemetryEventIngress {
  return makeIngress({
    tier,
    parentSpanId: newSpanId(),
    name: 'operation with detail',
    startTime: BASE_TIME + 0.000_137,
    duration: 0.004_2,
    attributes: {
      'http.method': 'POST',
      'http.status_code': 201,
      nested: { depth: 2, flags: [true, false], label: 'inner' },
      empty: null,
    },
    status: 'error',
    seq: 0,
    source: {
      file: 'src/module/handler.ts',
      line: 42,
      column: 7,
      symbol: 'handleOperation',
      resolvedBy: 'code-graph',
      confidence: 0.75,
    },
    redacted: ['attributes.http.url'],
  });
}

/**
 * An object that reads like an event but whose `tier` getter throws — what a
 * value that bypassed validation, or a hostile proxy, would look like.
 */
function eventWithThrowingGetter(): TelemetryEventIngress {
  const base: Record<string, unknown> = { ...makeIngress() };
  Reflect.deleteProperty(base, 'tier');
  Object.defineProperty(base, 'tier', {
    enumerable: true,
    get(): never {
      throw new Error(`unreadable ${SENTINEL}`);
    },
  });
  return base as unknown as TelemetryEventIngress;
}

/** Freezes `value` and everything reachable from it, so a write would throw. */
function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Reflect.ownKeys(value)) {
      deepFreeze((value as Record<PropertyKey, unknown>)[key]);
    }
  }
  return value;
}

/* -------------------------------------------------------------------------------------------------
 * Result helpers
 * ---------------------------------------------------------------------------------------------- */

/**
 * Asserts `result` is an attribution drop for `reason` and returns its error.
 *
 * Every drop is checked against the drop contract as a whole: a real
 * `DebuggenError`, a code from the closed shared vocabulary, the drop marker,
 * and `reason` readable both directly and through `attributionDropReason`.
 */
function expectDrop(
  result: Result<IngestAttribution, DebuggenError>,
  reason: DropReason,
): DebuggenError {
  if (isOk(result)) {
    return expect.unreachable(`expected a ${reason} drop, got an attribution`);
  }
  expect(isErr(result)).toBe(true);

  const error = result.error;

  expect(DebuggenError.is(error)).toBe(true);
  expect(DEBUGGEN_ERROR_CODES).toContain(error.code);
  expect(error.details?.[ATTRIBUTION_DROP_DETAIL_KEY]).toBe(true);
  expect(error.details?.['reason']).toBe(reason);
  expect(attributionDropReason(error)).toBe(reason);
  observedReasons.add(reason);

  return error;
}

/** Asserts `result` resolved and returns the attribution. */
function expectResolved(result: Result<IngestAttribution, DebuggenError>): IngestAttribution {
  if (isErr(result)) {
    return expect.unreachable(
      `expected an attribution, got a drop: ${String(attributionDropReason(result.error))}`,
    );
  }
  expect(isOk(result)).toBe(true);
  return result.value;
}

/** Asserts `outcome` attributed its event and returns the stamped event. */
function expectAttributed(outcome: AttributionOutcome): AttributedEvent {
  if (outcome.kind !== 'attributed') {
    return expect.unreachable(`expected an attributed event, got a ${outcome.reason} drop`);
  }
  return outcome.event;
}

/** Asserts `outcome` dropped its event for `reason`. */
function expectEventDrop(outcome: AttributionOutcome, reason: DropReason): void {
  expect(outcome).toStrictEqual({ kind: 'dropped', reason });
  observedReasons.add(reason);
}

/**
 * Everything an error carries to a user interface or a log line — message,
 * hint, the wire payload and the details — as one searchable string.
 */
function errorText(error: DebuggenError): string {
  return JSON.stringify({
    message: error.message,
    hint: error.hint ?? null,
    payload: error.toPayload(),
    details: error.details ?? null,
  });
}

/** Asserts no segment of the sentinel appears in `text`. */
function expectNoSentinel(text: string): void {
  for (const segment of SENTINEL_SEGMENTS) {
    expect(text).not.toContain(segment);
  }
}

/* -------------------------------------------------------------------------------------------------
 * Worlds: a repository, a manager and an attributor wired together
 * ---------------------------------------------------------------------------------------------- */

/** One browser-origin scenario. */
interface BrowserWorld {
  readonly sessionId: SessionId;
  readonly captureId: CaptureId;
  readonly repo: FakeRepo;
  readonly log: LogCapture;
  readonly attributor: IngestAttributor;
}

/**
 * A browser-origin scenario: tab {@link TAB_ID} bound to a session of
 * {@link PROJECT_ONE} with an open capture — each fact removable.
 */
function browserWorld(
  shape: {
    readonly bound?: boolean;
    readonly sessionExists?: boolean;
    readonly captureOpen?: boolean;
    readonly projectRoot?: string;
  } = {},
): BrowserWorld {
  const sessionId = newSessionId();
  const captureId = newCaptureId();
  const repo = fakeRepo({
    bindings: shape.bound === false ? [] : [[TAB_ID, sessionId]],
    sessions:
      shape.sessionExists === false
        ? []
        : [{ id: sessionId, projectRoot: shape.projectRoot ?? PROJECT_ONE }],
    activeCaptures: shape.captureOpen === false ? [] : [[sessionId, captureId]],
  });
  const log = recordingLogger();
  const attributor = createIngestAttributor({
    sessions: repo,
    logger: log.logger,
    now: fixedClock,
  });

  return { sessionId, captureId, repo, log, attributor };
}

/** The browser context of tab {@link TAB_ID}. */
function browserContext(overrides: { readonly tabId?: number; readonly url?: string } = {}) {
  return {
    origin: 'browser-agent',
    tabId: overrides.tabId ?? TAB_ID,
    documentId: 'doc-one',
    producerId: PRODUCER,
    url: overrides.url ?? 'http://127.0.0.1:3000/page',
  } as const satisfies IngestContext;
}

/** One server-origin scenario. */
interface ServerWorld {
  readonly sessionId: SessionId;
  readonly captureId: CaptureId;
  readonly repo: FakeRepo;
  readonly manager: FakeManager;
  readonly log: LogCapture;
  readonly attributor: IngestAttributor;
}

/**
 * A server-origin scenario over a session manager: {@link PROJECT_ONE}'s
 * capture is owned by one session whose capture row is, depending on `owner`,
 * open (`'open'`), absent from the manager (`'none'`), closed in the store
 * (`'closed'`) or replaced by another capture (`'changed'`).
 */
function serverWorld(owner: 'open' | 'none' | 'closed' | 'changed' = 'open'): ServerWorld {
  const sessionId = newSessionId();
  const captureId = newCaptureId();
  const storeCapture =
    owner === 'closed' ? undefined : owner === 'changed' ? newCaptureId() : captureId;
  const repo = fakeRepo({
    sessions: [{ id: sessionId, projectRoot: PROJECT_ONE }],
    activeCaptures: storeCapture === undefined ? [] : [[sessionId, storeCapture]],
  });
  const manager = fakeManager((projectRoot) =>
    owner !== 'none' && projectRoot === PROJECT_ONE ? { sessionId, captureId } : undefined,
  );
  const log = recordingLogger();
  const attributor = createIngestAttributor({
    sessions: repo,
    sessionManager: manager,
    logger: log.logger,
    now: fixedClock,
  });

  return { sessionId, captureId, repo, manager, log, attributor };
}

/** The server context of a preload for `projectRoot`, scoped to `scopedProjectRoot`. */
function serverContext(projectRoot: string, scopedProjectRoot: string = PROJECT_ONE) {
  return {
    origin: 'server-agent',
    projectRoot,
    scopedProjectRoot,
    producerId: PRODUCER,
  } as const satisfies IngestContext;
}

/** A browser attribution as `resolveBatch` would produce it. */
function browserAttribution(overrides: Partial<IngestAttribution> = {}): IngestAttribution {
  return {
    sessionId: newSessionId(),
    captureId: newCaptureId(),
    origin: 'browser-agent',
    tabId: TAB_ID,
    projectRoot: PROJECT_ONE,
    producerId: PRODUCER,
    resolvedAt: FIXED_NOW,
    ...overrides,
  };
}

/** A server attribution as `resolveBatch` would produce it. */
function serverAttribution(overrides: Partial<IngestAttribution> = {}): IngestAttribution {
  return {
    sessionId: newSessionId(),
    captureId: newCaptureId(),
    origin: 'server-agent',
    projectRoot: PROJECT_ONE,
    producerId: PRODUCER,
    resolvedAt: FIXED_NOW,
    ...overrides,
  };
}

/** An attributor over an empty repository, for the pure per-event cases. */
function bareAttributor(logger?: Logger): IngestAttributor {
  return createIngestAttributor({
    sessions: fakeRepo(),
    ...(logger === undefined ? {} : { logger }),
    now: fixedClock,
  });
}

/* -------------------------------------------------------------------------------------------------
 * The harness itself
 * ---------------------------------------------------------------------------------------------- */

describe('test harness', () => {
  it('builds ingress fixtures the strict ingress schema accepts, without service-owned fields', () => {
    for (const tier of TELEMETRY_TIERS) {
      for (const event of [makeIngress({ tier }), richIngress(tier)]) {
        expect(isOk(parseTelemetryEventIngress(event))).toBe(true);
        expect('sessionId' in event).toBe(false);
        expect('captureId' in event).toBe(false);
        expect('ingestSeq' in event).toBe(false);
        expect(Number.isInteger(event.startTime)).toBe(false);
      }
    }
  });

  it('answers a missing row with ok(undefined) and records every call', () => {
    const repo = fakeRepo();

    expect(repo.getBindingByTab(TAB_ID)).toStrictEqual(ok(undefined));
    expect(repo.calls.getBindingByTab).toStrictEqual([TAB_ID]);
  });
});

/* -------------------------------------------------------------------------------------------------
 * resolveBatch — browser origin
 * ---------------------------------------------------------------------------------------------- */

describe('resolveBatch: browser origin', () => {
  it('attributes a bound tab to its session and that session’s open capture', async () => {
    const world = browserWorld();

    const attribution = expectResolved(await world.attributor.resolveBatch(browserContext()));

    expect(attribution).toStrictEqual({
      sessionId: world.sessionId,
      captureId: world.captureId,
      origin: 'browser-agent',
      tabId: TAB_ID,
      projectRoot: PROJECT_ONE,
      producerId: PRODUCER,
      resolvedAt: FIXED_NOW,
    });
    // What was asked, in order: the tab's binding, the bound session, its capture.
    expect(world.repo.calls.getBindingByTab).toStrictEqual([TAB_ID]);
    expect(world.repo.calls.get).toStrictEqual([world.sessionId]);
    expect(world.repo.calls.getActiveCapture).toStrictEqual([world.sessionId]);
    // The server-origin fallback is never consulted for a browser batch.
    expect(world.repo.calls.list).toStrictEqual([]);
  });

  it('reports the bound session’s project root in normalised form', async () => {
    const world = browserWorld({ projectRoot: '/tmp/./project-one/' });

    const attribution = expectResolved(await world.attributor.resolveBatch(browserContext()));

    expect(attribution.projectRoot).toBe(PROJECT_ONE);
  });

  it('drops a batch from a tab bound to no session as no-binding', async () => {
    const world = browserWorld({ bound: false });

    const error = expectDrop(await world.attributor.resolveBatch(browserContext()), 'no-binding');

    expect(error.code).toBe(DROP_REASON_ERROR_CODES['no-binding']);
    expect(error.details?.['origin']).toBe('browser-agent');
    expect(error.details?.['tabId']).toBe(TAB_ID);
    // Nothing past the missing binding is read.
    expect(world.repo.calls.get).toStrictEqual([]);
    expect(world.repo.calls.getActiveCapture).toStrictEqual([]);
  });

  it('drops a batch whose bound session no longer exists as session-missing', async () => {
    const world = browserWorld({ sessionExists: false });

    const error = expectDrop(
      await world.attributor.resolveBatch(browserContext()),
      'session-missing',
    );

    expect(error.code).toBe(DROP_REASON_ERROR_CODES['session-missing']);
    expect(error.details?.['sessionId']).toBe(world.sessionId);
    expect(world.repo.calls.get).toStrictEqual([world.sessionId]);
    expect(world.repo.calls.getActiveCapture).toStrictEqual([]);
  });

  it('drops a batch whose store row answers for a different session id as session-missing', async () => {
    const sessionId = newSessionId();
    const repo = fakeRepo({
      bindings: [[TAB_ID, sessionId]],
      get: () => ok({ id: newSessionId(), projectRoot: PROJECT_ONE }),
      activeCaptures: [[sessionId, newCaptureId()]],
    });
    const attributor = createIngestAttributor({ sessions: repo, now: fixedClock });

    const error = expectDrop(await attributor.resolveBatch(browserContext()), 'session-missing');

    expect(error.code).toBe('STORE_ERROR');
    expect(repo.calls.getActiveCapture).toStrictEqual([]);
  });

  // The load-bearing case: outside a capture window nothing may be stored,
  // whatever else is true (AAP §0.7.1 Group 2).
  it('drops a bound tab’s batch while its session has no open capture as no-active-capture', async () => {
    const world = browserWorld({ captureOpen: false });

    const error = expectDrop(
      await world.attributor.resolveBatch(browserContext()),
      'no-active-capture',
    );

    expect(error.code).toBe(DROP_REASON_ERROR_CODES['no-active-capture']);
    // The capture window was actually consulted — the refusal is a finding,
    // not a short-circuit.
    expect(world.repo.calls.getActiveCapture).toStrictEqual([world.sessionId]);
    // Nothing was attributed: the error names the session but no capture, and
    // no "resolved" line was logged.
    expect(error.details?.['sessionId']).toBe(world.sessionId);
    expect(error.details).not.toHaveProperty('captureId');
    expect(world.log.lines.map((line) => line.message)).not.toContain('telemetry batch resolved');
  });

  it('drops a batch whose capture row carries no usable id as no-active-capture', async () => {
    const sessionId = newSessionId();
    const repo = fakeRepo({
      bindings: [[TAB_ID, sessionId]],
      sessions: [{ id: sessionId, projectRoot: PROJECT_ONE }],
      getActiveCapture: () => ok({ capture: { id: '' } }),
    });
    const attributor = createIngestAttributor({ sessions: repo, now: fixedClock });

    const error = expectDrop(await attributor.resolveBatch(browserContext()), 'no-active-capture');

    expect(error.code).toBe('STORE_ERROR');
  });

  it('reports a failed store read under the store’s own code, still as a drop', async () => {
    const repo = fakeRepo({
      getBindingByTab: () => err(new DebuggenError('STORE_ERROR', 'database is locked')),
    });
    const attributor = createIngestAttributor({ sessions: repo, now: fixedClock });

    const error = expectDrop(await attributor.resolveBatch(browserContext()), 'no-binding');

    expect(error.code).toBe('STORE_ERROR');
    expect(error.details?.['fault']).toBe('store-read-failed');
  });

  it('reports a throwing store read as INTERNAL, still as a drop', async () => {
    const sessionId = newSessionId();
    const repo = fakeRepo({
      bindings: [[TAB_ID, sessionId]],
      sessions: [{ id: sessionId, projectRoot: PROJECT_ONE }],
      getActiveCapture: () => {
        throw new Error('driver crashed');
      },
    });
    const attributor = createIngestAttributor({ sessions: repo, now: fixedClock });

    const error = expectDrop(await attributor.resolveBatch(browserContext()), 'no-active-capture');

    expect(error.code).toBe('INTERNAL');
    expect(error.details?.['fault']).toBe('dependency-threw');
  });
});

/* -------------------------------------------------------------------------------------------------
 * resolveBatch — the producer's capture identity (stale-capture)
 * ---------------------------------------------------------------------------------------------- */

describe('resolveBatch: the producer’s armed capture', () => {
  /**
   * A browser world whose open capture can be replaced mid-case, the way a
   * Stop followed by a Start replaces it: `open` is read on every
   * `getActiveCapture` call, so a batch resolved after `open = next` sees the
   * new window.
   */
  function rearmableWorld(): {
    readonly sessionId: SessionId;
    readonly first: CaptureId;
    readonly second: CaptureId;
    readonly setOpen: (captureId: CaptureId | undefined) => void;
    readonly log: LogCapture;
    readonly attributor: IngestAttributor;
  } {
    const sessionId = newSessionId();
    const first = newCaptureId();
    const second = newCaptureId();
    let open: CaptureId | undefined = first;
    const repo = fakeRepo({
      bindings: [[TAB_ID, sessionId]],
      sessions: [{ id: sessionId, projectRoot: PROJECT_ONE }],
      getActiveCapture: () => ok(open === undefined ? undefined : { capture: { id: open } }),
    });
    const log = recordingLogger();
    const attributor = createIngestAttributor({
      sessions: repo,
      logger: log.logger,
      now: fixedClock,
    });

    return {
      sessionId,
      first,
      second,
      setOpen: (captureId) => {
        open = captureId;
      },
      log,
      attributor,
    };
  }

  it('attributes a batch naming the open capture exactly as one that names none', async () => {
    const world = browserWorld();

    const named = expectResolved(
      await world.attributor.resolveBatch({
        ...browserContext(),
        armedCaptureId: world.captureId,
      }),
    );
    const unnamed = expectResolved(await world.attributor.resolveBatch(browserContext()));
    const explicitlyAbsent = expectResolved(
      await world.attributor.resolveBatch({ ...browserContext(), armedCaptureId: undefined }),
    );

    // Naming the open capture adds nothing to the attribution: the identity
    // still comes from the binding and the store's open capture row.
    expect(named).toStrictEqual(unnamed);
    expect(explicitlyAbsent).toStrictEqual(unnamed);
    expect(named.captureId).toBe(world.captureId);
    expect(expectAttributed(world.attributor.attributeEvent(makeIngress(), named)).captureId).toBe(
      world.captureId,
    );
  });

  // The defect this reason exists for: a batch recorded during capture A that
  // arrives after B opened must never be filed under B.
  it('refuses a batch recorded for the previous capture after the next one opened, whole', async () => {
    const world = rearmableWorld();

    // While A is open, A's batch is A's.
    const during = expectResolved(
      await world.attributor.resolveBatch({ ...browserContext(), armedCaptureId: world.first }),
    );
    expect(during.captureId).toBe(world.first);

    // Stop A, start B: A's late batch is refused, B's own batch is B's.
    world.setOpen(world.second);
    const late = expectDrop(
      await world.attributor.resolveBatch({ ...browserContext(), armedCaptureId: world.first }),
      'stale-capture',
    );
    const current = expectResolved(
      await world.attributor.resolveBatch({ ...browserContext(), armedCaptureId: world.second }),
    );

    expect(current.captureId).toBe(world.second);
    expect(late.code).toBe(DROP_REASON_ERROR_CODES['stale-capture']);
    expect(late.code).toBe('SESSION_INVALID_STATE');
    expect(late.details).toMatchObject({
      origin: 'browser-agent',
      tabId: TAB_ID,
      sessionId: world.sessionId,
      // The refusal names the capture it protected — never the one the page named.
      captureId: world.second,
    });
    expect(late.details).not.toHaveProperty('fault');
    expect(errorText(late)).not.toContain(world.first);

    // Logged once, at warn — evidence this capture is missing — and only ever
    // under the open capture's binding.
    const dropped = world.log.lines.filter((line) => line.message === 'telemetry batch dropped');
    expect(dropped).toHaveLength(1);
    expect(dropped[0]?.level).toBe('warn');
    expect(dropped[0]?.fields).toMatchObject({
      reason: 'stale-capture',
      code: 'SESSION_INVALID_STATE',
      tabId: TAB_ID,
    });
    expect(dropped[0]?.fields['captureId']).toBe(world.second);
    expect(JSON.stringify(dropped)).not.toContain(world.first);
    // Two batches resolved (A during A, B during B); the late one did not.
    expect(
      world.log.lines.filter((line) => line.message === 'telemetry batch resolved'),
    ).toHaveLength(2);
  });

  it('refuses a batch naming any capture other than the open one, before anything is attributed', async () => {
    const world = browserWorld();

    const error = expectDrop(
      await world.attributor.resolveBatch({ ...browserContext(), armedCaptureId: newCaptureId() }),
      'stale-capture',
    );

    expect(error.details?.['captureId']).toBe(world.captureId);
    // The store was read exactly as for any batch: binding, session, capture.
    expect(world.repo.calls.getBindingByTab).toStrictEqual([TAB_ID]);
    expect(world.repo.calls.get).toStrictEqual([world.sessionId]);
    expect(world.repo.calls.getActiveCapture).toStrictEqual([world.sessionId]);
    expect(world.log.lines.map((line) => line.message)).not.toContain('telemetry batch resolved');
  });

  it('answers a named capture while none is open as no-active-capture, the routine boundary flush', async () => {
    const world = rearmableWorld();
    world.setOpen(undefined);

    const error = expectDrop(
      await world.attributor.resolveBatch({ ...browserContext(), armedCaptureId: world.first }),
      'no-active-capture',
    );

    expect(error.code).toBe(DROP_REASON_ERROR_CODES['no-active-capture']);
    expect(error.details).not.toHaveProperty('captureId');
    const dropped = world.log.lines.filter((line) => line.message === 'telemetry batch dropped');
    expect(dropped.map((line) => line.level)).toStrictEqual(['debug']);
    expect(dropped[0]?.fields['reason']).toBe('no-active-capture');
  });

  it('refuses a malformed armed capture as stale-capture with its fault, never attributing it', async () => {
    for (const malformed of ['', 42, null, { id: 'capture' }]) {
      const world = browserWorld();

      const error = expectDrop(
        await world.attributor.resolveBatch({
          ...browserContext(),
          armedCaptureId: malformed as unknown as CaptureId,
        }),
        'stale-capture',
      );

      expect(error.code).toBe('SESSION_INVALID_STATE');
      expect(error.details?.['fault']).toBe('invalid-armed-capture');
      expect(error.details?.['captureId']).toBe(world.captureId);
    }
  });

  it('never echoes the page-supplied capture name, the URL or the document id into the refusal', async () => {
    const world = browserWorld();

    const error = expectDrop(
      await world.attributor.resolveBatch({
        ...browserContext({ url: `http://127.0.0.1:3000/${SENTINEL}?q=${SENTINEL}` }),
        documentId: SENTINEL,
        armedCaptureId: SENTINEL,
      }),
      'stale-capture',
    );

    expectNoSentinel(error.message);
    expectNoSentinel(error.hint ?? '');
    expectNoSentinel(JSON.stringify(error.toPayload()));
    expectNoSentinel(errorText(error));
    expectNoSentinel(world.log.text());
    expect(world.log.text()).not.toContain('127.0.0.1');
    // The refusal's own words name no identifier at all.
    expect(error.message).not.toContain(world.captureId);
    expect(error.hint ?? '').not.toContain(world.captureId);
  });
});

/* -------------------------------------------------------------------------------------------------
 * resolveBatch — server origin and credential scope (AAP §0.5.6)
 * ---------------------------------------------------------------------------------------------- */

describe('resolveBatch: server origin and credential scope', () => {
  it('attributes a batch for exactly the credential’s project to its capture owner', async () => {
    const world = serverWorld();

    const attribution = expectResolved(
      await world.attributor.resolveBatch(serverContext(PROJECT_ONE)),
    );

    expect(attribution).toStrictEqual({
      sessionId: world.sessionId,
      captureId: world.captureId,
      origin: 'server-agent',
      projectRoot: PROJECT_ONE,
      producerId: PRODUCER,
      resolvedAt: FIXED_NOW,
    });
    // The owner is asked about the normalised project once, and its capture is
    // confirmed against the store's open capture row.
    expect(world.manager.calls).toStrictEqual([PROJECT_ONE]);
    expect(world.repo.calls.getActiveCapture).toStrictEqual([world.sessionId]);
    // No tab binding is involved in a server batch.
    expect(world.repo.calls.getBindingByTab).toStrictEqual([]);
  });

  it.each([
    ['a trailing slash', '/tmp/project-one/'],
    ['a ./ segment', '/tmp/./project-one'],
    ['backslash separators', '\\tmp\\project-one'],
    ['mixed separators and a trailing backslash', '/tmp\\project-one\\'],
    ['a resolved .. segment', '/tmp/elsewhere/../project-one'],
  ])(
    'treats a request root with %s as the same project after POSIX normalisation',
    async (_label, requested) => {
      const world = serverWorld();

      const attribution = expectResolved(
        await world.attributor.resolveBatch(serverContext(requested)),
      );

      expect(attribution.sessionId).toBe(world.sessionId);
      expect(attribution.projectRoot).toBe(PROJECT_ONE);
      expect(world.manager.calls).toStrictEqual([PROJECT_ONE]);
    },
  );

  it('normalises the credential’s scope the same way', async () => {
    const world = serverWorld();

    const attribution = expectResolved(
      await world.attributor.resolveBatch(serverContext(PROJECT_ONE, '/tmp/project-one/')),
    );

    expect(attribution.projectRoot).toBe(PROJECT_ONE);
    expect(world.manager.calls).toStrictEqual([PROJECT_ONE]);
  });

  it('drops a batch naming a different project as project-scope-mismatch', async () => {
    const world = serverWorld();

    const error = expectDrop(
      await world.attributor.resolveBatch(serverContext(PROJECT_TWO)),
      'project-scope-mismatch',
    );

    expect(error.code).toBe(DROP_REASON_ERROR_CODES['project-scope-mismatch']);
    expect(error.details?.['mismatch']).toBe('different-project');
    // An out-of-scope batch never reaches the owner lookup or the store.
    expect(world.manager.calls).toStrictEqual([]);
    expect(world.repo.calls.getActiveCapture).toStrictEqual([]);
  });

  // AAP §0.5.6: a server-agent credential is scoped to exactly one project
  // root. A directory beneath it — a workspace package, a nested app — is a
  // different project the credential was never issued for, so containment is
  // not authorisation and a descendant is refused like any unrelated path.
  it('drops a batch naming a descendant of the credential’s project as project-scope-mismatch', async () => {
    const world = serverWorld();

    const error = expectDrop(
      await world.attributor.resolveBatch(serverContext('/tmp/project-one/packages/app')),
      'project-scope-mismatch',
    );

    expect(error.details?.['mismatch']).toBe('descendant-of-scope');
    expect(world.manager.calls).toStrictEqual([]);
  });

  it('drops a batch naming an ancestor of the credential’s project as project-scope-mismatch', async () => {
    const world = serverWorld();

    const error = expectDrop(
      await world.attributor.resolveBatch(serverContext('/tmp')),
      'project-scope-mismatch',
    );

    expect(error.details?.['mismatch']).toBe('ancestor-of-scope');
    expect(world.manager.calls).toStrictEqual([]);
  });

  it('never accepts a sibling that merely shares the project’s path prefix', async () => {
    const world = serverWorld();

    const error = expectDrop(
      await world.attributor.resolveBatch(serverContext('/tmp/project-one-evil')),
      'project-scope-mismatch',
    );

    expect(error.details?.['mismatch']).toBe('different-project');
    expect(world.manager.calls).toStrictEqual([]);
  });

  it('never names either compared path in a scope refusal', async () => {
    const world = serverWorld();

    const error = expectDrop(
      await world.attributor.resolveBatch(serverContext(PROJECT_TWO)),
      'project-scope-mismatch',
    );

    expect(errorText(error)).not.toContain('project-one');
    expect(errorText(error)).not.toContain('project-two');
    expect(world.log.text()).not.toContain('project-one');
    expect(world.log.text()).not.toContain('project-two');
  });

  it('drops a batch for a project nobody is capturing as no-active-capture', async () => {
    const world = serverWorld('none');

    const error = expectDrop(
      await world.attributor.resolveBatch(serverContext(PROJECT_ONE)),
      'no-active-capture',
    );

    expect(error.code).toBe(DROP_REASON_ERROR_CODES['no-active-capture']);
    expect(world.manager.calls).toStrictEqual([PROJECT_ONE]);
    // With no owner there is no capture row to confirm.
    expect(world.repo.calls.getActiveCapture).toStrictEqual([]);
  });

  it('drops a batch whose named owner has no open capture row as capture-owner-mismatch', async () => {
    const world = serverWorld('closed');

    const error = expectDrop(
      await world.attributor.resolveBatch(serverContext(PROJECT_ONE)),
      'capture-owner-mismatch',
    );

    expect(error.code).toBe(DROP_REASON_ERROR_CODES['capture-owner-mismatch']);
    expect(error.details?.['owningSessionId']).toBe(world.sessionId);
    expect(world.repo.calls.getActiveCapture).toStrictEqual([world.sessionId]);
  });

  it('drops a batch whose owner’s open capture is not the one the manager named as capture-owner-mismatch', async () => {
    const world = serverWorld('changed');

    const error = expectDrop(
      await world.attributor.resolveBatch(serverContext(PROJECT_ONE)),
      'capture-owner-mismatch',
    );

    expect(error.details?.['owningSessionId']).toBe(world.sessionId);
  });

  it('drops a batch whose owner cannot be loaded from the store as capture-owner-mismatch', async () => {
    const sessionId = newSessionId();
    const repo = fakeRepo({
      getActiveCapture: () => err(new DebuggenError('STORE_ERROR', 'disk I/O error')),
    });
    const manager = fakeManager(() => ({ sessionId, captureId: newCaptureId() }));
    const attributor = createIngestAttributor({
      sessions: repo,
      sessionManager: manager,
      now: fixedClock,
    });

    const error = expectDrop(
      await attributor.resolveBatch(serverContext(PROJECT_ONE)),
      'capture-owner-mismatch',
    );

    expect(error.code).toBe('STORE_ERROR');
    expect(repo.calls.getActiveCapture).toStrictEqual([sessionId]);
  });

  it('drops a batch whose manager names a malformed owner as capture-owner-mismatch', async () => {
    const repo = fakeRepo();
    const manager = fakeManager(() => ({ sessionId: '', captureId: '' }));
    const attributor = createIngestAttributor({
      sessions: repo,
      sessionManager: manager,
      now: fixedClock,
    });

    expectDrop(await attributor.resolveBatch(serverContext(PROJECT_ONE)), 'capture-owner-mismatch');
    expect(repo.calls.getActiveCapture).toStrictEqual([]);
  });

  it('drops a batch whose manager throws as capture-owner-mismatch, under INTERNAL', async () => {
    const manager = fakeManager(() => {
      throw new Error('owner index unavailable');
    });
    const attributor = createIngestAttributor({
      sessions: fakeRepo(),
      sessionManager: manager,
      now: fixedClock,
    });

    const error = expectDrop(
      await attributor.resolveBatch(serverContext(PROJECT_ONE)),
      'capture-owner-mismatch',
    );

    expect(error.code).toBe('INTERNAL');
  });
});

/* -------------------------------------------------------------------------------------------------
 * resolveBatch — server origin without a session manager (the repository fallback)
 * ---------------------------------------------------------------------------------------------- */

describe('resolveBatch: repository fallback when no session manager is injected', () => {
  it('finds the single capturing session of the project and confirms its open capture', async () => {
    const owner = newSessionId();
    const other = newSessionId();
    const captureId = newCaptureId();
    const repo = fakeRepo({
      listed: [
        { id: other, projectRoot: PROJECT_TWO },
        { id: owner, projectRoot: '/tmp/project-one/' },
      ],
      activeCaptures: [
        [owner, captureId],
        [other, newCaptureId()],
      ],
    });
    const attributor = createIngestAttributor({ sessions: repo, now: fixedClock });

    const attribution = expectResolved(await attributor.resolveBatch(serverContext(PROJECT_ONE)));

    expect(attribution).toStrictEqual({
      sessionId: owner,
      captureId,
      origin: 'server-agent',
      projectRoot: PROJECT_ONE,
      producerId: PRODUCER,
      resolvedAt: FIXED_NOW,
    });

    // One page of capturing sessions was asked for, from the start.
    const [query, ...rest] = repo.calls.list;
    expect(rest).toStrictEqual([]);
    expect(query?.statuses).toStrictEqual(['capturing']);
    expect(query?.offset).toBe(0);
    expect(query?.limit).toBeGreaterThan(0);
    // Only the candidate on this project was confirmed against the store.
    expect(repo.calls.getActiveCapture).toStrictEqual([owner]);
  });

  it('pages through the session list until it is exhausted', async () => {
    const owner = newSessionId();
    const captureId = newCaptureId();
    const unrelated: ListedSessionLike[] = Array.from({ length: 150 }, (_, index) => ({
      id: newSessionId(),
      projectRoot: `/tmp/unrelated-${String(index)}`,
    }));
    const repo = fakeRepo({
      listed: [...unrelated, { id: owner, projectRoot: PROJECT_ONE }],
      activeCaptures: [[owner, captureId]],
    });
    const attributor = createIngestAttributor({ sessions: repo, now: fixedClock });

    const attribution = expectResolved(await attributor.resolveBatch(serverContext(PROJECT_ONE)));

    expect(attribution.sessionId).toBe(owner);
    expect(attribution.captureId).toBe(captureId);

    const offsets = repo.calls.list.map((query) => query.offset);
    expect(offsets.length).toBeGreaterThan(1);
    expect(offsets[0]).toBe(0);
    // Each page starts where the previous one ended.
    for (let index = 1; index < offsets.length; index += 1) {
      const previous = repo.calls.list[index - 1];
      expect(offsets[index]).toBe((previous?.offset ?? 0) + (previous?.limit ?? 0));
    }
  });

  it('drops the batch as no-active-capture when no capturing session of the project has an open capture', async () => {
    const candidate = newSessionId();
    const repo = fakeRepo({ listed: [{ id: candidate, projectRoot: PROJECT_ONE }] });
    const attributor = createIngestAttributor({ sessions: repo, now: fixedClock });

    expectDrop(await attributor.resolveBatch(serverContext(PROJECT_ONE)), 'no-active-capture');
    expect(repo.calls.getActiveCapture).toStrictEqual([candidate]);
  });

  it('refuses to guess between two sessions capturing one project (capture-owner-mismatch)', async () => {
    const first = newSessionId();
    const second = newSessionId();
    const log = recordingLogger();
    const repo = fakeRepo({
      listed: [
        { id: first, projectRoot: PROJECT_ONE },
        { id: second, projectRoot: '/tmp/project-one/' },
      ],
      activeCaptures: [
        [first, newCaptureId()],
        [second, newCaptureId()],
      ],
    });
    const attributor = createIngestAttributor({
      sessions: repo,
      logger: log.logger,
      now: fixedClock,
    });

    const error = expectDrop(
      await attributor.resolveBatch(serverContext(PROJECT_ONE)),
      'capture-owner-mismatch',
    );

    expect(error.details).not.toHaveProperty('sessionId');
    // The exclusivity violation (AAP §0.4.2) is surfaced loudly.
    expect(log.lines.some((line) => line.level === 'error')).toBe(true);
  });

  it('drops the batch as no-active-capture when the repository cannot list sessions', async () => {
    const repo = fakeRepo({ withList: false });
    const attributor = createIngestAttributor({ sessions: repo, now: fixedClock });

    expect('list' in repo).toBe(false);
    expectDrop(await attributor.resolveBatch(serverContext(PROJECT_ONE)), 'no-active-capture');
    expect(repo.calls.getActiveCapture).toStrictEqual([]);
  });

  it('drops the batch as capture-owner-mismatch when the session list cannot be read', async () => {
    const repo = fakeRepo({
      list: () => err(new DebuggenError('STORE_ERROR', 'no such table')),
    });
    const attributor = createIngestAttributor({ sessions: repo, now: fixedClock });

    const error = expectDrop(
      await attributor.resolveBatch(serverContext(PROJECT_ONE)),
      'capture-owner-mismatch',
    );

    expect(error.code).toBe('STORE_ERROR');
  });

  it('applies the credential scope before any fallback read', async () => {
    const repo = fakeRepo({ listed: [{ id: newSessionId(), projectRoot: PROJECT_ONE }] });
    const attributor = createIngestAttributor({ sessions: repo, now: fixedClock });

    expectDrop(
      await attributor.resolveBatch(serverContext('/tmp/project-one/packages/app')),
      'project-scope-mismatch',
    );
    expect(repo.calls.list).toStrictEqual([]);
  });
});

/* -------------------------------------------------------------------------------------------------
 * resolveBatch — the preload's capture identity (stale-capture), on both owner lookups
 * ---------------------------------------------------------------------------------------------- */

describe('resolveBatch: the preload’s armed capture', () => {
  /** Which owner lookup a case runs through: the session manager, or the repository fallback. */
  type OwnerPath = 'manager' | 'repository';

  /** Both owner lookups, so every case below runs once through each. */
  const OWNER_PATHS: readonly OwnerPath[] = ['manager', 'repository'];

  /** A server world whose open capture can be replaced mid-case. */
  interface RearmableServerWorld {
    readonly sessionId: SessionId;
    readonly first: CaptureId;
    readonly second: CaptureId;
    readonly repo: FakeRepo;
    /** The session manager on the manager path; `undefined` on the repository fallback. */
    readonly manager: FakeManager | undefined;
    readonly setOpen: (captureId: CaptureId | undefined) => void;
    readonly log: LogCapture;
    readonly attributor: IngestAttributor;
  }

  /**
   * One session capturing {@link PROJECT_ONE}, whose open capture is `first`
   * until a case replaces it, the way a Stop followed by a Start does. On the
   * manager path the owner index follows the store's capture row, as the real
   * manager's does; on the repository path the session is the one capturing
   * session the fallback lists.
   */
  function rearmableServerWorld(path: OwnerPath): RearmableServerWorld {
    const sessionId = newSessionId();
    const first = newCaptureId();
    const second = newCaptureId();
    let open: CaptureId | undefined = first;
    const repo = fakeRepo({
      sessions: [{ id: sessionId, projectRoot: PROJECT_ONE }],
      listed: [{ id: sessionId, projectRoot: PROJECT_ONE }],
      getActiveCapture: (id) =>
        ok(id === sessionId && open !== undefined ? { capture: { id: open } } : undefined),
    });
    const manager =
      path === 'manager'
        ? fakeManager((projectRoot) =>
            projectRoot === PROJECT_ONE && open !== undefined
              ? { sessionId, captureId: open }
              : undefined,
          )
        : undefined;
    const log = recordingLogger();
    const attributor = createIngestAttributor({
      sessions: repo,
      ...(manager === undefined ? {} : { sessionManager: manager }),
      logger: log.logger,
      now: fixedClock,
    });

    return {
      sessionId,
      first,
      second,
      repo,
      manager,
      setOpen: (captureId) => {
        open = captureId;
      },
      log,
      attributor,
    };
  }

  /** The server context of a preload for `projectRoot` that names `armedCaptureId`. */
  function armedServerContext(armedCaptureId: CaptureId, projectRoot: string = PROJECT_ONE) {
    return { ...serverContext(projectRoot), armedCaptureId } as const satisfies IngestContext;
  }

  /** Asserts the owner was looked up exactly once, the way an attributed batch looks it up. */
  function expectOneOwnerLookup(world: RearmableServerWorld): void {
    if (world.manager === undefined) {
      expect(world.repo.calls.list).toHaveLength(1);
    } else {
      expect(world.manager.calls).toStrictEqual([PROJECT_ONE]);
      expect(world.repo.calls.list).toStrictEqual([]);
    }
    expect(world.repo.calls.getActiveCapture).toStrictEqual([world.sessionId]);
  }

  it.each(OWNER_PATHS)(
    'attributes a batch naming the open capture exactly as one that names none (%s lookup)',
    async (path) => {
      const world = rearmableServerWorld(path);

      const named = expectResolved(
        await world.attributor.resolveBatch(armedServerContext(world.first)),
      );
      const unnamed = expectResolved(
        await world.attributor.resolveBatch(serverContext(PROJECT_ONE)),
      );
      const explicitlyAbsent = expectResolved(
        await world.attributor.resolveBatch({
          ...serverContext(PROJECT_ONE),
          armedCaptureId: undefined,
        }),
      );

      // Naming the open capture adds nothing: the identity still comes from the
      // credential's project, its capture owner and the store's open row.
      expect(named).toStrictEqual({
        sessionId: world.sessionId,
        captureId: world.first,
        origin: 'server-agent',
        projectRoot: PROJECT_ONE,
        producerId: PRODUCER,
        resolvedAt: FIXED_NOW,
      });
      expect(unnamed).toStrictEqual(named);
      expect(explicitlyAbsent).toStrictEqual(named);
      expect(
        expectAttributed(world.attributor.attributeEvent(makeIngress({ tier: 'server' }), named))
          .captureId,
      ).toBe(world.first);
    },
  );

  // The defect this check exists for on the server tier: a POST of capture A's
  // spans, retried in place after Stop and Start, must never be filed under B.
  it.each(OWNER_PATHS)(
    'refuses a batch recorded for the previous capture after the next one opened, whole (%s lookup)',
    async (path) => {
      const world = rearmableServerWorld(path);

      const during = expectResolved(
        await world.attributor.resolveBatch(armedServerContext(world.first)),
      );
      expect(during.captureId).toBe(world.first);

      world.setOpen(world.second);
      const late = expectDrop(
        await world.attributor.resolveBatch(armedServerContext(world.first)),
        'stale-capture',
      );
      const current = expectResolved(
        await world.attributor.resolveBatch(armedServerContext(world.second)),
      );

      expect(current.captureId).toBe(world.second);
      expect(late.code).toBe(DROP_REASON_ERROR_CODES['stale-capture']);
      expect(late.code).toBe('SESSION_INVALID_STATE');
      expect(late.details).toMatchObject({
        origin: 'server-agent',
        sessionId: world.sessionId,
        // The refusal names the capture it protected — never the one the body named.
        captureId: world.second,
      });
      expect(late.details).not.toHaveProperty('fault');
      expect(late.details).not.toHaveProperty('tabId');
      expect(errorText(late)).not.toContain(world.first);

      // Logged once, at warn, under the open capture's binding only.
      const dropped = world.log.lines.filter((line) => line.message === 'telemetry batch dropped');
      expect(dropped).toHaveLength(1);
      expect(dropped[0]?.level).toBe('warn');
      expect(dropped[0]?.fields).toMatchObject({
        reason: 'stale-capture',
        code: 'SESSION_INVALID_STATE',
        origin: 'server-agent',
      });
      expect(dropped[0]?.fields['sessionId']).toBe(world.sessionId);
      expect(dropped[0]?.fields['captureId']).toBe(world.second);
      expect(JSON.stringify(dropped)).not.toContain(world.first);
      expect(
        world.log.lines.filter((line) => line.message === 'telemetry batch resolved'),
      ).toHaveLength(2);
    },
  );

  it.each(OWNER_PATHS)(
    'refuses a batch naming any capture other than the open one after the usual owner lookup (%s lookup)',
    async (path) => {
      const world = rearmableServerWorld(path);

      const error = expectDrop(
        await world.attributor.resolveBatch(armedServerContext(newCaptureId())),
        'stale-capture',
      );

      expect(error.details?.['captureId']).toBe(world.first);
      expect(error.details?.['sessionId']).toBe(world.sessionId);
      // The owner was found and confirmed exactly as for an attributed batch.
      expectOneOwnerLookup(world);
      expect(world.log.lines.map((line) => line.message)).not.toContain('telemetry batch resolved');
    },
  );

  it.each(OWNER_PATHS)(
    'refuses a malformed armed capture as stale-capture with its fault, never attributing it (%s lookup)',
    async (path) => {
      for (const malformed of ['', 42, null, { id: 'capture' }]) {
        const world = rearmableServerWorld(path);

        const error = expectDrop(
          await world.attributor.resolveBatch(
            armedServerContext(malformed as unknown as CaptureId),
          ),
          'stale-capture',
        );

        expect(error.code).toBe('SESSION_INVALID_STATE');
        expect(error.details?.['fault']).toBe('invalid-armed-capture');
        expect(error.details?.['captureId']).toBe(world.first);
        expect(error.details?.['sessionId']).toBe(world.sessionId);
      }
    },
  );

  it.each(OWNER_PATHS)(
    'never echoes the producer-supplied capture name or the project path into the refusal (%s lookup)',
    async (path) => {
      const world = rearmableServerWorld(path);

      const error = expectDrop(
        await world.attributor.resolveBatch(armedServerContext(SENTINEL)),
        'stale-capture',
      );

      expectNoSentinel(error.message);
      expectNoSentinel(error.hint ?? '');
      expectNoSentinel(JSON.stringify(error.toPayload()));
      expectNoSentinel(errorText(error));
      expectNoSentinel(world.log.text());
      expect(errorText(error)).not.toContain('project-one');
      expect(world.log.text()).not.toContain('project-one');
      // The refusal's own words name no identifier at all.
      expect(error.message).not.toContain(world.first);
      expect(error.hint ?? '').not.toContain(world.first);
    },
  );

  it.each(OWNER_PATHS)(
    'answers a named capture while none is open as no-active-capture, the routine boundary flush (%s lookup)',
    async (path) => {
      const world = rearmableServerWorld(path);
      world.setOpen(undefined);

      for (const named of [world.first, SENTINEL]) {
        const error = expectDrop(
          await world.attributor.resolveBatch(armedServerContext(named)),
          'no-active-capture',
        );

        expect(error.code).toBe(DROP_REASON_ERROR_CODES['no-active-capture']);
        expect(error.details).not.toHaveProperty('captureId');
        expect(error.details).not.toHaveProperty('fault');
      }

      const dropped = world.log.lines.filter((line) => line.message === 'telemetry batch dropped');
      expect(dropped.map((line) => line.level)).toStrictEqual(['debug', 'debug']);
      expectNoSentinel(world.log.text());
    },
  );

  it('keeps an unconfirmed owner a capture-owner-mismatch whatever the batch names (manager lookup)', async () => {
    for (const owner of ['closed', 'changed'] as const) {
      const world = serverWorld(owner);

      for (const named of [world.captureId, newCaptureId()]) {
        const error = expectDrop(
          await world.attributor.resolveBatch({
            ...serverContext(PROJECT_ONE),
            armedCaptureId: named,
          }),
          'capture-owner-mismatch',
        );

        expect(error.details?.['owningSessionId']).toBe(world.sessionId);
        expect(error.details).not.toHaveProperty('captureId');
      }
    }
  });

  it('keeps two capturing owners a capture-owner-mismatch whatever the batch names (repository lookup)', async () => {
    const first = newSessionId();
    const second = newSessionId();
    const firstCapture = newCaptureId();
    const repo = fakeRepo({
      listed: [
        { id: first, projectRoot: PROJECT_ONE },
        { id: second, projectRoot: PROJECT_ONE },
      ],
      activeCaptures: [
        [first, firstCapture],
        [second, newCaptureId()],
      ],
    });
    const attributor = createIngestAttributor({ sessions: repo, now: fixedClock });

    for (const named of [firstCapture, newCaptureId()]) {
      const error = expectDrop(
        await attributor.resolveBatch({ ...serverContext(PROJECT_ONE), armedCaptureId: named }),
        'capture-owner-mismatch',
      );

      expect(error.details?.['fault']).toBe('ambiguous-owner');
    }
  });

  it.each(OWNER_PATHS)(
    'applies the credential scope before the owner lookup and before the capture comparison (%s lookup)',
    async (path) => {
      const world = rearmableServerWorld(path);

      for (const projectRoot of [PROJECT_TWO, '/tmp/project-one/packages/app']) {
        const error = expectDrop(
          await world.attributor.resolveBatch(armedServerContext(newCaptureId(), projectRoot)),
          'project-scope-mismatch',
        );

        expect(error.code).toBe(DROP_REASON_ERROR_CODES['project-scope-mismatch']);
        expect(error.details).not.toHaveProperty('captureId');
      }

      // Neither owner lookup was consulted for an out-of-scope batch.
      expect(world.manager?.calls ?? []).toStrictEqual([]);
      expect(world.repo.calls.list).toStrictEqual([]);
      expect(world.repo.calls.getActiveCapture).toStrictEqual([]);
    },
  );
});

/* -------------------------------------------------------------------------------------------------
 * attributeEvent — stamping and fidelity
 * ---------------------------------------------------------------------------------------------- */

describe('attributeEvent: stamping and fidelity', () => {
  it('stamps exactly the attribution’s sessionId and captureId', () => {
    const attribution = browserAttribution();

    const event = expectAttributed(bareAttributor().attributeEvent(makeIngress(), attribution));

    expect(event.sessionId).toBe(attribution.sessionId);
    expect(event.captureId).toBe(attribution.captureId);
  });

  // The store assigns the arrival order: telemetry_events.ingest_seq INTEGER
  // PRIMARY KEY AUTOINCREMENT, returned by TelemetryRepo.insertMany. An
  // attributed event must therefore carry no ingestSeq key at all — not even
  // one holding undefined — or it would pre-empt the store's value.
  it('adds no ingestSeq key: only the store assigns it', () => {
    const event = expectAttributed(
      bareAttributor().attributeEvent(makeIngress(), browserAttribution()),
    );

    expect('ingestSeq' in event).toBe(false);
    // Adding the store's value is all it takes to satisfy the strict persisted schema.
    expect(isOk(parseTelemetryEvent({ ...event, ingestSeq: 1 }))).toBe(true);
  });

  it('removes an ingestSeq and overwrites identity smuggled past the ingress schema', () => {
    const attribution = browserAttribution();
    const smuggled = {
      ...makeIngress(),
      ingestSeq: 99,
      sessionId: newSessionId(),
      captureId: newCaptureId(),
    } as TelemetryEventIngress;

    const event = expectAttributed(bareAttributor().attributeEvent(smuggled, attribution));

    expect('ingestSeq' in event).toBe(false);
    expect(event.sessionId).toBe(attribution.sessionId);
    expect(event.captureId).toBe(attribution.captureId);
  });

  it('preserves every other field byte-faithfully, including a sub-millisecond start time', () => {
    const input = richIngress();
    const expected = structuredClone(input);

    const event = expectAttributed(bareAttributor().attributeEvent(input, browserAttribution()));

    // Exact comparisons, never a tolerance: a start time is a double and must
    // survive attribution bit for bit.
    expect(Object.is(event.startTime, expected.startTime)).toBe(true);
    expect(Object.is(event.duration, expected.duration)).toBe(true);
    expect(event.id).toBe(expected.id);
    expect(event.traceId).toBe(expected.traceId);
    expect(event.spanId).toBe(expected.spanId);
    expect(event.parentSpanId).toBe(expected.parentSpanId);
    expect(event.kind).toBe(expected.kind);
    expect(event.name).toBe(expected.name);
    expect(event.tier).toBe(expected.tier);
    expect(event.attributes).toStrictEqual(expected.attributes);
    expect(event.status).toBe(expected.status);
    expect(event.producerId).toBe(expected.producerId);
    expect(event.seq).toBe(expected.seq);
    expect(event.source).toStrictEqual(expected.source);
    expect(event.redacted).toStrictEqual(expected.redacted);
  });

  it('adds exactly sessionId and captureId to the input’s key set', () => {
    for (const input of [makeIngress(), richIngress()]) {
      const event = expectAttributed(bareAttributor().attributeEvent(input, browserAttribution()));

      expect(Object.keys(event).sort()).toStrictEqual(
        [...Object.keys(input), 'sessionId', 'captureId'].sort(),
      );
    }
  });

  it('never mutates the input event', () => {
    const input = richIngress();
    const before = structuredClone(input);
    // Frozen as well as compared: a write attempt would throw in module code.
    deepFreeze(input);

    const event = expectAttributed(bareAttributor().attributeEvent(input, browserAttribution()));

    expect(input).toStrictEqual(before);
    expect('sessionId' in input).toBe(false);
    expect('captureId' in input).toBe(false);
    // A new object, not the input with fields bolted on.
    expect(event).not.toBe(input);
    expect(event.attributes).toStrictEqual(input.attributes);
  });

  it('treats a producerId differing from the announced one as informational only', () => {
    const attribution = browserAttribution({ producerId: newProducerId() });
    const input = makeIngress({ producerId: newProducerId() });

    const event = expectAttributed(bareAttributor().attributeEvent(input, attribution));

    expect(event.producerId).toBe(input.producerId);
  });

  it('refuses to stamp an attribution without a session or without a capture', () => {
    const attributor = bareAttributor();

    expectEventDrop(
      attributor.attributeEvent(makeIngress(), browserAttribution({ sessionId: '' })),
      'session-missing',
    );
    expectEventDrop(
      attributor.attributeEvent(makeIngress(), browserAttribution({ captureId: '' })),
      'no-active-capture',
    );
  });
});

/* -------------------------------------------------------------------------------------------------
 * attributeEvent — the tier gate
 *
 * The per-event expression of AAP §0.5.6's role scoping. Without it a
 * compromised or confused page could forge database spans or server request
 * spans into a session's evidence, and the analysis would cite a database cause
 * the database never reported; symmetrically, a dev server may not speak for
 * the page.
 * ---------------------------------------------------------------------------------------------- */

describe('attributeEvent: the tier gate', () => {
  it('lets a browser-agent batch report browser events only', () => {
    const attributor = bareAttributor();
    const attribution = browserAttribution();

    expectAttributed(attributor.attributeEvent(makeIngress({ tier: 'browser' }), attribution));
    expectEventDrop(
      attributor.attributeEvent(makeIngress({ tier: 'server' }), attribution),
      'tier-not-permitted',
    );
    expectEventDrop(
      attributor.attributeEvent(makeIngress({ tier: 'db' }), attribution),
      'tier-not-permitted',
    );
  });

  it('lets a server-agent batch report server and db events, never browser ones', () => {
    const attributor = bareAttributor();
    const attribution = serverAttribution();

    expectAttributed(attributor.attributeEvent(makeIngress({ tier: 'server' }), attribution));
    expectAttributed(attributor.attributeEvent(makeIngress({ tier: 'db' }), attribution));
    expectEventDrop(
      attributor.attributeEvent(makeIngress({ tier: 'browser' }), attribution),
      'tier-not-permitted',
    );
  });

  it('assigns every tier of the vocabulary to exactly one producing origin', () => {
    for (const tier of TELEMETRY_TIERS) {
      const producers = INGEST_ORIGINS.filter((origin: IngestOrigin) =>
        TIER_BY_ORIGIN[origin].includes(tier),
      );
      expect(producers).toHaveLength(1);
    }
  });

  it('refuses an event whose tier is not in the vocabulary, or an attribution with no known origin', () => {
    const attributor = bareAttributor();
    const unknownTier = { ...makeIngress(), tier: 'edge' } as unknown as TelemetryEventIngress;
    const unknownOrigin = {
      ...browserAttribution(),
      origin: 'elsewhere',
    } as unknown as IngestAttribution;

    expectEventDrop(
      attributor.attributeEvent(unknownTier, browserAttribution()),
      'tier-not-permitted',
    );
    expectEventDrop(attributor.attributeEvent(makeIngress(), unknownOrigin), 'tier-not-permitted');
  });
});

/* -------------------------------------------------------------------------------------------------
 * attributeBatch — the same decision over a batch, with counts
 * ---------------------------------------------------------------------------------------------- */

describe('attributeBatch', () => {
  it('keeps input order, counts drops per reason and counts producer mismatches', () => {
    const log = recordingLogger();
    const attributor = bareAttributor(log.logger);
    const attribution = browserAttribution();
    const first = makeIngress({ tier: 'browser' });
    const forgedServer = makeIngress({ tier: 'server' });
    const forgedDb = makeIngress({ tier: 'db' });
    const otherProducer = makeIngress({ tier: 'browser', producerId: newProducerId() });

    const batch = attributor.attributeBatch(
      [first, forgedServer, forgedDb, otherProducer],
      attribution,
    );

    expect(batch.outcomes.map((outcome) => outcome.kind)).toStrictEqual([
      'attributed',
      'dropped',
      'dropped',
      'attributed',
    ]);
    expect(batch.events.map((event) => event.id)).toStrictEqual([first.id, otherProducer.id]);
    expect(batch.droppedTotal).toBe(2);
    expect(batch.producerMismatches).toBe(1);
    expect(Object.keys(batch.dropped).sort()).toStrictEqual([...DROP_REASONS].sort());
    for (const reason of DROP_REASONS) {
      expect(batch.dropped[reason]).toBe(reason === 'tier-not-permitted' ? 2 : 0);
    }
    for (const outcome of batch.outcomes) {
      if (outcome.kind === 'dropped') {
        observedReasons.add(outcome.reason);
      }
    }

    // One summary line of counts; a refused tier makes it a warning.
    const summaries = log.lines.filter((line) => line.message === 'telemetry batch attributed');
    expect(summaries).toHaveLength(1);
    const summary = summaries[0];
    expect(summary?.level).toBe('warn');
    expect(summary?.fields).toMatchObject({
      events: 4,
      attributed: 2,
      dropped: 2,
      droppedByReason: { 'tier-not-permitted': 2 },
      producerMismatches: 1,
      sessionId: attribution.sessionId,
      captureId: attribution.captureId,
    });
  });

  it('answers an empty batch with empty results and zero counts', () => {
    const batch = bareAttributor().attributeBatch([], serverAttribution());

    expect(batch.outcomes).toStrictEqual([]);
    expect(batch.events).toStrictEqual([]);
    expect(batch.droppedTotal).toBe(0);
    expect(batch.producerMismatches).toBe(0);
  });
});

/* -------------------------------------------------------------------------------------------------
 * The pre-capture rule — the page's replayed lifecycle entries
 *
 * The page agent observes `navigation` and `paint` with `buffered: true`, so
 * the first batch after it is armed replays the load and first paints of a
 * document that loaded before Start. Identity cannot tell them apart from the
 * capture's own evidence; the capture's recorded start can. The rule is narrow
 * on purpose: only those two entry families, only on the browser tier, only
 * when the entry *ended* before Start — every other kind and tier keeps the
 * identity-only contract, because their producer clocks can lag the wall
 * clock after a system sleep.
 * ---------------------------------------------------------------------------------------------- */

/** When the open capture of the pre-capture cases started, a minute past {@link BASE_TIME}. */
const CAPTURE_STARTED_AT = BASE_TIME + 60_000;

/** The kind of the page's navigation timing. */
const NAVIGATION: TelemetryKind = 'navigation';

/** The kind of every other performance entry the page agent reports. */
const PERF_ENTRY: TelemetryKind = 'perf.entry';

/** The `perf.entry` attribute naming the `PerformanceEntry` type, as the page agent writes it. */
const ENTRY_TYPE_KEY = 'entry.type';

/** A browser `navigation` event occupying `[startTime, startTime + duration]`. */
function navigationEntry(startTime: number, duration: number): TelemetryEventIngress {
  return makeIngress({
    tier: 'browser',
    kind: NAVIGATION,
    name: 'navigation',
    startTime,
    duration,
    attributes: { 'navigation.type': 'navigate' },
  });
}

/** A browser `perf.entry` of `entryType` at `startTime`; a paint is an instant, as the agent emits it. */
function perfEntry(
  entryType: 'paint' | 'resource',
  startTime: number,
  duration = 0,
): TelemetryEventIngress {
  return makeIngress({
    tier: 'browser',
    kind: PERF_ENTRY,
    name: entryType === 'paint' ? 'first-contentful-paint' : 'http://127.0.0.1:3000/asset.js',
    startTime,
    duration,
    attributes: { [ENTRY_TYPE_KEY]: entryType },
  });
}

/** A browser attribution whose open capture started at {@link CAPTURE_STARTED_AT}. */
function windowedAttribution(overrides: Partial<IngestAttribution> = {}): IngestAttribution {
  return browserAttribution({ captureStartedAt: CAPTURE_STARTED_AT, ...overrides });
}

/**
 * A browser-origin scenario whose store row reports `startedAt` for the open
 * capture — the real repository's `CaptureRecord.startedAt` — beside its id.
 */
function browserWorldStartedAt(startedAt: unknown): BrowserWorld {
  const sessionId = newSessionId();
  const captureId = newCaptureId();
  const repo = fakeRepo({
    bindings: [[TAB_ID, sessionId]],
    sessions: [{ id: sessionId, projectRoot: PROJECT_ONE }],
    getActiveCapture: (id) =>
      ok(
        id === sessionId
          ? ({ capture: { id: captureId, startedAt } } as unknown as ActiveCaptureLike)
          : undefined,
      ),
  });
  const log = recordingLogger();
  const attributor = createIngestAttributor({
    sessions: repo,
    logger: log.logger,
    now: fixedClock,
  });

  return { sessionId, captureId, repo, log, attributor };
}

describe('attributeEvent: the pre-capture rule', () => {
  it('builds lifecycle fixtures the strict ingress schema accepts', () => {
    for (const event of [
      navigationEntry(BASE_TIME, 380.5),
      perfEntry('paint', BASE_TIME + 120.25),
      perfEntry('resource', BASE_TIME + 40, 9.5),
    ]) {
      expect(isOk(parseTelemetryEventIngress(event))).toBe(true);
    }
  });

  it('drops a navigation that ended before the capture started', () => {
    const outcome = bareAttributor().attributeEvent(
      navigationEntry(CAPTURE_STARTED_AT - 45_000, 342.5),
      windowedAttribution(),
    );

    expectEventDrop(outcome, 'pre-capture');
  });

  it('drops a paint mark from before the capture started', () => {
    const attributor = bareAttributor();
    const attribution = windowedAttribution();

    expectEventDrop(
      attributor.attributeEvent(perfEntry('paint', CAPTURE_STARTED_AT - 44_000), attribution),
      'pre-capture',
    );
    expectEventDrop(
      attributor.attributeEvent(perfEntry('paint', CAPTURE_STARTED_AT - 0.001), attribution),
      'pre-capture',
    );
  });

  it('keeps a reload during the capture: its navigation and paints start inside the window', () => {
    const attributor = bareAttributor();
    const attribution = windowedAttribution();
    const reload = navigationEntry(CAPTURE_STARTED_AT + 5_000.125, 512.75);
    const paint = perfEntry('paint', CAPTURE_STARTED_AT + 5_210.5);

    const kept = [reload, paint].map((event) =>
      expectAttributed(attributor.attributeEvent(event, attribution)),
    );

    expect(kept.map((event) => event.id)).toStrictEqual([reload.id, paint.id]);
    expect(kept.every((event) => event.captureId === attribution.captureId)).toBe(true);
  });

  it('keeps a navigation that started before the capture but ended inside it', () => {
    const straddling = navigationEntry(CAPTURE_STARTED_AT - 200, 450);

    expectAttributed(bareAttributor().attributeEvent(straddling, windowedAttribution()));
  });

  it('keeps a lifecycle entry whose end is exactly the capture start: only strictly earlier is dropped', () => {
    const attributor = bareAttributor();
    const attribution = windowedAttribution();

    expectAttributed(
      attributor.attributeEvent(navigationEntry(CAPTURE_STARTED_AT - 250, 250), attribution),
    );
    expectAttributed(
      attributor.attributeEvent(perfEntry('paint', CAPTURE_STARTED_AT), attribution),
    );
  });

  it('keeps a resource perf.entry from before the capture: only paint entries are lifecycle entries', () => {
    const resource = perfEntry('resource', CAPTURE_STARTED_AT - 30_000, 9.5);

    expectAttributed(bareAttributor().attributeEvent(resource, windowedAttribution()));
  });

  it('applies no time test to any other browser kind', () => {
    const attributor = bareAttributor();
    const attribution = windowedAttribution();
    const lifecycle = new Set<TelemetryKind>([NAVIGATION, PERF_ENTRY]);
    const others = TELEMETRY_KINDS.filter(
      (kind) => !lifecycle.has(kind) && allowedTiersFor(kind).includes('browser'),
    );

    expect(others.length).toBeGreaterThan(0);
    for (const kind of others) {
      const early = makeIngress({
        tier: 'browser',
        kind,
        startTime: CAPTURE_STARTED_AT - 600_000,
        duration: 1,
      });
      expectAttributed(attributor.attributeEvent(early, attribution));
    }
  });

  it('keeps server and db events from before the capture: the rule is browser-tier only', () => {
    const attributor = bareAttributor();
    const attribution = serverAttribution({ captureStartedAt: CAPTURE_STARTED_AT });

    for (const tier of ['server', 'db'] as const) {
      const early = makeIngress({ tier, startTime: CAPTURE_STARTED_AT - 600_000, duration: 1 });
      expectAttributed(attributor.attributeEvent(early, attribution));
    }
  });

  it('leaves a forged tier a tier-not-permitted drop whatever its times', () => {
    const attributor = bareAttributor();
    const forged = { ...navigationEntry(CAPTURE_STARTED_AT - 45_000, 1), tier: 'db' as const };

    expectEventDrop(attributor.attributeEvent(forged, windowedAttribution()), 'tier-not-permitted');
    expectEventDrop(
      attributor.attributeEvent(
        navigationEntry(CAPTURE_STARTED_AT - 45_000, 1),
        serverAttribution({ captureStartedAt: CAPTURE_STARTED_AT }),
      ),
      'tier-not-permitted',
    );
  });

  it('drops nothing when the attribution carries no readable capture start', () => {
    const attributor = bareAttributor();
    const early = navigationEntry(CAPTURE_STARTED_AT - 45_000, 342.5);
    const unreadable = [
      browserAttribution(),
      windowedAttribution({ captureStartedAt: Number.NaN }),
      windowedAttribution({ captureStartedAt: Number.POSITIVE_INFINITY }),
      { ...browserAttribution(), captureStartedAt: 'yesterday' } as unknown as IngestAttribution,
    ];

    for (const attribution of unreadable) {
      expectAttributed(attributor.attributeEvent(early, attribution));
    }
  });

  it('keeps, and never throws for, a perf.entry whose attributes cannot be read', () => {
    const attributes: Record<string, unknown> = {};
    Object.defineProperty(attributes, ENTRY_TYPE_KEY, {
      enumerable: true,
      get(): never {
        throw new Error(`unreadable ${SENTINEL}`);
      },
    });
    const hostile = { ...perfEntry('paint', CAPTURE_STARTED_AT - 44_000), attributes };

    expect(() => bareAttributor().attributeEvent(hostile, windowedAttribution())).not.toThrow();
    expectAttributed(bareAttributor().attributeEvent(hostile, windowedAttribution()));
  });

  it('never mutates the entry it drops, nor rewrites the times of one it keeps', () => {
    const attributor = bareAttributor();
    const attribution = windowedAttribution();
    const early = deepFreeze(navigationEntry(CAPTURE_STARTED_AT - 45_000.375, 342.625));
    const straddling = deepFreeze(navigationEntry(CAPTURE_STARTED_AT - 0.125, 0.25));
    const earlyBefore = structuredClone(early);
    const straddlingBefore = structuredClone(straddling);

    expectEventDrop(attributor.attributeEvent(early, attribution), 'pre-capture');
    const kept = expectAttributed(attributor.attributeEvent(straddling, attribution));

    expect(early).toStrictEqual(earlyBefore);
    expect(straddling).toStrictEqual(straddlingBefore);
    expect(Object.is(kept.startTime, straddlingBefore.startTime)).toBe(true);
    expect(Object.is(kept.duration, straddlingBefore.duration)).toBe(true);
    expect('ingestSeq' in kept).toBe(false);
  });

  it('counts the drops under pre-capture in a routine, content-free batch summary', () => {
    const log = recordingLogger();
    const attributor = bareAttributor(log.logger);
    const attribution = windowedAttribution();
    const navigation = navigationEntry(CAPTURE_STARTED_AT - 45_000, 342.5);
    const firstPaint = perfEntry('paint', CAPTURE_STARTED_AT - 44_800);
    const contentfulPaint = perfEntry('paint', CAPTURE_STARTED_AT - 44_790);
    const render = makeIngress({
      tier: 'browser',
      kind: 'render',
      startTime: CAPTURE_STARTED_AT + 1_250.5,
      duration: 18.5,
    });

    const batch = attributor.attributeBatch(
      [navigation, firstPaint, render, contentfulPaint],
      attribution,
    );

    expect(batch.outcomes.map((outcome) => outcome.kind)).toStrictEqual([
      'dropped',
      'dropped',
      'attributed',
      'dropped',
    ]);
    expect(batch.events.map((event) => event.id)).toStrictEqual([render.id]);
    expect(batch.droppedTotal).toBe(3);
    for (const reason of DROP_REASONS) {
      expect(batch.dropped[reason]).toBe(reason === 'pre-capture' ? 3 : 0);
    }
    for (const outcome of batch.outcomes) {
      if (outcome.kind === 'dropped') {
        observedReasons.add(outcome.reason);
      }
    }

    const summaries = log.lines.filter((line) => line.message === 'telemetry batch attributed');
    expect(summaries).toHaveLength(1);
    // A replayed page load is the agent working as designed: debug, never a warning.
    expect(summaries[0]?.level).toBe('debug');
    expect(summaries[0]?.fields).toMatchObject({
      events: 4,
      attributed: 1,
      dropped: 3,
      droppedByReason: { 'pre-capture': 3 },
    });
    expect(log.text()).not.toContain('first-contentful-paint');
  });

  it('reports the reason under a window code, never an authorization one', () => {
    expect(DROP_REASON_ERROR_CODES['pre-capture']).toBe('SESSION_INVALID_STATE');
    expect(DROP_REASON_ERROR_CODES['pre-capture']).not.toBe('UNAUTHORIZED');
  });
});

describe('resolveBatch: the open capture’s start', () => {
  it('carries the capture row’s startedAt on a browser attribution', async () => {
    const world = browserWorldStartedAt(CAPTURE_STARTED_AT);

    const attribution = expectResolved(await world.attributor.resolveBatch(browserContext()));

    expect(attribution).toStrictEqual({
      sessionId: world.sessionId,
      captureId: world.captureId,
      captureStartedAt: CAPTURE_STARTED_AT,
      origin: 'browser-agent',
      tabId: TAB_ID,
      projectRoot: PROJECT_ONE,
      producerId: PRODUCER,
      resolvedAt: FIXED_NOW,
    });
    // Read with the id, from the same single capture lookup.
    expect(world.repo.calls.getActiveCapture).toStrictEqual([world.sessionId]);
  });

  it('omits it, rather than refusing the batch, when the row has no finite start', async () => {
    for (const startedAt of [undefined, Number.NaN, 'yesterday']) {
      const world = browserWorldStartedAt(startedAt);

      const attribution = expectResolved(await world.attributor.resolveBatch(browserContext()));

      expect(attribution).not.toHaveProperty('captureStartedAt');
      expect(attribution.captureId).toBe(world.captureId);
    }
  });

  it('never carries it on a server attribution, which reports no browser-tier event', async () => {
    const world = serverWorld();

    const attribution = expectResolved(
      await world.attributor.resolveBatch(serverContext(PROJECT_ONE)),
    );

    expect(attribution).not.toHaveProperty('captureStartedAt');
  });

  it('drops the replayed page load and keeps the capture’s own evidence, end to end', async () => {
    const world = browserWorldStartedAt(CAPTURE_STARTED_AT);
    const navigation = navigationEntry(CAPTURE_STARTED_AT - 2_446.5, 342.5);
    const paint = perfEntry('paint', CAPTURE_STARTED_AT - 2_100.25);
    const render = makeIngress({
      tier: 'browser',
      kind: 'render',
      startTime: CAPTURE_STARTED_AT + 850.125,
      duration: 18.5,
    });

    const attribution = expectResolved(await world.attributor.resolveBatch(browserContext()));
    const batch = world.attributor.attributeBatch([navigation, paint, render], attribution);

    expect(batch.events.map((event) => event.id)).toStrictEqual([render.id]);
    expect(batch.dropped['pre-capture']).toBe(2);
    expect(batch.events[0]?.captureId).toBe(world.captureId);
  });
});

/* -------------------------------------------------------------------------------------------------
 * Failure discipline: nothing throws, nothing rejects
 * ---------------------------------------------------------------------------------------------- */

describe('failure discipline', () => {
  it.each([
    ['NaN', Number.NaN],
    ['negative', -1],
    ['fractional', 1.5],
    ['infinite', Number.POSITIVE_INFINITY],
  ])('drops a browser batch with a %s tab id without asking the store', async (_label, tabId) => {
    const world = browserWorld();

    const pending = world.attributor.resolveBatch(browserContext({ tabId }));

    await expect(pending).resolves.toBeDefined();
    const error = expectDrop(await pending, 'no-binding');
    expect(DEBUGGEN_ERROR_CODES).toContain(error.code);
    expect(world.repo.calls.getBindingByTab).toStrictEqual([]);
  });

  it('drops a server batch with an empty project root or an empty credential scope', async () => {
    const world = serverWorld();

    const noRoot = expectDrop(
      await world.attributor.resolveBatch(serverContext('', PROJECT_ONE)),
      'project-scope-mismatch',
    );
    const noScope = expectDrop(
      await world.attributor.resolveBatch(serverContext(PROJECT_ONE, '')),
      'project-scope-mismatch',
    );
    const neither = expectDrop(
      await world.attributor.resolveBatch(serverContext('', '')),
      'project-scope-mismatch',
    );

    expect(noRoot.details?.['mismatch']).toBe('missing-project-root');
    expect(noScope.details?.['mismatch']).toBe('missing-credential-scope');
    expect(neither.details?.['mismatch']).toBe('missing-project-root');
    // An empty root must not normalise to "." and match an empty scope.
    expect(world.manager.calls).toStrictEqual([]);
  });

  it('resolves, never rejects, for a context whose fields throw when read', async () => {
    const world = serverWorld();
    const browser = Object.defineProperty({ origin: 'browser-agent' }, 'tabId', {
      enumerable: true,
      get(): never {
        throw new Error(`unreadable ${SENTINEL}`);
      },
    }) as unknown as IngestContext;
    const server = Object.defineProperty({ origin: 'server-agent' }, 'projectRoot', {
      enumerable: true,
      get(): never {
        throw new Error(`unreadable ${SENTINEL}`);
      },
    }) as unknown as IngestContext;

    const browserError = expectDrop(await world.attributor.resolveBatch(browser), 'no-binding');
    const serverError = expectDrop(
      await world.attributor.resolveBatch(server),
      'project-scope-mismatch',
    );

    expect(browserError.code).toBe('INTERNAL');
    expect(serverError.code).toBe('INTERNAL');
    expectNoSentinel(errorText(browserError));
    expectNoSentinel(errorText(serverError));
    expectNoSentinel(world.log.text());
  });

  it('drops a context naming no known origin as no-binding', async () => {
    const attributor = bareAttributor();
    const context = { origin: 'elsewhere', tabId: TAB_ID } as unknown as IngestContext;

    const error = expectDrop(await attributor.resolveBatch(context), 'no-binding');

    expect(error.details).not.toHaveProperty('origin');
  });

  it('keeps an event with a throwing getter from throwing: it is refused, not stamped', () => {
    const attributor = bareAttributor();
    const hostile = eventWithThrowingGetter();

    expect(() => attributor.attributeEvent(hostile, browserAttribution())).not.toThrow();
    expectEventDrop(attributor.attributeEvent(hostile, browserAttribution()), 'tier-not-permitted');

    const batch = attributor.attributeBatch([hostile, makeIngress()], browserAttribution());
    expect(batch.droppedTotal).toBe(1);
    expect(batch.events).toHaveLength(1);
  });

  it('answers a batch that is not an array with an empty result', () => {
    const attributor = bareAttributor();
    const notABatch = { length: 1, 0: makeIngress() } as unknown as TelemetryEventIngress[];

    expect(() => attributor.attributeBatch(notABatch, browserAttribution())).not.toThrow();
    expect(attributor.attributeBatch(notABatch, browserAttribution()).events).toStrictEqual([]);
  });

  it('decides the same with a logger that throws on every call', async () => {
    const world = browserWorld();
    const attributor = createIngestAttributor({
      sessions: world.repo,
      logger: throwingLogger(),
      now: fixedClock,
    });

    const attribution = expectResolved(await attributor.resolveBatch(browserContext()));
    expectDrop(await attributor.resolveBatch(browserContext({ tabId: TAB_ID + 1 })), 'no-binding');
    expect(() => attributor.attributeBatch([makeIngress()], attribution)).not.toThrow();
  });

  it('omits resolvedAt, rather than failing, when the clock throws or is not finite', async () => {
    const world = browserWorld();
    const throwingClock = createIngestAttributor({
      sessions: world.repo,
      now: () => {
        throw new Error('clock unavailable');
      },
    });
    const nanClock = createIngestAttributor({ sessions: world.repo, now: () => Number.NaN });

    for (const attributor of [throwingClock, nanClock]) {
      const attribution = expectResolved(await attributor.resolveBatch(browserContext()));
      expect(attribution).not.toHaveProperty('resolvedAt');
      expect(attribution.sessionId).toBe(world.sessionId);
    }
  });
});

/* -------------------------------------------------------------------------------------------------
 * Privacy: no rejected value reaches an error or a log line (AAP §0.5.2)
 * ---------------------------------------------------------------------------------------------- */

describe('privacy', () => {
  it('never echoes a store error’s text or a thrown value into the refusal', async () => {
    const leakingRead = fakeRepo({
      getBindingByTab: () => err(new DebuggenError('STORE_ERROR', `row ${SENTINEL}`)),
    });
    const throwingRead = fakeRepo({
      getBindingByTab: () => {
        throw new Error(`statement ${SENTINEL}`);
      },
    });

    for (const repo of [leakingRead, throwingRead]) {
      const log = recordingLogger();
      const attributor = createIngestAttributor({
        sessions: repo,
        logger: log.logger,
        now: fixedClock,
      });

      const error = expectDrop(await attributor.resolveBatch(browserContext()), 'no-binding');

      expectNoSentinel(errorText(error));
      expect(error.cause).toBeUndefined();
      expectNoSentinel(log.text());
    }
  });

  it('never echoes the tab URL, a document id or a project path into a refusal', async () => {
    const browser = browserWorld({ captureOpen: false });
    const server = serverWorld();

    const browserError = expectDrop(
      await browser.attributor.resolveBatch({
        ...browserContext({ url: `http://127.0.0.1:3000/${SENTINEL}?q=${SENTINEL}` }),
        documentId: SENTINEL,
      }),
      'no-active-capture',
    );
    const serverError = expectDrop(
      await server.attributor.resolveBatch(
        serverContext(`/tmp/${SENTINEL}`, `/tmp/project-one-${SENTINEL}`),
      ),
      'project-scope-mismatch',
    );

    for (const error of [browserError, serverError]) {
      expectNoSentinel(error.message);
      expectNoSentinel(error.hint ?? '');
      expectNoSentinel(JSON.stringify(error.toPayload()));
      expectNoSentinel(errorText(error));
    }
    expectNoSentinel(browser.log.text());
    expectNoSentinel(server.log.text());
  });

  it('logs counts and reasons only: no event name, attribute value, URL or path', async () => {
    const world = browserWorld({ projectRoot: `/tmp/project-one-${SENTINEL}` });
    const url = `http://127.0.0.1:3000/${SENTINEL}`;
    const eventName = `operation ${SENTINEL}`;

    const attribution = expectResolved(
      await world.attributor.resolveBatch(browserContext({ url })),
    );
    world.attributor.attributeBatch(
      [
        makeIngress({ name: eventName, attributes: { url, token: SENTINEL } }),
        makeIngress({ tier: 'db', name: eventName, attributes: { 'db.statement': SENTINEL } }),
      ],
      attribution,
    );
    expectDrop(
      await world.attributor.resolveBatch(browserContext({ tabId: TAB_ID + 1, url })),
      'no-binding',
    );

    expect(world.log.lines.length).toBeGreaterThan(0);
    expectNoSentinel(world.log.text());
    expect(world.log.text()).not.toContain('127.0.0.1');
    for (const line of world.log.lines) {
      // Every line is attributable to this module without matching on its text…
      expect(line.fields['subsystem']).toBe(ATTRIBUTION_SUBSYSTEM);
      // …and carries no field that could hold captured content.
      for (const key of ['name', 'url', 'attributes', 'projectRoot', 'statement', 'documentId']) {
        expect(line.fields).not.toHaveProperty(key);
      }
      // Every value is a count, a flag, an identifier or a closed-vocabulary word.
      for (const value of Object.values(line.fields)) {
        const kind = typeof value;
        expect(['string', 'number', 'boolean', 'object']).toContain(kind);
        if (kind === 'object') {
          const counts = Object.values(value as Record<string, unknown>);
          expect(counts.every((count) => Number.isInteger(count))).toBe(true);
        }
      }
    }
  });
});

/* -------------------------------------------------------------------------------------------------
 * The closed drop vocabulary
 * ---------------------------------------------------------------------------------------------- */

describe('drop vocabulary', () => {
  it('is a frozen, duplicate-free tuple the guard recognises exactly', () => {
    expect(Object.isFrozen(DROP_REASONS)).toBe(true);
    expect(new Set(DROP_REASONS).size).toBe(DROP_REASONS.length);
    for (const reason of DROP_REASONS) {
      expect(isDropReason(reason)).toBe(true);
    }
    for (const other of ['', 'no binding', 'NO-BINDING', 'dropped', undefined, null, 0]) {
      expect(isDropReason(other)).toBe(false);
    }
  });

  it('maps every reason, and only those, to a code of the shared vocabulary', () => {
    expect(Object.keys(DROP_REASON_ERROR_CODES).sort()).toStrictEqual([...DROP_REASONS].sort());
    for (const reason of DROP_REASONS) {
      expect(DEBUGGEN_ERROR_CODES).toContain(DROP_REASON_ERROR_CODES[reason]);
    }
  });

  it('recognises a drop only by its marker, never by a lookalike reason detail', () => {
    const lookalike = new DebuggenError('SESSION_NOT_FOUND', 'unrelated', {
      details: { reason: 'session-missing' },
    });
    const forgedReason = new DebuggenError('INTERNAL', 'unrelated', {
      details: { reason: 'not-a-reason', [ATTRIBUTION_DROP_DETAIL_KEY]: true },
    });

    expect(attributionDropReason(lookalike)).toBeUndefined();
    expect(attributionDropReason(forgedReason)).toBeUndefined();
    expect(attributionDropReason(new Error('plain'))).toBeUndefined();
    expect(attributionDropReason({ reason: 'no-binding', attributionDrop: true })).toBeUndefined();
    expect(attributionDropReason(undefined)).toBeUndefined();
  });

  // Runs last: every reason the cases above produced must be a member of the
  // closed tuple — no free-text reason exists anywhere in the module.
  it('covers every drop this suite produced', () => {
    expect(observedReasons.size).toBeGreaterThan(0);
    const closed = new Set<string>(DROP_REASONS);
    for (const reason of observedReasons) {
      expect(closed.has(reason)).toBe(true);
    }
  });
});
