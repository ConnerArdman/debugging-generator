/**
 * Tests for `./progress.ts`: the public failure copy a failed stage is shown
 * with, the emitter's handling of its own collaborators failing, the Step-8
 * groups every row is filed under, and the wording of the investigation's
 * class rows.
 *
 * The from-findings guarantee of the row builders is asserted by
 * `apps/local-service/test/integration/session-lifecycle.test.ts`; this suite
 * covers what that one cannot observe from the outside — that no failure's own
 * text, and no hint a product builder did not register, can become a row; that
 * the reference a row shows leads to a `debug` diagnostic of the failure; that
 * a failing logger, store or transport never costs a connected client its row;
 * and that the investigation and the planning report inside the groups Step 8
 * shows while a failure keeps the stage that failed.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  PROGRESS_STAGES,
  parseSessionProgressPayload,
  type ProtocolMessage,
} from '@debuggen/protocol';
import {
  DEBUGGEN_ERROR_CODES,
  DebuggenError,
  err,
  newSessionId,
  ok,
  type DebuggenErrorCode,
  type LogFields,
  type LogLevel,
  type Logger,
  type Result,
} from '@debuggen/shared';

import type { ServiceConfig } from '../config.js';
import { LOG_ERROR_FIELD_KEY, createServiceLogger } from '../logging.js';
import type { AppendProgressInput } from '../store/sessions-repo.js';
import {
  CANCELLATION_COPY_BY_CAUSE,
  FAILURE_COPY_BY_CODE,
  PROGRESS_RECIPIENT_KINDS,
  PROGRESS_STAGE_GROUPS,
  PROGRESS_STAGE_TITLES,
  PRODUCT_TEXT_MAX_LENGTH,
  PRODUCT_TEXT_REGISTRY_LIMIT,
  READY_TO_CAPTURE_MESSAGE,
  STAGE_CANCELLATION_CAUSES,
  STAGE_FAILURE_DIAGNOSTIC_MESSAGE,
  STAGE_FAILURE_LOG_MESSAGE,
  authorProductText,
  buildInvestigationRows,
  buildStageCancelledRow,
  carriesWrappedExceptionText,
  createSessionProgress,
  isProductAuthoredText,
  publicFailureCopy,
  type SessionProgressDeps,
} from './progress.js';
import type { SessionFailure } from './state-machine.js';

/* -------------------------------------------------------------------------------------------------
 * Doubles: a recording store, broadcaster and logger
 * ---------------------------------------------------------------------------------------------- */

/** One log call as the recording logger saw it, bindings merged under the call's fields. */
interface LoggedRecord {
  readonly level: LogLevel;
  readonly message: string;
  readonly fields: LogFields;
}

/** One broadcast as the recording broadcaster saw it. */
interface BroadcastCall {
  readonly sessionId: string;
  readonly kinds: readonly string[];
  readonly frame: ProtocolMessage;
}

/** A `Logger` that records every call, children included, into one shared list. */
function recordingLogger(records: LoggedRecord[], bindings: LogFields = {}): Logger {
  const at =
    (level: LogLevel) =>
    (message: string, fields?: LogFields): void => {
      records.push({ level, message, fields: { ...bindings, ...(fields ?? {}) } });
    };
  return {
    level: 'trace',
    trace: at('trace'),
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
    fatal: at('fatal'),
    child: (next) => recordingLogger(records, { ...bindings, ...next }),
  };
}

/** Everything one emitter under test wrote, read back by the assertions. */
interface EmitterProbe {
  readonly appended: AppendProgressInput[];
  readonly broadcasts: BroadcastCall[];
  readonly logs: LoggedRecord[];
  readonly progress: ReturnType<typeof createSessionProgress>;
}

/** Overrides for {@link emitter}: the store's answer and any dependency of the emitter. */
interface EmitterOptions extends Partial<Omit<SessionProgressDeps, 'sessions' | 'broadcaster'>> {
  /** What `appendProgress` answers; `ok` by default. */
  readonly store?: () => Result<void, DebuggenError>;
  /** Runs after a broadcast is recorded; a throw here is a transport failure. */
  readonly deliver?: () => void;
}

/** Builds an emitter over recording doubles. */
function emitter(options: EmitterOptions = {}): EmitterProbe {
  const appended: AppendProgressInput[] = [];
  const broadcasts: BroadcastCall[] = [];
  const logs: LoggedRecord[] = [];
  const { store, deliver, ...deps } = options;
  const progress = createSessionProgress({
    logger: recordingLogger(logs),
    ...deps,
    sessions: {
      appendProgress: (entry) => {
        appended.push(entry);
        return store === undefined ? ok(undefined) : store();
      },
    },
    broadcaster: {
      broadcastToKinds: (sessionId, kinds, frame) => {
        broadcasts.push({ sessionId, kinds, frame });
        deliver?.();
      },
    },
  });
  return { appended, broadcasts, logs, progress };
}

/** The `session.progress` payload of a recorded frame. */
function progressPayloadOf(call: BroadcastCall | undefined): {
  readonly message: string;
  readonly detail?: string | undefined;
} {
  if (call?.frame.type !== 'session.progress') {
    throw new Error(`expected a session.progress frame, got ${String(call?.frame.type)}`);
  }
  return call.frame.payload;
}

/** The one stage-failure record the emitter logged. */
function failureRecordOf(logs: readonly LoggedRecord[]): LoggedRecord {
  const matching = logs.filter((record) => record.message === STAGE_FAILURE_LOG_MESSAGE);
  expect(matching).toHaveLength(1);
  return matching[0]!;
}

/** The one `debug` diagnostic twin of a stage failure the emitter logged. */
function diagnosticRecordOf(logs: readonly LoggedRecord[]): LoggedRecord {
  const matching = logs.filter((record) => record.message === STAGE_FAILURE_DIAGNOSTIC_MESSAGE);
  expect(matching).toHaveLength(1);
  return matching[0]!;
}

/** A record's fields without its error field: the part no serializer rewrites. */
function outsideErrorField(fields: LogFields): LogFields {
  return Object.fromEntries(Object.entries(fields).filter(([key]) => key !== LOG_ERROR_FIELD_KEY));
}

/** The reference at the end of a `failed` row's detail. */
const DETAIL_REF_PATTERN = /\(error code: ([A-Z_]+), ref: ([A-Za-z0-9][A-Za-z0-9_-]*)\)$/u;

