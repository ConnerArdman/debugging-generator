/**
 * Colocated tests for `./ingest.ts`: the **ordering and wiring** of telemetry
 * ingest — the mechanical proof of the product's privacy guarantee.
 *
 * AAP §0.5.2 promises that captured data is redacted "before any event is
 * persisted or broadcast", and that duplicate detection keys requests with a
 * per-session secret that never leaves the store. AAP §0.7.1 Group 2 fixes the
 * order that makes both true: validate ingress → compute `request_key` →
 * redact → attribute → persist → correlate → tail. Nothing else in the product
 * enforces that order, so this suite proves it by **observation**:
 *
 * 1. **The mandatory order.** Every collaborator — the request-key hasher, the
 *    redactor, the attributor, the store, the correlator and the live tail —
 *    writes a tag into one shared call-order log, so the order is a single
 *    array comparison rather than a reading of the implementation.
 * 2. **The key precedes redaction, by value.** The hasher is shown the
 *    unredacted query value, and an independently computed digest of the
 *    `?`-masked URL is shown to differ — which is what turns "the key must be
 *    computed first" from a convention into a fact.
 * 3. **Redaction wiring and the store contract.** Every row handed to the store
 *    is exactly a redactor output plus its attribution; the correlator and the
 *    tail receive the rows the store *returned*; planted credentials reach
 *    neither; the epoch-millisecond time base survives untouched.
 * 4. **Batch discipline and graceful failure (AAP §0.5.5).** Bounds, drops,
 *    malformed siblings, replays, store and subsystem failures — and no input
 *    of any shape makes a call throw or a promise reject.
 * 5. **Privacy of the secret and of logs.** The session secret, digests and
 *    captured values appear in no log record, report or error payload.
 * 6. **Transport wrappers.** The browser and server transports build the
 *    context the attributor sees, and the server scope comes from the
 *    credential, never from the body; the ingest route's response reports the
 *    accepted rows, and rejected ones only when there are any.
 * 7. **Delivery context of a relayed batch.** The capture the page agent was
 *    armed for and the producer's loss report travel with a batch: the armed
 *    capture is handed to attribution, and a reported loss is recorded once,
 *    against the attributed session and capture, before the batch is
 *    processed.
 * 8. **The log throttle (CWE-400).** Hundreds of malformed batches write one
 *    warning per key per interval, the next record carries the count held
 *    back, and a ceiling across keys holds however many sessions a flood spans.
 *
 * ## The privacy layer is real, never stubbed
 *
 * `redactEvent` and `createRequestKeyHasher` are the real `@debuggen/telemetry`
 * functions, injected through the module's `privacy` seam wrapped in spies that
 * **delegate** to them. Nothing here is module-mocked: a suite that stubbed the
 * redactor would prove the wiring of a function that does not redact. The
 * attributor is the real `createIngestAttributor` over an in-file store, wrapped
 * the same way, so the tier gate and the drop contract are the product's own.
 *
 * ## What is deliberately not covered here
 *
 * Redaction-before-persistence and capture attribution against a **real**
 * store and a running service belong to
 * `apps/local-service/test/integration/telemetry-ingest.test.ts`. This suite
 * stays at unit level with spies, where the order is actually observable; the
 * two are complementary, not duplicates.
 *
 * ## Fixture conventions
 *
 * Hermetic by contract: no database, socket, server, network, wall clock or
 * real timer — the ingest clock is injected, and every case that depends on
 * the locate budget's timers drives them with Vitest's fake timers (a locator
 * double that answers at once has them cleared before they could fire).
 * Identifiers come from
 * `@debuggen/shared`'s minting functions and kinds/tiers are typed against
 * `@debuggen/telemetry`'s vocabularies. Every name and URL is invented and
 * generic (`/api/one?itemId=A`, `handleAction`): nothing names a component,
 * symbol or route of any real project (AAP §0.5.4). Secret-shaped values — the
 * session secret and the planted credential — are assembled from fragments at
 * run time so `scripts/check-secrets.mjs` never sees a credential-shaped
 * literal in this file.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildWrapperBody, createModificationRecord } from '@debuggen/instrumentation';
import { parseTelemetryEventPayload } from '@debuggen/protocol';
import {
  DEBUGGEN_ERROR_CODES,
  DebuggenError,
  err,
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
  SourceLocation,
} from '@debuggen/shared';
import {
  KIND_ATTRIBUTE_KEYS,
  MIN_EPOCH_MS,
  REQUEST_KINDS,
  SERVICE_ASSIGNED_ATTRIBUTE_KEYS,
  TELEMETRY_KINDS,
  TELEMETRY_TIERS,
  createRequestKeyHasher,
  parseTelemetryEvent,
  parseTelemetryEventIngress,
  redactEvent,
} from '@debuggen/telemetry';
import type {
  DB_QUERY_ATTRIBUTE_KEYS,
  FETCH_ATTRIBUTE_KEYS,
  RedactionOptions,
  RequestKeyHasher,
  TelemetryEvent,
  TelemetryEventIngress,
  TelemetryKind,
} from '@debuggen/telemetry';

import { createSourceResolver } from '../source/resolve.js';

import { DROP_REASONS, DROP_REASON_ERROR_CODES, createIngestAttributor } from './attribute.js';
import type {
  AttributedEvent,
  DropReason,
  IngestContext,
  SessionsRepoLike as AttributionStoreLike,
} from './attribute.js';
import type { CorrelateUpdate } from './correlate.js';
import {
  DEFAULT_LOCATE_BUDGET_MS,
  INGEST_REQUEST_KEY_ATTRIBUTE,
  INGEST_SUBSYSTEM,
  LOCATE_BUDGET_GRACE_MS,
  LOG_THROTTLE_INTERVAL_MS,
  LOG_THROTTLE_MAX_RECORDS_PER_INTERVAL,
  MAX_INGEST_BATCH,
  MAX_LOCATE_BUDGET_MS,
  createLogThrottle,
  createTelemetryIngest,
  summaryFields,
  suppressionFields,
  toIngestResponse,
} from './ingest.js';
import type {
  AgentIngestInput,
  IngestAttributorLike,
  IngestLocateOptions,
  IngestPrivacyPrimitives,
  IngestReport,
  IngestSourceLocator,
  LiveTailLike,
  LogThrottleSummary,
  ProducerLossReportLike,
  TelemetryIngest,
  TelemetryRepoLike,
  TraceCorrelatorLike,
} from './ingest.js';

/* -------------------------------------------------------------------------------------------------
 * Fixture constants
 * ---------------------------------------------------------------------------------------------- */

/** The injected clock's only reading: no case depends on wall time. */
const FIXED_NOW = 1_700_000_000_000;

/** The clock every pipeline and attributor in this file is built with. */
const fixedClock = (): number => FIXED_NOW;

/**
 * The epoch millisecond event start times are offset from — a double with a
 * fractional part, inside the window the ingress schema accepts, so a stray
 * integer conversion anywhere in the pipeline changes a value this suite
 * compares with `toBe`.
 */
const BASE_TIME = 1_768_000_000_000.125;

/** The inspected tab the browser batches are relayed for. */
const TAB_ID = 7;

/** An inspected tab no session is bound to. */
const UNBOUND_TAB_ID = 99;

/** The project the server batches are scoped to. Invented, outside any checkout. */
const PROJECT_ONE = '/tmp/project-one';

/** A second, unrelated project. */
const PROJECT_TWO = '/tmp/project-two';

/** The session every resolved batch belongs to. */
const SESSION: SessionId = newSessionId();

/** That session's open capture window. */
const CAPTURE: CaptureId = newCaptureId();

/** The producer id every fixture event carries. */
const PRODUCER: ProducerId = newProducerId();

/** The request kind the request fixtures use; its membership in `REQUEST_KINDS` is asserted. */
const REQUEST_KIND: TelemetryKind = 'fetch';

/** The request attribute carrying the HTTP method, typed against the upstream catalog. */
const METHOD_KEY: (typeof FETCH_ATTRIBUTE_KEYS)[number] = 'http.method';

/** The request attribute carrying the URL, typed against the upstream catalog. */
const URL_KEY: (typeof FETCH_ATTRIBUTE_KEYS)[number] = 'url';

/** The request attribute carrying the response status, typed against the upstream catalog. */
const STATUS_KEY: (typeof FETCH_ATTRIBUTE_KEYS)[number] = 'http.status_code';

/** The database attribute carrying the statement text, typed against the upstream catalog. */
const STATEMENT_KEY: (typeof DB_QUERY_ATTRIBUTE_KEYS)[number] = 'db.statement';

/** A request-header attribute the redactor masks by name. */
const AUTH_HEADER_KEY = 'http.request.header.authorization';

/**
 * The attribute the `request_key` digest must be written under, derived here
 * from the upstream vocabulary alone: the service-assigned key every request
 * kind declares in its attribute catalog. Never a local literal.
 */
const UPSTREAM_REQUEST_KEY_ATTRIBUTES: readonly string[] = SERVICE_ASSIGNED_ATTRIBUTE_KEYS.filter(
  (key) => REQUEST_KINDS.every((kind) => KIND_ATTRIBUTE_KEYS[kind].includes(key)),
);

/**
 * The single member of {@link UPSTREAM_REQUEST_KEY_ATTRIBUTES}. A test asserts
 * there is exactly one; reading it with a fallback keeps the type a `string`.
 */
const REQUEST_KEY_ATTRIBUTE: string = UPSTREAM_REQUEST_KEY_ATTRIBUTES[0] ?? '';

/**
 * The per-session request-key secret the fake sessions store hands out: 64
 * lowercase hex characters, **assembled at run time** from short fragments so
 * no high-entropy literal exists in this file.
 */
const SECRET_FRAGMENTS: readonly string[] = ['0f1e2d3c', '4b5a6978', '8796a5b4', 'c3d2e1f0'];
const REQUEST_KEY_SECRET: string = [...SECRET_FRAGMENTS, ...SECRET_FRAGMENTS].join('');

/**
 * A credential-shaped token planted in captured data, assembled from fragments
 * at run time. It has the shape of a GitHub personal token, which the
 * redaction rules deny by pattern.
 */
const PLANTED_TOKEN: string = ['gh', 'p_', 'Q9w8E7r6T5y4U3i2O1p0', 'A1s2D3f4G5h6J7k8'].join('');

/**
 * A distinctive marker for captured values whose absence from logs is
 * asserted. Assembled at run time; the label keeps each one traceable.
 */
function sentinel(label: string): string {
  return ['captured', label, 'm4rk3r'].join('-');
}

/* -------------------------------------------------------------------------------------------------
 * Event fixtures
 * ---------------------------------------------------------------------------------------------- */

/** The per-producer sequence counter the fixtures draw from. */
let nextSeq = 0;

/**
 * A valid producer event: hex ids from `@debuggen/shared`, an epoch-millisecond
 * `startTime` with a fractional part, a millisecond `duration`, and **no**
 * `sessionId`, `captureId` or `ingestSeq` — the ingress schema refuses those.
 *
 * @param overrides Fields replacing the defaults.
 * @returns A fresh event that `parseTelemetryEventIngress` accepts.
 */
function makeIngress(overrides: Partial<TelemetryEventIngress> = {}): TelemetryEventIngress {
  const seq = nextSeq;
  nextSeq += 1;

  const base: TelemetryEventIngress = {
    id: newEventId(),
    traceId: newTraceId(),
    spanId: newSpanId(),
    kind: 'interaction',
    name: 'click handleAction',
    startTime: BASE_TIME + seq * 1.5,
    duration: 3.25,
    tier: 'browser',
    attributes: {},
    status: 'ok',
    producerId: PRODUCER,
    seq,
  };

  return { ...base, ...overrides };
}

/**
 * A request-kind event whose attributes carry an HTTP method and a URL — the
 * shape that receives a `request_key`.
 *
 * @param url The request URL as the page reported it, query string included.
 * @param overrides Fields replacing the defaults; `attributes` replaces the whole bag.
 * @param method The HTTP method.
 */
function makeRequestIngress(
  url: string,
  overrides: Partial<TelemetryEventIngress> = {},
  method = 'GET',
): TelemetryEventIngress {
  return makeIngress({
    kind: REQUEST_KIND,
    name: `${method} /api/one`,
    attributes: { [METHOD_KEY]: method, [URL_KEY]: url, [STATUS_KEY]: 200 },
    ...overrides,
  });
}

/** A browser render event: not a request kind, so never keyed. */
function makeRenderIngress(overrides: Partial<TelemetryEventIngress> = {}): TelemetryEventIngress {
  return makeIngress({
    kind: 'render',
    name: 'WidgetPanel',
    attributes: { component: 'WidgetPanel', phase: 'update', renderCount: 3 },
    ...overrides,
  });
}

/** A browser long-task event: not a request kind, so never keyed. */
function makeLongTaskIngress(): TelemetryEventIngress {
  return makeIngress({ kind: 'perf.longtask', name: 'longtask', duration: 87.5 });
}

/**
 * A database span as the dev-server preload reports it.
 *
 * @param statement The statement text, inline literals included.
 */
function makeDbIngress(statement: string): TelemetryEventIngress {
  return makeIngress({
    kind: 'db.query',
    tier: 'db',
    name: 'db query',
    attributes: { 'db.system': 'postgresql', [STATEMENT_KEY]: statement, 'db.rowCount': 1 },
  });
}

/** A server request span as the dev-server preload reports it. */
function makeServerIngress(): TelemetryEventIngress {
  return makeIngress({ kind: 'http.server', tier: 'server', name: 'POST /api/one' });
}

/**
 * A shallow copy of `event` without one top-level field, as an unknown value:
 * the shape a malformed producer sends.
 */
function without(event: TelemetryEventIngress, field: keyof TelemetryEventIngress): unknown {
  const copy: Record<string, unknown> = { ...event };
  Reflect.deleteProperty(copy, field);
  return copy;
}

/** `count` valid events of alternating kinds. */
function manyEvents(count: number): TelemetryEventIngress[] {
  return Array.from({ length: count }, (_, index) =>
    index % 2 === 0 ? makeIngress() : makeRenderIngress(),
  );
}

/* -------------------------------------------------------------------------------------------------
 * The shared call-order log
 * ---------------------------------------------------------------------------------------------- */

/**
 * One tag per collaborator call, pushed by the spy that observed it. The order
 * of the whole pipeline is then one array comparison.
 */
type CallTag =
  | 'resolve'
  | 'secret'
  | 'hash'
  | 'redact'
  | 'attribute'
  | 'locate'
  | 'insert'
  | 'correlate'
  | 'tail';

/** The tags of the per-event and persistence steps AAP §0.7.1 Group 2 orders. */
const PIPELINE_TAGS: ReadonlySet<CallTag> = new Set<CallTag>([
  'hash',
  'redact',
  'attribute',
  'insert',
  'tail',
]);

/* -------------------------------------------------------------------------------------------------
 * Fake telemetry store
 * ---------------------------------------------------------------------------------------------- */

/** How the fake store answers `insertMany`. */
type RepoBehaviour = 'ok' | 'err' | 'throw';

