/**
 * Tests for the failure answers of `./sessions.ts`: which words a failed
 * session request reaches the client in, and which diagnostic reference leads
 * from that answer to the service log.
 *
 * The routes themselves are exercised end to end by the integration suites;
 * this suite pins the decisions those suites cannot provoke on demand:
 *
 * - a collaborator's failure, a wrapped exception's text, and any refusal
 *   sentence no product builder registered — even under a code whose refusals
 *   may be sent verbatim — is answered with fixed copy and a diagnostic
 *   reference instead of what it said (CWE-209);
 * - a refusal the product composed and registered keeps its own words;
 * - every `500` carries a freshly minted reference, which its `error` record
 *   and that record's `debug` twin repeat with the failure itself.
 *
 * The handlers are mounted on a bare hono application behind a stand-in for
 * the auth middleware that resolves one editor principal; every collaborator
 * the scenario does not reach throws, so a stray call cannot pass unnoticed.
 */

import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import {
  HTTP_ROUTES,
  httpErrorResponseSchema,
  parseSessionRecord,
  sessionListItemSchema,
  toSessionListItem,
} from '@debuggen/protocol';
import type { HttpErrorResponse, SessionListItem, SessionRecord } from '@debuggen/protocol';
import { DebuggenError, err, newSessionId, ok } from '@debuggen/shared';
import type { LogFields, LogLevel, Logger, SessionId } from '@debuggen/shared';

import type { ServiceConfig } from '../../config.js';
import { LOG_ERROR_FIELD_KEY, createServiceLogger } from '../../logging.js';
import {
  FAILURE_COPY_BY_CODE,
  authorProductText,
  isProductAuthoredText,
} from '../../sessions/progress.js';
import type { EditorPrincipal, ServerEnv } from '../auth.js';
import {
  SESSION_REQUEST_DIAGNOSTIC_MESSAGE,
  SESSION_REQUEST_FAILED_LOG_MESSAGE,
  SESSION_REQUEST_REFUSED_LOG_MESSAGE,
  createSessionRoutes,
  describedRefusalBody,
  sessionRouteFailureStatus,
} from './sessions.js';
import type { SessionRoutesDeps } from './sessions.js';

/* -------------------------------------------------------------------------------------------------
 * Private sentinels
 * ---------------------------------------------------------------------------------------------- */

/** The query value on its own, which must not survive even with its URL shortened. */
const QUERY_VALUE_SENTINEL = 'zz-query-value';

/** Private text an exception or an adapter may quote: a path, a statement, a query value. */
const SENTINELS = [
  '/home/dev/zz-private-project/src/zz-file.ts',
  "SELECT id FROM account WHERE email = 'zz-sql-literal'",
  `https://app.test/api/items?email=${QUERY_VALUE_SENTINEL}`,
] as const;

/** Every fragment that must stay out of a client answer and out of every non-error log field. */
const PRIVATE_FRAGMENTS: readonly string[] = [
  ...SENTINELS,
  QUERY_VALUE_SENTINEL,
  'zz-sql-literal',
  'zz-private-project',
];

/** An exception quoting every sentinel, as a driver or the filesystem would. */
function quotingException(): Error {
  return new Error(`EACCES: ${SENTINELS.join(' | ')}`);
}

/** Asserts that no private fragment occurs anywhere in `value`'s text. */
function expectNoPrivateText(value: unknown, where: string): void {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  for (const fragment of PRIVATE_FRAGMENTS) {
    expect(text.includes(fragment), `${where} carries ${fragment}`).toBe(false);
  }
}

/* -------------------------------------------------------------------------------------------------
 * Doubles: a recording logger, a session, an editor principal and the mounted routes
 * ---------------------------------------------------------------------------------------------- */