/* -------------------------------------------------------------------------------------------------
 * Private sentinels: what an unexpected exception can quote
 * ---------------------------------------------------------------------------------------------- */

/** An absolute path on the developer's machine. */
const PATH_SENTINEL = '/home/dev-sentinel/private-project/src/ledger-sentinel.ts';

/** An inline SQL literal. */
const SQL_SENTINEL = "SELECT * FROM accounts WHERE email = 'owner.sentinel@example.test'";

/** A URL whose query value is private. */
const URL_SENTINEL = 'http://127.0.0.1:3999/api/orders?voucher=QV-SENTINEL-4417';

/** The query value on its own, which must not survive even with its URL redacted. */
const QUERY_VALUE_SENTINEL = 'QV-SENTINEL-4417';

/** A provider credential, assembled from fragments so no tracked line holds one. */
const CREDENTIAL_SENTINEL = ['sk', 'ant', 'api03', 'Wd'.repeat(24)].join('-');

/** Every sentinel an exception message below carries. */
const SENTINELS: readonly string[] = Object.freeze([
  PATH_SENTINEL,
  SQL_SENTINEL,
  URL_SENTINEL,
  QUERY_VALUE_SENTINEL,
  CREDENTIAL_SENTINEL,
  'owner.sentinel@example.test',
  'dev-sentinel',
]);

/** An exception message as `DebuggenError.from` would keep it, quoting every sentinel. */
const LEAKY_MESSAGE =
  `ENOENT: no such file or directory, open '${PATH_SENTINEL}' while running ${SQL_SENTINEL} ` +
  `for ${URL_SENTINEL} with ${CREDENTIAL_SENTINEL}`;

/**
 * A hint no product builder wrote — what an adapter's rejection, or an error
 * `DebuggenError.from` salvaged, can carry — quoting a URL whose query value
 * is private, a SQL literal and an absolute path. It reads like a recovery
 * step, which is exactly why plausibility is not what decides whether it is
 * shown.
 */
const LEAKY_HINT = `Retry ${URL_SENTINEL} once ${SQL_SENTINEL} succeeds in ${PATH_SENTINEL}.`;

/** The service configuration the real-logger test builds its logger from; nothing is opened. */
const LOGGER_CONFIG: ServiceConfig = {
  host: '127.0.0.1',
  port: 20000,
  logLevel: 'info',
  retentionDays: 30,
  provider: 'deterministic',
  debuggenHome: '/tmp/debuggen-home/progress-test',
  databasePath: '/tmp/debuggen-home/progress-test/sessions.sqlite',
  backupsDir: '/tmp/debuggen-home/progress-test/backups',
  indexCacheDir: '/tmp/debuggen-home/progress-test/index',
  authFilePath: '/tmp/debuggen-home/progress-test/auth.json',
  promptsDir: '/tmp/debuggen-home/progress-test/prompts',
};

/** Asserts that no sentinel occurs anywhere in `value`'s JSON text. */
function expectNoSentinel(value: unknown, where: string): void {
  const text = JSON.stringify(value);
  for (const sentinel of SENTINELS) {
    expect(text.includes(sentinel), `${where} carries ${sentinel}`).toBe(false);
  }
}

describe('public failure copy', () => {
  it('has a summary and a hint for every code of the closed vocabulary', () => {
    for (const code of DEBUGGEN_ERROR_CODES) {
      const copy = FAILURE_COPY_BY_CODE[code];
      expect(copy.summary.trim().length, code).toBeGreaterThan(0);
      expect(copy.hint.trim().length, code).toBeGreaterThan(0);
      expect(copy.summary, code).toMatch(/[.)]$/u);
    }
  });

  it('composes the stage title with the code summary for every stage', () => {
    for (const stage of PROGRESS_STAGES) {
      const composed = publicFailureCopy(stage, 'INTERNAL');
      expect(composed.message).toBe(
        `${PROGRESS_STAGE_TITLES[stage]} failed: ${FAILURE_COPY_BY_CODE.INTERNAL.summary}`,
      );
      expect(composed.hint).toBe(FAILURE_COPY_BY_CODE.INTERNAL.hint);
    }
  });

  it("uses AAP §0.5.5's wording for an unavailable model provider", () => {
    expect(publicFailureCopy('understand', 'MODEL_UNAVAILABLE')).toEqual({
      message: 'Understanding problem failed: Model provider unavailable (MODEL_UNAVAILABLE).',
      hint: 'Check ANTHROPIC_API_KEY or switch DEBUGGEN_PROVIDER.',
    });
  });

  it('falls back to generic copy for a stage or code outside the vocabulary', () => {
    const outside = publicFailureCopy(
      '/home/dev/project' as (typeof PROGRESS_STAGES)[number],
      "SELECT 'secret'" as DebuggenErrorCode,
    );
    expect(outside).toEqual({
      message: `This step failed: ${FAILURE_COPY_BY_CODE.INTERNAL.summary}`,
      hint: FAILURE_COPY_BY_CODE.INTERNAL.hint,
    });
    expect(publicFailureCopy('plan', 'toString' as DebuggenErrorCode).message).toBe(
      `${PROGRESS_STAGE_TITLES.plan} failed: ${FAILURE_COPY_BY_CODE.INTERNAL.summary}`,
    );
  });
});