/** The fake store: `insertMany` only, recording exactly what it was handed. */
interface FakeTelemetryRepo extends TelemetryRepoLike {
  /** Every array `insertMany` received, by reference, in call order. */
  readonly calls: (readonly AttributedEvent[])[];
  /** Every array `insertMany` returned, by reference, in call order. */
  readonly returned: TelemetryEvent[][];
}

/**
 * A store double mimicking `telemetry_events`: each written row gains an
 * incrementing `ingestSeq` (the `AUTOINCREMENT` column), and in `dedupe` mode a
 * row whose id is already held is skipped and returned as stored, mimicking
 * `ON CONFLICT(id) DO NOTHING`.
 */
function fakeTelemetryRepo(
  log: CallTag[],
  options: { readonly behaviour?: RepoBehaviour; readonly dedupe?: boolean } = {},
): FakeTelemetryRepo {
  const calls: (readonly AttributedEvent[])[] = [];
  const returned: TelemetryEvent[][] = [];
  const stored = new Map<string, TelemetryEvent>();
  let ingestSeq = 0;

  return {
    calls,
    returned,
    insertMany(events) {
      log.push('insert');
      calls.push(events);

      if (options.behaviour === 'throw') {
        throw new Error('the store connection dropped mid-transaction');
      }

      if (options.behaviour === 'err') {
        return err(new DebuggenError('STORE_ERROR', 'The telemetry store refused the batch.'));
      }

      let inserted = 0;
      let skipped = 0;
      const rows = events.map((event): TelemetryEvent => {
        const existing = options.dedupe === true ? stored.get(event.id) : undefined;

        if (existing !== undefined) {
          skipped += 1;
          return existing;
        }

        ingestSeq += 1;
        inserted += 1;
        const row: TelemetryEvent = { ...event, ingestSeq };
        stored.set(event.id, row);
        return row;
      });

      returned.push(rows);
      return ok({ events: rows, inserted, skipped });
    },
  };
}

/* -------------------------------------------------------------------------------------------------
 * Fake sessions store (the request-key secret)
 * ---------------------------------------------------------------------------------------------- */

/** How the fake sessions store answers `getOrCreateRequestKeySecret`. */
type SecretBehaviour = 'ok' | 'err' | 'throw';

/** The fake sessions store: the secret read only, counting every call. */
interface FakeSessionsRepo {
  /** The session ids the secret was requested for, in call order. */
  readonly requested: SessionId[];
  getOrCreateRequestKeySecret(sessionId: SessionId): Result<string, DebuggenError>;
}

/**
 * A sessions-store double holding one fixed secret.
 *
 * @param secret The value handed out; {@link REQUEST_KEY_SECRET} unless a case
 * needs a malformed one.
 */
function fakeSessionsRepo(
  log: CallTag[],
  options: { readonly behaviour?: SecretBehaviour; readonly secret?: string } = {},
): FakeSessionsRepo {
  const requested: SessionId[] = [];

  return {
    requested,
    getOrCreateRequestKeySecret(sessionId) {
      log.push('secret');
      requested.push(sessionId);

      if (options.behaviour === 'throw') {
        throw new Error('the session_keys table is locked');
      }

      if (options.behaviour === 'err') {
        return err(new DebuggenError('STORE_ERROR', 'The session key could not be read.'));
      }

      return ok(options.secret ?? REQUEST_KEY_SECRET);
    },
  };
}

/* -------------------------------------------------------------------------------------------------
 * The real privacy primitives, wrapped in delegating spies
 * ---------------------------------------------------------------------------------------------- */

/** What the privacy spies observed. */
interface PrivacySpies {
  /** Injected as `deps.privacy`: the real functions, observed. */
  readonly primitives: IngestPrivacyPrimitives;
  /** How many hashers were built — one per batch, never one per event. */
  hasherBuilds(): number;
  /** Every `compute` input, in call order: the method and the URL the hasher saw. */
  readonly hashed: { readonly method: string; readonly url: string }[];
  /** Every digest the real hasher produced, in call order. */
  readonly digests: string[];
  /** Every event handed to the redactor, in call order. */
  readonly redactInputs: (TelemetryEventIngress | TelemetryEvent)[];
  /** Every event the real redactor returned, in call order. */
  readonly redactOutputs: (TelemetryEventIngress | TelemetryEvent)[];
}

/**
 * Wraps the real `createRequestKeyHasher` and `redactEvent` so every call is
 * logged and recorded, then **delegates** — the privacy layer under test is
 * the product's own, never a stub.
 */
function privacySpies(log: CallTag[]): PrivacySpies {
  let builds = 0;
  const hashed: { method: string; url: string }[] = [];
  const digests: string[] = [];
  const redactInputs: (TelemetryEventIngress | TelemetryEvent)[] = [];
  const redactOutputs: (TelemetryEventIngress | TelemetryEvent)[] = [];

  function spiedRedactEvent<T extends TelemetryEventIngress | TelemetryEvent>(
    event: T,
    options?: RedactionOptions,
  ): T {
    log.push('redact');
    redactInputs.push(event);
    const redacted = redactEvent(event, options);
    redactOutputs.push(redacted);
    return redacted;
  }

  function spiedCreateRequestKeyHasher(
    sessionKey: string,
  ): Result<RequestKeyHasher, DebuggenError> {
    builds += 1;
    const real = createRequestKeyHasher(sessionKey);

    if (!real.ok) {
      return real;
    }

    const inner = real.value;

    return ok({
      async compute(method: string, url: string): Promise<Result<string, DebuggenError>> {
        log.push('hash');
        hashed.push({ method, url });
        const digest = await inner.compute(method, url);

        if (digest.ok) {
          digests.push(digest.value);
        }

        return digest;
      },
    });
  }

  return {
    primitives: {
      createRequestKeyHasher: spiedCreateRequestKeyHasher,
      redactEvent: spiedRedactEvent,
    },
    hasherBuilds: () => builds,
    hashed,
    digests,
    redactInputs,
    redactOutputs,
  };
}

/* -------------------------------------------------------------------------------------------------
 * The real attributor over an in-file store, wrapped in a spy
 * ---------------------------------------------------------------------------------------------- */

/**
 * The attribution store: {@link TAB_ID} is bound to {@link SESSION}, whose
 * project is {@link PROJECT_ONE} and whose open capture is {@link CAPTURE}.
 * Every other tab, session or project is absent.
 */
const attributionStore: AttributionStoreLike = {
  getBindingByTab: (tabId) => ok(tabId === TAB_ID ? { sessionId: SESSION } : undefined),
  get: (id) => ok(id === SESSION ? { id: SESSION, projectRoot: PROJECT_ONE } : undefined),
  getActiveCapture: (id) => ok(id === SESSION ? { capture: { id: CAPTURE } } : undefined),
};

/** The product's own attributor: the drop contract and tier gate under test are real. */
const realAttributor = createIngestAttributor({
  sessions: attributionStore,
  sessionManager: {
    captureOwnerForProject: (projectRoot) =>
      projectRoot === PROJECT_ONE ? { sessionId: SESSION, captureId: CAPTURE } : undefined,
  },
  now: fixedClock,
});

/** Per-test replacements for either attributor method. */
interface AttributorOptions {
  readonly resolveBatch?: IngestAttributorLike['resolveBatch'];
  readonly attributeEvent?: IngestAttributorLike['attributeEvent'];
}

/** The attributor spy: every context and event it was handed. */
interface AttributorSpy extends IngestAttributorLike {
  /** Every context `resolveBatch` received, in call order. */
  readonly contexts: IngestContext[];
  /** Every event `attributeEvent` received, in call order. */
  readonly attributed: TelemetryEventIngress[];
}

/**
 * Logs and records each call, then delegates to the per-test replacement or
 * to {@link realAttributor}.
 */
function attributorSpy(log: CallTag[], options: AttributorOptions = {}): AttributorSpy {
  const contexts: IngestContext[] = [];
  const attributed: TelemetryEventIngress[] = [];
  const resolve = options.resolveBatch ?? ((context) => realAttributor.resolveBatch(context));
  const stamp =
    options.attributeEvent ??
    ((event, attribution) => realAttributor.attributeEvent(event, attribution));

  return {
    contexts,
    attributed,
    resolveBatch(context) {
      log.push('resolve');
      contexts.push(context);
      return resolve(context);
    },
    attributeEvent(event, attribution) {
      log.push('attribute');
      attributed.push(event);
      return stamp(event, attribution);
    },
  };
}

/* -------------------------------------------------------------------------------------------------
 * Correlator and live-tail spies
 * ---------------------------------------------------------------------------------------------- */

/** How a spied subsystem answers. `absent` leaves it out of the deps entirely. */
type SubsystemBehaviour = 'ok' | 'err' | 'throw' | 'absent';

/** A correlator double whose `onEventsPersisted` is a Vitest spy. */
function correlatorSpy(log: CallTag[], behaviour: SubsystemBehaviour) {
  const onEventsPersisted = vi.fn(
    (rows: readonly TelemetryEvent[]): Promise<Result<CorrelateUpdate, DebuggenError>> => {
      log.push('correlate');

      if (behaviour === 'throw') {
        return Promise.reject(new Error('the trace cache is corrupt'));
      }

      if (behaviour === 'err') {
        return Promise.resolve(
          err(new DebuggenError('STORE_ERROR', 'The trace rows could not be reloaded.')),
        );
      }

      const tracesTouched = [...new Set(rows.map((row) => row.traceId))];
      return Promise.resolve(ok({ tracesTouched, rebuilt: tracesTouched.length, orphanCount: 0 }));
    },
  );

  const correlator: TraceCorrelatorLike = { onEventsPersisted };
  return { correlator, onEventsPersisted };
}

/** A live-tail double whose `push` is a Vitest spy. */
function tailSpy(log: CallTag[], behaviour: SubsystemBehaviour) {
  const push = vi.fn(
    (sessionId: SessionId, rows: readonly TelemetryEvent[]): Result<void, DebuggenError> => {
      log.push('tail');

      if (behaviour === 'throw') {
        throw new Error(`the tail buffer for ${sessionId} overflowed with ${String(rows.length)}`);
      }

      if (behaviour === 'err') {
        return err(new DebuggenError('TRANSPORT_DISCONNECTED', 'No DevTools client is listening.'));
      }

      return ok(undefined);
    },
  );

  const liveTail: LiveTailLike = { push };
  return { liveTail, push };
}

/* -------------------------------------------------------------------------------------------------
 * Recording logger
 * ---------------------------------------------------------------------------------------------- */

/** One record the logger received, with every child binding merged in. */
interface LogEntry {
  readonly level: LogLevel;
  readonly message: string;
  readonly fields: LogFields;
}

/** A `Logger` that records every message and fields object, children included. */
function recordingLogger(): { readonly logger: Logger; readonly entries: LogEntry[] } {
  const entries: LogEntry[] = [];

  function make(bindings: LogFields): Logger {
    const writer =
      (level: LogLevel) =>
      (message: string, fields?: LogFields): void => {
        entries.push({ level, message, fields: { ...bindings, ...fields } });
      };

    return {
      level: 'trace',
      trace: writer('trace'),
      debug: writer('debug'),
      info: writer('info'),
      warn: writer('warn'),
      error: writer('error'),
      fatal: writer('fatal'),
      child: (extra) => make({ ...bindings, ...extra }),
    };
  }

  return { logger: make({}), entries };
}

/* -------------------------------------------------------------------------------------------------
 * The harness
 * ---------------------------------------------------------------------------------------------- */

/** Everything one case can configure; every default is the happy path. */
interface HarnessOptions {
  readonly repo?: RepoBehaviour;
  readonly dedupe?: boolean;
  readonly secret?: SecretBehaviour;
  readonly secretValue?: string;
  readonly attributor?: AttributorOptions;
  readonly correlator?: SubsystemBehaviour;
  readonly tail?: SubsystemBehaviour;
  readonly maxBatch?: number;
  readonly sources?: IngestSourceLocator;
  readonly locateBudgetMs?: number;
  /** The ingest clock; defaults to {@link fixedClock}. Only the log-throttle cases move it. */
  readonly now?: () => number;
}

/** One pipeline and every double it was built from. */
interface Harness {
  readonly ingest: TelemetryIngest;
  readonly log: CallTag[];
  readonly repo: FakeTelemetryRepo;
  readonly sessions: FakeSessionsRepo;
  readonly privacy: PrivacySpies;
  readonly attributor: AttributorSpy;
  readonly correlator: ReturnType<typeof correlatorSpy>;
  readonly tail: ReturnType<typeof tailSpy>;
  readonly logs: LogEntry[];
}

/** Builds a pipeline over fresh doubles that all write into one call-order log. */
function harness(options: HarnessOptions = {}): Harness {
  const log: CallTag[] = [];
  const repo = fakeTelemetryRepo(log, {
    ...(options.repo === undefined ? {} : { behaviour: options.repo }),
    ...(options.dedupe === undefined ? {} : { dedupe: options.dedupe }),
  });
  const sessions = fakeSessionsRepo(log, {
    ...(options.secret === undefined ? {} : { behaviour: options.secret }),
    ...(options.secretValue === undefined ? {} : { secret: options.secretValue }),
  });
  const privacy = privacySpies(log);
  const attributor = attributorSpy(log, options.attributor);
  const correlatorBehaviour = options.correlator ?? 'ok';
  const tailBehaviour = options.tail ?? 'ok';
  const correlator = correlatorSpy(log, correlatorBehaviour);
  const tail = tailSpy(log, tailBehaviour);
  const { logger, entries } = recordingLogger();

  const ingest = createTelemetryIngest({
    telemetry: repo,
    sessions,
    attributor,
    correlator: correlatorBehaviour === 'absent' ? undefined : correlator.correlator,
    liveTail: tailBehaviour === 'absent' ? undefined : tail.liveTail,
    logger,
    now: options.now ?? fixedClock,
    maxBatch: options.maxBatch,
    privacy: privacy.primitives,
    sources: options.sources,
    locateBudgetMs: options.locateBudgetMs,
  });

  return { ingest, log, repo, sessions, privacy, attributor, correlator, tail, logs: entries };
}

/** The browser transport identity of a batch relayed for {@link TAB_ID}. */
const BROWSER_CONTEXT: IngestContext = { origin: 'browser-agent', tabId: TAB_ID };

/** The server transport identity of a batch from {@link PROJECT_ONE}'s preload. */
const SERVER_CONTEXT: IngestContext = {
  origin: 'server-agent',
  projectRoot: PROJECT_ONE,
  scopedProjectRoot: PROJECT_ONE,
};

/** The report of an `ok` result; fails the case with the error code otherwise. */
function expectReport(result: Result<IngestReport, DebuggenError>): IngestReport {
  if (!result.ok) {
    throw new Error(`expected an ingest report, got ${result.error.code}`);
  }

  return result.value;
}

/** The error of an `Err` result; fails the case otherwise. */
function expectError(result: Result<IngestReport, DebuggenError>): DebuggenError {
  if (result.ok) {
    throw new Error('expected an ingest error, got a report');
  }

  expect(DebuggenError.is(result.error)).toBe(true);
  expect(DEBUGGEN_ERROR_CODES).toContain(result.error.code);
  return result.error;
}

/** The rows of the store's only `insertMany` call. */
function insertedRows(repo: FakeTelemetryRepo): readonly AttributedEvent[] {
  expect(repo.calls).toHaveLength(1);
  return repo.calls[0] ?? [];
}