/** One log call as the recording logger saw it, bindings merged under the call's fields. */
interface LoggedRecord {
  readonly level: LogLevel;
  readonly message: string;
  readonly fields: LogFields;
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

/** A record's fields without its error field: the part no serializer rewrites. */
function outsideErrorField(fields: LogFields): LogFields {
  return Object.fromEntries(Object.entries(fields).filter(([key]) => key !== LOG_ERROR_FIELD_KEY));
}

/** The project every session of this suite belongs to; inside the editor's workspace. */
const PROJECT_ROOT = '/work/zz-routes-project';

/** The editor principal the stand-in auth middleware resolves for every request. */
const EDITOR: EditorPrincipal = Object.freeze({
  role: 'vscode',
  scope: Object.freeze({ kind: 'machine-user', workspaceFolders: Object.freeze([PROJECT_ROOT]) }),
  tokenHash: 'a'.repeat(64),
  issuedAt: 1_790_000_000_000,
});

/** A valid stored session of {@link PROJECT_ROOT}, validated by the protocol's own schema. */
function sessionRecord(id: SessionId): SessionRecord {
  const parsed = parseSessionRecord({
    id,
    projectRoot: PROJECT_ROOT,
    projectName: 'zz-routes-project',
    devServerUrl: 'http://127.0.0.1:3000/',
    createdAt: 1_790_000_000_000,
    updatedAt: 1_790_000_000_000,
    status: 'generated',
    question: 'Why is this interaction slow?',
    followUps: [],
    relevantFiles: [],
    plans: [],
    modifications: [],
    captures: [],
    panelIds: [],
    analyses: [],
    cleanup: { status: 'pending', conflicts: [] },
    promptVersions: {},
    provider: { id: 'deterministic' },
  });
  if (!parsed.ok) {
    throw parsed.error;
  }
  return parsed.value;
}

/** A collaborator the scenario never reaches. */
function unexpected(): never {
  throw new Error('This collaborator is not part of the scenario.');
}

/** What a scenario changes about the routes' collaborators. */
interface MountOptions {
  /** The one stored session. */
  readonly record: SessionRecord;
  /** The logger handed to the routes. */
  readonly logger: Logger;
  /** What `orchestrator.followUp` answers. */
  readonly followUp?: SessionRoutesDeps['orchestrator']['followUp'];
  /**
   * The one row `sessions.listWithinFolders` answers `session.list` with; the
   * stored session's own list row by default.
   */
  readonly listed?: SessionListItem;
}

/** Mounts the session routes behind a stand-in auth middleware resolving {@link EDITOR}. */
function mount(options: MountOptions): Hono<ServerEnv> {
  const { record } = options;
  const listed = options.listed ?? toSessionListItem(record);
  const routes = createSessionRoutes({
    manager: {
      create: unexpected,
      get: (sessionId) => ok(sessionId === record.id ? record : undefined),
      list: unexpected,
      end: unexpected,
      fail: unexpected,
      patch: unexpected,
    },
    reopener: { reopen: unexpected },
    orchestrator: {
      run: unexpected,
      beginCapture: unexpected,
      completeCapture: unexpected,
      followUp: options.followUp ?? unexpected,
      cancel: unexpected,
      activeRun: () => undefined,
      releaseSession: unexpected,
    },
    sessions: {
      getActiveCapture: unexpected,
      getCapture: unexpected,
      getAccessTarget: unexpected,
      // `session.list` reads its page from the store's summary projection.
      listWithinFolders: () => ok({ items: [listed], total: 1, consumed: 1, unreadable: 0 }),
    },
    panels: { getLatestPanel: unexpected, getPanel: unexpected },
    modifications: { listPageBySession: unexpected },
    bindings: { bindingForSession: () => undefined, sendToBoundTab: unexpected },
    retention: { purge: unexpected },
    // The revocation fence every `POST` passes: the editor's credential is live.
    auth: { requireLiveCredential: () => ok(undefined) },
    logger: options.logger,
    settlePollIntervalMs: 5,
  });

  const app = new Hono<ServerEnv>();
  app.use('*', async (c, next) => {
    c.set('principal', EDITOR);
    await next();
  });
  for (const operation of ['session.question', 'session.get', 'session.list'] as const) {
    const { method, pattern } = HTTP_ROUTES[operation];
    app.on(method, pattern, routes[operation]);
  }
  return app;
}

/** Sends one `session.question`. */
function askQuestion(app: Hono<ServerEnv>, sessionId: string): Promise<Response> {
  return Promise.resolve(
    app.request(`/sessions/${sessionId}/question`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question: 'Why does the report take so long?' }),
    }),
  );
}

/** A response's body as protocol's error payload, or a failure naming what it was. */
async function errorBodyOf(response: Response): Promise<HttpErrorResponse> {
  const text = await response.text();
  const parsed = httpErrorResponseSchema.safeParse(JSON.parse(text));
  if (!parsed.success) {
    throw new Error(`Expected protocol's error body, got ${text}`);
  }
  expectNoPrivateText(text, 'the response body');
  return parsed.data;
}

/** The records with `message`, in the order they were written. */
function recordsWith(logs: readonly LoggedRecord[], message: string): readonly LoggedRecord[] {
  return logs.filter((record) => record.message === message);
}