describe('the public projection of a stage failure', () => {
  it('keeps every private sentinel out of the stored row and the broadcast frame', () => {
    const sessionId = newSessionId();
    const probe = emitter({ newRef: () => 'ref_projection01' });
    const failure: SessionFailure = {
      stage: 'investigate',
      code: 'INTERNAL',
      message: LEAKY_MESSAGE,
    };

    const sent = probe.progress.stageFailed(sessionId, failure);

    expect(sent.ok).toBe(true);
    const copy = publicFailureCopy('investigate', 'INTERNAL');
    const expectedDetail = `${copy.hint} (error code: INTERNAL, ref: ref_projection01)`;

    expect(probe.appended).toHaveLength(1);
    expect(probe.appended[0]).toMatchObject({
      sessionId,
      stage: 'investigate',
      status: 'failed',
      message: copy.message,
      detail: expectedDetail,
    });
    expectNoSentinel(probe.appended, 'the stored row');

    expect(probe.broadcasts).toHaveLength(1);
    expect(probe.broadcasts[0]?.kinds).toEqual(PROGRESS_RECIPIENT_KINDS);
    expect(progressPayloadOf(probe.broadcasts[0])).toMatchObject({
      message: copy.message,
      detail: expectedDetail,
    });
    expectNoSentinel(probe.broadcasts, 'the broadcast frame');
    if (sent.ok) {
      expectNoSentinel(sent.value, 'the returned payload');
    }
  });

  it('logs the failure locally, at warn and as a debug twin, under the reference its row shows', () => {
    const sessionId = newSessionId();
    const probe = emitter({ newRef: () => 'ref_projection02' });
    const hint = FAILURE_COPY_BY_CODE.SERVER_AGENT_NOT_READY.hint;

    probe.progress.stageFailed(sessionId, {
      stage: 'generate-panel',
      code: 'MODEL_UNAVAILABLE',
      message: LEAKY_MESSAGE,
      hint,
    });

    const record = failureRecordOf(probe.logs);
    expect(record.level).toBe('warn');
    const { [LOG_ERROR_FIELD_KEY]: diagnostic, ...fields } = record.fields;
    expect(fields).toMatchObject({
      subsystem: 'sessions',
      sessionId,
      stage: 'generate-panel',
      code: 'MODEL_UNAVAILABLE',
      ref: 'ref_projection02',
      hintSource: 'failure',
      rowSent: true,
    });
    // The failure's own words travel only as the error field, for the service's
    // serializer to redact; no other field of any record carries them.
    expectNoSentinel(fields, 'the failure record outside its error field');
    expect(DebuggenError.is(diagnostic)).toBe(true);
    if (DebuggenError.is(diagnostic)) {
      expect(diagnostic.code).toBe('MODEL_UNAVAILABLE');
      expect(diagnostic.message).toBe(LEAKY_MESSAGE);
      // A proven hint may travel at warn; it is product copy.
      expect(diagnostic.hint).toBe(hint);
    }

    const twin = diagnosticRecordOf(probe.logs);
    expect(twin.level).toBe('debug');
    const { [LOG_ERROR_FIELD_KEY]: detailed, ...twinFields } = twin.fields;
    expect(twinFields).toEqual({
      subsystem: 'sessions',
      sessionId,
      stage: 'generate-panel',
      code: 'MODEL_UNAVAILABLE',
      ref: 'ref_projection02',
    });
    expect(DebuggenError.is(detailed)).toBe(true);
    if (DebuggenError.is(detailed)) {
      expect(detailed.code).toBe('MODEL_UNAVAILABLE');
      expect(detailed.message).toBe(LEAKY_MESSAGE);
      expect(detailed.hint).toBe(hint);
    }

    for (const other of probe.logs) {
      expectNoSentinel(outsideErrorField(other.fields), `the "${other.message}" record`);
    }

    const detail = progressPayloadOf(probe.broadcasts[0]).detail ?? '';
    expect(DETAIL_REF_PATTERN.exec(detail)?.slice(1)).toEqual([
      'MODEL_UNAVAILABLE',
      record.fields['ref'],
    ]);
  });

  it("shows the failure's own hint once a product builder registered it, such as the relaunch command", () => {
    const probe = emitter({ newRef: () => 'ref_projection03' });
    const command = `pnpm run dev --preload # ${newSessionId()}`;
    const composed = `Relaunch the dev server with: ${command}`;
    const sessionId = newSessionId();
    const failure: SessionFailure = {
      stage: 'capture',
      code: 'SERVER_AGENT_NOT_READY',
      message: LEAKY_MESSAGE,
      hint: composed,
    };

    // Before registration the very same sentence is unproven, and the code's copy is shown.
    probe.progress.stageFailed(sessionId, failure);
    authorProductText(composed);
    probe.progress.stageFailed(sessionId, failure);

    expect(probe.appended.map((row) => row.message)).toEqual([
      publicFailureCopy('capture', 'SERVER_AGENT_NOT_READY').message,
      publicFailureCopy('capture', 'SERVER_AGENT_NOT_READY').message,
    ]);
    expect(probe.appended.map((row) => row.detail)).toEqual([
      `${FAILURE_COPY_BY_CODE.SERVER_AGENT_NOT_READY.hint} (error code: SERVER_AGENT_NOT_READY, ref: ref_projection03)`,
      `${composed} (error code: SERVER_AGENT_NOT_READY, ref: ref_projection03)`,
    ]);
    expect(progressPayloadOf(probe.broadcasts[1]).detail).toBe(probe.appended[1]?.detail);
    const warned = probe.logs.filter((record) => record.message === STAGE_FAILURE_LOG_MESSAGE);
    expect(warned.map((record) => record.fields['hintSource'])).toEqual(['code', 'failure']);
    expect(
      warned.map((record) => {
        const logged = record.fields[LOG_ERROR_FIELD_KEY];
        return DebuggenError.is(logged) ? logged.hint : 'not a DebuggenError';
      }),
    ).toEqual([undefined, composed]);
  });

  it('never shows or logs at warn an unproven hint, whatever it quotes or wherever it came from', () => {
    const sessionId = newSessionId();
    const probe = emitter({ newRef: () => 'ref_projection06' });
    // A branded value `DebuggenError.from` salvages code, message and hint from,
    // as a stage's catch block does with a collaborator's rejection.
    const salvaged = DebuggenError.from(
      {
        __isDebuggenError__: true,
        code: 'INSTRUMENTATION_INSTALL_FAILED',
        message: LEAKY_MESSAGE,
        hint: LEAKY_HINT,
      },
      'INTERNAL',
    );
    expect(salvaged.hint).toBe(LEAKY_HINT);
    const failures: readonly SessionFailure[] = [
      { stage: 'instrument', code: salvaged.code, message: salvaged.message, hint: LEAKY_HINT },
      // Provenance is judged on the raw value: fixed copy padded or re-cased is not fixed copy.
      {
        stage: 'plan',
        code: 'PLAN_INVALID',
        message: LEAKY_MESSAGE,
        hint: ` ${FAILURE_COPY_BY_CODE.MODEL_UNAVAILABLE.hint}`,
      },
    ];

    const sent = failures.map((failure) => probe.progress.stageFailed(sessionId, failure));

    expect(sent.every((result) => result.ok)).toBe(true);
    expect(probe.appended.map((row) => row.detail)).toEqual([
      `${FAILURE_COPY_BY_CODE.INSTRUMENTATION_INSTALL_FAILED.hint} (error code: INSTRUMENTATION_INSTALL_FAILED, ref: ref_projection06)`,
      `${FAILURE_COPY_BY_CODE.PLAN_INVALID.hint} (error code: PLAN_INVALID, ref: ref_projection06)`,
    ]);
    expectNoSentinel(probe.appended, 'the stored rows');
    expect(probe.broadcasts).toHaveLength(2);
    expect(probe.broadcasts.every((call) => call.kinds === PROGRESS_RECIPIENT_KINDS)).toBe(true);
    expectNoSentinel(probe.broadcasts, 'the broadcast frames');
    expectNoSentinel(
      sent.map((result) => (result.ok ? result.value : undefined)),
      'the returned payloads',
    );

    // No field but the error field of any record carries the hint, and the
    // warn record's error does not carry it at all: only the debug twin does.
    for (const record of probe.logs) {
      expectNoSentinel(outsideErrorField(record.fields), `the "${record.message}" record`);
    }
    const warned = probe.logs.filter((record) => record.message === STAGE_FAILURE_LOG_MESSAGE);
    expect(warned.map((record) => record.fields['hintSource'])).toEqual(['code', 'code']);
    for (const record of warned) {
      const logged = record.fields[LOG_ERROR_FIELD_KEY];
      expect(DebuggenError.is(logged) ? logged.hint : 'not a DebuggenError').toBeUndefined();
    }
    const twins = probe.logs.filter(
      (record) => record.message === STAGE_FAILURE_DIAGNOSTIC_MESSAGE,
    );
    expect(twins.map((record) => record.level)).toEqual(['debug', 'debug']);
    expect(
      twins.map((record) => {
        const logged = record.fields[LOG_ERROR_FIELD_KEY];
        return DebuggenError.is(logged) ? [logged.code, logged.message, logged.hint] : [];
      }),
    ).toEqual([
      ['INSTRUMENTATION_INSTALL_FAILED', LEAKY_MESSAGE, LEAKY_HINT],
      ['PLAN_INVALID', LEAKY_MESSAGE, ` ${FAILURE_COPY_BY_CODE.MODEL_UNAVAILABLE.hint}`],
    ]);
  });

  it("leads the row's reference to a redacted diagnostic at debug, and to no private text at info", () => {
    const failure: SessionFailure = {
      stage: 'investigate',
      code: 'INTERNAL',
      message: LEAKY_MESSAGE,
      hint: LEAKY_HINT,
    };
    const run = (logLevel: ServiceConfig['logLevel']) => {
      const lines: string[] = [];
      const logger = createServiceLogger(
        { ...LOGGER_CONFIG, logLevel },
        { destination: { write: (line: string) => void lines.push(line) } },
      );
      const probe = emitter({ logger });
      probe.progress.stageFailed(newSessionId(), failure);
      const ref = DETAIL_REF_PATTERN.exec(String(probe.appended[0]?.detail))?.[2];
      const records = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
      return { lines, records, ref, probe };
    };

    // The default operating range: the one warn record, with the reference and
    // the code, and none of the failure's message or unproven hint.
    const atInfo = run('info');
    expect(atInfo.ref).toMatch(/^msg_/u);
    expect(atInfo.records.map((record) => record['msg'])).toEqual([STAGE_FAILURE_LOG_MESSAGE]);
    expect(atInfo.records[0]).toMatchObject({ ref: atInfo.ref, code: 'INTERNAL' });
    expectNoSentinel(atInfo.lines.join('\n'), 'the service log at info');
    expectNoSentinel(atInfo.probe.appended, 'the stored row');

    // Opted into debug: the twin under the same reference carries the
    // failure's message, redacted by the service's serializer — the query
    // value and the SQL literal masked.
    const atDebug = run('debug');
    const twin = atDebug.records.find(
      (record) => record['msg'] === STAGE_FAILURE_DIAGNOSTIC_MESSAGE,
    );
    expect(twin).toMatchObject({ ref: atDebug.ref, code: 'INTERNAL', stage: 'investigate' });
    const detailed = twin?.[LOG_ERROR_FIELD_KEY] as Record<string, unknown> | undefined;
    expect(detailed?.['type']).toBe('DebuggenError');
    expect(typeof detailed?.['message']).toBe('string');
    const redacted = String(detailed?.['message']);
    expect(redacted.length).toBeGreaterThan(0);
    expect(redacted).not.toContain(QUERY_VALUE_SENTINEL);
    expect(redacted).not.toContain('owner.sentinel@example.test');
    expect(redacted).not.toContain(CREDENTIAL_SENTINEL);
    expectNoSentinel(atDebug.probe.appended, 'the stored row');
  });

  it('falls back to the code hint for a blank hint and shows a long proven one whole, before the suffix', () => {
    const probe = emitter({ newRef: () => 'ref_projection04' });
    const sessionId = newSessionId();
    // As long as the registry proves, and well past the row's display bound
    // of 1000: a projection that clipped it would cut the sentence short.
    const opening = `Ask again ${newSessionId()}.`;
    const long = authorProductText(
      `${opening}${' Ask again.'.repeat(Math.floor((PRODUCT_TEXT_MAX_LENGTH - opening.length) / 11))}`,
    );
    expect(long.length).toBeGreaterThan(1000);
    expect(long.length).toBeLessThanOrEqual(PRODUCT_TEXT_MAX_LENGTH);
    expect(isProductAuthoredText(long)).toBe(true);

    probe.progress.stageFailed(sessionId, {
      stage: 'plan',
      code: 'PLAN_INVALID',
      message: LEAKY_MESSAGE,
      hint: authorProductText(' \n\t '),
    });
    probe.progress.stageFailed(sessionId, {
      stage: 'plan',
      code: 'PLAN_INVALID',
      message: LEAKY_MESSAGE,
      hint: long,
    });

    expect(probe.appended[0]?.detail).toBe(
      `${FAILURE_COPY_BY_CODE.PLAN_INVALID.hint} (error code: PLAN_INVALID, ref: ref_projection04)`,
    );
    const whole = String(probe.appended[1]?.detail);
    expect(whole).toBe(`${long} (error code: PLAN_INVALID, ref: ref_projection04)`);
    expect(whole).not.toContain('…');
    // Within protocol's transport bound for `session.progress` detail.
    expect(whole.length).toBeLessThanOrEqual(4000);
    expect(progressPayloadOf(probe.broadcasts[1]).detail).toBe(whole);
    expect(
      probe.logs
        .filter((record) => record.message === STAGE_FAILURE_LOG_MESSAGE)
        .map((record) => record.fields['hintSource']),
    ).toEqual(['code', 'failure']);
  });

  it('never cuts a proven relaunch command mid-command in the failed row', () => {
    const probe = emitter({ newRef: () => 'ref_projection07' });
    const sessionId = newSessionId();
    // A relaunch hint as long as a readiness hint may be (1000): its command,
    // which ends the hint, would lose its tail to a 1000-character detail.
    const lead =
      'This project’s dev server is running without the Debug Generator preload. Start it by hand: cd ';
    const tail =
      ' && NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--import file:///opt/debuggen/telemetry/node/register.mjs" DEBUGGEN_TOKEN="$DEBUGGEN_TOKEN" pnpm run dev';
    const relaunch = authorProductText(
      `${lead}/work/${'nested/'.repeat(Math.floor((1000 - lead.length - tail.length - 6) / 7))}${'p'.repeat((1000 - lead.length - tail.length - 6) % 7)}${tail}`,
    );
    expect(relaunch.length).toBe(1000);

    probe.progress.stageFailed(sessionId, {
      stage: 'instrument',
      code: 'INSTRUMENTATION_UNAVAILABLE',
      message: LEAKY_MESSAGE,
      hint: relaunch,
    });

    expect(probe.appended[0]?.detail).toBe(
      `${relaunch} (error code: INSTRUMENTATION_UNAVAILABLE, ref: ref_projection07)`,
    );
    expect(progressPayloadOf(probe.broadcasts[0]).detail).toBe(probe.appended[0]?.detail);
    expect(failureRecordOf(probe.logs).fields['hintSource']).toBe('failure');
  });

  it('names and words a code outside the closed vocabulary as INTERNAL', () => {
    const probe = emitter({ newRef: () => 'ref_projection05' });

    probe.progress.stageFailed(newSessionId(), {
      stage: 'analyze',
      code: `DROP TABLE ${PATH_SENTINEL}` as DebuggenErrorCode,
      message: LEAKY_MESSAGE,
    });

    expect(probe.appended[0]?.message).toBe(publicFailureCopy('analyze', 'INTERNAL').message);
    expect(probe.appended[0]?.detail).toBe(
      `${FAILURE_COPY_BY_CODE.INTERNAL.hint} (error code: INTERNAL, ref: ref_projection05)`,
    );
    expectNoSentinel(probe.appended, 'the stored row');
    const { [LOG_ERROR_FIELD_KEY]: diagnostic, ...fields } = failureRecordOf(probe.logs).fields;
    expect(fields['code']).toBe('INTERNAL');
    expect(DebuggenError.is(diagnostic) ? diagnostic.code : undefined).toBe('INTERNAL');
    expectNoSentinel(fields, 'the failure record outside its error field');
  });

  it('mints a fresh message id per failure, and replaces an unusable injected reference', () => {
    const sessionId = newSessionId();
    const failure: SessionFailure = {
      stage: 'understand',
      code: 'INTERNAL',
      message: LEAKY_MESSAGE,
    };
    const refOf = (detail: unknown): string | undefined =>
      DETAIL_REF_PATTERN.exec(String(detail))?.[2];

    const minted = emitter();
    minted.progress.stageFailed(sessionId, failure);
    minted.progress.stageFailed(sessionId, failure);
    const [first, second] = minted.appended.map((row) => refOf(row.detail));
    expect(first).toMatch(/^msg_/u);
    expect(second).toMatch(/^msg_/u);
    expect(first).not.toBe(second);
    expect(
      minted.logs
        .filter((record) => record.message === STAGE_FAILURE_LOG_MESSAGE)
        .map((record) => record.fields['ref']),
    ).toEqual([first, second]);

    const unusable = emitter({ newRef: () => `ref ${PATH_SENTINEL}` });
    unusable.progress.stageFailed(sessionId, failure);
    expect(refOf(unusable.appended[0]?.detail)).toMatch(/^msg_/u);
    expectNoSentinel(unusable.appended, 'a row whose injected reference was unusable');

    const throwing = emitter({
      newRef: () => {
        throw new Error(`reference store at ${PATH_SENTINEL} is gone`);
      },
    });
    const sent = throwing.progress.stageFailed(sessionId, failure);
    expect(sent.ok).toBe(true);
    expect(refOf(throwing.appended[0]?.detail)).toMatch(/^msg_/u);
    expect(throwing.broadcasts).toHaveLength(1);
    expectNoSentinel(throwing.appended, 'a row whose reference generator threw');
    expectNoSentinel(
      throwing.logs.map((record) =>
        record.fields[LOG_ERROR_FIELD_KEY] === undefined ? record : {},
      ),
      'the logs of a reference generator that threw',
    );
  });
});