/** The one row a single-event batch persisted. */
function onlyRow(repo: FakeTelemetryRepo): AttributedEvent {
  const rows = insertedRows(repo);
  expect(rows).toHaveLength(1);
  const [row] = rows;

  if (row === undefined) {
    throw new Error('expected one persisted row');
  }

  return row;
}

/** A string attribute of a row, failing the case when it is not a string. */
function stringAttribute(event: AttributedEvent | TelemetryEventIngress, key: string): string {
  const value = event.attributes[key];

  if (typeof value !== 'string') {
    throw new Error(`expected attribute ${key} to be a string`);
  }

  return value;
}

/** The digest the real hasher computes for one request under `secret`. */
async function independentDigest(method: string, url: string, secret = REQUEST_KEY_SECRET) {
  const hasher = createRequestKeyHasher(secret);

  if (!hasher.ok) {
    throw new Error('the fixture secret must be a valid session key');
  }

  const digest = await hasher.value.compute(method, url);

  if (!digest.ok) {
    throw new Error('the host must provide Web Crypto');
  }

  return digest.value;
}

/** Every drop reason at zero except the ones named. */
function dropCounts(nonZero: Partial<Record<DropReason, number>> = {}): Record<DropReason, number> {
  const counts = {} as Record<DropReason, number>;

  for (const reason of DROP_REASONS) {
    counts[reason] = nonZero[reason] ?? 0;
  }

  return counts;
}

/* =================================================================================================
 * The fixtures themselves
 * ============================================================================================== */

describe('fixtures', () => {
  it('builds valid producer events that carry no service-assigned field', () => {
    const events = [
      makeIngress(),
      makeRequestIngress('/api/one?itemId=A'),
      makeRenderIngress(),
      makeLongTaskIngress(),
      makeDbIngress('SELECT id FROM widgets WHERE qty = 1'),
      makeServerIngress(),
    ];

    for (const event of events) {
      expect(parseTelemetryEventIngress(event).ok).toBe(true);
      expect(TELEMETRY_KINDS).toContain(event.kind);
      expect(TELEMETRY_TIERS).toContain(event.tier);
      expect('sessionId' in event).toBe(false);
      expect('captureId' in event).toBe(false);
      expect('ingestSeq' in event).toBe(false);
      expect(Number.isInteger(event.startTime)).toBe(false);
      expect(event.startTime).toBeGreaterThan(MIN_EPOCH_MS);
    }
  });

  it('uses a request kind from the upstream vocabulary and a well-formed session secret', () => {
    expect(REQUEST_KINDS).toContain(REQUEST_KIND);
    expect(REQUEST_KEY_SECRET).toMatch(/^[0-9a-f]{64}$/);
    expect(createRequestKeyHasher(REQUEST_KEY_SECRET).ok).toBe(true);
  });

  it('derives exactly one request-key attribute from the upstream vocabulary', () => {
    expect(UPSTREAM_REQUEST_KEY_ATTRIBUTES).toHaveLength(1);
    expect(SERVICE_ASSIGNED_ATTRIBUTE_KEYS).toContain(REQUEST_KEY_ATTRIBUTE);
    expect(INGEST_REQUEST_KEY_ATTRIBUTE).toBe(REQUEST_KEY_ATTRIBUTE);
  });
});

/* =================================================================================================
 * 1. The mandatory order — the heart of the suite
 * ============================================================================================== */

describe('the mandatory order', () => {
  it('runs hash → redact → attribute → insert → correlate → tail for a request event', async () => {
    const h = harness();

    const report = expectReport(
      await h.ingest.ingest(BROWSER_CONTEXT, [makeRequestIngress('/api/one?itemId=A')]),
    );

    // The order is fixed by the folder brief and AAP §0.7.1 Group 2 row 6:
    // validate → request_key → redact → attribute → persist → correlate → tail.
    // Attribution is resolved once and the secret read once *before* the first
    // event is hashed, because the HMAC is keyed per session.
    expect(h.log).toEqual([
      'resolve',
      'secret',
      'hash',
      'redact',
      'attribute',
      'insert',
      'correlate',
      'tail',
    ]);
    expect(h.log.filter((tag) => PIPELINE_TAGS.has(tag))).toEqual([
      'hash',
      'redact',
      'attribute',
      'insert',
      'tail',
    ]);
    expect(report.persisted).toBe(1);
    expect(report.requestKeysComputed).toBe(1);
  });

  it('keys every request before redacting, and redacts each event before attributing it', async () => {
    const h = harness();
    const batch = [
      makeRequestIngress('/api/one?itemId=A'),
      makeRenderIngress(),
      makeRequestIngress('/api/one?itemId=B'),
      makeLongTaskIngress(),
      makeRequestIngress('/api/one?itemId=C'),
    ];

    expectReport(await h.ingest.ingest(BROWSER_CONTEXT, batch));

    expect(h.log).toEqual([
      'resolve',
      'secret',
      'hash',
      'hash',
      'hash',
      'redact',
      'attribute',
      'redact',
      'attribute',
      'redact',
      'attribute',
      'redact',
      'attribute',
      'redact',
      'attribute',
      'insert',
      'correlate',
      'tail',
    ]);

    // Each event is redacted exactly once, in batch order, and what the
    // attributor receives is the redactor's output itself — never the raw event.
    expect(h.privacy.redactInputs.map((event) => event.id)).toEqual(batch.map((event) => event.id));
    expect(h.attributor.attributed).toHaveLength(batch.length);
    h.attributor.attributed.forEach((event, index) => {
      expect(event).toBe(h.privacy.redactOutputs[index]);
    });
  });

  it('computes request_key from the unredacted URL: a digest of the masked URL would differ', async () => {
    // The same property is pinned upstream by
    // packages/telemetry/src/redaction/request-key.test.ts; here it is proven
    // for the order ingest actually runs.
    const queryValue = sentinel('query');
    const url = `/api/one?itemId=${queryValue}`;
    const h = harness();

    expectReport(await h.ingest.ingest(BROWSER_CONTEXT, [makeRequestIngress(url)]));

    expect(h.privacy.hashed).toEqual([{ method: 'GET', url }]);
    expect(h.privacy.hashed[0]?.url).toContain(queryValue);

    const row = onlyRow(h.repo);
    const storedUrl = stringAttribute(row, URL_KEY);
    const storedKey = stringAttribute(row, REQUEST_KEY_ATTRIBUTE);

    expect(storedUrl).not.toContain(queryValue);
    expect(storedUrl).toContain('itemId=');

    const unmaskedDigest = await independentDigest('GET', url);
    const maskedDigest = await independentDigest('GET', storedUrl);

    expect(storedKey).toBe(unmaskedDigest);
    expect(maskedDigest).not.toBe(unmaskedDigest);
    expect(storedKey).not.toBe(maskedDigest);
  });

  it('keeps parameter-distinct requests apart and makes byte-identical requests collide', async () => {
    const h = harness();
    const first = makeRequestIngress('/api/one?itemId=A');
    const other = makeRequestIngress('/api/one?itemId=B');
    const repeat = makeRequestIngress('/api/one?itemId=A');

    expectReport(await h.ingest.ingest(BROWSER_CONTEXT, [first, other, repeat]));

    const [rowFirst, rowOther, rowRepeat] = insertedRows(h.repo);

    if (rowFirst === undefined || rowOther === undefined || rowRepeat === undefined) {
      throw new Error('expected three persisted rows');
    }

    // After redaction all three display identically…
    const displayed = [rowFirst, rowOther, rowRepeat].map((row) => stringAttribute(row, URL_KEY));
    expect(new Set(displayed).size).toBe(1);
    expect(displayed[0]).not.toContain('itemId=A');

    // …so only the pre-redaction key can tell a distinct request from a duplicate.
    const keyFirst = stringAttribute(rowFirst, REQUEST_KEY_ATTRIBUTE);
    expect(stringAttribute(rowOther, REQUEST_KEY_ATTRIBUTE)).not.toBe(keyFirst);
    expect(stringAttribute(rowRepeat, REQUEST_KEY_ATTRIBUTE)).toBe(keyFirst);
  });

  it('builds one hasher and reads the session secret once per batch, however many requests it holds', async () => {
    const h = harness();
    const batch = Array.from({ length: 25 }, (_, index) =>
      makeRequestIngress(`/api/one?itemId=${String(index)}`),
    );

    const report = expectReport(await h.ingest.ingest(BROWSER_CONTEXT, batch));

    // The folder brief mandates `createRequestKeyHasher` over the one-shot
    // `computeRequestKey`: the HMAC key is imported once per hasher, so one
    // build per batch is one key import per batch.
    expect(h.sessions.requested).toEqual([SESSION]);
    expect(h.privacy.hasherBuilds()).toBe(1);
    expect(h.privacy.hashed).toHaveLength(batch.length);
    expect(report.requestKeysComputed).toBe(batch.length);

    expectReport(await h.ingest.ingest(BROWSER_CONTEXT, [makeRequestIngress('/api/one?x=1')]));
    expect(h.sessions.requested).toEqual([SESSION, SESSION]);
    expect(h.privacy.hasherBuilds()).toBe(2);
  });

  it('writes the digest under the upstream service-assigned key and adds no other attribute', async () => {
    const h = harness();
    const event = makeRequestIngress('/api/one?itemId=A');

    expectReport(await h.ingest.ingest(BROWSER_CONTEXT, [event]));

    const row = onlyRow(h.repo);
    const added = Object.keys(row.attributes).filter((key) => !(key in event.attributes));

    expect(added).toEqual([REQUEST_KEY_ATTRIBUTE]);
    expect(row.attributes[REQUEST_KEY_ATTRIBUTE]).toBe(h.privacy.digests[0]);
  });

  it('lets request_key survive redaction while the URL of the same event is masked', async () => {
    const h = harness();

    expectReport(
      await h.ingest.ingest(BROWSER_CONTEXT, [makeRequestIngress('/api/one?itemId=A&page=2')]),
    );

    const row = onlyRow(h.repo);

    expect(stringAttribute(row, REQUEST_KEY_ATTRIBUTE)).toMatch(/^[0-9a-f]{64}$/);
    expect(stringAttribute(row, REQUEST_KEY_ATTRIBUTE)).toBe(h.privacy.digests[0]);
    expect(stringAttribute(row, URL_KEY)).not.toContain('itemId=A');
    expect(row.redacted).toContain(URL_KEY);
    expect(row.redacted ?? []).not.toContain(REQUEST_KEY_ATTRIBUTE);
  });

  it('never keys a non-request kind, and never calls the hasher for one', async () => {
    const h = harness();

    const report = expectReport(
      await h.ingest.ingest(BROWSER_CONTEXT, [makeRenderIngress(), makeLongTaskIngress()]),
    );

    expect(h.privacy.hashed).toEqual([]);
    expect(h.log.filter((tag) => tag === 'hash')).toEqual([]);
    expect(report.requestKeysComputed).toBe(0);
    expect(report.persisted).toBe(2);

    for (const row of insertedRows(h.repo)) {
      expect(REQUEST_KEY_ATTRIBUTE in row.attributes).toBe(false);
    }
  });

  it('discards a producer-supplied request_key on every kind and writes only its own digest', async () => {
    const forged = sentinel('forged-key');
    const h = harness();
    const request = makeRequestIngress('/api/one?itemId=A');
    const render = makeRenderIngress();

    const report = expectReport(
      await h.ingest.ingest(BROWSER_CONTEXT, [
        { ...request, attributes: { ...request.attributes, [REQUEST_KEY_ATTRIBUTE]: forged } },
        { ...render, attributes: { ...render.attributes, [REQUEST_KEY_ATTRIBUTE]: forged } },
      ]),
    );

    const [requestRow, renderRow] = insertedRows(h.repo);

    expect(report.serviceKeysStripped).toBe(2);
    expect(requestRow?.attributes[REQUEST_KEY_ATTRIBUTE]).toBe(h.privacy.digests[0]);
    expect(renderRow !== undefined && REQUEST_KEY_ATTRIBUTE in renderRow.attributes).toBe(false);
    expect(JSON.stringify(h.repo.calls)).not.toContain(forged);
    expect(JSON.stringify(h.privacy.hashed)).not.toContain(forged);
  });
});

/* =================================================================================================
 * 2. Redaction wiring and the store contract
 * ============================================================================================== */