/** The service configuration the real-logger test builds its logger from; nothing is opened. */
const LOGGER_CONFIG: ServiceConfig = {
  host: '127.0.0.1',
  port: 20000,
  logLevel: 'info',
  retentionDays: 30,
  provider: 'deterministic',
  debuggenHome: '/tmp/debuggen-home/routes-test',
  databasePath: '/tmp/debuggen-home/routes-test/sessions.sqlite',
  backupsDir: '/tmp/debuggen-home/routes-test/backups',
  indexCacheDir: '/tmp/debuggen-home/routes-test/index',
  authFilePath: '/tmp/debuggen-home/routes-test/auth.json',
  promptsDir: '/tmp/debuggen-home/routes-test/prompts',
};

/* -------------------------------------------------------------------------------------------------
 * describedRefusalBody
 * ---------------------------------------------------------------------------------------------- */

describe('describedRefusalBody', () => {
  it('keeps a lifecycle refusal the product registered in its own words', () => {
    const message = authorProductText(`The session is not ready to capture (${newSessionId()}).`);
    const refusal = describedRefusalBody(new DebuggenError('SESSION_INVALID_STATE', message));
    expect(refusal.ref).toBeUndefined();
    expect(refusal.body).toEqual({ code: 'SESSION_INVALID_STATE', message });
  });

  it('answers the same sentence with fixed copy while no product builder registered it', () => {
    const message = `The session is not ready to capture (${newSessionId()}).`;
    const refusal = describedRefusalBody(
      new DebuggenError('SESSION_INVALID_STATE', message),
      () => 'msg_zzunregistered',
    );
    expect(refusal).toEqual({
      body: {
        code: 'SESSION_INVALID_STATE',
        message: FAILURE_COPY_BY_CODE.SESSION_INVALID_STATE.summary,
        ref: 'msg_zzunregistered',
      },
      ref: 'msg_zzunregistered',
    });
  });

  it('never sends a composed refusal quoting an adapter, even under a verbatim code', () => {
    // A readiness refusal composed from an adapter's reason: no wrapped cause,
    // so nothing but provenance can tell it from product copy.
    for (const code of ['SERVER_AGENT_NOT_READY', 'AGENT_NOT_READY', 'TAB_NOT_BOUND'] as const) {
      const error = new DebuggenError(
        code,
        `Could not enable Server spans: the preload reported ${SENTINELS.join(' and ')}.`,
      );
      const refusal = describedRefusalBody(error, () => `msg_zz${code.toLowerCase()}`);
      expect(sessionRouteFailureStatus(error)).toBe(409);
      expect(refusal.body).toEqual({
        code,
        message: FAILURE_COPY_BY_CODE[code].summary,
        ref: `msg_zz${code.toLowerCase()}`,
      });
      expectNoPrivateText(refusal.body, `the ${code} refusal`);
    }
  });

  it('answers a collaborator failure with fixed copy and a reference', () => {
    const error = new DebuggenError(
      'PATCH_UNSUPPORTED',
      `The adapter could not instrument it: ${SENTINELS.join(' ')}`,
    );
    const refusal = describedRefusalBody(error, () => 'msg_zzref');
    expect(sessionRouteFailureStatus(error)).toBe(422);
    expect(refusal.ref).toBe('msg_zzref');
    expect(refusal.body).toEqual({
      code: 'PATCH_UNSUPPORTED',
      message: FAILURE_COPY_BY_CODE.PATCH_UNSUPPORTED.summary,
      ref: 'msg_zzref',
    });
    expect(httpErrorResponseSchema.safeParse(refusal.body).success).toBe(true);
  });

  it('never sends a wrapped exception text, even under a verbatim code', () => {
    for (const code of ['PROJECT_NOT_FOUND', 'FS_UNSAFE_PATH', 'MODEL_UNAVAILABLE'] as const) {
      const refusal = describedRefusalBody(DebuggenError.from(quotingException(), code));
      expectNoPrivateText(refusal.body, code);
      expect(refusal.body.message).toBe(FAILURE_COPY_BY_CODE[code].summary);
      expect(refusal.ref).toMatch(/^msg_/u);
      expect(refusal.body.ref).toBe(refusal.ref);
    }
  });

  it('treats a thrown string wrapped by DebuggenError.from as unproven text', () => {
    const refusal = describedRefusalBody(
      DebuggenError.from(SENTINELS[0], 'SESSION_NOT_FOUND'),
      () => 'msg_zzstring',
    );
    expect(refusal.body).toEqual({
      code: 'SESSION_NOT_FOUND',
      message: FAILURE_COPY_BY_CODE.SESSION_NOT_FOUND.summary,
      ref: 'msg_zzstring',
    });
  });
});