describe('a logger that throws never costs a client its row', () => {
  /** A logger whose every level method, and `child()` itself, throws. */
  function throwingLogger(): Logger {
    const refuse = (): never => {
      throw new Error(`the log destination ${PATH_SENTINEL} is closed`);
    };
    return {
      level: 'trace',
      trace: refuse,
      debug: refuse,
      info: refuse,
      warn: refuse,
      error: refuse,
      fatal: refuse,
      child: refuse,
    };
  }

  /** A logger whose `child()` works but whose every write throws, as a failing stream would. */
  function failingWrites(): Logger {
    const logger = throwingLogger();
    return { ...logger, child: () => logger };
  }

  /** Runs `body` with standard error captured, so the guard's fallback notice is observable. */
  function withCapturedStandardError(body: (written: () => string) => void): void {
    const lines: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      lines.push(typeof chunk === 'string' ? chunk : String(chunk));
      return true;
    });
    try {
      body(() => lines.join(''));
    } finally {
      spy.mockRestore();
    }
  }

  /** A store whose every append fails, as a full disk would. */
  const failingStore = (): Result<void, DebuggenError> =>
    err(new DebuggenError('STORE_ERROR', `database is locked at ${PATH_SENTINEL}`));

  for (const [name, make] of [
    ['every logger method and child() throw', throwingLogger],
    ['every write throws while child() works', failingWrites],
  ] as const) {
    it(`persists, broadcasts and returns ok when ${name} and the store fails`, () => {
      withCapturedStandardError((written) => {
        const sessionId = newSessionId();
        const probe = emitter({ logger: make(), store: failingStore });
        const started = probe.progress.stageStarted(sessionId, 'understand');
        const failed = probe.progress.stageFailed(sessionId, {
          stage: 'understand',
          code: 'MODEL_UNAVAILABLE',
          message: LEAKY_MESSAGE,
        });

        expect(started.ok).toBe(true);
        expect(failed.ok).toBe(true);
        expect(probe.appended.map((row) => row.status)).toEqual(['running', 'failed']);
        expect(probe.broadcasts.map((call) => progressPayloadOf(call).message)).toEqual([
          PROGRESS_STAGE_TITLES.understand,
          publicFailureCopy('understand', 'MODEL_UNAVAILABLE').message,
        ]);
        expectNoSentinel(probe.broadcasts, 'the broadcast frames');
        // The guard announced the dropped records once, in its own fixed words.
        expect(written()).toContain('log records could not be written and were dropped');
        expectNoSentinel(written(), 'the fallback notice');
      });
    });
  }

  it('returns ok when the logger and the transport both throw', () => {
    withCapturedStandardError(() => {
      const probe = emitter({
        logger: throwingLogger(),
        deliver: () => {
          throw new Error('socket closed');
        },
      });
      const sent = probe.progress.stageFailed(newSessionId(), {
        stage: 'plan',
        code: 'PLAN_INVALID',
        message: LEAKY_MESSAGE,
      });

      expect(sent.ok).toBe(true);
      expect(probe.appended).toHaveLength(1);
      expect(probe.broadcasts).toHaveLength(1);
    });
  });

  it('answers a schema-rejected row with Err, never a throw, when the logger throws', () => {
    withCapturedStandardError(() => {
      const probe = emitter({ logger: throwingLogger() });
      let sent: ReturnType<typeof probe.progress.emit> | undefined;

      expect(() => {
        sent = probe.progress.emit(newSessionId(), {
          stage: 'understand',
          status: 'running',
          message: '',
        });
      }).not.toThrow();
      expect(sent?.ok).toBe(false);
      expect(probe.appended).toHaveLength(0);
      expect(probe.broadcasts).toHaveLength(0);
    });
  });
});