describe('source locations (step 7½)', () => {
  const LOCATION: SourceLocation = {
    file: 'src/components/Widget.tsx',
    line: 52,
    column: 7,
    resolvedBy: 'source-map',
    confidence: 0.7,
  };
  const STAMPED: SourceLocation = {
    file: 'src/server/ledger.ts',
    line: 10,
    column: 3,
    symbol: 'loadLedger',
    resolvedBy: 'patch',
    confidence: 1,
  };
  /**
   * A location a page script stamps on an event it forges: contained,
   * schema-valid and plausible — nothing about its shape gives it away.
   */
  const FORGED: SourceLocation = {
    file: 'src/components/ForgedPanel.tsx',
    line: 999,
    column: 1,
    symbol: 'ForgedPanel',
    resolvedBy: 'code-graph',
    confidence: 0.85,
  };

  /** How the locator answers: its own locations for the events it was handed. */
  type LocatorAnswer = (
    events: readonly AttributedEvent[],
  ) => ReadonlyMap<string, SourceLocation> | null;

  /** The default answer: every event handed over is placed at {@link LOCATION}. */
  const placeAll: LocatorAnswer = (events) => new Map(events.map((event) => [event.id, LOCATION]));

  /**
   * A locator that records what it was handed and answers with `answer`,
   * writing into the call-order log `order` returns when it is called.
   */
  function locatorSpy(
    order: () => CallTag[],
    behaviour: SubsystemBehaviour = 'ok',
    answer: LocatorAnswer = placeAll,
  ) {
    const locate = vi.fn(
      (
        events: readonly AttributedEvent[],
      ): Promise<Result<ReadonlyMap<string, SourceLocation>, DebuggenError>> => {
        order().push('locate');
        if (behaviour === 'throw') {
          return Promise.reject(new Error('the source map could not be fetched'));
        }
        if (behaviour === 'err') {
          return Promise.resolve(
            err(new DebuggenError('CODE_INDEX_FAILED', 'The project could not be indexed.')),
          );
        }
        // `null` stands for a locator whose `ok` answer is not a readable map.
        return Promise.resolve(ok(answer(events) as ReadonlyMap<string, SourceLocation>));
      },
    );
    const sources: IngestSourceLocator = { locate };
    return { sources, locate };
  }

  /** Every row a case stored, then correlated, then tailed: where a claim could survive. */
  function rowsDownstream(h: Harness): readonly (AttributedEvent | TelemetryEvent)[] {
    return [
      ...insertedRows(h.repo),
      ...(h.correlator.onEventsPersisted.mock.calls[0]?.[0] ?? []),
      ...(h.tail.push.mock.calls[0]?.[1] ?? []),
    ];
  }

  it('locates redacted, attributed events before they are stored, and stores and tails the location', async () => {
    const spy = locatorSpy(() => h.log);
    const h = harness({ sources: spy.sources });

    const report = expectReport(
      await h.ingest.ingest(BROWSER_CONTEXT, [makeRequestIngress('/api/one?itemId=A')]),
    );

    expect(h.log).toEqual([
      'resolve',
      'secret',
      'hash',
      'redact',
      'attribute',
      'locate',
      'insert',
      'correlate',
      'tail',
    ]);
    const handed = spy.locate.mock.calls[0]?.[0] ?? [];
    expect(handed).toHaveLength(1);
    // Redacted and attributed: the query value is masked and the session stamped.
    const first = handed[0];
    expect(first === undefined ? '' : stringAttribute(first, URL_KEY)).not.toContain('itemId=A');
    expect(first?.sessionId).toBe(report.sessionId);
    expect(onlyRow(h.repo).source).toEqual(LOCATION);
    const tailed = h.tail.push.mock.calls[0]?.[1] ?? [];
    expect(tailed.map((row) => row.source)).toEqual([LOCATION]);
    expect(report.sourcesLocated).toBe(1);
    expect(report.failures.location).toBe(0);
  });

  it('hands every event to the locator, a patch claim included, and stores its answer instead of the claim', async () => {
    const spy = locatorSpy(() => []);
    const h = harness({ sources: spy.sources });

    const report = expectReport(
      await h.ingest.ingest(BROWSER_CONTEXT, [
        makeRenderIngress({ source: STAMPED }),
        makeIngress(),
      ]),
    );

    // The claim reaches the verifier (a patch claim is corroborated, not recomputed)…
    const handed = spy.locate.mock.calls[0]?.[0] ?? [];
    expect(handed).toHaveLength(2);
    expect(handed.map((event) => event.source)).toEqual([STAMPED, undefined]);
    // …and what is stored is the locator's answer, never the claim.
    expect(insertedRows(h.repo).map((row) => row.source)).toEqual([LOCATION, LOCATION]);
    expect(report.sourcesLocated).toBe(2);
    expect(report.sourcesRefused).toBe(0);
    expect(report.failures.location).toBe(0);
  });

  it('keeps a producer claim the locator confirms', async () => {
    const spy = locatorSpy(
      () => [],
      'ok',
      (events) =>
        new Map(
          events.flatMap((event) =>
            event.source === undefined ? [] : [[event.id, event.source] as const],
          ),
        ),
    );
    const h = harness({ sources: spy.sources });

    // A preload span whose patch claim the journal corroborates, beside one the locator cannot place.
    const report = expectReport(
      await h.ingest.ingest(SERVER_CONTEXT, [
        { ...makeServerIngress(), source: STAMPED },
        makeServerIngress(),
      ]),
    );

    const [confirmed, unplaced] = insertedRows(h.repo);
    expect(confirmed?.source).toEqual(STAMPED);
    expect(unplaced !== undefined && 'source' in unplaced).toBe(false);
    expect(h.tail.push.mock.calls[0]?.[1].map((row) => row.source)).toEqual([STAMPED, undefined]);
    expect(report.sourcesLocated).toBe(1);
    expect(report.sourcesRefused).toBe(0);
    expect(report.failures.location).toBe(0);
  });

  it('stores a forged claim the locator does not confirm without a source, and never correlates or tails it', async () => {
    const spy = locatorSpy(
      () => [],
      'ok',
      () => new Map(),
    );
    const h = harness({ sources: spy.sources });

    const report = expectReport(
      await h.ingest.ingest(BROWSER_CONTEXT, [
        makeRenderIngress({ source: FORGED }),
        makeIngress(),
      ]),
    );

    expect(spy.locate).toHaveBeenCalledTimes(1);
    // No producer stamps a code-graph location, so the verifier is not even offered the claim.
    const handed = spy.locate.mock.calls[0]?.[0] ?? [];
    expect(handed).toHaveLength(2);
    expect(handed.map((event) => 'source' in event)).toEqual([false, false]);
    expect(report.persisted).toBe(2);
    const downstream = rowsDownstream(h);
    expect(downstream).toHaveLength(6);
    for (const row of downstream) {
      // Removed, not set to `undefined`: the stored document holds no `source` key at all.
      expect('source' in row).toBe(false);
    }
    expect(JSON.stringify(downstream)).not.toContain(FORGED.file);
    expect(report.sourcesLocated).toBe(0);
    expect(report.sourcesRefused).toBe(1);
    // A refusal is the verifier working, not failing.
    expect(report.failures.location).toBe(0);
  });

  it('with the real resolver, keeps an exact patch claim and stores one with an invented line on the same file without a source', async () => {
    // The journal of a session that really patched the stamped function: its diff adds the wrapper
    // the patch template writes, `meta` literal included, as the patcher journals it.
    const meta = {
      file: STAMPED.file,
      line: STAMPED.line,
      column: STAMPED.column,
      symbol: 'loadLedger',
    };
    const wrapper = buildWrapperBody({
      language: 'typescript',
      callStyle: 'arguments',
      spanName: meta.symbol,
      meta,
    });
    if (!wrapper.ok) {
      throw new Error(`the patch template refused the fixture: ${wrapper.error.code}`);
    }
    const added = wrapper.value.text.split('\n').map((line) => `+  ${line}`);
    const record = createModificationRecord(
      {
        sessionId: SESSION,
        planVersion: 1,
        file: meta.file,
        originalHash: 'a'.repeat(64),
        backupPath: `/tmp/debuggen-backups/${SESSION}/${'a'.repeat(64)}`,
        instrumentedHash: 'b'.repeat(64),
        diff: [
          `--- ${meta.file}\toriginal`,
          `+++ ${meta.file}\tinstrumented`,
          `@@ -${String(meta.line)},2 +${String(meta.line)},${String(2 + added.length)} @@`,
          ` export function ${meta.symbol}(id: string): string {`,
          ...added,
          '   return id;',
        ].join('\n'),
        status: 'applied',
      },
      { now: fixedClock },
    );
    if (!record.ok) {
      throw new Error(`the fixture record is invalid: ${record.error.code}`);
    }
    // The locator `main.ts` wires, minus the session lookup: the real resolver over that journal.
    const resolver = createSourceResolver({
      projectRoot: PROJECT_ONE,
      modifications: {
        listBySession: (sessionId) => ok(sessionId === SESSION ? [record.value] : []),
        listPatchEvidence: (sessionId, file) =>
          ok(sessionId === SESSION && file === record.value.file ? [record.value] : []),
      },
    });
    const h = harness({ sources: { locate: (events) => resolver.resolveEvents(events) } });

    // What a page script hands the public span helper: the instrumented file, an invented line.
    const invented: SourceLocation = { ...STAMPED, line: 999 };
    const report = expectReport(
      await h.ingest.ingest(BROWSER_CONTEXT, [
        makeIngress({ kind: 'function', name: meta.symbol, source: STAMPED }),
        makeIngress({ kind: 'function', name: meta.symbol, source: invented }),
      ]),
    );

    const [genuine, forged] = insertedRows(h.repo);
    expect(genuine?.source).toEqual(STAMPED);
    expect(forged !== undefined && 'source' in forged).toBe(false);
    expect(h.tail.push.mock.calls[0]?.[1].map((row) => row.source)).toEqual([STAMPED, undefined]);
    expect(report.sourcesLocated).toBe(1);
    expect(report.sourcesRefused).toBe(1);
    expect(report.failures.location).toBe(0);
  });

  it('replaces a claim on a route no producer stamps with the location the locator computes itself', async () => {
    const spy = locatorSpy(() => []);
    const h = harness({ sources: spy.sources });

    const report = expectReport(
      await h.ingest.ingest(BROWSER_CONTEXT, [makeRenderIngress({ source: FORGED })]),
    );

    expect(spy.locate.mock.calls[0]?.[0].map((event) => event.source)).toEqual([undefined]);
    expect(onlyRow(h.repo).source).toEqual(LOCATION);
    expect(report.sourcesLocated).toBe(1);
    expect(report.sourcesRefused).toBe(0);
  });

  it('strips every producer claim when no locator is wired, since nothing can verify it', async () => {
    const h = harness();

    const report = expectReport(
      await h.ingest.ingest(BROWSER_CONTEXT, [
        makeRenderIngress({ source: FORGED }),
        makeRenderIngress({ source: STAMPED }),
        makeIngress(),
      ]),
    );

    expect(report.persisted).toBe(3);
    for (const row of rowsDownstream(h)) {
      expect('source' in row).toBe(false);
    }
    expect(report.sourcesLocated).toBe(0);
    expect(report.sourcesRefused).toBe(2);
    expect(report.failures.location).toBe(0);
  });

  for (const behaviour of ['err', 'throw'] as const) {
    it(`stores the batch without locations, claims stripped and counted, when the locator answers ${behaviour}`, async () => {
      const spy = locatorSpy(() => [], behaviour);
      const h = harness({ sources: spy.sources });

      const report = expectReport(
        await h.ingest.ingest(BROWSER_CONTEXT, [
          makeIngress(),
          makeRenderIngress({ source: FORGED }),
          makeRenderIngress({ source: STAMPED }),
        ]),
      );

      // Every event is still stored; not even the patch claim survives an unanswered check.
      expect(report.persisted).toBe(3);
      for (const row of rowsDownstream(h)) {
        expect('source' in row).toBe(false);
      }
      expect(report.failures.location).toBe(1);
      expect(report.sourcesLocated).toBe(0);
      expect(report.sourcesUnplacedByBudget).toBe(0);
      expect(report.sourcesRefused).toBe(2);

      const warning = h.logs.find(
        (entry) => entry.level === 'warn' && entry.message.includes('could not be located'),
      );
      expect(warning?.fields).toMatchObject({ pending: 3, sourcesRefused: 2 });
      expect(warning?.fields.code).toBe(behaviour === 'err' ? 'CODE_INDEX_FAILED' : 'INTERNAL');
      // Counts only: no location a producer claimed reaches a log record.
      const logged = JSON.stringify(h.logs);
      expect(logged).not.toContain(FORGED.file);
      expect(logged).not.toContain(STAMPED.file);
    });
  }

  describe('the locate budget', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    /** The answer type of a locator, spelled once. */
    type LocateResult = Result<ReadonlyMap<string, SourceLocation>, DebuggenError>;

    /**
     * A locator that places the first event of its batch and answers with that
     * alone once its budget fires — the contract of `IngestLocateOptions` — and
     * reports each signal it was handed and when it was first called.
     */
    function budgetedLocator() {
      const signals: AbortSignal[] = [];
      let markReached: () => void = () => undefined;
      const reached = new Promise<void>((resolve) => {
        markReached = resolve;
      });
      const locate = vi.fn<IngestSourceLocator['locate']>(
        (events, _attribution, options?: IngestLocateOptions) => {
          const signal = options?.signal;
          markReached();
          const [first] = events;
          const partial = new Map<string, SourceLocation>(
            first === undefined ? [] : [[first.id, LOCATION]],
          );
          return new Promise<LocateResult>((resolve) => {
            if (signal === undefined) {
              resolve(ok(partial));
              return;
            }
            signals.push(signal);
            signal.addEventListener(
              'abort',
              () => {
                resolve(ok(partial));
              },
              { once: true },
            );
          });
        },
      );
      const sources: IngestSourceLocator = { locate };
      return { sources, locate, signals, reached };
    }

    it('hands the locator its budget and stores the batch with what was placed when it fired', async () => {
      vi.useFakeTimers();
      const locator = budgetedLocator();
      const h = harness({ sources: locator.sources });

      const pending = h.ingest.ingest(BROWSER_CONTEXT, [
        makeIngress(),
        makeRenderIngress(),
        makeIngress(),
      ]);
      await locator.reached;
      expect(locator.signals).toHaveLength(1);
      expect(locator.signals[0]?.aborted).toBe(false);
      expect(h.repo.calls).toEqual([]);

      await vi.advanceTimersByTimeAsync(DEFAULT_LOCATE_BUDGET_MS);
      const report = expectReport(await pending);

      expect(locator.signals[0]?.aborted).toBe(true);
      expect(report).toMatchObject({ persisted: 3, sourcesLocated: 1, sourcesUnplacedByBudget: 2 });
      expect(report.failures.location).toBe(0);
      expect(insertedRows(h.repo).map((row) => row.source)).toEqual([
        LOCATION,
        undefined,
        undefined,
      ]);
      expect(h.log.slice(-3)).toEqual(['insert', 'correlate', 'tail']);
      const warning = h.logs.find((entry) => entry.level === 'warn' && entry.fields.unplaced === 2);
      expect(warning?.fields).toMatchObject({
        pending: 3,
        unplaced: 2,
        budgetMs: DEFAULT_LOCATE_BUDGET_MS,
      });
      expect(vi.getTimerCount()).toBe(0);
    });

    it('stops waiting for a locator that ignores its budget, and stores the batch without locations', async () => {
      vi.useFakeTimers();
      const held: ((value: LocateResult) => void)[] = [];
      let markReached: () => void = () => undefined;
      const reached = new Promise<void>((resolve) => {
        markReached = resolve;
      });
      const locate = vi.fn<IngestSourceLocator['locate']>(() => {
        markReached();
        return new Promise<LocateResult>((resolve) => {
          held.push(resolve);
        });
      });
      const h = harness({ sources: { locate } });
      let settled = false;

      const pending = h.ingest.ingest(BROWSER_CONTEXT, [makeIngress(), makeIngress()]);
      void pending.then(() => {
        settled = true;
      });
      await reached;

      // The budget fired and was ignored; the grace has not yet run out.
      await vi.advanceTimersByTimeAsync(DEFAULT_LOCATE_BUDGET_MS);
      expect(settled).toBe(false);
      expect(h.repo.calls).toEqual([]);

      await vi.advanceTimersByTimeAsync(LOCATE_BUDGET_GRACE_MS);
      const report = expectReport(await pending);

      expect(report).toMatchObject({ persisted: 2, sourcesLocated: 0, sourcesUnplacedByBudget: 2 });
      expect(report.failures.location).toBe(0);
      expect(insertedRows(h.repo).map((row) => row.source)).toEqual([undefined, undefined]);
      expect(vi.getTimerCount()).toBe(0);

      // A locator that answers after ingest stopped waiting changes nothing.
      for (const resolve of held) {
        resolve(ok(new Map()));
      }
      await vi.advanceTimersByTimeAsync(0);
      expect(h.repo.calls).toHaveLength(1);
    });

    it('honours a configured budget up to its maximum and ignores any other value', async () => {
      vi.useFakeTimers();
      const cases: readonly (readonly [number, number])[] = [
        [50, 50],
        [MAX_LOCATE_BUDGET_MS, MAX_LOCATE_BUDGET_MS],
        [MAX_LOCATE_BUDGET_MS + 1, DEFAULT_LOCATE_BUDGET_MS],
        [0, DEFAULT_LOCATE_BUDGET_MS],
        [-5, DEFAULT_LOCATE_BUDGET_MS],
        [Number.NaN, DEFAULT_LOCATE_BUDGET_MS],
        [Number.POSITIVE_INFINITY, DEFAULT_LOCATE_BUDGET_MS],
      ];

      for (const [option, expected] of cases) {
        const locator = budgetedLocator();
        const h = harness({ sources: locator.sources, locateBudgetMs: option });

        const pending = h.ingest.ingest(BROWSER_CONTEXT, [makeIngress()]);
        await locator.reached;
        await vi.advanceTimersByTimeAsync(expected - 1);
        expect(locator.signals[0]?.aborted).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect(locator.signals[0]?.aborted).toBe(true);
        expect(expectReport(await pending).sourcesLocated).toBe(1);
      }
    });

    it('clears its timers when the locator answers in time and counts nothing against the budget', async () => {
      vi.useFakeTimers();
      const handed: (AbortSignal | undefined)[] = [];
      const locate = vi.fn<IngestSourceLocator['locate']>((events, _attribution, options) => {
        handed.push(options?.signal);
        return Promise.resolve(ok(new Map(events.map((event) => [event.id, LOCATION]))));
      });
      const h = harness({ sources: { locate } });

      const report = expectReport(await h.ingest.ingest(BROWSER_CONTEXT, [makeIngress()]));

      expect(report).toMatchObject({ sourcesLocated: 1, sourcesUnplacedByBudget: 0 });
      expect(handed).toHaveLength(1);
      expect(handed[0]?.aborted).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  it('treats an ok answer that is not a readable map as a failure, not as confirmation', async () => {
    const spy = locatorSpy(
      () => [],
      'ok',
      () => null,
    );
    const h = harness({ sources: spy.sources });

    const report = expectReport(
      await h.ingest.ingest(BROWSER_CONTEXT, [makeRenderIngress({ source: STAMPED })]),
    );

    expect(report.persisted).toBe(1);
    expect('source' in onlyRow(h.repo)).toBe(false);
    expect(report.failures.location).toBe(1);
    expect(report.sourcesRefused).toBe(1);
  });

  it('reports refused claims in the batch summary as a count, never as a location', async () => {
    const spy = locatorSpy(
      () => [],
      'ok',
      () => new Map(),
    );
    const h = harness({ sources: spy.sources });

    expectReport(
      await h.ingest.ingest(BROWSER_CONTEXT, [
        makeRenderIngress({ source: FORGED }),
        makeRenderIngress({ source: STAMPED }),
      ]),
    );

    const summary = h.logs.find((entry) => entry.message === 'telemetry batch ingested');
    expect(summary?.fields).toMatchObject({ sourcesLocated: 0, sourcesRefused: 2 });
    const logged = JSON.stringify(h.logs);
    expect(logged).not.toContain(FORGED.file);
    expect(logged).not.toContain(STAMPED.file);
  });
});

describe('redaction wiring and the store contract', () => {
  it('persists exactly the redactor output of every event, attributed and schema-valid', async () => {
    const h = harness();
    const batch = [
      makeIngress(),
      makeRequestIngress(`/api/one?itemId=A&ref=${PLANTED_TOKEN}`, {
        attributes: {
          [METHOD_KEY]: 'POST',
          [URL_KEY]: `/api/one?itemId=A&ref=${PLANTED_TOKEN}`,
          [AUTH_HEADER_KEY]: `Bearer ${PLANTED_TOKEN}`,
        },
      }),
      makeRenderIngress(),
      makeLongTaskIngress(),
    ];

    expectReport(await h.ingest.ingest(BROWSER_CONTEXT, batch));

    const rows = insertedRows(h.repo);
    expect(rows).toHaveLength(batch.length);
    // Exactly once per event: no event bypassed the redactor, none ran twice.
    expect(h.privacy.redactInputs).toHaveLength(batch.length);

    rows.forEach((row, index) => {
      const { sessionId, captureId, ...rest } = row;

      // The row is the redactor's output plus the attribution — nothing else.
      expect(rest).toEqual(h.privacy.redactOutputs[index]);
      expect(sessionId).toBe(SESSION);
      expect(captureId).toBe(CAPTURE);
      // Already redacted: the redactor is idempotent, so a redacted row is a
      // fixed point of it.
      expect(redactEvent(row)).toEqual(row);
      // Valid against the persisted schema once the store adds `ingestSeq`.
      expect(parseTelemetryEvent({ ...row, ingestSeq: index + 1 }).ok).toBe(true);
    });

    // `redacted` is the upstream schema's list of attribute paths the redactor
    // replaced (packages/telemetry/src/schema/event.ts), not a boolean flag:
    // the request row records both masked paths.
    expect(rows[1]?.redacted).toEqual(expect.arrayContaining([URL_KEY, AUTH_HEADER_KEY]));
  });

  it('hands the store rows without ingestSeq, and forwards the rows the store returned', async () => {
    const h = harness();

    const report = expectReport(
      await h.ingest.ingest(BROWSER_CONTEXT, [
        makeIngress(),
        makeRequestIngress('/api/one?itemId=A'),
        makeRenderIngress(),
      ]),
    );

    for (const row of insertedRows(h.repo)) {
      expect('ingestSeq' in row).toBe(false);
    }

    const returned = h.repo.returned[0];
    expect(returned).toBeDefined();
    expect(returned?.map((row) => row.ingestSeq)).toEqual([1, 2, 3]);

    // The very array the store returned — carrying `ingestSeq`, the final
    // ordering tie-break — reaches both the correlator and the tail.
    expect(h.correlator.onEventsPersisted).toHaveBeenCalledTimes(1);
    expect(h.correlator.onEventsPersisted.mock.calls[0]?.[0]).toBe(returned);
    expect(h.tail.push).toHaveBeenCalledTimes(1);
    expect(h.tail.push.mock.calls[0]?.[0]).toBe(SESSION);
    expect(h.tail.push.mock.calls[0]?.[1]).toBe(returned);

    expect(report.inserted).toBe(3);
    expect(report.skipped).toBe(0);
    expect(report.persisted).toBe(3);
    expect(report.tracesTouched).toEqual(returned?.map((row) => row.traceId));
  });

  it('lets a planted credential reach neither the store nor the live tail', async () => {
    const url = `/api/one?itemId=A&ref=${PLANTED_TOKEN}`;
    const request = makeRequestIngress(url, {
      attributes: {
        [METHOD_KEY]: 'GET',
        [URL_KEY]: url,
        [AUTH_HEADER_KEY]: `Bearer ${PLANTED_TOKEN}`,
      },
    });
    const query = makeDbIngress(
      `SELECT id FROM widgets WHERE ref = '${PLANTED_TOKEN}' AND qty = 42`,
    );

    const browser = harness();
    const server = harness();

    expectReport(await browser.ingest.ingest(BROWSER_CONTEXT, [request]));
    expectReport(await server.ingest.ingest(SERVER_CONTEXT, [query]));

    for (const h of [browser, server]) {
      expect(h.repo.calls).toHaveLength(1);
      expect(h.tail.push).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(h.repo.calls)).not.toContain(PLANTED_TOKEN);
      expect(JSON.stringify(h.repo.returned)).not.toContain(PLANTED_TOKEN);
      expect(JSON.stringify(h.tail.push.mock.calls)).not.toContain(PLANTED_TOKEN);
    }

    // The request-key hasher alone saw the unredacted URL — by design.
    expect(browser.privacy.hashed[0]?.url).toContain(PLANTED_TOKEN);

    const requestRow = onlyRow(browser.repo);
    expect(requestRow.attributes[AUTH_HEADER_KEY]).toBeTypeOf('string');
    expect(requestRow.redacted).toEqual(expect.arrayContaining([URL_KEY, AUTH_HEADER_KEY]));

    const queryRow = onlyRow(server.repo);
    expect(queryRow.redacted).toContain(STATEMENT_KEY);
    expect(stringAttribute(queryRow, STATEMENT_KEY)).toContain('SELECT id FROM widgets');
  });

  it('preserves fractional epoch-millisecond startTime and duration exactly, end to end', async () => {
    const h = harness();
    const batch = [
      makeIngress({ startTime: BASE_TIME + 0.001, duration: 0.125 }),
      makeRequestIngress('/api/one?itemId=A', { startTime: BASE_TIME + 1 / 3, duration: 12.345 }),
      makeRenderIngress({ startTime: BASE_TIME + 640.0625, duration: 47.5 }),
    ];

    expectReport(await h.ingest.ingest(BROWSER_CONTEXT, batch));

    const persisted = insertedRows(h.repo);
    const correlated = h.correlator.onEventsPersisted.mock.calls[0]?.[0] ?? [];
    const tailed = h.tail.push.mock.calls[0]?.[1] ?? [];

    batch.forEach((event, index) => {
      for (const stage of [persisted, correlated, tailed]) {
        expect(stage[index]?.startTime).toBe(event.startTime);
        expect(stage[index]?.duration).toBe(event.duration);
      }
    });
  });
});

/* =================================================================================================
 * 3. Batch discipline, drops and graceful failure
 * ============================================================================================== */

describe('batch discipline', () => {
  it('takes its ceiling from the protocol schema and refuses a longer batch whole', async () => {
    // `@debuggen/protocol` keeps its `MAX_EVENTS_PER_BATCH` module-local (the
    // telemetry package exports a different number under that name), so the
    // bound is established here from protocol's own `telemetry.event` schema:
    // it accepts MAX_INGEST_BATCH events and refuses one more as too big.
    const atBound = manyEvents(MAX_INGEST_BATCH);
    const overBound = [...atBound, makeIngress()];

    expect(MAX_INGEST_BATCH).toBeGreaterThan(0);
    expect(parseTelemetryEventPayload({ events: atBound }).ok).toBe(true);

    const refusedByProtocol = parseTelemetryEventPayload({ events: overBound });
    expect(refusedByProtocol.ok).toBe(false);
    expect(JSON.stringify(refusedByProtocol.ok ? {} : refusedByProtocol.error.details)).toContain(
      'too_big',
    );

    const h = harness();
    const error = expectError(await h.ingest.ingest(BROWSER_CONTEXT, overBound));

    expect(error.code).toBe('PROTOCOL_INVALID_MESSAGE');
    expect(error.details).toMatchObject({ received: overBound.length, maxBatch: MAX_INGEST_BATCH });
    expect(h.log).toEqual([]);
    expect(h.attributor.contexts).toEqual([]);
    expect(h.sessions.requested).toEqual([]);
    expect(h.privacy.hasherBuilds()).toBe(0);
    expect(h.repo.calls).toEqual([]);
    expect(h.correlator.onEventsPersisted).not.toHaveBeenCalled();
    expect(h.tail.push).not.toHaveBeenCalled();
  });

  it('honours a lower configured ceiling and ignores one above the protocol bound', async () => {
    const lowered = harness({ maxBatch: 2 });
    const error = expectError(await lowered.ingest.ingest(BROWSER_CONTEXT, manyEvents(3)));
    expect(error.details).toMatchObject({ maxBatch: 2 });
    expect(lowered.repo.calls).toEqual([]);

    const raised = harness({ maxBatch: MAX_INGEST_BATCH + 10 });
    const refused = expectError(
      await raised.ingest.ingest(BROWSER_CONTEXT, manyEvents(MAX_INGEST_BATCH + 1)),
    );
    expect(refused.details).toMatchObject({ maxBatch: MAX_INGEST_BATCH });
  });

  it('answers an empty batch with an empty report and touches nothing', async () => {
    const h = harness();

    const report = expectReport(await h.ingest.ingest(BROWSER_CONTEXT, []));

    expect(report).toMatchObject({ received: 0, parsed: 0, invalid: 0, persisted: 0 });
    expect(report.dropped).toEqual(dropCounts());
    expect(h.log).toEqual([]);
  });
});

describe('drops', () => {
  it('drops a batch attribution refuses before anything is hashed, stored or broadcast', async () => {
    const h = harness();
    const batch = [makeRequestIngress('/api/one?itemId=A'), makeIngress(), makeRenderIngress()];

    const report = expectReport(
      await h.ingest.ingest({ origin: 'browser-agent', tabId: UNBOUND_TAB_ID }, batch),
    );

    expect(report.dropped).toEqual(dropCounts({ 'no-binding': batch.length }));
    expect(report.batchDropReason).toBe('no-binding');
    expect(report.batchDropCode).toBe(DROP_REASON_ERROR_CODES['no-binding']);
    expect(report.persisted).toBe(0);
    expect(report.sessionId).toBeUndefined();
    expect(h.log).toEqual(['resolve']);
    expect(h.sessions.requested).toEqual([]);
    expect(h.privacy.hasherBuilds()).toBe(0);
    expect(h.privacy.redactInputs).toEqual([]);
    expect(h.repo.calls).toEqual([]);
    expect(h.tail.push).not.toHaveBeenCalled();
  });

  it('returns a typed error when attribution fails for a reason that is not a drop', async () => {
    const refusing = harness({
      attributor: {
        resolveBatch: () =>
          Promise.resolve(err(new DebuggenError('INTERNAL', 'The attribution gate failed.'))),
      },
    });
    expect(expectError(await refusing.ingest.ingest(BROWSER_CONTEXT, [makeIngress()])).code).toBe(
      'INTERNAL',
    );

    const rejecting = harness({
      attributor: { resolveBatch: () => Promise.reject(new Error('the binding table vanished')) },
    });
    const error = expectError(await rejecting.ingest.ingest(BROWSER_CONTEXT, [makeIngress()]));
    expect(error.code).toBe('INTERNAL');
    expect(error.message).not.toContain('binding table');

    for (const h of [refusing, rejecting]) {
      expect(h.sessions.requested).toEqual([]);
      expect(h.repo.calls).toEqual([]);
    }
  });

  it('counts each malformed element as invalid and persists every valid sibling', async () => {
    const h = harness();
    const first = makeIngress();
    const last = makeRenderIngress();
    const batch: unknown[] = [
      first,
      without(makeIngress(), 'traceId'),
      { ...makeIngress(), spanId: 'abc123' },
      { ...makeIngress(), startTime: 1_768_000_000.5 },
      { ...makeIngress(), sessionId: SESSION },
      last,
    ];

    const report = expectReport(await h.ingest.ingest(BROWSER_CONTEXT, batch));

    expect(report).toMatchObject({ received: 6, parsed: 2, invalid: 4, persisted: 2 });
    expect(insertedRows(h.repo).map((row) => row.id)).toEqual([first.id, last.id]);
    expect(h.privacy.redactInputs).toHaveLength(2);
  });

  it('never stores an event the attributor drops, and counts it under its reason', async () => {
    const h = harness();
    const browserEvent = makeIngress();

    // A page may report browser-tier events only: the real tier gate drops the
    // forged server and database spans relayed for a tab.
    const report = expectReport(
      await h.ingest.ingest(BROWSER_CONTEXT, [
        browserEvent,
        makeDbIngress('SELECT 1'),
        makeServerIngress(),
      ]),
    );

    expect(report.dropped).toEqual(dropCounts({ 'tier-not-permitted': 2 }));
    expect(report.persisted).toBe(1);
    expect(insertedRows(h.repo).map((row) => row.id)).toEqual([browserEvent.id]);
  });

  it('counts an attributor that throws as an attribution failure and stores nothing for it', async () => {
    const h = harness({
      attributor: {
        attributeEvent: (event, attribution) => {
          if (event.kind === 'render') {
            throw new Error('the attributor tripped');
          }

          return realAttributor.attributeEvent(event, attribution);
        },
      },
    });
    const kept = makeIngress();

    const report = expectReport(
      await h.ingest.ingest(BROWSER_CONTEXT, [kept, makeRenderIngress()]),
    );

    expect(report.failures.attribution).toBe(1);
    expect(report.persisted).toBe(1);
    expect(insertedRows(h.repo).map((row) => row.id)).toEqual([kept.id]);
  });
});

describe('graceful failure', () => {
  it('reports a replayed batch as skipped rows, not as an error', async () => {
    const h = harness({ dedupe: true });
    const batch = [makeIngress(), makeRequestIngress('/api/one?itemId=A'), makeRenderIngress()];

    const first = expectReport(await h.ingest.ingest(BROWSER_CONTEXT, batch));
    const replay = expectReport(await h.ingest.ingest(BROWSER_CONTEXT, batch));

    expect(first).toMatchObject({ inserted: 3, skipped: 0, persisted: 3 });
    expect(replay).toMatchObject({ inserted: 0, skipped: 3, persisted: 3 });
    // The replayed rows are the stored ones, with their original arrival numbers.
    expect(h.repo.returned[1]?.map((row) => row.ingestSeq)).toEqual([1, 2, 3]);
    // The tail de-duplicates by id (./live-tail.ts), so resending is harmless.
    expect(h.tail.push).toHaveBeenCalledTimes(2);
  });

  it('turns a refused or throwing store write into a typed error and broadcasts nothing', async () => {
    const refused = harness({ repo: 'err' });
    const refusedError = expectError(await refused.ingest.ingest(BROWSER_CONTEXT, [makeIngress()]));
    expect(refusedError.code).toBe('STORE_ERROR');

    const throwing = harness({ repo: 'throw' });
    const thrownError = expectError(await throwing.ingest.ingest(BROWSER_CONTEXT, [makeIngress()]));
    expect(thrownError.code).toBe('STORE_ERROR');
    expect(thrownError.message).not.toContain('mid-transaction');

    for (const h of [refused, throwing]) {
      expect(h.repo.calls).toHaveLength(1);
      expect(h.correlator.onEventsPersisted).not.toHaveBeenCalled();
      expect(h.tail.push).not.toHaveBeenCalled();
    }
  });

  it('refuses a batch when the session secret cannot be read or is malformed', async () => {
    for (const secret of ['err', 'throw'] as const) {
      const h = harness({ secret });
      const error = expectError(await h.ingest.ingest(BROWSER_CONTEXT, [makeIngress()]));

      expect(error.code).toBe('STORE_ERROR');
      expect(h.privacy.hasherBuilds()).toBe(0);
      expect(h.repo.calls).toEqual([]);
    }

    const malformed = harness({ secretValue: REQUEST_KEY_SECRET.toUpperCase() });
    expectError(await malformed.ingest.ingest(BROWSER_CONTEXT, [makeIngress()]));
    expect(malformed.privacy.hasherBuilds()).toBe(1);
    expect(malformed.privacy.redactInputs).toEqual([]);
    expect(malformed.repo.calls).toEqual([]);
  });

  it.each(['err', 'throw'] as const)(
    'survives a correlator that answers %s: the batch stays persisted and is still tailed',
    async (behaviour) => {
      const h = harness({ correlator: behaviour });

      const report = expectReport(
        await h.ingest.ingest(BROWSER_CONTEXT, [makeIngress(), makeRenderIngress()]),
      );

      expect(report.failures.correlation).toBe(1);
      expect(report.failures.tail).toBe(0);
      expect(report.tracesTouched).toEqual([]);
      expect(report.persisted).toBe(2);
      expect(h.tail.push.mock.calls[0]?.[1]).toBe(h.repo.returned[0]);
    },
  );

  it.each(['err', 'throw'] as const)(
    'survives a live tail that answers %s: the batch stays persisted and correlated',
    async (behaviour) => {
      const h = harness({ tail: behaviour });

      const report = expectReport(
        await h.ingest.ingest(BROWSER_CONTEXT, [makeIngress(), makeRenderIngress()]),
      );

      expect(report.failures.tail).toBe(1);
      expect(report.failures.correlation).toBe(0);
      expect(report.persisted).toBe(2);
      expect(report.tracesTouched).toHaveLength(2);
      expect(h.log.slice(-3)).toEqual(['insert', 'correlate', 'tail']);
    },
  );

  it('persists without correlating or tailing when neither subsystem is present', async () => {
    const h = harness({ correlator: 'absent', tail: 'absent' });

    const report = expectReport(await h.ingest.ingest(BROWSER_CONTEXT, [makeIngress()]));

    expect(report.persisted).toBe(1);
    expect(report.failures).toMatchObject({ correlation: 0, tail: 0 });
    expect(h.log).not.toContain('correlate');
    expect(h.log).not.toContain('tail');
  });

  it('never throws or rejects, whatever arrives as the batch', async () => {
    const throwingGetter: unknown = Object.defineProperty({ ...makeIngress() }, 'name', {
      enumerable: true,
      get(): never {
        throw new Error('the producer object is revoked');
      },
    });
    const unreadableLength = new Proxy<unknown[]>([], {
      get(target, property, receiver): unknown {
        if (property === 'length') {
          throw new Error('the array is revoked');
        }

        return Reflect.get(target, property, receiver) as unknown;
      },
    });

    for (const notAnArray of [null, undefined, 42, 'events', { events: [] }, unreadableLength]) {
      const h = harness();
      const result = await h.ingest.ingest(BROWSER_CONTEXT, notAnArray);

      expect(expectError(result).code).toBe('PROTOCOL_INVALID_MESSAGE');
      expect(h.repo.calls).toEqual([]);
    }

    const nulls = harness();
    expect(expectReport(await nulls.ingest.ingest(BROWSER_CONTEXT, [null, null]))).toMatchObject({
      received: 2,
      invalid: 2,
      persisted: 0,
    });
    expect(nulls.repo.calls).toEqual([]);

    const getter = harness();
    const kept = makeIngress();
    expect(
      expectReport(await getter.ingest.ingest(BROWSER_CONTEXT, [throwingGetter, kept])),
    ).toMatchObject({ received: 2, invalid: 1, persisted: 1 });
    expect(insertedRows(getter.repo).map((row) => row.id)).toEqual([kept.id]);
  });
});

/* =================================================================================================
 * 4. Privacy of the session secret and of log records
 * ============================================================================================== */

/** Every string an error exposes: message, hint, details and its serialised payload. */
function errorSurface(error: DebuggenError): string {
  return [
    error.message,
    error.hint ?? '',
    JSON.stringify(error.details ?? {}),
    JSON.stringify(error.toPayload()),
  ].join('\n');
}

describe('privacy of the session secret', () => {
  it('keeps the secret and every digest out of logs, reports and error payloads', async () => {
    const malformedSecret = REQUEST_KEY_SECRET.toUpperCase();
    const surfaces: string[] = [];
    const digests: string[] = [];

    const success = harness();
    const successReport = expectReport(
      await success.ingest.ingest(BROWSER_CONTEXT, [
        makeRequestIngress('/api/one?itemId=A'),
        makeIngress(),
        { ...makeIngress(), traceId: 'not-a-trace' },
      ]),
    );
    surfaces.push(JSON.stringify(successReport), JSON.stringify(success.logs));
    digests.push(...success.privacy.digests);

    const badSecret = harness({ secretValue: malformedSecret });
    const badSecretError = expectError(
      await badSecret.ingest.ingest(BROWSER_CONTEXT, [makeRequestIngress('/api/one?itemId=A')]),
    );
    surfaces.push(errorSurface(badSecretError), JSON.stringify(badSecret.logs));

    const storeDown = harness({ repo: 'throw' });
    const storeError = expectError(
      await storeDown.ingest.ingest(BROWSER_CONTEXT, [makeRequestIngress('/api/one?itemId=B')]),
    );
    surfaces.push(errorSurface(storeError), JSON.stringify(storeDown.logs));
    digests.push(...storeDown.privacy.digests);

    expect(digests.length).toBeGreaterThan(0);

    for (const surface of surfaces) {
      expect(surface).not.toContain(REQUEST_KEY_SECRET);
      expect(surface).not.toContain(malformedSecret);

      for (const digest of digests) {
        expect(surface).not.toContain(digest);
      }
    }
  });
});

describe('privacy of log records', () => {
  it('logs counts, identifiers and codes only — never a name, value, URL or statement', async () => {
    const nameValue = sentinel('name');
    const attributeValue = sentinel('attribute');
    const queryValue = sentinel('query');
    const statementValue = sentinel('statement');
    const rejectedValue = sentinel('rejected');

    const browser = harness({ tail: 'err', correlator: 'err' });
    expectReport(
      await browser.ingest.ingest(BROWSER_CONTEXT, [
        makeIngress({ name: `handleAction ${nameValue}`, attributes: { label: attributeValue } }),
        makeRequestIngress(`/api/one?itemId=${queryValue}`),
        { ...makeIngress({ name: rejectedValue }), spanId: rejectedValue },
        makeDbIngress(`SELECT id FROM widgets WHERE ref = '${statementValue}'`),
      ]),
    );

    const server = harness({ repo: 'err' });
    expectError(
      await server.ingest.ingest(SERVER_CONTEXT, [
        makeDbIngress(`SELECT id FROM widgets WHERE ref = '${statementValue}'`),
      ]),
    );

    const entries = [...browser.logs, ...server.logs];
    const serialised = JSON.stringify(entries);

    expect(entries.length).toBeGreaterThan(0);

    for (const value of [nameValue, attributeValue, queryValue, statementValue, rejectedValue]) {
      expect(serialised).not.toContain(value);
    }

    expect(serialised).not.toContain('/api/one');
    expect(serialised).not.toContain('SELECT');

    for (const entry of entries) {
      // Every record is bound to the ingest subsystem…
      expect(Object.values(entry.fields)).toContain(INGEST_SUBSYSTEM);

      // …and every field is a count, an identifier, a code or a list of them.
      for (const value of Object.values(entry.fields)) {
        const scalars: unknown[] = Array.isArray(value) ? value : [value];

        for (const scalar of scalars) {
          expect(['string', 'number', 'boolean']).toContain(typeof scalar);
        }
      }
    }

    // The batch summary says how much happened, not what.
    expect(
      browser.logs.some((entry) => entry.fields.received === 4 && entry.fields.invalid === 1),
    ).toBe(true);
  });

  it('describes a validation failure by schema fields and issue codes, never by the rejected values', async () => {
    const rejected = sentinel('bad-id');
    const unknownKey = sentinel('unknown-key');
    const h = harness();

    const report = expectReport(
      await h.ingest.ingest(BROWSER_CONTEXT, [
        { ...makeIngress(), spanId: rejected },
        { ...makeIngress(), traceId: rejected },
        { ...makeIngress(), startTime: 1_768_000_000.5 },
        { ...makeIngress(), [unknownKey]: rejected },
      ]),
    );

    expect(report.invalid).toBe(4);

    const warning = h.logs.find((entry) => entry.fields.invalid === 4);
    expect(warning?.level).toBe('warn');

    const fields = warning?.fields.fields;
    const issueCodes = warning?.fields.issueCodes;

    expect(fields).toEqual(expect.arrayContaining(['spanId', 'traceId', 'startTime']));
    expect(Array.isArray(issueCodes) && issueCodes.length > 0).toBe(true);

    const serialised = JSON.stringify(h.logs);
    expect(serialised).not.toContain(rejected);
    expect(serialised).not.toContain(unknownKey);
    expect(serialised).not.toContain('1768000000.5');
  });
});

/* =================================================================================================
 * 5. Transport wrappers
 * ============================================================================================== */

describe('transport wrappers', () => {
  it('builds a browser-agent context from the relayed tab and delegates to ingest', async () => {
    const h = harness();
    const documentId = 'doc-1';
    const url = `http://127.0.0.1:3000/one?itemId=${sentinel('page-url')}`;

    const report = expectReport(
      await h.ingest.ingestFromAgent({
        tabId: TAB_ID,
        documentId,
        producerId: PRODUCER,
        url,
        events: [makeIngress()],
      }),
    );

    expect(h.attributor.contexts).toStrictEqual([
      { origin: 'browser-agent', tabId: TAB_ID, documentId, producerId: PRODUCER, url },
    ]);
    expect(report.persisted).toBe(1);
    expect(report.sessionId).toBe(SESSION);
    expect(report.captureId).toBe(CAPTURE);
    expect(JSON.stringify(h.logs)).not.toContain(url);

    const minimal = harness();
    expectReport(await minimal.ingest.ingestFromAgent({ tabId: TAB_ID, events: [makeIngress()] }));
    expect(minimal.attributor.contexts).toStrictEqual([{ origin: 'browser-agent', tabId: TAB_ID }]);
  });

  it('builds a server-agent context carrying both project roots', async () => {
    const h = harness();

    const report = expectReport(
      await h.ingest.ingestFromServerAgent({
        projectRoot: PROJECT_ONE,
        scopedProjectRoot: PROJECT_ONE,
        events: [makeServerIngress(), makeDbIngress('SELECT id FROM widgets WHERE qty = 1')],
      }),
    );

    expect(h.attributor.contexts).toStrictEqual([
      { origin: 'server-agent', projectRoot: PROJECT_ONE, scopedProjectRoot: PROJECT_ONE },
    ]);
    expect(report.persisted).toBe(2);
    expect(insertedRows(h.repo).map((row) => row.tier)).toEqual(['server', 'db']);
  });

  it('takes the server scope from the credential, never from the body', async () => {
    const h = harness();

    const report = expectReport(
      await h.ingest.ingestFromServerAgent({
        projectRoot: PROJECT_ONE,
        scopedProjectRoot: PROJECT_TWO,
        events: [makeServerIngress()],
      }),
    );

    const [context] = h.attributor.contexts;
    expect(context).toMatchObject({ origin: 'server-agent', scopedProjectRoot: PROJECT_TWO });
    expect(context).toMatchObject({ projectRoot: PROJECT_ONE });
    expect(report.batchDropReason).toBe('project-scope-mismatch');
    expect(report.batchDropCode).toBe(DROP_REASON_ERROR_CODES['project-scope-mismatch']);
    expect(report.dropped).toEqual(dropCounts({ 'project-scope-mismatch': 1 }));
    expect(h.sessions.requested).toEqual([]);
    expect(h.repo.calls).toEqual([]);
  });

  it('answers an unreadable transport input with a typed error instead of throwing', async () => {
    const h = harness();
    const input: AgentIngestInput = {
      tabId: TAB_ID,
      get events(): unknown {
        throw new Error('the relayed frame is revoked');
      },
    };

    const error = expectError(await h.ingest.ingestFromAgent(input));

    expect(error.code).toBe('PROTOCOL_INVALID_MESSAGE');
    expect(error.message).not.toContain('revoked');
    expect(h.log).toEqual([]);
  });
});

/* =================================================================================================
 * 6. The ingest route's response
 * ============================================================================================== */

describe('toIngestResponse', () => {
  it('reports accepted rows, and rejected ones only when there are any', async () => {
    const h = harness();

    const clean = expectReport(await h.ingest.ingest(BROWSER_CONTEXT, [makeIngress()]));
    expect(toIngestResponse(clean)).toEqual({ accepted: 1 });

    const mixed = expectReport(
      await h.ingest.ingest(BROWSER_CONTEXT, [makeIngress(), null, makeDbIngress('SELECT 1')]),
    );
    expect(toIngestResponse(mixed)).toEqual({ accepted: 1, rejected: 2 });
  });
});

/* =================================================================================================
 * 7. Delivery context of a relayed batch: the armed capture and the producer's loss report
 * ============================================================================================== */

/** How the loss-ledger double answers `recordProducerLoss`. */
type LedgerBehaviour = 'ok' | 'err' | 'throw';

/**
 * A loss-ledger double: records every report and a snapshot of the shared
 * call-order log at the moment it was called, and answers with the running
 * total of the capture it was given (the shape `TelemetryRepo` answers with).
 */
function lossLedger(log: CallTag[], behaviour: LedgerBehaviour) {
  const reports: ProducerLossReportLike[] = [];
  const logBefore: CallTag[][] = [];
  const totals = new Map<CaptureId, number>();

  const recordProducerLoss = vi.fn(
    (report: ProducerLossReportLike): Result<number, DebuggenError> => {
      reports.push(report);
      logBefore.push([...log]);

      if (behaviour === 'throw') {
        throw new Error(`the loss ledger is locked ${sentinel('ledger-throw')}`);
      }

      if (behaviour === 'err') {
        return err(new DebuggenError('STORE_ERROR', `ledger refused ${sentinel('ledger-err')}`));
      }

      const total = (totals.get(report.captureId) ?? 0) + report.droppedEvents;
      totals.set(report.captureId, total);
      return ok(total);
    },
  );

  return { reports, logBefore, recordProducerLoss };
}

/**
 * The file's pipeline over the same doubles as {@link harness}, except that
 * the telemetry store also carries a loss ledger.
 */
function ledgerHarness(behaviour: LedgerBehaviour = 'ok') {
  const log: CallTag[] = [];
  const repo = fakeTelemetryRepo(log);
  const ledger = lossLedger(log, behaviour);
  const sessions = fakeSessionsRepo(log);
  const attributor = attributorSpy(log);
  const { logger, entries } = recordingLogger();
  const telemetry: TelemetryRepoLike = {
    insertMany: (events) => repo.insertMany(events),
    recordProducerLoss: ledger.recordProducerLoss,
  };

  const ingest = createTelemetryIngest({
    telemetry,
    sessions,
    attributor,
    logger,
    now: fixedClock,
  });

  return { ingest, log, repo, ledger, sessions, attributor, logs: entries };
}

describe('delivery context: the armed capture', () => {
  it('hands the armed capture to attribution and stores a batch that names the open capture', async () => {
    const h = harness();
    const event = makeIngress();

    const report = expectReport(
      await h.ingest.ingestFromAgent({ tabId: TAB_ID, armedCaptureId: CAPTURE, events: [event] }),
    );

    expect(h.attributor.contexts).toStrictEqual([
      { origin: 'browser-agent', tabId: TAB_ID, armedCaptureId: CAPTURE },
    ]);
    expect(report.persisted).toBe(1);
    expect(report.captureId).toBe(CAPTURE);
    expect(onlyRow(h.repo).captureId).toBe(CAPTURE);
    expect(report.dropped).toEqual(dropCounts());
  });

  it('drops a batch recorded for another capture whole, as stale-capture, touching nothing', async () => {
    const h = harness();
    const stale = newCaptureId();
    const batch = [makeRequestIngress('/api/one?itemId=A'), makeIngress(), makeRenderIngress()];

    const report = expectReport(
      await h.ingest.ingestFromAgent({ tabId: TAB_ID, armedCaptureId: stale, events: batch }),
    );

    expect(report.dropped).toEqual(dropCounts({ 'stale-capture': batch.length }));
    expect(report.batchDropReason).toBe('stale-capture');
    expect(report.batchDropCode).toBe(DROP_REASON_ERROR_CODES['stale-capture']);
    expect(report.batchDropCode).toBe('SESSION_INVALID_STATE');
    expect(report.persisted).toBe(0);
    expect(report.sessionId).toBeUndefined();
    expect(report.captureId).toBeUndefined();
    // Refused before anything is read, hashed, stored or broadcast.
    expect(h.log).toEqual(['resolve']);
    expect(h.sessions.requested).toEqual([]);
    expect(h.privacy.redactInputs).toEqual([]);
    expect(h.repo.calls).toEqual([]);
    expect(h.tail.push).not.toHaveBeenCalled();
    expect(toIngestResponse(report)).toEqual({ accepted: 0, rejected: batch.length });
    expect(JSON.stringify(h.logs)).not.toContain(stale);
  });
});

describe('delivery context: the producer’s loss report', () => {
  it('records a reported loss once, against the attributed session and capture, before the batch is processed', async () => {
    const h = ledgerHarness();
    const event = makeIngress();

    const report = expectReport(
      await h.ingest.ingestFromAgent({
        tabId: TAB_ID,
        producerId: PRODUCER,
        droppedCount: 42,
        events: [event],
      }),
    );

    expect(h.ledger.reports).toStrictEqual([
      { sessionId: SESSION, captureId: CAPTURE, producerId: PRODUCER, droppedEvents: 42 },
    ]);
    // After attribution, before the secret is read or anything is stored.
    expect(h.ledger.logBefore).toStrictEqual([['resolve']]);
    expect(report.producerDropped).toBe(42);
    expect(report.persisted).toBe(1);
    expect(insertedRows(h.repo).map((row) => row.id)).toEqual([event.id]);

    const recorded = h.logs.filter((entry) => entry.fields['droppedEvents'] === 42);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.fields).toMatchObject({
      sessionId: SESSION,
      captureId: CAPTURE,
      captureDroppedEvents: 42,
    });
  });

  it('omits the producer id from the report when the transport announced none', async () => {
    const h = ledgerHarness();

    expectReport(
      await h.ingest.ingestFromAgent({ tabId: TAB_ID, droppedCount: 3, events: [makeIngress()] }),
    );

    expect(h.ledger.reports).toStrictEqual([
      { sessionId: SESSION, captureId: CAPTURE, droppedEvents: 3 },
    ]);
  });

  it('records nothing for a batch attribution refused, whatever loss it reports', async () => {
    const unbound = ledgerHarness();
    const stale = ledgerHarness();

    const unboundReport = expectReport(
      await unbound.ingest.ingestFromAgent({
        tabId: UNBOUND_TAB_ID,
        droppedCount: 5,
        events: [makeIngress()],
      }),
    );
    const staleReport = expectReport(
      await stale.ingest.ingestFromAgent({
        tabId: TAB_ID,
        armedCaptureId: newCaptureId(),
        droppedCount: 5,
        events: [makeIngress(), makeIngress()],
      }),
    );

    expect(unboundReport.batchDropReason).toBe('no-binding');
    expect(staleReport.batchDropReason).toBe('stale-capture');
    expect(staleReport.dropped).toEqual(dropCounts({ 'stale-capture': 2 }));
    for (const [h, report] of [
      [unbound, unboundReport],
      [stale, staleReport],
    ] as const) {
      expect(h.ledger.recordProducerLoss).not.toHaveBeenCalled();
      expect(report.producerDropped).toBeUndefined();
      expect(report.persisted).toBe(0);
      expect(h.repo.calls).toEqual([]);
    }
  });

  it('ingests normally, and still reports the loss, when the store has no loss ledger', async () => {
    const h = harness();

    const report = expectReport(
      await h.ingest.ingestFromAgent({ tabId: TAB_ID, droppedCount: 7, events: [makeIngress()] }),
    );

    expect(report.persisted).toBe(1);
    expect(report.producerDropped).toBe(7);
    expect(h.logs.some((entry) => entry.fields['droppedEvents'] === 7)).toBe(true);
  });

  it('keeps the batch when the ledger refuses or throws, logging the code and never the error text', async () => {
    for (const behaviour of ['err', 'throw'] as const) {
      const h = ledgerHarness(behaviour);

      const report = expectReport(
        await h.ingest.ingestFromAgent({ tabId: TAB_ID, droppedCount: 9, events: [makeIngress()] }),
      );

      expect(h.ledger.recordProducerLoss).toHaveBeenCalledTimes(1);
      expect(report.persisted).toBe(1);
      expect(report.producerDropped).toBe(9);

      const warned = h.logs.filter(
        (entry) => entry.level === 'warn' && entry.fields['droppedEvents'] === 9,
      );
      expect(warned).toHaveLength(1);
      expect(warned[0]?.fields['code']).toBe('STORE_ERROR');

      const serialised = JSON.stringify(h.logs);
      expect(serialised).not.toContain(sentinel('ledger-err'));
      expect(serialised).not.toContain(sentinel('ledger-throw'));
    }
  });

  it('treats an absent or zero count as no report, and ignores a malformed one', async () => {
    const quiet = ledgerHarness();

    expectReport(await quiet.ingest.ingestFromAgent({ tabId: TAB_ID, events: [makeIngress()] }));
    const zero = expectReport(
      await quiet.ingest.ingestFromAgent({
        tabId: TAB_ID,
        droppedCount: 0,
        events: [makeIngress()],
      }),
    );

    expect(quiet.ledger.recordProducerLoss).not.toHaveBeenCalled();
    expect(zero.producerDropped).toBeUndefined();
    expect(zero.persisted).toBe(1);

    for (const malformed of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '3', null]) {
      const h = ledgerHarness();

      const report = expectReport(
        await h.ingest.ingestFromAgent({
          tabId: TAB_ID,
          droppedCount: malformed as unknown as number,
          events: [makeIngress()],
        }),
      );

      expect(h.ledger.recordProducerLoss).not.toHaveBeenCalled();
      expect(report.producerDropped).toBeUndefined();
      expect(report.persisted).toBe(1);
      expect(h.logs.filter((entry) => entry.level === 'warn')).toHaveLength(1);
    }
  });

  it('never reads a loss report from a server-agent batch', async () => {
    const h = ledgerHarness();

    const report = expectReport(
      await h.ingest.ingestFromServerAgent({
        projectRoot: PROJECT_ONE,
        scopedProjectRoot: PROJECT_ONE,
        events: [makeServerIngress()],
      }),
    );

    expect(report.persisted).toBe(1);
    expect(report.producerDropped).toBeUndefined();
    expect(h.ledger.recordProducerLoss).not.toHaveBeenCalled();
  });
});