/* -------------------------------------------------------------------------------------------------
 * The handlers' failure answers and their log records
 * ---------------------------------------------------------------------------------------------- */

describe('the failure answers of the session routes', () => {
  it('answers a returned pipeline Err with a 500 whose fresh ref its error record and debug twin repeat', async () => {
    const logs: LoggedRecord[] = [];
    const record = sessionRecord(newSessionId());
    const failure = new DebuggenError(
      'CODE_INDEX_FAILED',
      `The index could not be built: ${SENTINELS.join(' ')}`,
    );
    const app = mount({
      record,
      logger: recordingLogger(logs),
      followUp: () => Promise.resolve(err(failure)),
    });

    const first = await askQuestion(app, record.id);
    const second = await askQuestion(app, record.id);

    expect([first.status, second.status]).toEqual([500, 500]);
    const bodies = [await errorBodyOf(first), await errorBodyOf(second)];
    for (const body of bodies) {
      expect(body.code).toBe('CODE_INDEX_FAILED');
      expect(body.ref).toMatch(/^msg_[a-z0-9]+$/u);
      // The operation's fixed sentence, never the failure's own.
      expect(body.message).toBe(bodies[0]?.message);
      expect(body.message).not.toContain('The index could not be built');
    }
    // One reference per answer, never reused.
    expect(bodies[0]?.ref).not.toBe(bodies[1]?.ref);

    const failed = recordsWith(logs, SESSION_REQUEST_FAILED_LOG_MESSAGE);
    expect(failed.map((entry) => entry.level)).toEqual(['error', 'error']);
    expect(failed.map((entry) => entry.fields['ref'])).toEqual(bodies.map((body) => body.ref));
    const twins = recordsWith(logs, SESSION_REQUEST_DIAGNOSTIC_MESSAGE);
    expect(twins.map((entry) => entry.level)).toEqual(['debug', 'debug']);
    expect(twins.map((entry) => entry.fields['ref'])).toEqual(bodies.map((body) => body.ref));
    for (const entry of [...failed, ...twins]) {
      expect(entry.fields).toMatchObject({
        subsystem: 'server.sessions',
        sessionId: record.id,
        operation: 'session.question',
        status: 500,
        errorCode: 'CODE_INDEX_FAILED',
      });
      // The failure itself travels under the error field, for the serializer to shape per level.
      expect(entry.fields[LOG_ERROR_FIELD_KEY]).toBe(failure);
    }
    for (const entry of logs) {
      expectNoPrivateText(outsideErrorField(entry.fields), `the "${entry.message}" record`);
    }
  });

  it('writes no private text at info and the redacted diagnostic under the same ref at debug', async () => {
    const failure = new DebuggenError(
      'STORE_ERROR',
      `database is locked while running ${SENTINELS[1]} for ${SENTINELS[2]}`,
    );
    const run = async (logLevel: ServiceConfig['logLevel']) => {
      const lines: string[] = [];
      const logger = createServiceLogger(
        { ...LOGGER_CONFIG, logLevel },
        { destination: { write: (line: string) => void lines.push(line) } },
      );
      const record = sessionRecord(newSessionId());
      const app = mount({ record, logger, followUp: () => Promise.resolve(err(failure)) });
      const response = await askQuestion(app, record.id);
      expect(response.status).toBe(500);
      const body = await errorBodyOf(response);
      const records = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
      return { body, lines, records };
    };

    const atInfo = await run('info');
    const failedAtInfo = atInfo.records.filter(
      (entry) => entry['msg'] === SESSION_REQUEST_FAILED_LOG_MESSAGE,
    );
    expect(failedAtInfo).toHaveLength(1);
    expect(failedAtInfo[0]).toMatchObject({ ref: atInfo.body.ref, errorCode: 'STORE_ERROR' });
    expect(
      atInfo.records.some((entry) => entry['msg'] === SESSION_REQUEST_DIAGNOSTIC_MESSAGE),
    ).toBe(false);
    expectNoPrivateText(atInfo.lines.join('\n'), 'the service log at info');

    const atDebug = await run('debug');
    const twin = atDebug.records.find(
      (entry) => entry['msg'] === SESSION_REQUEST_DIAGNOSTIC_MESSAGE,
    );
    expect(twin).toMatchObject({ ref: atDebug.body.ref, errorCode: 'STORE_ERROR', status: 500 });
    const detailed = twin?.[LOG_ERROR_FIELD_KEY] as Record<string, unknown> | undefined;
    expect(detailed?.['type']).toBe('DebuggenError');
    const redacted = String(detailed?.['message']);
    expect(redacted).toContain('database is locked');
    expect(redacted).not.toContain(QUERY_VALUE_SENTINEL);
    expect(redacted).not.toContain('zz-sql-literal');
  });

  it('answers an unregistered refusal of a verbatim code with fixed copy and a logged ref', async () => {
    const logs: LoggedRecord[] = [];
    const record = sessionRecord(newSessionId());
    const refusal = new DebuggenError(
      'SESSION_INVALID_STATE',
      `A follow-up cannot start while ${SENTINELS[0]} is being patched.`,
    );
    const app = mount({
      record,
      logger: recordingLogger(logs),
      followUp: () => Promise.resolve(err(refusal)),
    });

    const response = await askQuestion(app, record.id);

    expect(response.status).toBe(409);
    const body = await errorBodyOf(response);
    expect(body).toEqual({
      code: 'SESSION_INVALID_STATE',
      message: FAILURE_COPY_BY_CODE.SESSION_INVALID_STATE.summary,
      ref: body.ref,
    });
    expect(body.ref).toMatch(/^msg_/u);
    const refused = recordsWith(logs, SESSION_REQUEST_REFUSED_LOG_MESSAGE);
    expect(refused).toHaveLength(1);
    expect(refused[0]?.level).toBe('warn');
    expect(refused[0]?.fields).toMatchObject({ ref: body.ref, status: 409 });
    expect(refused[0]?.fields[LOG_ERROR_FIELD_KEY]).toBe(refusal);
    const twins = recordsWith(logs, SESSION_REQUEST_DIAGNOSTIC_MESSAGE);
    expect(twins).toHaveLength(1);
    expect(twins[0]?.fields).toMatchObject({ ref: body.ref, status: 409 });
    expect(twins[0]?.fields[LOG_ERROR_FIELD_KEY]).toBe(refusal);
    for (const entry of logs) {
      expectNoPrivateText(outsideErrorField(entry.fields), `the "${entry.message}" record`);
    }
  });

  it("keeps this module's own composed refusal verbatim, with no ref and no debug twin", async () => {
    const logs: LoggedRecord[] = [];
    const record = sessionRecord(newSessionId());
    const app = mount({ record, logger: recordingLogger(logs) });

    const response = await Promise.resolve(app.request('/sessions/not-a-session-id'));

    expect(response.status).toBe(404);
    const body = await errorBodyOf(response);
    expect(body.code).toBe('SESSION_NOT_FOUND');
    expect(body.ref).toBeUndefined();
    expect(body.message).not.toBe(FAILURE_COPY_BY_CODE.SESSION_NOT_FOUND.summary);
    expect(isProductAuthoredText(body.message)).toBe(true);
    const refused = recordsWith(logs, SESSION_REQUEST_REFUSED_LOG_MESSAGE);
    expect(refused).toHaveLength(1);
    expect(refused[0]?.fields['ref']).toBeUndefined();
    expect(refused[0]?.fields[LOG_ERROR_FIELD_KEY]).toBeUndefined();
    expect(recordsWith(logs, SESSION_REQUEST_DIAGNOSTIC_MESSAGE)).toHaveLength(0);
  });

  it('answers a response drift with a 500 whose fresh ref its error record and debug twin repeat', async () => {
    const logs: LoggedRecord[] = [];
    const record = sessionRecord(newSessionId());
    // A stored list row the protocol's response schema refuses: a subsystem drift.
    const drifted: SessionListItem = { ...toSessionListItem(record), projectName: '' };
    expect(sessionListItemSchema.safeParse(drifted).success).toBe(false);
    const app = mount({ record, listed: drifted, logger: recordingLogger(logs) });

    const response = await Promise.resolve(app.request('/sessions'));

    expect(response.status).toBe(500);
    const body = await errorBodyOf(response);
    expect(body.code).toBe('INTERNAL');
    expect(body.ref).toMatch(/^msg_/u);
    const failed = recordsWith(logs, SESSION_REQUEST_FAILED_LOG_MESSAGE);
    expect(failed).toHaveLength(1);
    expect(failed[0]?.fields).toMatchObject({
      operation: 'session.list',
      status: 500,
      errorCode: 'INTERNAL',
      reason: 'response-off-schema',
      ref: body.ref,
    });
    const twins = recordsWith(logs, SESSION_REQUEST_DIAGNOSTIC_MESSAGE);
    expect(twins).toHaveLength(1);
    expect(twins[0]?.level).toBe('debug');
    expect(twins[0]?.fields['ref']).toBe(body.ref);
    expect(DebuggenError.is(twins[0]?.fields[LOG_ERROR_FIELD_KEY])).toBe(true);
  });
});