describe('a clock that throws never costs a client its row', () => {
  it('stamps the stored row and the frame with the same wall-clock time, and says so at debug', () => {
    const before = Date.now();
    const probe = emitter({
      now: () => {
        throw new TypeError(`clock source ${PATH_SENTINEL} is unreadable`);
      },
    });

    const sent = probe.progress.stageStarted(newSessionId(), 'capture');

    expect(sent.ok).toBe(true);
    const stored = probe.appended[0]?.ts;
    expect(typeof stored).toBe('number');
    expect(Number.isFinite(stored)).toBe(true);
    expect(stored).toBeGreaterThanOrEqual(before);
    expect(probe.broadcasts).toHaveLength(1);
    expect(probe.broadcasts[0]?.frame.ts).toBe(stored);

    const decision = probe.logs.filter(
      (record) =>
        record.message ===
        'the injected progress clock failed; the row is stamped with the wall clock',
    );
    expect(decision).toHaveLength(1);
    expect(decision[0]?.level).toBe('debug');
    expect(decision[0]?.fields).toMatchObject({ subsystem: 'sessions', errorClass: 'TypeError' });
    expectNoSentinel(probe.logs, 'the clock-failure record');
  });

  it('stamps with the wall clock when the clock answers an unusable time', () => {
    const probe = emitter({ now: () => Number.NaN });

    probe.progress.stageStarted(newSessionId(), 'capture');

    const stored = probe.appended[0]?.ts ?? 0;
    expect(Number.isFinite(stored) && stored > 0).toBe(true);
    expect(probe.broadcasts[0]?.frame.ts).toBe(stored);
  });
});