/* =================================================================================================
 * 8. The log throttle
 * ============================================================================================== */

/** A clock the case moves by hand, starting at {@link FIXED_NOW}. */
function steppedClock(): { readonly now: () => number; advance(ms: number): void } {
  let reading = FIXED_NOW;
  return {
    now: () => reading,
    advance(ms: number): void {
      reading += ms;
    },
  };
}

/** The records of one level and message. */
function recordsOf(logs: readonly LogEntry[], level: LogLevel, message: string): LogEntry[] {
  return logs.filter((entry) => entry.level === level && entry.message === message);
}

/** Every field of every record is a count, an identifier, a code or a list of them. */
function expectScalarFieldsOnly(entries: readonly LogEntry[]): void {
  for (const entry of entries) {
    expect(Object.values(entry.fields)).toContain(INGEST_SUBSYSTEM);

    for (const value of Object.values(entry.fields)) {
      const scalars: unknown[] = Array.isArray(value) ? value : [value];

      for (const scalar of scalars) {
        expect(['string', 'number', 'boolean']).toContain(typeof scalar);
      }
    }
  }
}

const MALFORMED_WARNING = 'malformed telemetry events skipped';
const REFUSED_WARNING = 'telemetry batch refused before ingest';
const BATCH_SUMMARY = 'telemetry batch ingested';