describe('carriesWrappedExceptionText', () => {
  it('tells a wrapped exception text from a sentence the product wrote', () => {
    expect(
      carriesWrappedExceptionText(new DebuggenError('SESSION_NOT_FOUND', 'No such session.')),
    ).toBe(false);
    expect(carriesWrappedExceptionText(DebuggenError.from(new Error('EACCES: /home/dev/x')))).toBe(
      true,
    );
    expect(carriesWrappedExceptionText(DebuggenError.from(new TypeError('')))).toBe(true);
    expect(carriesWrappedExceptionText(DebuggenError.from('/home/dev/x'))).toBe(true);
    expect(
      carriesWrappedExceptionText(
        new DebuggenError('STORE_ERROR', 'The session store failed.', {
          cause: new Error('disk I/O error at /home/dev/x'),
        }),
      ),
    ).toBe(false);
  });

  it('answers true for a cause that cannot be inspected', () => {
    const cause = new Proxy(
      {},
      {
        getPrototypeOf(): never {
          throw new Error('no prototype');
        },
      },
    );
    expect(carriesWrappedExceptionText(new DebuggenError('INTERNAL', 'x', { cause }))).toBe(true);
  });
});

describe('product-authored text provenance', () => {
  it('recognises every fixed failure copy text without registration', () => {
    for (const code of DEBUGGEN_ERROR_CODES) {
      expect(isProductAuthoredText(FAILURE_COPY_BY_CODE[code].summary)).toBe(true);
      expect(isProductAuthoredText(FAILURE_COPY_BY_CODE[code].hint)).toBe(true);
    }
  });

  it('recognises a registered text exactly, and nothing near it', () => {
    const marker = newSessionId();
    const text = `Restart the dev server with: pnpm run dev # ${marker}`;
    expect(isProductAuthoredText(text)).toBe(false);
    expect(authorProductText(text)).toBe(text);
    expect(isProductAuthoredText(text)).toBe(true);
    expect(isProductAuthoredText(` ${text}`)).toBe(false);
    expect(isProductAuthoredText(text.toUpperCase())).toBe(false);
    expect(isProductAuthoredText(`${text}?email=zz-private`)).toBe(false);
  });

  it('never recognises a non-string, an empty string or an over-long text', () => {
    const long = `${newSessionId()}${'x'.repeat(PRODUCT_TEXT_MAX_LENGTH)}`;
    expect(authorProductText(long)).toBe(long);
    expect(isProductAuthoredText(long)).toBe(false);
    expect(authorProductText('')).toBe('');
    expect(isProductAuthoredText('')).toBe(false);
    for (const value of [undefined, null, 42, {}, ['x'], new String('x')]) {
      expect(isProductAuthoredText(value)).toBe(false);
    }
  });

  it('forgets the least recently used text first once the bound is reached', () => {
    const prefix = newSessionId();
    const texts = Array.from(
      { length: PRODUCT_TEXT_REGISTRY_LIMIT + 1 },
      (_, index) => `${prefix} product sentence ${String(index)}`,
    );
    for (const text of texts.slice(0, PRODUCT_TEXT_REGISTRY_LIMIT)) {
      authorProductText(text);
    }
    const first = texts[0] ?? '';
    const second = texts[1] ?? '';
    // Recognising the first text refreshes it, so the second is now the oldest.
    expect(isProductAuthoredText(first)).toBe(true);
    authorProductText(texts[PRODUCT_TEXT_REGISTRY_LIMIT] ?? '');
    expect(isProductAuthoredText(second)).toBe(false);
    expect(isProductAuthoredText(first)).toBe(true);
    expect(isProductAuthoredText(texts[PRODUCT_TEXT_REGISTRY_LIMIT])).toBe(true);
  });
});

/* -------------------------------------------------------------------------------------------------
 * The Step-8 groups: the investigation reports inside "Understanding problem", planning inside
 * "Preparing instrumentation", and a failure keeps the stage that failed
 * ---------------------------------------------------------------------------------------------- */

/** A component the code graph found, and the file that declares it. */
const PANEL_COMPONENT = 'OrbitPanel';
const PANEL_FILE = 'src/panels/OrbitPanel.tsx';

/** The event handler the panel binds, declared in the same file. */
const PANEL_HANDLER = 'handlePlotClick';

/** The stored rows of a probe, as `[stage, status, message]` triples. */
function storedRows(probe: EmitterProbe): (readonly [string, string, string])[] {
  return probe.appended.map((row) => [row.stage, row.status, row.message] as const);
}

describe('the Step-8 groups', () => {
  it('places every stage in a group that heads itself', () => {
    expect(Object.keys(PROGRESS_STAGE_GROUPS).sort()).toEqual([...PROGRESS_STAGES].sort());
    for (const stage of PROGRESS_STAGES) {
      const group = PROGRESS_STAGE_GROUPS[stage];
      expect(PROGRESS_STAGES).toContain(group);
      expect(PROGRESS_STAGE_GROUPS[group], `${stage} reports in a group of its own`).toBe(group);
    }
    expect(PROGRESS_STAGE_GROUPS.investigate).toBe('understand');
    expect(PROGRESS_STAGE_GROUPS.plan).toBe('instrument');
  });

  it('files the investigation under "Understanding problem": re-opened as it starts, settled as it closes', () => {
    const sessionId = newSessionId();
    const probe = emitter();

    probe.progress.stageStarted(sessionId, 'understand');
    probe.progress.stageCompleted(sessionId, 'understand');
    probe.progress.stageStarted(sessionId, 'investigate');
    probe.progress.reportInvestigation(sessionId, {
      components: [PANEL_COMPONENT],
      eventHandlers: [PANEL_HANDLER],
      routes: [],
      databaseDependencies: [],
      origins: new Map([
        [PANEL_COMPONENT, PANEL_FILE],
        [PANEL_HANDLER, PANEL_FILE],
      ]),
    });
    probe.progress.stageCompleted(sessionId, 'investigate');

    const title = PROGRESS_STAGE_TITLES.understand;
    expect(storedRows(probe)).toEqual([
      ['understand', 'running', title],
      ['understand', 'done', title],
      ['understand', 'running', title],
      ['understand', 'done', `Found ${PANEL_COMPONENT}`],
      ['understand', 'done', 'Traced event handler'],
      ['understand', 'done', title],
    ]);
    // The frames carry the same group as the stored rows, so a replay reads as the live view did.
    expect(
      probe.broadcasts.map((call) =>
        call.frame.type === 'session.progress' ? call.frame.payload.stage : call.frame.type,
      ),
    ).toEqual(probe.appended.map((row) => row.stage));
    expect(JSON.stringify(probe.appended)).not.toContain(PROGRESS_STAGE_TITLES.investigate);
  });

  it('opens "Preparing instrumentation" with planning and files its own rows there', () => {
    const sessionId = newSessionId();
    const probe = emitter();
    const fallback = 'Continuing with the runtime-only plan';

    probe.progress.stageStarted(sessionId, 'plan');
    probe.progress.emit(sessionId, { stage: 'plan', status: 'running', message: fallback });
    probe.progress.stageCompleted(sessionId, 'plan');
    probe.progress.stageStarted(sessionId, 'instrument');
    probe.progress.readyToCapture(sessionId);

    const title = PROGRESS_STAGE_TITLES.instrument;
    expect(storedRows(probe)).toEqual([
      ['instrument', 'running', title],
      ['instrument', 'running', fallback],
      ['instrument', 'done', title],
      ['instrument', 'running', title],
      ['instrument', 'done', title],
      ['instrument', 'done', READY_TO_CAPTURE_MESSAGE],
    ]);
    expect(JSON.stringify(probe.appended)).not.toContain(PROGRESS_STAGE_TITLES.plan);
  });

  it('keeps a caller’s own header line, filed under the group', () => {
    const sessionId = newSessionId();
    const probe = emitter();
    probe.progress.stageStarted(sessionId, 'investigate', 'Reading the project index');
    expect(storedRows(probe)).toEqual([['understand', 'running', 'Reading the project index']]);
  });

  it.each(['investigate', 'plan'] as const)(
    'keeps a %s failure on the stage that failed, worded with that stage’s own title',
    (stage) => {
      const sessionId = newSessionId();
      const probe = emitter({ newRef: () => `ref_group_${stage}` });
      const failure: SessionFailure = { stage, code: 'STORE_ERROR', message: LEAKY_MESSAGE };

      probe.progress.stageStarted(sessionId, stage);
      probe.progress.stageFailed(sessionId, failure);

      const copy = publicFailureCopy(stage, 'STORE_ERROR');
      expect(copy.message.startsWith(PROGRESS_STAGE_TITLES[stage])).toBe(true);
      expect(storedRows(probe)).toEqual([
        [
          PROGRESS_STAGE_GROUPS[stage],
          'running',
          PROGRESS_STAGE_TITLES[PROGRESS_STAGE_GROUPS[stage]],
        ],
        [stage, 'failed', copy.message],
      ]);
      // A failed row sent directly keeps its stage too.
      probe.progress.emit(sessionId, { stage, status: 'failed', message: copy.message });
      expect(probe.appended.at(-1)?.stage).toBe(stage);
    },
  );
});