describe('createLogThrottle', () => {
  it('writes a key once per interval and hands the next record the count held back', () => {
    const clock = steppedClock();
    const throttle = createLogThrottle({ now: clock.now });

    expect(throttle.admit('malformed|a')).toEqual({
      write: true,
      suppressed: 0,
      suppressedUntracked: 0,
    });
    for (let index = 0; index < 5; index += 1) {
      expect(throttle.admit('malformed|a').write).toBe(false);
    }
    expect(throttle.admit('malformed|b').write, 'another key has its own interval').toBe(true);

    clock.advance(LOG_THROTTLE_INTERVAL_MS - 1);
    expect(throttle.admit('malformed|a').write).toBe(false);

    clock.advance(1);
    expect(throttle.admit('malformed|a')).toEqual({
      write: true,
      suppressed: 6,
      suppressedUntracked: 0,
    });
    expect(throttle.admit('malformed|a').write, 'the count starts again').toBe(false);

    clock.advance(-5_000);
    expect(throttle.admit('malformed|a'), 'a clock stepped back ends the interval').toEqual({
      write: true,
      suppressed: 1,
      suppressedUntracked: 0,
    });
  });

  it('caps records across keys, and a key the cap held back keeps its count', () => {
    const clock = steppedClock();
    const throttle = createLogThrottle({ now: clock.now, maxRecordsPerInterval: 3 });

    const firstRound = ['k1', 'k2', 'k3', 'k4', 'k5'].map((key) => throttle.admit(key).write);
    expect(firstRound).toEqual([true, true, true, false, false]);
    expect(throttle.admit('k4').write).toBe(false);

    clock.advance(LOG_THROTTLE_INTERVAL_MS);
    expect(throttle.admit('k4')).toEqual({ write: true, suppressed: 2, suppressedUntracked: 0 });
    expect(throttle.admit('k5')).toEqual({ write: true, suppressed: 1, suppressedUntracked: 0 });
    expect(throttle.admit('k1')).toEqual({ write: true, suppressed: 0, suppressedUntracked: 0 });
    expect(throttle.admit('k2').write, 'the new window is full again').toBe(false);
  });

  it('bounds its keys, reporting an evicted key’s count on the next record written', () => {
    const throttle = createLogThrottle({ now: fixedClock, maxKeys: 2 });

    expect(throttle.admit('a').write).toBe(true);
    expect(throttle.admit('a').write).toBe(false);
    expect(throttle.admit('a').write).toBe(false);
    expect(throttle.admit('b').write).toBe(true);

    // `a` is the least recently admitted key: `c` evicts it and its two held
    // occurrences move to the next written record.
    expect(throttle.admit('c')).toEqual({ write: true, suppressed: 0, suppressedUntracked: 2 });
    expect(throttle.admit('d')).toEqual({ write: true, suppressed: 0, suppressedUntracked: 0 });
  });

  it('keeps its defaults for unusable options and never throws, whatever the clock does', () => {
    let calls = 0;
    const throttle = createLogThrottle({
      intervalMs: Number.NaN,
      maxRecordsPerInterval: 0,
      maxKeys: -1,
      now: () => {
        calls += 1;
        if (calls % 2 === 0) {
          throw new Error('the clock is gone');
        }
        return calls % 3 === 0 ? Number.POSITIVE_INFINITY : FIXED_NOW;
      },
    });

    const verdicts = Array.from({ length: LOG_THROTTLE_MAX_RECORDS_PER_INTERVAL + 5 }, (_, index) =>
      throttle.admit(`key-${String(index)}`),
    );
    expect(verdicts.filter((verdict) => verdict.write)).toHaveLength(
      LOG_THROTTLE_MAX_RECORDS_PER_INTERVAL,
    );
    expect(throttle.admit('key-0').write, 'the default interval still holds').toBe(false);
    expect(createLogThrottle().admit('any').write).toBe(true);
  });

  /** A scheduler whose wake-ups run only when the test says so. */
  function manualScheduler(): {
    readonly scheduler: (callback: () => void, delayMs: number) => void;
    readonly delays: number[];
    fire(): void;
  } {
    const queued: (() => void)[] = [];
    const delays: number[] = [];
    return {
      scheduler: (callback, delayMs) => {
        queued.push(callback);
        delays.push(delayMs);
      },
      delays,
      fire: () => {
        queued.shift()?.();
      },
    };
  }

  it('writes a trailing summary of held-back occurrences no later record carried', () => {
    const clock = steppedClock();
    const timers = manualScheduler();
    const summaries: LogThrottleSummary<string>[] = [];
    const throttle = createLogThrottle<string>({
      now: clock.now,
      scheduler: timers.scheduler,
      onSummary: (summary) => summaries.push(summary),
    });

    expect(throttle.admit('flood', 'first').write).toBe(true);
    for (let index = 0; index < 499; index += 1) {
      expect(throttle.admit('flood', `held-${String(index)}`).write).toBe(false);
    }
    expect(timers.delays, 'one wake-up, an interval on').toEqual([LOG_THROTTLE_INTERVAL_MS]);

    clock.advance(LOG_THROTTLE_INTERVAL_MS);
    timers.fire();
    expect(summaries).toEqual([{ payload: 'held-498', suppressed: 499, suppressedUntracked: 0 }]);
    expect(timers.delays, 'nothing is left, so nothing is scheduled').toHaveLength(1);

    // The summary spent the count and the interval: the next occurrence waits.
    expect(throttle.admit('flood', 'later').write).toBe(false);
    clock.advance(LOG_THROTTLE_INTERVAL_MS);
    expect(throttle.admit('flood')).toEqual({ write: true, suppressed: 1, suppressedUntracked: 0 });
    timers.fire();
    expect(summaries, 'a count a record carried is never summarised as well').toHaveLength(1);
  });

  it('writes trailing summaries within the ceiling across keys, and wakes again for the rest', () => {
    const clock = steppedClock();
    const timers = manualScheduler();
    const summaries: LogThrottleSummary<string>[] = [];
    const throttle = createLogThrottle<string>({
      now: clock.now,
      maxRecordsPerInterval: 2,
      scheduler: timers.scheduler,
      onSummary: (summary) => summaries.push(summary),
    });

    for (const key of ['k1', 'k2', 'k3', 'k4', 'k5']) {
      throttle.admit(key, key);
      throttle.admit(key, key);
    }
    // k1 and k2 were written; every key holds one or two occurrences back.
    clock.advance(LOG_THROTTLE_INTERVAL_MS);
    timers.fire();
    expect(summaries.map((summary) => [summary.payload, summary.suppressed])).toEqual([
      ['k1', 1],
      ['k2', 1],
    ]);

    clock.advance(LOG_THROTTLE_INTERVAL_MS);
    timers.fire();
    clock.advance(LOG_THROTTLE_INTERVAL_MS);
    timers.fire();
    expect(summaries.map((summary) => [summary.payload, summary.suppressed])).toEqual([
      ['k1', 1],
      ['k2', 1],
      ['k3', 2],
      ['k4', 2],
      ['k5', 2],
    ]);
    expect(timers.delays).toHaveLength(3);
  });

  it('stops waking when a clock that does not advance leaves nothing due, and never throws', () => {
    const timers = manualScheduler();
    const throttle = createLogThrottle<string>({
      now: fixedClock,
      scheduler: timers.scheduler,
      onSummary: () => {
        throw new Error('the sink is gone');
      },
    });

    throttle.admit('stuck', 'payload');
    throttle.admit('stuck', 'payload');
    for (let wake = 0; wake < 10; wake += 1) {
      timers.fire();
    }
    expect(timers.delays.length, 'bounded wake-ups for a count that never falls due').toBe(3);

    // A throwing sink spends the count and does not stop later summaries.
    const clock = steppedClock();
    const laterTimers = manualScheduler();
    let attempts = 0;
    const later = createLogThrottle<string>({
      now: clock.now,
      scheduler: laterTimers.scheduler,
      onSummary: () => {
        attempts += 1;
        throw new Error('the sink is gone');
      },
    });
    later.admit('k', 'p');
    later.admit('k', 'p');
    clock.advance(LOG_THROTTLE_INTERVAL_MS);
    expect(() => {
      laterTimers.fire();
    }).not.toThrow();
    later.admit('k', 'p');
    clock.advance(LOG_THROTTLE_INTERVAL_MS);
    laterTimers.fire();
    expect(attempts, 'each held-back run was summarised once').toBe(2);
  });

  it('schedules nothing without a summary sink, and survives a scheduler that throws', () => {
    const timers = manualScheduler();
    const silent = createLogThrottle({ now: fixedClock, scheduler: timers.scheduler });
    silent.admit('k');
    silent.admit('k');
    expect(timers.delays).toHaveLength(0);

    const broken = createLogThrottle<string>({
      now: fixedClock,
      scheduler: () => {
        throw new Error('no timers here');
      },
      onSummary: () => undefined,
    });
    broken.admit('k', 'p');
    expect(broken.admit('k', 'p').write).toBe(false);
  });

  it('marks a trailing summary and adds its untracked count only when non-zero', () => {
    expect(summaryFields({ payload: 'p', suppressed: 3, suppressedUntracked: 0 })).toEqual({
      suppressed: 3,
      trailingSummary: true,
    });
    expect(summaryFields({ payload: 'p', suppressed: 1, suppressedUntracked: 2 })).toEqual({
      suppressed: 1,
      trailingSummary: true,
      suppressedUntracked: 2,
    });
  });

  it('adds only the non-zero counts to a written record', () => {
    expect(suppressionFields({ write: true, suppressed: 0, suppressedUntracked: 0 })).toEqual({});
    expect(suppressionFields({ write: true, suppressed: 4, suppressedUntracked: 0 })).toEqual({
      suppressed: 4,
    });
    expect(suppressionFields({ write: true, suppressed: 0, suppressedUntracked: 2 })).toEqual({
      suppressedUntracked: 2,
    });
  });
});