/* -------------------------------------------------------------------------------------------------
 * The cancellation row: a stage withdrawn before it finished is reported, never failed
 * ---------------------------------------------------------------------------------------------- */

describe('the cancellation row', () => {
  it('words every stage and every cause from the stage title and the cause’s copy, as a done row', () => {
    expect([...STAGE_CANCELLATION_CAUSES].sort()).toEqual(
      Object.keys(CANCELLATION_COPY_BY_CAUSE).sort(),
    );
    for (const stage of PROGRESS_STAGES) {
      for (const cause of STAGE_CANCELLATION_CAUSES) {
        const copy = CANCELLATION_COPY_BY_CAUSE[cause];
        const row = buildStageCancelledRow(stage, cause);

        expect(row, `${stage}/${cause}`).toStrictEqual({
          stage,
          status: 'done',
          message: `${PROGRESS_STAGE_TITLES[stage]} ${copy.clause}`,
          detail: copy.detail,
        });
        expect(Object.isFrozen(row)).toBe(true);
        expect(row.message.toLowerCase()).not.toContain('failed');
        expect(
          parseSessionProgressPayload({ sessionId: newSessionId(), ...row }).ok,
          `${stage}/${cause} satisfies the session.progress schema`,
        ).toBe(true);
      }
    }
  });

  it('says the session was ended, and what that means, when the session’s end cancelled the stage', () => {
    expect(buildStageCancelledRow('instrument', 'session-ended')).toStrictEqual({
      stage: 'instrument',
      status: 'done',
      message: 'Preparing instrumentation cancelled: the session was ended.',
      detail:
        'Ending the session removes any instrumentation it applied; ask the question again in a new session to continue.',
    });
    expect(buildStageCancelledRow('plan', 'session-ended').message).toBe(
      'Planning instrumentation cancelled: the session was ended.',
    );
  });

  it('says the step was cancelled, and that it can run again, for any other cause', () => {
    expect(buildStageCancelledRow('instrument', 'cancelled')).toStrictEqual({
      stage: 'instrument',
      status: 'done',
      message: 'Preparing instrumentation was cancelled before it finished.',
      detail: 'Run the step again when you are ready.',
    });
  });

  it('falls back to generic copy for a stage or cause outside the vocabulary, never echoing it', () => {
    const outside = buildStageCancelledRow(
      '/home/dev/project' as (typeof PROGRESS_STAGES)[number],
      "SELECT 'secret'" as (typeof STAGE_CANCELLATION_CAUSES)[number],
    );
    expect(outside.message).toBe(`This step ${CANCELLATION_COPY_BY_CAUSE.cancelled.clause}`);
    expect(outside.detail).toBe(CANCELLATION_COPY_BY_CAUSE.cancelled.detail);
    expect(JSON.stringify(outside)).not.toContain('secret');
    expect(buildStageCancelledRow('plan', 'toString' as 'cancelled').message).toBe(
      `${PROGRESS_STAGE_TITLES.plan} ${CANCELLATION_COPY_BY_CAUSE.cancelled.clause}`,
    );
  });

  it('is filed under the cancelled stage’s group, like any other row that is not a failure', () => {
    const sessionId = newSessionId();
    const probe = emitter();

    probe.progress.stageStarted(sessionId, 'plan');
    const sent = probe.progress.emit(sessionId, buildStageCancelledRow('plan', 'session-ended'));

    expect(sent.ok).toBe(true);
    expect(storedRows(probe)).toEqual([
      ['instrument', 'running', PROGRESS_STAGE_TITLES.instrument],
      ['instrument', 'done', 'Planning instrumentation cancelled: the session was ended.'],
    ]);
    expect(probe.appended.at(-1)?.detail).toBe(CANCELLATION_COPY_BY_CAUSE['session-ended'].detail);
    expect(probe.logs.filter((record) => record.message === STAGE_FAILURE_LOG_MESSAGE)).toEqual([]);
  });
});

describe('the investigation’s class rows', () => {
  it('words a traced handler as one "Traced event handler" row: its symbol, then its file', () => {
    const rows = buildInvestigationRows({
      components: [PANEL_COMPONENT],
      eventHandlers: [PANEL_HANDLER],
      routes: [],
      databaseDependencies: [],
      relevantFiles: [
        { file: PANEL_FILE, symbol: PANEL_COMPONENT, reason: 'Renders the panel.', score: 1 },
        { file: PANEL_FILE, symbol: PANEL_HANDLER, reason: 'Handles the click.', score: 0.8 },
      ],
    });

    expect(rows).toEqual([
      {
        stage: 'understand',
        status: 'done',
        message: `Found ${PANEL_COMPONENT}`,
        detail: PANEL_FILE,
      },
      {
        stage: 'understand',
        status: 'done',
        message: 'Traced event handler',
        detail: `${PANEL_HANDLER} · ${PANEL_FILE}`,
      },
    ]);
    // No handler traced, no row: the label is never shown without its evidence.
    expect(
      buildInvestigationRows({ components: [PANEL_COMPONENT], eventHandlers: [] }).map(
        (row) => row.message,
      ),
    ).toEqual([`Found ${PANEL_COMPONENT}`]);
  });

  it('names every file holding a call site once, where the code graph located it', () => {
    const [row] = buildInvestigationRows({
      databaseDependencies: ['ledger.query', 'ledger.insert', 'cache.write'],
      origins: new Map([
        ['ledger.query', 'src/server/ledger.ts'],
        ['ledger.insert', 'src/server/ledger.ts'],
        ['cache.write', 'src/server/cache.ts'],
      ]),
      relevantFiles: [],
    });

    expect(row).toEqual({
      stage: 'understand',
      status: 'done',
      message: 'Found database dependency',
      detail:
        'ledger.query, ledger.insert, cache.write · src/server/ledger.ts, src/server/cache.ts',
    });
  });

  it('prefers the file the code graph located a finding in over a relevant file of that name', () => {
    const rows = buildInvestigationRows({
      components: [PANEL_COMPONENT],
      origins: new Map([[PANEL_COMPONENT, PANEL_FILE]]),
      relevantFiles: [
        {
          file: 'src/panels/index.ts',
          symbol: PANEL_COMPONENT,
          reason: 'Re-exports it.',
          score: 1,
        },
      ],
    });

    expect(rows.map((row) => row.detail)).toEqual([PANEL_FILE]);
  });
});