describe('the ingest log throttle', () => {
  it('writes one warning for 500 malformed batches, and the next one carries the count', async () => {
    const clock = steppedClock();
    const h = harness({ now: clock.now });

    for (let index = 0; index < 500; index += 1) {
      const report = expectReport(await h.ingest.ingest(BROWSER_CONTEXT, [null]));
      expect(report.invalid).toBe(1);
    }

    const flooded = recordsOf(h.logs, 'warn', MALFORMED_WARNING);
    expect(flooded).toHaveLength(1);
    expect(flooded[0]?.fields).not.toHaveProperty('suppressed');
    expect(
      recordsOf(h.logs, 'debug', BATCH_SUMMARY),
      'a batch that stored nothing has its debug summary throttled too',
    ).toHaveLength(1);

    clock.advance(LOG_THROTTLE_INTERVAL_MS);
    expectReport(await h.ingest.ingest(BROWSER_CONTEXT, [null]));

    const warnings = recordsOf(h.logs, 'warn', MALFORMED_WARNING);
    expect(warnings).toHaveLength(2);
    expect(warnings[1]?.fields).toMatchObject({ invalid: 1, received: 1, suppressed: 499 });
    expect(warnings[1]?.fields.sessionId).toBe(SESSION);
    const summaries = recordsOf(h.logs, 'debug', BATCH_SUMMARY);
    expect(summaries).toHaveLength(2);
    expect(summaries[1]?.fields).toMatchObject({ persisted: 0, invalid: 1, suppressed: 499 });
    expectScalarFieldsOnly(h.logs);
  });

  it('reports a flood that stops with a trailing summary, one interval on', async () => {
    vi.useFakeTimers();
    try {
      const clock = steppedClock();
      const h = harness({ now: clock.now });

      for (let index = 0; index < 300; index += 1) {
        expectReport(await h.ingest.ingest(BROWSER_CONTEXT, [null]));
      }
      expect(recordsOf(h.logs, 'warn', MALFORMED_WARNING)).toHaveLength(1);

      // Silence: no further batch arrives to carry the count.
      clock.advance(LOG_THROTTLE_INTERVAL_MS);
      await vi.advanceTimersByTimeAsync(LOG_THROTTLE_INTERVAL_MS);

      const warnings = recordsOf(h.logs, 'warn', MALFORMED_WARNING);
      expect(warnings).toHaveLength(2);
      expect(warnings[1]?.fields).toMatchObject({
        invalid: 1,
        suppressed: 299,
        trailingSummary: true,
        sessionId: SESSION,
      });
      const summaries = recordsOf(h.logs, 'debug', BATCH_SUMMARY);
      expect(summaries).toHaveLength(2);
      expect(summaries[1]?.fields).toMatchObject({ suppressed: 299, trailingSummary: true });

      // Nothing is left: no further record and no further wake-up.
      clock.advance(LOG_THROTTLE_INTERVAL_MS);
      await vi.advanceTimersByTimeAsync(LOG_THROTTLE_INTERVAL_MS);
      expect(recordsOf(h.logs, 'warn', MALFORMED_WARNING)).toHaveLength(2);
      expect(vi.getTimerCount()).toBe(0);
      expectScalarFieldsOnly(h.logs);
    } finally {
      vi.useRealTimers();
    }
  });

  it('writes the debug summary of every batch that stored evidence', async () => {
    const h = harness();

    for (let index = 0; index < 5; index += 1) {
      const report = expectReport(await h.ingest.ingest(BROWSER_CONTEXT, [makeIngress()]));
      expect(report.persisted).toBe(1);
    }

    expect(recordsOf(h.logs, 'debug', BATCH_SUMMARY)).toHaveLength(5);
  });

  it('keys the debug summary of a batch that stored nothing by its producer', async () => {
    // Every producer's batch is attributed to one session, so only the producer
    // tells the four apart.
    const h = harness({
      attributor: {
        resolveBatch: (context) =>
          Promise.resolve(ok({ sessionId: SESSION, captureId: CAPTURE, origin: context.origin })),
      },
    });
    const otherTab: IngestContext = { origin: 'browser-agent', tabId: TAB_ID + 1 };
    const otherProject: IngestContext = {
      origin: 'server-agent',
      projectRoot: PROJECT_TWO,
      scopedProjectRoot: PROJECT_TWO,
    };

    for (const context of [BROWSER_CONTEXT, SERVER_CONTEXT, otherTab, otherProject]) {
      expect(expectReport(await h.ingest.ingest(context, [null])).persisted).toBe(0);
    }
    const first = recordsOf(h.logs, 'debug', BATCH_SUMMARY);
    expect(
      first.map((record) => record.fields.origin),
      'every producer’s first batch in the interval is reported whole',
    ).toEqual(['browser-agent', 'server-agent', 'browser-agent', 'server-agent']);

    for (const context of [BROWSER_CONTEXT, SERVER_CONTEXT, otherTab, otherProject]) {
      expectReport(await h.ingest.ingest(context, [null]));
    }
    expect(
      recordsOf(h.logs, 'debug', BATCH_SUMMARY),
      'a producer’s repeats are held back under its own key',
    ).toHaveLength(4);
    expectScalarFieldsOnly(h.logs);
    expect(JSON.stringify(h.logs), 'no key, and so no project path, is written').not.toContain(
      PROJECT_TWO,
    );
  });

  it('holds a flood that spans many sessions to the ceiling across keys', async () => {
    const clock = steppedClock();
    const sessions = Array.from({ length: 100 }, () => newSessionId());
    let next = 0;
    const h = harness({
      now: clock.now,
      attributor: {
        resolveBatch: () => {
          const sessionId = sessions[next % sessions.length] ?? SESSION;
          next += 1;
          return Promise.resolve(
            ok({ sessionId, captureId: CAPTURE, origin: 'browser-agent' as const, tabId: TAB_ID }),
          );
        },
      },
    });

    for (let index = 0; index < sessions.length; index += 1) {
      expectReport(await h.ingest.ingest(BROWSER_CONTEXT, [null]));
    }

    const firstWindow = recordsOf(h.logs, 'warn', MALFORMED_WARNING);
    expect(firstWindow).toHaveLength(LOG_THROTTLE_MAX_RECORDS_PER_INTERVAL);
    expect(firstWindow.map((entry) => entry.fields.sessionId)).toEqual(
      sessions.slice(0, LOG_THROTTLE_MAX_RECORDS_PER_INTERVAL),
    );

    // A new window: the sessions the ceiling held back are written first, each
    // reporting its one held occurrence.
    clock.advance(LOG_THROTTLE_INTERVAL_MS);
    next = LOG_THROTTLE_MAX_RECORDS_PER_INTERVAL;
    for (let index = 0; index < LOG_THROTTLE_MAX_RECORDS_PER_INTERVAL + 1; index += 1) {
      expectReport(await h.ingest.ingest(BROWSER_CONTEXT, [null]));
    }

    const secondWindow = recordsOf(h.logs, 'warn', MALFORMED_WARNING).slice(firstWindow.length);
    expect(secondWindow).toHaveLength(LOG_THROTTLE_MAX_RECORDS_PER_INTERVAL);
    for (const entry of secondWindow) {
      expect(entry.fields.suppressed).toBe(1);
    }
    expectScalarFieldsOnly(h.logs);
  });

  it('keys an unattributed refusal by origin and tab, and never writes the key', async () => {
    const h = harness();

    for (let index = 0; index < 50; index += 1) {
      expectError(await h.ingest.ingestFromAgent({ tabId: TAB_ID, events: 'not-a-batch' }));
      expectError(await h.ingest.ingestFromAgent({ tabId: UNBOUND_TAB_ID, events: 'not-a-batch' }));
      expectError(await h.ingest.ingest(SERVER_CONTEXT, 'not-a-batch'));
    }

    const refusals = recordsOf(h.logs, 'warn', REFUSED_WARNING);
    expect(refusals.map((entry) => entry.fields.origin)).toEqual([
      'browser-agent',
      'browser-agent',
      'server-agent',
    ]);

    const serialised = JSON.stringify(h.logs);
    expect(serialised).not.toContain('\\u0000');
    expect(serialised).not.toContain(`browser-agent:${String(TAB_ID)}`);
    expect(serialised).not.toContain(PROJECT_ONE);
    expectScalarFieldsOnly(h.logs);
  });

  it('throttles the locate failure warning per session like every other one', async () => {
    const h = harness({
      sources: {
        locate: () =>
          Promise.resolve(err(new DebuggenError('CODE_INDEX_FAILED', 'The index is unreadable.'))),
      },
    });

    for (let index = 0; index < 20; index += 1) {
      const report = expectReport(await h.ingest.ingest(BROWSER_CONTEXT, [makeIngress()]));
      expect(report.failures.location).toBe(1);
    }

    expect(
      recordsOf(
        h.logs,
        'warn',
        'telemetry events could not be located; they are stored without one',
      ),
    ).toHaveLength(1);
    expect(h.repo.calls, 'every batch was still stored').toHaveLength(20);
  });
});
