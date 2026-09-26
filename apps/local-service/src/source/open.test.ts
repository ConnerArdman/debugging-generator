/**
 * Tests for `./open.ts`: the service's `source.open` containment gate and
 * forwarder.
 *
 * What is proven here, at minimum, is **source-path containment**: traversal,
 * absolute, Windows-absolute, prefix-sibling and planted-symlink escapes are each
 * refused with a typed `Err`, and in every such case no envelope is sent. Around
 * that: the authorization matrix (an editor only inside the workspace folders it
 * announced; a DevTools panel only for the session bound to its own tab; the page
 * agent and the dev-server agent never), the happy path forwarding exactly one
 * `source.open` envelope whose location equals the input byte for byte, the
 * `delivered: false` answer when no editor is connected, that the handler never
 * throws or rejects, and the privacy rule that no error payload or log record
 * carries an absolute path, a symbolic-link target, file contents or a
 * credential.
 *
 * The correlation of the editor's `source.result` with the forward it answers
 * is driven on an injected fake clock: the first `opened` settles, every
 * addressed editor failing settles the first failure, the deadline settles
 * `failed`, a late or unknown answer is accepted and ignored, an answer from the
 * wrong session, the wrong workspace or the wrong client kind is refused,
 * `close()` settles what is pending, an editor answering inside the send itself
 * finds its entry, and the pending table stays bounded.
 *
 * The symbolic-link cases run twice: against a real temporary directory with
 * real `realpath` and `lstat`, and against an injected table-based resolver,
 * which is how the edge cases a real filesystem cannot stage on demand (a
 * resolver answering with a relative or Windows path, an `ELOOP`) are reached.
 *
 * Every on-disk case gets a fresh `mkdtemp` sandbox of its own under the system
 * temporary directory — `project/` (the session's root), `outside/` (the escape
 * target) and `project-evil/` (the prefix sibling of the root) — which is
 * removed, and proven removed, after the case. Every case that touches the
 * sandbox also proves that the handler left it byte-for-byte as it found it:
 * the only filesystem operations the gate may perform are `realpath` and
 * `lstat`. Nothing is written inside the repository or under `~/.debuggen`.
 *
 * Expected error codes are taken from {@link CODES}, whose every member is
 * checked against `DEBUGGEN_ERROR_CODES`, and the editor client kind from
 * `CLIENT_KINDS`, so neither vocabulary is restated here as a bare string.
 * Cases that need a symbolic link are skipped, by capability, on a host that
 * cannot create one — the convention of `packages/shared/src/node/safe-fs.test.ts`.
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { realpath as realpathAsync } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CLIENT_KINDS,
  SOURCE_OPEN_EDITOR_TIMEOUT_MS,
  createEnvelope,
  encodeMessage,
  isMessageOfType,
  parseMessage,
  parseSessionRecord,
  parseSourceOpenPayload,
  toErrorPayload,
} from '@debuggen/protocol';
import type {
  ClientKind,
  ProtocolMessage,
  SessionRecord,
  SourceOpenPayload,
  SourceResultPayload,
} from '@debuggen/protocol';
import {
  DEBUGGEN_ERROR_CODES,
  DEFAULT_RESOLUTION_CONFIDENCE,
  DebuggenError,
  err,
  isSafeRelativePath,
  ok,
} from '@debuggen/shared';
import type {
  DebuggenErrorCode,
  LogFields,
  Logger,
  Result,
  SourceLocation,
} from '@debuggen/shared';

import {
  DEFAULT_MAX_PENDING_EDITOR_RESULTS,
  SOURCE_OPEN_REJECTIONS,
  assertLocationWithinProject,
  createSourceOpenHandler,
  resolveRealPathWithinProject,
  sourceOpenRejectionOf,
} from './open.js';
import type {
  SourceOpenBinding,
  SourceOpenDelivered,
  SourceOpenDeps,
  SourceOpenEditorResult,
  SourceOpenHandler,
  SourceOpenOutcome,
  SourceOpenPrincipal,
  SourceOpenRealPath,
  SourceOpenTimers,
} from './open.js';

/* -------------------------------------------------------------------------------------------------
 * Fixtures
 * ---------------------------------------------------------------------------------------------- */

const SESSION_ID = 'ses_source_open_0001';

/** A value standing in for a credential: it must never surface anywhere. */
const CREDENTIAL_MARKER = 'credential-marker-91';

/** Content planted in a file outside the project: it must never surface anywhere. */
const OUTSIDE_CONTENT_MARKER = 'OUTSIDE-CONTENT-MARKER';

/** A fixed clock for the outbound envelope. */
const FIXED_NOW = 1_760_000_000_000;

/**
 * The error codes this suite expects, by role. Each is a `DebuggenErrorCode`
 * at compile time, and the first case of the suite proves each is a member of
 * `DEBUGGEN_ERROR_CODES` at run time, so an assertion against one of these is
 * an assertion against the shared vocabulary itself.
 */
const CODES = Object.freeze({
  outsideProject: 'PATH_OUTSIDE_PROJECT',
  unsafePath: 'FS_UNSAFE_PATH',
  fileMissing: 'PROJECT_NOT_FOUND',
  invalidMessage: 'PROTOCOL_INVALID_MESSAGE',
  sessionNotFound: 'SESSION_NOT_FOUND',
  unauthorized: 'UNAUTHORIZED',
  tabNotBound: 'TAB_NOT_BOUND',
  store: 'STORE_ERROR',
  transport: 'TRANSPORT_DISCONNECTED',
  internal: 'INTERNAL',
} as const satisfies Readonly<Record<string, DebuggenErrorCode>>);

/** One member of the protocol's client-kind vocabulary, proven present at run time. */
function clientKindFromVocabulary(kind: ClientKind): ClientKind {
  const found = CLIENT_KINDS.find((candidate) => candidate === kind);
  if (found === undefined) {
    throw new Error('the protocol client-kind vocabulary lost a member this suite relies on');
  }
  return found;
}

/** The only client kind a location may ever be forwarded to. */
const EDITOR_KIND = clientKindFromVocabulary('vscode');

/**
 * Whether this host can plant a symbolic link. Probed by capability, never by
 * platform name, in a directory of its own that is removed straight away.
 */
const CAN_CREATE_SYMLINKS = ((): boolean => {
  const probeRoot = mkdtempSync(join(tmpdir(), 'debuggen-source-open-probe-'));
  try {
    symlinkSync(join(probeRoot, 'absent'), join(probeRoot, 'link'));
    return lstatSync(join(probeRoot, 'link')).isSymbolicLink();
  } catch {
    return false;
  } finally {
    rmSync(probeRoot, { recursive: true, force: true });
  }
})();

/** Neutral, invented names for the sandbox's files. */
const LEGIT_FILE = 'src/app.ts';
const FOREIGN_NAME = 'foreign.ts';

/**
 * The path corpus every containment layer is driven over, relative to a
 * project root whose directory is named `project` and whose prefix sibling is
 * `project-evil`. Each entry escapes the root, is not a project-relative POSIX
 * path, or both; none may be accepted by any layer.
 */
const ESCAPING_FILES: readonly (readonly [label: string, file: string])[] = Object.freeze([
  ['parent traversal', `../outside/${FOREIGN_NAME}`],
  ['deeper parent traversal', `../../outside/${FOREIGN_NAME}`],
  [
    'interior traversal that climbs out and re-enters elsewhere',
    `src/../../outside/${FOREIGN_NAME}`,
  ],
  ['an absolute POSIX path', `/opt/elsewhere/${FOREIGN_NAME}`],
  ['a Windows drive path with backslashes', `C:\\elsewhere\\${FOREIGN_NAME}`],
  ['a Windows drive path with forward slashes', `C:/elsewhere/${FOREIGN_NAME}`],
  ['a UNC path', `\\\\server\\share\\${FOREIGN_NAME}`],
  ['a forward-slash network share', `//server/share/${FOREIGN_NAME}`],
  ['a prefix sibling of the root', `../project-evil/${FOREIGN_NAME}`],
  ['a NUL character', 'src/app.ts\u0000.png'],
  ['a C0 control character', 'src/\u0007app.ts'],
  ['a backslash segment', `src\\..\\..\\${FOREIGN_NAME}`],
]);

/** A hostile value, typed as whatever the call under test declares. */
function hostile<T>(value: unknown): T {
  return value as T;
}

/** A source location in the schema's own key order, so byte equality is meaningful. */
function locationOf(file: string, overrides: Partial<SourceLocation> = {}): SourceLocation {
  return {
    file,
    line: 12,
    column: 5,
    symbol: 'loadThing',
    resolvedBy: 'code-graph',
    confidence: 0.85,
    ...overrides,
  };
}

/** A valid stored session, validated by the protocol's own schema. */
function sessionRecordFor(projectRoot: string, boundTabId?: number): SessionRecord {
  const candidate: Record<string, unknown> = {
    id: SESSION_ID,
    projectRoot,
    projectName: 'sample-project',
    devServerUrl: 'http://127.0.0.1:3000/',
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
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
  };
  if (boundTabId !== undefined) {
    candidate['boundTab'] = { tabId: boundTabId, url: 'http://127.0.0.1:3000/page' };
  }
  const parsed = parseSessionRecord(candidate);
  if (!parsed.ok) {
    throw parsed.error;
  }
  return parsed.value;
}

/** One record written through the capturing logger. */
interface LogEntry {
  readonly level: string;
  readonly message: string;
  readonly fields: LogFields;
}

/** A `Logger` that records every entry together with its bindings. */
function capturingLogger(entries: LogEntry[], bindings: LogFields = {}): Logger {
  const write =
    (level: string) =>
    (message: string, fields?: LogFields): void => {
      entries.push({ level, message, fields: { ...bindings, ...fields } });
    };
  return {
    level: 'trace',
    trace: write('trace'),
    debug: write('debug'),
    info: write('info'),
    warn: write('warn'),
    error: write('error'),
    fatal: write('fatal'),
    child: (more: LogFields): Logger => capturingLogger(entries, { ...bindings, ...more }),
  };
}

/** One message handed to the client port. */
interface SentMessage {
  readonly sessionId: string;
  readonly clientKind: string;
  readonly message: ProtocolMessage;
}

/** Options for {@link harness}. */
interface HarnessOptions {
  readonly session?: SessionRecord | undefined;
  readonly deliverTo?: number;
  readonly binding?: SourceOpenBinding | undefined;
  readonly useBindingPort?: boolean;
  readonly realpath?: SourceOpenRealPath;
  readonly verifyExists?: boolean;
  readonly asyncPorts?: boolean;
  readonly logger?: Logger;
  readonly sessionsGet?: SourceOpenDeps['sessions']['get'];
  readonly send?: SourceOpenDeps['clients']['sendToSessionClients'];
  readonly timers?: SourceOpenTimers;
  readonly editorResultTimeoutMs?: number;
  readonly maxPendingEditorResults?: number;
}

/** The handler wired to recording fakes. */
interface Harness {
  readonly sent: SentMessage[];
  readonly entries: LogEntry[];
  readonly lookups: string[];
  readonly handler: SourceOpenHandler;
  readonly handle: (
    input: unknown,
    principal: SourceOpenPrincipal,
  ) => Promise<Result<SourceOpenOutcome, DebuggenError>>;
}

function harness(options: HarnessOptions): Harness {
  const sent: SentMessage[] = [];
  const entries: LogEntry[] = [];
  const lookups: string[] = [];
  const wrap = <T>(value: T): T | Promise<T> =>
    options.asyncPorts === true ? Promise.resolve(value) : value;

  const sessions: SourceOpenDeps['sessions'] = {
    get:
      options.sessionsGet ??
      ((sessionId) => {
        lookups.push(sessionId);
        return wrap(ok(options.session?.id === sessionId ? options.session : undefined));
      }),
    ...(options.useBindingPort === true
      ? {
          getBindingBySession: (sessionId: string) => {
            lookups.push(`binding:${sessionId}`);
            return wrap(ok(options.binding));
          },
        }
      : {}),
  };

  const clients: SourceOpenDeps['clients'] = {
    sendToSessionClients:
      options.send ??
      ((sessionId, clientKind, message) => {
        sent.push({ sessionId, clientKind, message });
        return wrap(options.deliverTo ?? 1);
      }),
  };

  const handler = createSourceOpenHandler({
    sessions,
    clients,
    logger: options.logger ?? capturingLogger(entries),
    now: () => FIXED_NOW,
    ...(options.realpath === undefined ? {} : { realpath: options.realpath }),
    ...(options.verifyExists === undefined ? {} : { verifyExists: options.verifyExists }),
    ...(options.timers === undefined ? {} : { timers: options.timers }),
    ...(options.editorResultTimeoutMs === undefined
      ? {}
      : { editorResultTimeoutMs: options.editorResultTimeoutMs }),
    ...(options.maxPendingEditorResults === undefined
      ? {}
      : { maxPendingEditorResults: options.maxPendingEditorResults }),
  });

  return {
    sent,
    entries,
    lookups,
    handler,
    handle: (input, principal) => handler.handle(input, principal),
  };
}

/** A deterministic clock behind the {@link SourceOpenTimers} seam. */
interface FakeClock extends SourceOpenTimers {
  /** Moves the clock forward, running every callback that falls due, in order. */
  advance(ms: number): void;
  /** How many callbacks are scheduled and not yet run or cleared. */
  readonly active: number;
  /** How many handles had `unref()` called on them. */
  readonly unrefs: number;
}

function fakeClock(): FakeClock {
  let now = 0;
  let unrefs = 0;
  const scheduled = new Map<object, { readonly at: number; readonly callback: () => void }>();
  return {
    setTimeout(callback: () => void, delayMs: number): unknown {
      const handle = {
        unref: (): void => {
          unrefs += 1;
        },
      };
      scheduled.set(handle, { at: now + delayMs, callback });
      return handle;
    },
    clearTimeout(handle: unknown): void {
      if (typeof handle === 'object' && handle !== null) {
        scheduled.delete(handle);
      }
    },
    advance(ms: number): void {
      now += ms;
      const due = [...scheduled.entries()]
        .filter(([, timer]) => timer.at <= now)
        .sort(([, a], [, b]) => a.at - b.at);
      for (const [handle, timer] of due) {
        scheduled.delete(handle);
        timer.callback();
      }
    },
    get active(): number {
      return scheduled.size;
    },
    get unrefs(): number {
      return unrefs;
    },
  };
}

/** Records whether, and with what, a promise has settled. */
function track<T>(promise: Promise<T>): {
  readonly settled: boolean;
  readonly value: T | undefined;
} {
  const state: { settled: boolean; value: T | undefined } = { settled: false, value: undefined };
  void promise.then((value) => {
    state.settled = true;
    state.value = value;
  });
  return state;
}

/** Lets every queued promise callback run. */
function flushPromises(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

/** A delivered outcome, failing the test for anything else. */
function deliveredOf(outcome: SourceOpenOutcome): SourceOpenDelivered {
  if (!outcome.delivered) {
    throw new Error('expected a delivered forward, received no-editor-client');
  }
  return outcome;
}

/** A delivered outcome without the per-request correlation fields, for equality checks. */
function withoutCorrelation(outcome: SourceOpenOutcome): Record<string, unknown> {
  if (!outcome.delivered) {
    return { ...outcome };
  }
  const { delivered, clients, location, file } = outcome;
  return { delivered, clients, location, file };
}

/** The refusal carried by a result, failing the test when there is none. */
function refusalOf<T>(result: Result<T, DebuggenError>): DebuggenError {
  if (result.ok) {
    throw new Error('expected an Err, received an Ok');
  }
  return result.error;
}

/** The success value carried by a result, failing the test when there is none. */
function valueOf<T>(result: Result<T, DebuggenError>): T {
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}

/**
 * Asserts that none of the surfaces an error can reach — its wire payload, its
 * class payload, its message, hint and details — contains any forbidden string.
 */
function expectPrivate(error: DebuggenError, forbidden: readonly string[]): void {
  const surfaces = [
    JSON.stringify(toErrorPayload(error)),
    JSON.stringify(error.toPayload()),
    error.message,
    error.hint ?? '',
    JSON.stringify(error.details ?? {}),
  ];
  for (const surface of surfaces) {
    for (const value of forbidden) {
      expect(surface).not.toContain(value);
    }
  }
}

/** A platform-style error: a message quoting the path, and an errno code. */
function platformError(code: string, path: string): Error {
  return Object.assign(new Error(`${code}: failure, realpath '${path}'`), { code });
}

/**
 * A resolver over a table of links. A path in `failures` throws the given errno;
 * a path in `table` resolves to its entry; every other path resolves to itself.
 */
function tableRealpath(
  table: Readonly<Record<string, string>>,
  failures: Readonly<Record<string, string>> = {},
  calls: string[] = [],
): SourceOpenRealPath {
  return (path: string): string => {
    calls.push(path);
    const failure = failures[path];
    if (failure !== undefined) {
      throw platformError(failure, path);
    }
    return table[path] ?? path;
  };
}

/**
 * Every entry under a directory, without following a link: a file by its bytes
 * and modification time, a link by its target, a directory by its presence. Two
 * equal snapshots mean nothing was written, created, removed, retargeted or
 * even re-saved in between.
 */
function sandboxState(root: string): Record<string, string> {
  const state: Record<string, string> = {};
  const walk = (directory: string, prefix: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const key = `${prefix}${entry.name}`;
      if (entry.isSymbolicLink()) {
        state[key] = `link -> ${readlinkSync(path)}`;
      } else if (entry.isDirectory()) {
        state[key] = 'directory';
        walk(path, `${key}/`);
      } else {
        const stats = lstatSync(path);
        state[key] = `file ${String(stats.mtimeMs)} ${readFileSync(path).toString('base64')}`;
      }
    }
  };
  walk(root, '');
  return state;
}

/**
 * The only log field names a record of this handler may carry: the standard
 * bindings, codes and enumerated reasons, the project-relative file, the
 * position, the resolver and the delivery count.
 */
const ALLOWED_LOG_FIELDS: ReadonlySet<string> = new Set([
  'subsystem',
  'sessionId',
  'client',
  'code',
  'causeCode',
  'detail',
  'rejection',
  'reason',
  'pathReason',
  'errno',
  'file',
  'line',
  'column',
  'resolvedBy',
  'delivered',
  'ref',
  'status',
  'settled',
  'pending',
  'option',
  'fallback',
]);

/* -------------------------------------------------------------------------------------------------
 * The public vocabulary
 * ---------------------------------------------------------------------------------------------- */

describe('the harness contract', () => {
  it('expects only codes of the shared DEBUGGEN_ERROR_CODES vocabulary', () => {
    for (const code of Object.values(CODES)) {
      expect(DEBUGGEN_ERROR_CODES).toContain(code);
    }
  });

  it('forwards to a client kind of the protocol CLIENT_KINDS vocabulary', () => {
    expect(CLIENT_KINDS).toContain(EDITOR_KIND);
  });

  it('builds a stored-session fixture the protocol SessionRecord schema accepts', () => {
    const record = sessionRecordFor('/work/project', 7);
    const reparsed = parseSessionRecord(JSON.parse(JSON.stringify(record)));
    expect(reparsed.ok).toBe(true);
    expect(record.projectRoot).toBe('/work/project');
    expect(record.boundTab?.tabId).toBe(7);
  });
});

describe('SOURCE_OPEN_REJECTIONS — the rejection vocabulary', () => {
  it('is closed and frozen', () => {
    expect([...SOURCE_OPEN_REJECTIONS]).toEqual([
      'invalid-payload',
      'session-not-found',
      'not-authorized',
      'outside-project',
      'unsafe-path',
      'file-missing',
    ]);
    expect(Object.isFrozen(SOURCE_OPEN_REJECTIONS)).toBe(true);
  });

  it('reads a rejection back only from an error that carries a known one', () => {
    const refused = new DebuggenError(CODES.outsideProject, 'refused', {
      details: { rejection: 'outside-project' },
    });
    const foreign = new DebuggenError(CODES.outsideProject, 'refused', {
      details: { rejection: 'made-up' },
    });
    expect(sourceOpenRejectionOf(refused)).toBe('outside-project');
    expect(sourceOpenRejectionOf(foreign)).toBeUndefined();
    expect(sourceOpenRejectionOf(new DebuggenError(CODES.internal, 'x'))).toBeUndefined();
  });
});

/* -------------------------------------------------------------------------------------------------
 * The lexical half
 * ---------------------------------------------------------------------------------------------- */

describe('assertLocationWithinProject — the lexical half', () => {
  const root = '/work/project';

  it('places a project-relative file under the root (the corpus sanity guard)', () => {
    expect(valueOf(assertLocationWithinProject(root, locationOf(LEGIT_FILE)))).toEqual({
      absolutePath: `/work/project/${LEGIT_FILE}`,
    });
    expect(valueOf(assertLocationWithinProject(root, locationOf('src/lib/a.ts')))).toEqual({
      absolutePath: '/work/project/src/lib/a.ts',
    });
  });

  it('normalises an interior segment that stays inside', () => {
    expect(valueOf(assertLocationWithinProject(root, locationOf('src/./lib/../lib/a.ts')))).toEqual(
      { absolutePath: '/work/project/src/lib/a.ts' },
    );
  });

  const lexicalCases: [label: string, file: string][] = [
    ...ESCAPING_FILES.map(([label, file]): [string, string] => [label, file]),
    ['an empty path', ''],
    ['a whitespace-only path', '   '],
  ];

  it.each(lexicalCases)('refuses %s without quoting it', (_label, file) => {
    const error = refusalOf(assertLocationWithinProject(root, locationOf(file)));
    expect(error.code).toBe(CODES.outsideProject);
    expect(sourceOpenRejectionOf(error)).toBe('outside-project');
    const forbidden = file.trim().length === 0 ? [root] : [root, file];
    expectPrivate(error, forbidden);
  });

  it('refuses the prefix sibling even though the root is a string prefix of it', () => {
    const sibling = `../project-evil/${FOREIGN_NAME}`;
    expect(`/work/project-evil/${FOREIGN_NAME}`.startsWith(root)).toBe(true);
    const error = refusalOf(assertLocationWithinProject(root, locationOf(sibling)));
    expect(error.code).toBe(CODES.outsideProject);
  });

  it('refuses a relative project root', () => {
    const error = refusalOf(assertLocationWithinProject('work/project', locationOf('src/a.ts')));
    expect(error.code).toBe(CODES.outsideProject);
  });

  it('refuses, rather than throws on, a location that never passed the schema', () => {
    for (const value of [null, undefined, 42, 'src/a.ts', { file: 7 }, []]) {
      const error = refusalOf(assertLocationWithinProject(root, hostile<SourceLocation>(value)));
      expect(error.code).toBe(CODES.outsideProject);
    }
  });
});

/* -------------------------------------------------------------------------------------------------
 * The filesystem half, over an injected resolver
 * ---------------------------------------------------------------------------------------------- */

describe('resolveRealPathWithinProject — the filesystem half', () => {
  const root = '/work/app';

  it('proves an ordinary file and reports its canonical relative path', async () => {
    const result = await resolveRealPathWithinProject(
      root,
      '/work/app/src/a.ts',
      tableRealpath({}),
    );
    expect(valueOf(result)).toEqual({
      realProjectRoot: '/work/app',
      realPath: '/work/app/src/a.ts',
      relativePath: 'src/a.ts',
    });
  });

  it('compares against the canonical root when the root itself is reached through a link', async () => {
    const result = await resolveRealPathWithinProject(
      '/link/app',
      '/link/app/src/a.ts',
      tableRealpath({ '/link/app': '/real/app', '/link/app/src/a.ts': '/real/app/src/a.ts' }),
    );
    expect(valueOf(result).realProjectRoot).toBe('/real/app');
    expect(valueOf(result).relativePath).toBe('src/a.ts');
  });

  it('refuses a link inside the project whose target is outside it', async () => {
    const error = refusalOf(
      await resolveRealPathWithinProject(
        root,
        '/work/app/src/leak.ts',
        tableRealpath({ '/work/app/src/leak.ts': '/elsewhere/foreign.ts' }),
      ),
    );
    expect(error.code).toBe(CODES.unsafePath);
    expect(sourceOpenRejectionOf(error)).toBe('unsafe-path');
    expect(error.details?.['reason']).toBe('symlink-escapes-project-root');
    expect(error.message).toContain('src/leak.ts');
    expectPrivate(error, ['/elsewhere', FOREIGN_NAME, root]);
  });

  it('refuses a link that leads to a prefix sibling of the root', async () => {
    const error = refusalOf(
      await resolveRealPathWithinProject(
        root,
        '/work/app/src/leak.ts',
        tableRealpath({ '/work/app/src/leak.ts': '/work/app-evil/foreign.ts' }),
      ),
    );
    expect(error.code).toBe(CODES.unsafePath);
    expect(sourceOpenRejectionOf(error)).toBe('unsafe-path');
    // Refused by the canonical containment check itself, not by a later guard:
    // a bare string-prefix test would have let this target through that check.
    expect(error.details?.['reason']).toBe('symlink-escapes-project-root');
    expectPrivate(error, ['app-evil', root]);
  });

  it('refuses a candidate that is not inside the root as text, before resolving anything', async () => {
    const calls: string[] = [];
    for (const candidate of [
      '/work/app-evil/foreign.ts',
      '/opt/elsewhere/foreign.ts',
      '/work',
      'work/app/a.ts',
    ]) {
      const error = refusalOf(
        await resolveRealPathWithinProject(root, candidate, tableRealpath({}, {}, calls)),
      );
      expect(error.code).toBe(CODES.outsideProject);
      expect(sourceOpenRejectionOf(error)).toBe('outside-project');
      expectPrivate(error, [candidate, root]);
    }
    expect(calls).toEqual([]);
  });

  it('refuses a relative project root before resolving anything', async () => {
    const calls: string[] = [];
    const error = refusalOf(
      await resolveRealPathWithinProject('work/app', 'work/app/a.ts', tableRealpath({}, {}, calls)),
    );
    expect(error.code).toBe(CODES.outsideProject);
    expect(calls).toEqual([]);
  });

  it('tells a missing file apart from an unsafe one', async () => {
    const missing = refusalOf(
      await resolveRealPathWithinProject(
        root,
        '/work/app/src/missing.ts',
        tableRealpath({}, { '/work/app/src/missing.ts': 'ENOENT' }),
      ),
    );
    expect(missing.code).toBe(CODES.fileMissing);
    expect(sourceOpenRejectionOf(missing)).toBe('file-missing');
    expect(missing.message).toContain('src/missing.ts');
    expectPrivate(missing, [root]);

    const notADirectory = refusalOf(
      await resolveRealPathWithinProject(
        root,
        '/work/app/src/a.ts/b.ts',
        tableRealpath({}, { '/work/app/src/a.ts/b.ts': 'ENOTDIR' }),
      ),
    );
    expect(sourceOpenRejectionOf(notADirectory)).toBe('file-missing');

    const looped = refusalOf(
      await resolveRealPathWithinProject(
        root,
        '/work/app/src/loop.ts',
        tableRealpath({}, { '/work/app/src/loop.ts': 'ELOOP' }),
      ),
    );
    expect(looped.code).toBe(CODES.unsafePath);
    expect(looped.details?.['errno']).toBe('ELOOP');
    expectPrivate(looped, [root]);
  });

  it('reports a project root that no longer exists', async () => {
    const error = refusalOf(
      await resolveRealPathWithinProject(
        root,
        '/work/app/src/a.ts',
        tableRealpath({}, { '/work/app': 'ENOENT' }),
      ),
    );
    expect(sourceOpenRejectionOf(error)).toBe('file-missing');
    expect(error.details?.['reason']).toBe('project-root-missing');
    expectPrivate(error, [root]);
  });

  it('refuses the project root itself as a target', async () => {
    const error = refusalOf(await resolveRealPathWithinProject(root, root, tableRealpath({})));
    expect(sourceOpenRejectionOf(error)).toBe('file-missing');
    expect(error.details?.['reason']).toBe('not-a-file');
  });

  it('refuses a resolver answer it cannot use, without throwing', async () => {
    const relative = refusalOf(
      await resolveRealPathWithinProject(
        root,
        '/work/app/src/a.ts',
        tableRealpath({ '/work/app/src/a.ts': 'relative/a.ts' }),
      ),
    );
    expect(relative.details?.['reason']).toBe('resolved-path-not-absolute');

    const windows = refusalOf(
      await resolveRealPathWithinProject(
        root,
        '/work/app/src/a.ts',
        tableRealpath({ '/work/app/src/a.ts': 'C:\\elsewhere\\a.ts' }),
      ),
    );
    expect(windows.code).toBe(CODES.unsafePath);
    expectPrivate(windows, ['elsewhere']);

    // A resolver that throws something other than an Error: typed as one only
    // so the lint rule against throwing non-errors does not refuse the test.
    const throwsNonError = refusalOf(
      await resolveRealPathWithinProject(root, '/work/app/src/a.ts', (): string => {
        throw hostile<Error>('not an error object');
      }),
    );
    expect(throwsNonError.code).toBe(CODES.unsafePath);

    const nonString = refusalOf(
      await resolveRealPathWithinProject(root, '/work/app/src/a.ts', () => hostile<string>(42)),
    );
    expect(nonString.code).toBe(CODES.unsafePath);
  });

  it('accepts an asynchronous resolver and a rejection from it', async () => {
    const resolved = await resolveRealPathWithinProject(root, '/work/app/src/a.ts', (path) =>
      Promise.resolve(path),
    );
    expect(valueOf(resolved).relativePath).toBe('src/a.ts');

    const rejected = refusalOf(
      await resolveRealPathWithinProject(root, '/work/app/src/a.ts', (path) =>
        Promise.reject(platformError('ENOENT', path)),
      ),
    );
    expect(sourceOpenRejectionOf(rejected)).toBe('file-missing');
  });

  it.skipIf(!CAN_CREATE_SYMLINKS)(
    'judges a genuinely planted link with the real node:fs/promises realpath',
    async () => {
      const sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'debuggen-source-open-real-')));
      try {
        const projectRoot = join(sandbox, 'project');
        mkdirSync(join(projectRoot, 'src'), { recursive: true });
        mkdirSync(join(sandbox, 'outside'), { recursive: true });
        writeFileSync(join(projectRoot, LEGIT_FILE), 'export const inside = 1;\n');
        writeFileSync(join(sandbox, 'outside', FOREIGN_NAME), `// ${OUTSIDE_CONTENT_MARKER}\n`);
        symlinkSync(join(sandbox, 'outside', FOREIGN_NAME), join(projectRoot, 'src', 'link.ts'));
        symlinkSync(join(projectRoot, LEGIT_FILE), join(projectRoot, 'src', 'inner-link.ts'));
        const before = sandboxState(sandbox);

        const escaping = refusalOf(
          await resolveRealPathWithinProject(
            projectRoot,
            join(projectRoot, 'src', 'link.ts'),
            realpathAsync,
          ),
        );
        expect(escaping.code).toBe(CODES.unsafePath);
        expect(escaping.details?.['reason']).toBe('symlink-escapes-project-root');
        expectPrivate(escaping, [sandbox, FOREIGN_NAME, OUTSIDE_CONTENT_MARKER]);

        const inner = await resolveRealPathWithinProject(
          projectRoot,
          join(projectRoot, 'src', 'inner-link.ts'),
          realpathAsync,
        );
        expect(valueOf(inner).relativePath).toBe(LEGIT_FILE);

        expect(sandboxState(sandbox)).toEqual(before);
      } finally {
        rmSync(sandbox, { recursive: true, force: true });
      }
      expect(existsSync(sandbox)).toBe(false);
    },
  );
});

/* -------------------------------------------------------------------------------------------------
 * The handler, over a real project on disk
 * ---------------------------------------------------------------------------------------------- */

describe('createSourceOpenHandler → SourceOpenHandler.handle', () => {
  let base = '';
  let project = '';
  let outside = '';
  let sibling = '';
  let editor: SourceOpenPrincipal = { client: 'vscode' };
  let initialState: Record<string, string> = {};

  /** Everything that must never surface in an error or a log record. */
  const forbidden = (): string[] => [
    base,
    outside,
    sibling,
    OUTSIDE_CONTENT_MARKER,
    CREDENTIAL_MARKER,
  ];

  /**
   * Asserts that no captured log record carries a forbidden string, a field
   * outside the allowed set, or a `file` that is not project-relative.
   */
  const expectPrivateLogs = (entries: readonly LogEntry[]): void => {
    const serialised = JSON.stringify(entries);
    for (const value of forbidden()) {
      expect(serialised).not.toContain(value);
    }
    for (const entry of entries) {
      for (const key of Object.keys(entry.fields)) {
        expect(ALLOWED_LOG_FIELDS.has(key), `unexpected log field ${key}`).toBe(true);
      }
      const file = entry.fields['file'];
      if (file !== undefined) {
        expect(typeof file === 'string' && isSafeRelativePath(file)).toBe(true);
      }
    }
  };

  /** Asserts that the sandbox is exactly as `beforeEach` left it. */
  const expectSandboxUntouched = (): void => {
    expect(sandboxState(base)).toEqual(initialState);
  };

  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'debuggen-source-open-')));
    project = join(base, 'project');
    outside = join(base, 'outside');
    sibling = join(base, 'project-evil');

    mkdirSync(join(project, 'src', 'folder'), { recursive: true });
    mkdirSync(outside, { recursive: true });
    mkdirSync(sibling, { recursive: true });

    writeFileSync(join(project, LEGIT_FILE), 'export const answer = 42;\n');
    const leaked = `export const leaked = '${OUTSIDE_CONTENT_MARKER}';\n`;
    writeFileSync(join(outside, FOREIGN_NAME), leaked);
    writeFileSync(join(sibling, FOREIGN_NAME), leaked);

    // Links planted inside the project: two that escape by file, one that
    // escapes by directory, one that stays inside, and one that dangles.
    if (CAN_CREATE_SYMLINKS) {
      symlinkSync(join(outside, FOREIGN_NAME), join(project, 'src', 'leak.ts'));
      symlinkSync(join(sibling, FOREIGN_NAME), join(project, 'src', 'sibling-leak.ts'));
      symlinkSync(outside, join(project, 'vendor'), 'dir');
      symlinkSync(join(project, LEGIT_FILE), join(project, 'src', 'alias.ts'));
      symlinkSync(join(outside, 'gone.ts'), join(project, 'src', 'dangling.ts'));
    }

    editor = { client: 'vscode', projectRoots: [project], scope: CREDENTIAL_MARKER };
    initialState = sandboxState(base);
  });

  afterEach(() => {
    if (base !== '') {
      rmSync(base, { recursive: true, force: true });
      expect(existsSync(base)).toBe(false);
    }
  });

  describe('SourceOpenOutcome — forwarding and delivery outcomes', () => {
    it('sends exactly one source.open envelope to the editor, with the location unchanged', async () => {
      const h = harness({ session: sessionRecordFor(project) });
      // A confidence that differs from the resolver's default, so a handler
      // that re-stamped the location would be caught.
      const input: SourceOpenPayload = {
        sessionId: SESSION_ID,
        location: locationOf(LEGIT_FILE, { resolvedBy: 'source-map', confidence: 0.42 }),
      };
      expect(input.location.confidence).not.toBe(DEFAULT_RESOLUTION_CONFIDENCE['source-map']);

      const outcome = valueOf(await h.handle(input, editor));

      expect(withoutCorrelation(outcome)).toEqual({
        delivered: true,
        clients: 1,
        location: input.location,
        file: LEGIT_FILE,
      });
      expect(h.sent).toHaveLength(1);
      const [sent] = h.sent;
      if (sent === undefined) {
        throw new Error('expected one message');
      }
      expect(sent.sessionId).toBe(SESSION_ID);
      expect(sent.clientKind).toBe(EDITOR_KIND);
      // The outcome names the forwarded frame an editor's answer will carry as `ref`.
      const delivered = deliveredOf(outcome);
      expect(delivered.forwardedId).toBe(sent.message.id);
      expect(delivered.editorResult).toBeInstanceOf(Promise);

      // The frame is one the receiving editor's own parser accepts.
      const reparsed = valueOf(parseMessage(JSON.parse(JSON.stringify(sent.message))));
      expect(isMessageOfType(reparsed, 'source.open')).toBe(true);
      const { message } = sent;
      if (!isMessageOfType(message, 'source.open')) {
        throw new Error(`expected a source.open message, received ${message.type}`);
      }
      expect(valueOf(parseSourceOpenPayload(message.payload))).toEqual(input);
      expect(message.sessionId).toBe(SESSION_ID);
      expect(message.ts).toBe(FIXED_NOW);
      expect(Number.isSafeInteger(message.ts) && message.ts > 0).toBe(true);
      expect(typeof message.id).toBe('string');
      expect(message.id.length).toBeGreaterThan(0);
      expect(message.payload).toEqual(input);
      expect(message.payload.location.resolvedBy).toBe('source-map');
      expect(message.payload.location.confidence).toBe(0.42);
      expect(JSON.stringify(message.payload.location)).toBe(JSON.stringify(input.location));
      expectPrivateLogs(h.entries);
      expectSandboxUntouched();
    });

    it('stamps the envelope with the protocol clock when none is injected', async () => {
      const sent: ProtocolMessage[] = [];
      const handler = createSourceOpenHandler({
        sessions: { get: () => ok(sessionRecordFor(project)) },
        clients: {
          sendToSessionClients: (_sessionId, _kind, message) => {
            sent.push(message);
            return 1;
          },
        },
      });
      const before = Date.now();

      valueOf(
        await handler.handle({ sessionId: SESSION_ID, location: locationOf(LEGIT_FILE) }, editor),
      );

      const after = Date.now();
      const [message] = sent;
      expect(message?.ts).toBeGreaterThanOrEqual(before);
      expect(message?.ts).toBeLessThanOrEqual(after);
    });

    it('accepts a parsed envelope and a raw JSON frame as well as a bare payload', async () => {
      const h = harness({ session: sessionRecordFor(project) });
      const payload: SourceOpenPayload = {
        sessionId: SESSION_ID,
        location: locationOf(LEGIT_FILE),
      };
      const envelope = createEnvelope('source.open', payload);

      expect(valueOf(await h.handle(envelope, editor)).delivered).toBe(true);
      expect(valueOf(await h.handle(encodeMessage(envelope), editor)).delivered).toBe(true);
      expect(h.sent).toHaveLength(2);
    });

    it('answers delivered: false when no editor client is connected', async () => {
      const h = harness({ session: sessionRecordFor(project), deliverTo: 0 });
      const location = locationOf(LEGIT_FILE);

      const outcome = valueOf(await h.handle({ sessionId: SESSION_ID, location }, editor));

      expect(outcome).toEqual({ delivered: false, reason: 'no-editor-client', location });
      // The frame was offered to the editor kind only, and reached nobody.
      expect(h.sent.map((entry) => entry.clientKind)).toEqual([EDITOR_KIND]);
      const entry = h.entries.find((candidate) => candidate.message.startsWith('No editor client'));
      expect(entry?.fields['delivered']).toBe(0);
      expectPrivateLogs(h.entries);
      expectSandboxUntouched();
    });

    it('reports how many editor clients received the frame', async () => {
      const h = harness({ session: sessionRecordFor(project), deliverTo: 3 });
      const outcome = valueOf(
        await h.handle({ sessionId: SESSION_ID, location: locationOf(LEGIT_FILE) }, editor),
      );
      expect(outcome.delivered && outcome.clients).toBe(3);
    });

    it('works with asynchronous ports', async () => {
      const h = harness({ session: sessionRecordFor(project), asyncPorts: true });
      const outcome = valueOf(
        await h.handle({ sessionId: SESSION_ID, location: locationOf(LEGIT_FILE) }, editor),
      );
      expect(outcome.delivered).toBe(true);
    });

    it('lets an editor whose workspace folder contains the project open its source', async () => {
      const h = harness({ session: sessionRecordFor(project) });
      const outcome = valueOf(
        await h.handle(
          { sessionId: SESSION_ID, location: locationOf(LEGIT_FILE) },
          { client: 'vscode', projectRoots: [base] },
        ),
      );
      expect(outcome.delivered).toBe(true);
    });

    it.skipIf(!CAN_CREATE_SYMLINKS)(
      'opens a file reached through a link that stays inside the project, forwarding the location as sent',
      async () => {
        const h = harness({ session: sessionRecordFor(project) });
        const location = locationOf('src/alias.ts');

        const outcome = valueOf(await h.handle({ sessionId: SESSION_ID, location }, editor));

        expect(withoutCorrelation(outcome)).toEqual({
          delivered: true,
          clients: 1,
          location,
          file: LEGIT_FILE,
        });
        const message = h.sent[0]?.message;
        expect(message?.type === 'source.open' && message.payload.location.file).toBe(
          'src/alias.ts',
        );
        expectSandboxUntouched();
      },
    );

    it('is deterministic: the same request twice yields the same answer and one frame each', async () => {
      const h = harness({ session: sessionRecordFor(project) });
      const input: SourceOpenPayload = { sessionId: SESSION_ID, location: locationOf(LEGIT_FILE) };

      const first = valueOf(await h.handle(input, editor));
      const second = valueOf(await h.handle(input, editor));

      // Equal but for the correlation of each forward, which is its own.
      expect(withoutCorrelation(second)).toEqual(withoutCorrelation(first));
      expect(deliveredOf(second).forwardedId).not.toBe(deliveredOf(first).forwardedId);
      expect(h.sent).toHaveLength(2);

      const refusing = harness({ session: sessionRecordFor(project) });
      const escaping = { sessionId: SESSION_ID, location: locationOf('src/missing.ts') };
      const refusedOnce = refusalOf(await refusing.handle(escaping, editor));
      const refusedTwice = refusalOf(await refusing.handle(escaping, editor));
      expect(refusedTwice.toPayload()).toEqual(refusedOnce.toPayload());
      expect(refusing.sent).toEqual([]);
      expectSandboxUntouched();
    });
  });

  describe('containment through the handler', () => {
    /** One on-disk refusal: label, file, expected code, rejection and reason. */
    type DiskRefusal = readonly [
      label: string,
      file: string,
      code: DebuggenErrorCode,
      rejection: string,
      reason: string,
    ];

    /** Asserts all four properties of a refusal: typed, coded, nothing sent, nothing touched. */
    const expectRefusedWithoutEffect = async ([, file, code, rejection, reason]: DiskRefusal) => {
      const h = harness({ session: sessionRecordFor(project) });

      const error = refusalOf(
        await h.handle({ sessionId: SESSION_ID, location: locationOf(file) }, editor),
      );

      expect(DEBUGGEN_ERROR_CODES).toContain(error.code);
      expect(error.code).toBe(code);
      expect(sourceOpenRejectionOf(error)).toBe(rejection);
      expect(error.details?.['reason']).toBe(reason);
      expect(h.sent).toEqual([]);
      expectSandboxUntouched();
      expectPrivate(error, forbidden());
      expectPrivateLogs(h.entries);
    };

    const LINK_REFUSALS: readonly DiskRefusal[] = [
      [
        'a link to a file outside the project',
        'src/leak.ts',
        CODES.unsafePath,
        'unsafe-path',
        'symlink-escapes-project-root',
      ],
      [
        'a link to a file in a prefix-sibling directory',
        'src/sibling-leak.ts',
        CODES.unsafePath,
        'unsafe-path',
        'symlink-escapes-project-root',
      ],
      [
        'a file under a directory link that leads outside',
        `vendor/${FOREIGN_NAME}`,
        CODES.unsafePath,
        'unsafe-path',
        'symlink-escapes-project-root',
      ],
      ['a dangling link', 'src/dangling.ts', CODES.fileMissing, 'file-missing', 'not-found'],
    ];

    const PLAIN_REFUSALS: readonly DiskRefusal[] = [
      [
        'a file that does not exist',
        'src/missing.ts',
        CODES.fileMissing,
        'file-missing',
        'not-found',
      ],
      ['a directory', 'src/folder', CODES.fileMissing, 'file-missing', 'not-a-file'],
      ['the project root itself', '.', CODES.fileMissing, 'file-missing', 'not-a-file'],
    ];

    it.skipIf(!CAN_CREATE_SYMLINKS).each(LINK_REFUSALS)(
      'refuses %s, sends nothing, touches nothing and leaks nothing',
      async (...row) => {
        await expectRefusedWithoutEffect(row);
      },
    );

    it.each(PLAIN_REFUSALS)(
      'refuses %s, sends nothing, touches nothing and leaks nothing',
      async (...row) => {
        await expectRefusedWithoutEffect(row);
      },
    );

    it.skipIf(!CAN_CREATE_SYMLINKS)(
      'refuses a planted link out of the project although the lexical gate passes it',
      async () => {
        const location = locationOf('src/leak.ts');
        const linkTarget = readlinkSync(join(project, 'src', 'leak.ts'));
        const outsideBytes = readFileSync(join(outside, FOREIGN_NAME));
        // The lexical half alone accepts it: only the filesystem half can see the link.
        expect(assertLocationWithinProject(project, location).ok).toBe(true);
        const h = harness({ session: sessionRecordFor(project) });

        const error = refusalOf(await h.handle({ sessionId: SESSION_ID, location }, editor));

        expect(error.code).toBe(CODES.unsafePath);
        expect(h.sent).toEqual([]);
        expect(readFileSync(join(outside, FOREIGN_NAME)).equals(outsideBytes)).toBe(true);
        expectSandboxUntouched();
        const serialised = JSON.stringify(error.toPayload());
        expect(serialised).not.toContain(linkTarget);
        expect(serialised).not.toContain(join(outside, FOREIGN_NAME));
        expect(serialised).not.toContain(OUTSIDE_CONTENT_MARKER);
        expectPrivate(error, [...forbidden(), linkTarget]);
      },
    );

    it('tells a missing file apart from a containment failure', async () => {
      const h = harness({ session: sessionRecordFor(project) });

      const missing = refusalOf(
        await h.handle({ sessionId: SESSION_ID, location: locationOf('src/missing.ts') }, editor),
      );
      const escaping = refusalOf(
        await h.handle(
          { sessionId: SESSION_ID, location: locationOf(`../outside/${FOREIGN_NAME}`) },
          editor,
        ),
      );

      expect(missing.code).toBe(CODES.fileMissing);
      expect(sourceOpenRejectionOf(missing)).toBe('file-missing');
      expect(missing.code).not.toBe(escaping.code);
      expect(sourceOpenRejectionOf(missing)).not.toBe(sourceOpenRejectionOf(escaping));
      expect(h.sent).toEqual([]);
      expectSandboxUntouched();
    });

    it('refuses every escaping path of the corpus at shape validation, before anything else', async () => {
      // open.ts documents that the embedded source-location schema refuses
      // obvious escapes first, so through the handler they are malformed
      // frames; the lexical and filesystem halves are pinned directly above.
      const files = [
        ...ESCAPING_FILES.map(([, file]) => file),
        join(outside, FOREIGN_NAME),
        join(sibling, FOREIGN_NAME),
      ];
      for (const file of files) {
        const h = harness({ session: sessionRecordFor(project) });

        const error = refusalOf(
          await h.handle({ sessionId: SESSION_ID, location: locationOf(file) }, editor),
        );

        expect(error.code).toBe(CODES.invalidMessage);
        expect(sourceOpenRejectionOf(error)).toBe('invalid-payload');
        expect(h.sent).toEqual([]);
        expect(h.lookups).toEqual([]);
        expectPrivate(error, [...forbidden(), file]);
        expectPrivateLogs(h.entries);
      }
      expectSandboxUntouched();
    });

    it.skipIf(!CAN_CREATE_SYMLINKS)(
      'still refuses an escaping link when shape validation passes, with the warning logged',
      async () => {
        const h = harness({ session: sessionRecordFor(project) });

        refusalOf(
          await h.handle({ sessionId: SESSION_ID, location: locationOf('src/leak.ts') }, editor),
        );

        const warning = h.entries.find((entry) => entry.level === 'warn');
        expect(warning?.fields['rejection']).toBe('unsafe-path');
        expect(warning?.fields['subsystem']).toBe('source');
        expect(warning?.fields['file']).toBe('src/leak.ts');
        expectPrivateLogs(h.entries);
      },
    );

    it.skipIf(!CAN_CREATE_SYMLINKS)(
      'refuses a link at the final component even when the canonicaliser misses it',
      async () => {
        // An identity resolver "resolves" nothing, so the link survives to the
        // non-following lstat, which must refuse it.
        const h = harness({ session: sessionRecordFor(project), realpath: tableRealpath({}) });

        const error = refusalOf(
          await h.handle({ sessionId: SESSION_ID, location: locationOf('src/leak.ts') }, editor),
        );

        expect(error.code).toBe(CODES.unsafePath);
        expect(error.details?.['reason']).toBe('changed-after-resolution');
        expect(h.sent).toEqual([]);
        expectPrivate(error, forbidden());
      },
    );

    it('checks existence only when asked to, and never skips containment', async () => {
      const virtualRoot = '/virtual/app';
      const session = sessionRecordFor(virtualRoot);
      const principal: SourceOpenPrincipal = { client: 'vscode', projectRoots: [virtualRoot] };
      const location = locationOf('src/a.ts');

      const unchecked = harness({ session, realpath: tableRealpath({}), verifyExists: false });
      expect(
        withoutCorrelation(
          valueOf(await unchecked.handle({ sessionId: SESSION_ID, location }, principal)),
        ),
      ).toEqual({ delivered: true, clients: 1, location, file: 'src/a.ts' });

      const checked = harness({ session, realpath: tableRealpath({}) });
      const missing = refusalOf(
        await checked.handle({ sessionId: SESSION_ID, location }, principal),
      );
      expect(sourceOpenRejectionOf(missing)).toBe('file-missing');
      expect(checked.sent).toEqual([]);

      const escaping = harness({
        session,
        realpath: tableRealpath({ '/virtual/app/src/a.ts': '/elsewhere/a.ts' }),
        verifyExists: false,
      });
      const refused = refusalOf(
        await escaping.handle({ sessionId: SESSION_ID, location }, principal),
      );
      expect(refused.code).toBe(CODES.unsafePath);
      expect(escaping.sent).toEqual([]);
    });
  });

  describe('frame validation', () => {
    it('refuses malformed input before looking anything up, and never echoes it', async () => {
      const marker = 'MARKER-9f2c';
      const contradicting = {
        ...createEnvelope('source.open', {
          sessionId: SESSION_ID,
          location: locationOf(LEGIT_FILE),
        }),
        sessionId: 'ses_someone_else',
      };
      const inputs: unknown[] = [
        undefined,
        null,
        42,
        '{not json',
        `{"type":"source.open","payload":"${marker}"}`,
        true,
        [],
        { sessionId: SESSION_ID },
        { location: locationOf(LEGIT_FILE) },
        { sessionId: SESSION_ID, location: locationOf(LEGIT_FILE), extra: marker },
        { sessionId: '', location: locationOf(LEGIT_FILE) },
        { sessionId: SESSION_ID, location: locationOf(LEGIT_FILE, { line: 0 }) },
        { sessionId: SESSION_ID, location: { ...locationOf(`../../${marker}/x.ts`), line: 0 } },
        { sessionId: SESSION_ID, location: locationOf(LEGIT_FILE, { column: 2.5 }) },
        { sessionId: SESSION_ID, location: { ...locationOf(LEGIT_FILE), resolvedBy: marker } },
        { sessionId: SESSION_ID, location: locationOf(LEGIT_FILE, { confidence: 7 }) },
        { sessionId: SESSION_ID, location: locationOf(LEGIT_FILE, { confidence: -0.1 }) },
        { sessionId: SESSION_ID, location: locationOf(LEGIT_FILE, { endLine: 3 }) },
        createEnvelope('error', { code: CODES.internal, message: 'not a source.open' }),
        contradicting,
      ];

      for (const input of inputs) {
        const h = harness({ session: sessionRecordFor(project) });

        const error = refusalOf(await h.handle(input, editor));

        expect(error.code).toBe(CODES.invalidMessage);
        expect(sourceOpenRejectionOf(error)).toBe('invalid-payload');
        expect(h.lookups).toEqual([]);
        expect(h.sent).toEqual([]);
        expectPrivate(error, [...forbidden(), marker]);
      }
    });
  });

  describe('session lookup', () => {
    const location = locationOf(LEGIT_FILE);

    it('refuses a session that does not exist', async () => {
      const h = harness({ session: undefined });

      const error = refusalOf(await h.handle({ sessionId: SESSION_ID, location }, editor));

      expect(error.code).toBe(CODES.sessionNotFound);
      expect(sourceOpenRejectionOf(error)).toBe('session-not-found');
      expect(h.sent).toEqual([]);
    });

    it('refuses an unknown session id while another session exists', async () => {
      const h = harness({ session: sessionRecordFor(project) });
      const unknownId = 'ses_unknown_0002';

      const error = refusalOf(await h.handle({ sessionId: unknownId, location }, editor));

      expect(error.code).toBe(CODES.sessionNotFound);
      expect(h.lookups).toEqual([unknownId]);
      expect(h.sent).toEqual([]);
      expectPrivate(error, forbidden());
      expectPrivateLogs(h.entries);
      expectSandboxUntouched();
    });

    it('reports a store failure — returned, thrown or rejected — as an operational error', async () => {
      const storeError = new DebuggenError(CODES.store, `corrupt row under ${base}`);
      const getters: SourceOpenDeps['sessions']['get'][] = [
        () => err(storeError),
        () => {
          throw new Error(`disk failure at ${base}`);
        },
        () => Promise.reject(new Error(`disk failure at ${base}`)),
      ];

      for (const sessionsGet of getters) {
        const h = harness({ sessionsGet });

        const error = refusalOf(await h.handle({ sessionId: SESSION_ID, location }, editor));

        expect(error.code).toBe(CODES.store);
        expect(sourceOpenRejectionOf(error)).toBeUndefined();
        expect(h.sent).toEqual([]);
        expectPrivate(error, forbidden());
        expect(h.entries.some((entry) => entry.level === 'error')).toBe(true);
        expectPrivateLogs(h.entries);
      }
    });

    it('refuses a record the store returned for a different session', async () => {
      const other = { ...sessionRecordFor(project), id: 'ses_someone_else' };
      const h = harness({ sessionsGet: () => ok(other) });

      const error = refusalOf(await h.handle({ sessionId: SESSION_ID, location }, editor));

      expect(error.code).toBe(CODES.store);
      expect(h.sent).toEqual([]);
    });
  });

  describe('authorization', () => {
    const location = locationOf(LEGIT_FILE);

    it.each<[string, unknown]>([
      ['the page agent', { client: 'agent', tabId: 7 }],
      ['the dev-server agent', { client: 'server-agent', projectRoots: ['/'] }],
      ['an unknown client kind', { client: 'root', projectRoots: ['/'] }],
      ['a missing principal', undefined],
      ['a non-object principal', 'vscode'],
    ])('refuses %s', async (_label, principal) => {
      const calls: string[] = [];
      const h = harness({
        session: sessionRecordFor(project, 7),
        realpath: tableRealpath({}, {}, calls),
      });

      const error = refusalOf(
        await h.handle(
          { sessionId: SESSION_ID, location },
          hostile<SourceOpenPrincipal>(principal),
        ),
      );

      expect(error.code).toBe(CODES.unauthorized);
      expect(sourceOpenRejectionOf(error)).toBe('not-authorized');
      expect(error.details?.['reason']).toBe('role-not-permitted');
      expect(h.sent).toEqual([]);
      expect(calls).toEqual([]);
    });

    it('refuses an editor outside the workspace folders it announced', async () => {
      const cases: unknown[] = [
        undefined,
        [],
        [`${project}-evil`],
        [join(base, 'pro')],
        [join(project, 'src')],
        ['project'],
        ['C:\\work\\project'],
        [42],
        'not-an-array',
      ];
      for (const projectRoots of cases) {
        const h = harness({ session: sessionRecordFor(project) });

        const error = refusalOf(
          await h.handle(
            { sessionId: SESSION_ID, location },
            hostile<SourceOpenPrincipal>({ client: 'vscode', projectRoots }),
          ),
        );

        expect(error.code).toBe(CODES.unauthorized);
        expect(error.details?.['reason']).toBe('project-out-of-scope');
        expect(h.sent).toEqual([]);
        expectPrivate(error, forbidden());
      }
    });

    it('lets a DevTools panel open source only for the session bound to its own tab', async () => {
      const bound = harness({ session: sessionRecordFor(project, 7) });
      expect(
        valueOf(
          await bound.handle({ sessionId: SESSION_ID, location }, { client: 'devtools', tabId: 7 }),
        ).delivered,
      ).toBe(true);

      const refusals: unknown[] = [
        { client: 'devtools' },
        { client: 'devtools', tabId: 8 },
        { client: 'devtools', tabId: -1 },
        { client: 'devtools', tabId: 7.5 },
        { client: 'devtools', tabId: '7' },
        { client: 'devtools', tabId: 7, sessionId: 'ses_someone_else' },
      ];
      for (const principal of refusals) {
        const h = harness({ session: sessionRecordFor(project, 7) });

        const error = refusalOf(
          await h.handle(
            { sessionId: SESSION_ID, location },
            hostile<SourceOpenPrincipal>(principal),
          ),
        );

        expect(error.code).toBe(CODES.tabNotBound);
        expect(sourceOpenRejectionOf(error)).toBe('not-authorized');
        expect(error.details?.['reason']).toBe('session-not-bound');
        expect(h.sent).toEqual([]);
      }

      const unbound = harness({ session: sessionRecordFor(project) });
      const error = refusalOf(
        await unbound.handle({ sessionId: SESSION_ID, location }, { client: 'devtools', tabId: 7 }),
      );
      expect(error.code).toBe(CODES.tabNotBound);
    });

    it('treats the bindings table as authoritative when the store offers it', async () => {
      const session = sessionRecordFor(project, 7);
      const binding: SourceOpenBinding = { tab: { tabId: 9 } };

      const stale = harness({ session, binding, useBindingPort: true });
      expect(
        refusalOf(
          await stale.handle({ sessionId: SESSION_ID, location }, { client: 'devtools', tabId: 7 }),
        ).code,
      ).toBe(CODES.tabNotBound);

      const current = harness({ session, binding, useBindingPort: true, asyncPorts: true });
      expect(
        valueOf(
          await current.handle(
            { sessionId: SESSION_ID, location },
            { client: 'devtools', tabId: 9 },
          ),
        ).delivered,
      ).toBe(true);
      expect(current.lookups).toContain(`binding:${SESSION_ID}`);

      const none = harness({ session, binding: undefined, useBindingPort: true });
      expect(
        refusalOf(
          await none.handle({ sessionId: SESSION_ID, location }, { client: 'devtools', tabId: 7 }),
        ).code,
      ).toBe(CODES.tabNotBound);
    });

    it('reports a bindings-table failure as a store error', async () => {
      const handler = createSourceOpenHandler({
        sessions: {
          get: () => ok(sessionRecordFor(project, 7)),
          getBindingBySession: () => err(new DebuggenError(CODES.store, 'corrupt binding')),
        },
        clients: { sendToSessionClients: () => 1 },
      });

      const error = refusalOf(
        await handler.handle({ sessionId: SESSION_ID, location }, { client: 'devtools', tabId: 7 }),
      );

      expect(error.code).toBe(CODES.store);
    });

    it('decides authorization before any filesystem work', async () => {
      const calls: string[] = [];
      const h = harness({
        session: sessionRecordFor(project),
        realpath: tableRealpath({}, {}, calls),
      });

      const error = refusalOf(
        await h.handle(
          { sessionId: SESSION_ID, location: locationOf('src/leak.ts') },
          { client: 'agent' },
        ),
      );

      expect(sourceOpenRejectionOf(error)).toBe('not-authorized');
      expect(calls).toEqual([]);
    });

    it('never lets a telemetry producer kind open source, whatever scope it carries', async () => {
      const producerKinds = CLIENT_KINDS.filter(
        (kind) => kind !== EDITOR_KIND && kind !== clientKindFromVocabulary('devtools'),
      );
      expect(producerKinds).toEqual(['agent', 'server-agent']);

      for (const client of producerKinds) {
        const h = harness({ session: sessionRecordFor(project, 7) });

        const error = refusalOf(
          await h.handle(
            { sessionId: SESSION_ID, location },
            { client, projectRoots: [project], tabId: 7, sessionId: SESSION_ID },
          ),
        );

        expect(error.code).toBe(CODES.unauthorized);
        expect(error.details?.['reason']).toBe('role-not-permitted');
        expect(h.sent).toEqual([]);
      }
    });

    it('decides from the resolved principal only, never from carriers of another role', async () => {
      // A DevTools connection that also carries an editor's workspace folders
      // is still judged by its tab.
      const devtools = harness({ session: sessionRecordFor(project, 7) });
      const devtoolsError = refusalOf(
        await devtools.handle(
          { sessionId: SESSION_ID, location },
          { client: 'devtools', tabId: 8, projectRoots: [project] },
        ),
      );
      expect(devtoolsError.code).toBe(CODES.tabNotBound);
      expect(devtools.sent).toEqual([]);

      // An editor connection that also carries the bound tab is still judged
      // by its announced workspace folders.
      const vscode = harness({ session: sessionRecordFor(project, 7) });
      const vscodeError = refusalOf(
        await vscode.handle({ sessionId: SESSION_ID, location }, { client: 'vscode', tabId: 7 }),
      );
      expect(vscodeError.code).toBe(CODES.unauthorized);
      expect(vscodeError.details?.['reason']).toBe('project-out-of-scope');
      expect(vscode.sent).toEqual([]);
    });

    it('refuses a frame that names its own project root, and never looks the session up', async () => {
      const h = harness({ session: sessionRecordFor(project) });
      const selfDescribing = {
        sessionId: SESSION_ID,
        location,
        projectRoot: outside,
        client: 'vscode',
      };

      const error = refusalOf(await h.handle(selfDescribing, editor));

      expect(error.code).toBe(CODES.invalidMessage);
      expect(h.lookups).toEqual([]);
      expect(h.sent).toEqual([]);
      expectPrivate(error, forbidden());
    });

    it('contains against the stored SessionRecord.projectRoot, not anything the request names', async () => {
      const calls: string[] = [];
      const recording: SourceOpenRealPath = async (path) => {
        calls.push(path);
        return realpathAsync(path);
      };
      const h = harness({ session: sessionRecordFor(project), realpath: recording });

      valueOf(
        await h.handle(
          { sessionId: SESSION_ID, location },
          { client: 'vscode', projectRoots: [base, outside] },
        ),
      );

      expect(calls).toEqual([project, join(project, LEGIT_FILE)]);
      expect(calls.some((path) => path.startsWith(outside))).toBe(false);
    });
  });

  describe('delivery', () => {
    const location = locationOf(LEGIT_FILE);

    it('reports a client registry that throws or rejects as a transport failure', async () => {
      const senders: SourceOpenDeps['clients']['sendToSessionClients'][] = [
        () => {
          throw new Error('socket closed');
        },
        () => Promise.reject(new Error('socket closed')),
      ];
      for (const send of senders) {
        const h = harness({ session: sessionRecordFor(project), send });

        const error = refusalOf(await h.handle({ sessionId: SESSION_ID, location }, editor));

        expect(error.code).toBe(CODES.transport);
        expect(sourceOpenRejectionOf(error)).toBeUndefined();
      }
    });

    it('refuses to trust an invalid delivery count', async () => {
      for (const count of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, hostile<number>('1')]) {
        const h = harness({ session: sessionRecordFor(project), send: () => count });

        const error = refusalOf(await h.handle({ sessionId: SESSION_ID, location }, editor));

        expect(error.code).toBe(CODES.internal);
      }
    });

    it('refuses to send a frame stamped with an invalid clock', async () => {
      const sent: ProtocolMessage[] = [];
      const handler = createSourceOpenHandler({
        sessions: { get: () => ok(sessionRecordFor(project)) },
        clients: {
          sendToSessionClients: (_sessionId, _kind, message) => {
            sent.push(message);
            return 1;
          },
        },
        now: () => Number.NaN,
      });

      const error = refusalOf(await handler.handle({ sessionId: SESSION_ID, location }, editor));

      expect(error.code).toBe(CODES.internal);
      expect(sent).toEqual([]);
    });
  });

  describe('logging', () => {
    const location = locationOf(LEGIT_FILE);

    it('records a forward at debug with the standard bindings and project-relative fields only', async () => {
      const h = harness({ session: sessionRecordFor(project) });

      valueOf(await h.handle({ sessionId: SESSION_ID, location }, editor));

      const entry = h.entries.find((candidate) => candidate.message.startsWith('Forwarded'));
      expect(entry?.level).toBe('debug');
      expect(entry?.fields).toMatchObject({
        subsystem: 'source',
        sessionId: SESSION_ID,
        client: EDITOR_KIND,
        file: LEGIT_FILE,
        line: 12,
        column: 5,
        resolvedBy: 'code-graph',
        delivered: 1,
      });
      expectPrivateLogs(h.entries);
    });

    it('is observation only: a throwing logger changes no outcome', async () => {
      const throwing = (): never => {
        throw new Error('logger down');
      };
      const brokenLogger: Logger = {
        level: 'trace',
        trace: throwing,
        debug: throwing,
        info: throwing,
        warn: throwing,
        error: throwing,
        fatal: throwing,
        child: (): Logger => brokenLogger,
      };
      const brokenChild: Logger = { ...brokenLogger, child: throwing };

      for (const logger of [brokenLogger, brokenChild]) {
        const delivered = harness({ session: sessionRecordFor(project), logger });
        expect(
          valueOf(await delivered.handle({ sessionId: SESSION_ID, location }, editor)).delivered,
        ).toBe(true);

        // A probing refusal is recorded at warn; a stale link at debug.
        const refused = harness({ session: sessionRecordFor(project), logger });
        expect(
          refusalOf(await refused.handle({ sessionId: SESSION_ID, location }, { client: 'agent' }))
            .code,
        ).toBe(CODES.unauthorized);
        expect(
          refusalOf(
            await refused.handle(
              { sessionId: SESSION_ID, location: locationOf('src/missing.ts') },
              editor,
            ),
          ).code,
        ).toBe(CODES.fileMissing);
      }
    });

    it('records refusals with enumerated fields only, never the rejected value', async () => {
      const h = harness({ session: sessionRecordFor(project) });

      refusalOf(
        await h.handle(
          { sessionId: SESSION_ID, location: locationOf(`../outside/${FOREIGN_NAME}`) },
          editor,
        ),
      );
      refusalOf(await h.handle({ sessionId: SESSION_ID, location }, { client: 'server-agent' }));
      refusalOf(
        await h.handle({ sessionId: SESSION_ID, location: locationOf('src/missing.ts') }, editor),
      );

      expect(h.entries.length).toBeGreaterThanOrEqual(3);
      expect(JSON.stringify(h.entries)).not.toContain(`../outside/${FOREIGN_NAME}`);
      expectPrivateLogs(h.entries);
    });
  });

  describe('editor result correlation — acceptEditorResult, the deadline and close()', () => {
    const location = locationOf(LEGIT_FILE);

    /** An editor connection of the project, with a registry id for de-duplication. */
    const editorConnection = (connectionId: string): SourceOpenPrincipal => ({
      ...editor,
      connectionId,
    });

    /** Forwards one request and returns the delivered outcome. */
    const forward = async (h: Harness): Promise<SourceOpenDelivered> =>
      deliveredOf(valueOf(await h.handle({ sessionId: SESSION_ID, location }, editor)));

    /** An editor's `source.result` envelope for `ref`. */
    const answerFrame = (
      ref: string,
      result: SourceOpenEditorResult,
      sessionId: string = SESSION_ID,
    ): ProtocolMessage => {
      const payload: SourceResultPayload = { ...result, sessionId, ref };
      return createEnvelope('source.result', payload);
    };

    const failedWith = (code: DebuggenErrorCode, message: string): SourceOpenEditorResult => ({
      status: 'failed',
      error: { code, message, hint: 'Reopen the file in VS Code.' },
    });

    it('settles opened on the first opened answer, and ignores every later answer', async () => {
      const clock = fakeClock();
      const h = harness({ session: sessionRecordFor(project), deliverTo: 2, timers: clock });
      const { forwardedId, editorResult } = await forward(h);
      const state = track(editorResult);

      const first = valueOf(
        await h.handler.acceptEditorResult(
          answerFrame(forwardedId, failedWith(CODES.fileMissing, 'The file is gone.')),
          editorConnection('conn-a'),
        ),
      );
      await flushPromises();
      expect(first).toEqual({ settled: false });
      expect(state.settled).toBe(false);

      const second = valueOf(
        await h.handler.acceptEditorResult(
          answerFrame(forwardedId, { status: 'opened' }),
          editorConnection('conn-b'),
        ),
      );
      expect(second).toEqual({ settled: true });
      expect(await editorResult).toEqual({ status: 'opened' });
      expect(clock.active).toBe(0);

      // A late answer after settlement is normal: accepted, and it changes nothing.
      const late = valueOf(
        await h.handler.acceptEditorResult(
          answerFrame(forwardedId, failedWith(CODES.internal, 'Late.')),
          editorConnection('conn-a'),
        ),
      );
      expect(late).toEqual({ settled: false });
      expect(await editorResult).toEqual({ status: 'opened' });
      expectPrivateLogs(h.entries);
    });

    it('settles with the first failure once every addressed editor failed, counting each connection once', async () => {
      const clock = fakeClock();
      const h = harness({ session: sessionRecordFor(project), deliverTo: 2, timers: clock });
      const { forwardedId, editorResult } = await forward(h);
      const state = track(editorResult);
      const firstFailure = failedWith(CODES.fileMissing, 'The file is gone.');

      expect(
        valueOf(
          await h.handler.acceptEditorResult(
            answerFrame(forwardedId, firstFailure),
            editorConnection('conn-a'),
          ),
        ),
      ).toEqual({ settled: false });
      // The same connection failing twice is one editor, not two.
      expect(
        valueOf(
          await h.handler.acceptEditorResult(
            answerFrame(forwardedId, failedWith(CODES.internal, 'Again.')),
            editorConnection('conn-a'),
          ),
        ),
      ).toEqual({ settled: false });
      await flushPromises();
      expect(state.settled).toBe(false);

      expect(
        valueOf(
          await h.handler.acceptEditorResult(
            answerFrame(forwardedId, failedWith(CODES.unsafePath, 'Refused.')),
            editorConnection('conn-b'),
          ),
        ),
      ).toEqual({ settled: true });
      expect(await editorResult).toEqual(firstFailure);
      expect(clock.active).toBe(0);
    });

    it('settles failed TRANSPORT_DISCONNECTED when no editor answers before the deadline', async () => {
      const clock = fakeClock();
      const h = harness({
        session: sessionRecordFor(project),
        timers: clock,
        editorResultTimeoutMs: 500,
      });
      const { forwardedId, editorResult } = await forward(h);
      const state = track(editorResult);
      expect(clock.active).toBe(1);
      expect(clock.unrefs).toBe(1);

      clock.advance(499);
      await flushPromises();
      expect(state.settled).toBe(false);

      clock.advance(1);
      const result = await editorResult;
      const responsiveHint: unknown = expect.stringContaining(
        'VS Code window for the project is responsive',
      );
      expect(result).toEqual({
        status: 'failed',
        error: {
          code: CODES.transport,
          message: 'VS Code did not confirm that it opened the source location in time.',
          hint: responsiveHint,
        },
      });
      expect(clock.active).toBe(0);

      // The editor answering after the deadline is not an error.
      expect(
        valueOf(
          await h.handler.acceptEditorResult(
            answerFrame(forwardedId, { status: 'opened' }),
            editor,
          ),
        ),
      ).toEqual({ settled: false });
      expectPrivateLogs(h.entries);
    });

    it('waits SOURCE_OPEN_EDITOR_TIMEOUT_MS by default', async () => {
      const clock = fakeClock();
      const h = harness({ session: sessionRecordFor(project), timers: clock });
      const { editorResult } = await forward(h);
      const state = track(editorResult);

      clock.advance(SOURCE_OPEN_EDITOR_TIMEOUT_MS - 1);
      await flushPromises();
      expect(state.settled).toBe(false);

      clock.advance(1);
      expect((await editorResult).status).toBe('failed');
    });

    it('runs on the global timers when none are injected', async () => {
      const h = harness({ session: sessionRecordFor(project), editorResultTimeoutMs: 5 });
      const { editorResult } = await forward(h);

      const result = await editorResult;

      expect(result.status === 'failed' && result.error.code).toBe(CODES.transport);
    });

    it('replaces an unusable option with its default, and says so', async () => {
      for (const unusable of [0, -1, 1.5, Number.NaN, 2 ** 31]) {
        const clock = fakeClock();
        const h = harness({
          session: sessionRecordFor(project),
          timers: clock,
          editorResultTimeoutMs: unusable,
          maxPendingEditorResults: unusable,
        });
        expect(
          h.entries
            .filter((entry) => entry.level === 'warn')
            .map((entry) => entry.fields['option']),
        ).toEqual(
          unusable === 2 ** 31
            ? ['editorResultTimeoutMs']
            : ['editorResultTimeoutMs', 'maxPendingEditorResults'],
        );

        const { editorResult } = await forward(h);
        const state = track(editorResult);
        clock.advance(SOURCE_OPEN_EDITOR_TIMEOUT_MS - 1);
        await flushPromises();
        expect(state.settled).toBe(false);
        clock.advance(1);
        expect((await editorResult).status).toBe('failed');
        expectPrivateLogs(h.entries);
      }
    });

    it('answers a ref that is not pending with ok({ settled: false }) and a debug record', async () => {
      const h = harness({ session: sessionRecordFor(project), timers: fakeClock() });

      const outcome = valueOf(
        await h.handler.acceptEditorResult(
          answerFrame('msg_never_forwarded', { status: 'opened' }),
          editor,
        ),
      );

      expect(outcome).toEqual({ settled: false });
      const entry = h.entries.find((candidate) => candidate.message.startsWith('Ignored'));
      expect(entry?.level).toBe('debug');
      expect(entry?.fields).toMatchObject({ ref: 'msg_never_forwarded', status: 'opened' });
      expectPrivateLogs(h.entries);
    });

    it('refuses an answer naming another session than the forward it answers', async () => {
      const h = harness({ session: sessionRecordFor(project), timers: fakeClock() });
      const { forwardedId, editorResult } = await forward(h);

      const error = refusalOf(
        await h.handler.acceptEditorResult(
          answerFrame(forwardedId, { status: 'opened' }, 'ses_some_other_session'),
          editor,
        ),
      );

      expect(error.code).toBe(CODES.unauthorized);
      expect(sourceOpenRejectionOf(error)).toBe('not-authorized');
      expect(error.details?.['reason']).toBe('session-mismatch');
      // The refused answer settled nothing: the rightful one still does.
      expect(
        valueOf(
          await h.handler.acceptEditorResult(
            answerFrame(forwardedId, { status: 'opened' }),
            editor,
          ),
        ),
      ).toEqual({ settled: true });
      expect(await editorResult).toEqual({ status: 'opened' });
    });

    it('refuses an editor whose announced workspace does not cover the session project', async () => {
      const h = harness({ session: sessionRecordFor(project), timers: fakeClock() });
      const { forwardedId, editorResult } = await forward(h);
      const state = track(editorResult);

      for (const principal of [
        { client: 'vscode', projectRoots: [outside] },
        { client: 'vscode', projectRoots: [sibling] },
        { client: 'vscode' },
      ] satisfies SourceOpenPrincipal[]) {
        const error = refusalOf(
          await h.handler.acceptEditorResult(
            answerFrame(forwardedId, { status: 'opened' }),
            principal,
          ),
        );
        expect(error.code).toBe(CODES.unauthorized);
        expect(error.details?.['reason']).toBe('project-out-of-scope');
        expectPrivate(error, forbidden());
      }
      await flushPromises();
      expect(state.settled).toBe(false);
      expectPrivateLogs(h.entries);
    });

    it('refuses an answer from anything but an editor connection', async () => {
      const h = harness({ session: sessionRecordFor(project), timers: fakeClock() });
      const { forwardedId, editorResult } = await forward(h);
      const state = track(editorResult);

      for (const principal of [
        { client: 'devtools', tabId: 7, sessionId: SESSION_ID },
        { client: 'agent' },
        { client: 'server-agent', projectRoots: [project] },
        hostile<SourceOpenPrincipal>(undefined),
        hostile<SourceOpenPrincipal>({ client: 'root' }),
      ] satisfies SourceOpenPrincipal[]) {
        const error = refusalOf(
          await h.handler.acceptEditorResult(
            answerFrame(forwardedId, { status: 'opened' }),
            principal,
          ),
        );
        expect(error.code).toBe(CODES.unauthorized);
        expect(sourceOpenRejectionOf(error)).toBe('not-authorized');
        expect(error.details?.['reason']).toBe('role-not-permitted');
      }
      await flushPromises();
      expect(state.settled).toBe(false);
    });

    it('refuses no-editor from an editor: that status is the service’s own answer', async () => {
      const h = harness({ session: sessionRecordFor(project), timers: fakeClock() });
      const { forwardedId, editorResult } = await forward(h);
      const state = track(editorResult);

      const error = refusalOf(
        await h.handler.acceptEditorResult(
          createEnvelope('source.result', {
            sessionId: SESSION_ID,
            ref: forwardedId,
            status: 'no-editor',
          }),
          editor,
        ),
      );

      expect(error.code).toBe(CODES.invalidMessage);
      expect(sourceOpenRejectionOf(error)).toBe('invalid-payload');
      expect(error.details?.['reason']).toBe('status-not-permitted');
      await flushPromises();
      expect(state.settled).toBe(false);
    });

    it('refuses a malformed answer without echoing any of it', async () => {
      const h = harness({ session: sessionRecordFor(project), timers: fakeClock() });
      const { forwardedId } = await forward(h);
      const marker = 'ANSWER-MARKER-5d1e';

      for (const input of [
        'not json at all',
        `{"id":"${marker}"`,
        { sessionId: SESSION_ID, ref: forwardedId, status: 'opened', extra: marker },
        { sessionId: SESSION_ID, ref: forwardedId, status: 'failed' },
        { sessionId: SESSION_ID, ref: forwardedId, status: `${marker}-status` },
        { sessionId: SESSION_ID, status: 'opened' },
        createEnvelope('source.open', { sessionId: SESSION_ID, location }),
        undefined,
        42,
      ]) {
        const error = refusalOf(await h.handler.acceptEditorResult(input, editor));
        expect(error.code).toBe(CODES.invalidMessage);
        expect(sourceOpenRejectionOf(error)).toBe('invalid-payload');
        expectPrivate(error, [marker]);
      }
      expect(JSON.stringify(h.entries)).not.toContain(marker);
      expectPrivateLogs(h.entries);
    });

    it('accepts a parsed envelope, a raw frame and a bare payload', async () => {
      const h = harness({ session: sessionRecordFor(project), timers: fakeClock() });
      const forms: ((ref: string) => unknown)[] = [
        (ref) => answerFrame(ref, { status: 'opened' }),
        (ref) => encodeMessage(answerFrame(ref, { status: 'opened' })),
        (ref) => ({ sessionId: SESSION_ID, ref, status: 'opened' }),
      ];

      for (const form of forms) {
        const { forwardedId, editorResult } = await forward(h);
        expect(valueOf(await h.handler.acceptEditorResult(form(forwardedId), editor))).toEqual({
          settled: true,
        });
        expect(await editorResult).toEqual({ status: 'opened' });
      }
    });

    it('logs an editor answer by status, code and ids only — never its message or hint', async () => {
      const h = harness({ session: sessionRecordFor(project), timers: fakeClock() });
      const { forwardedId, editorResult } = await forward(h);
      const secret = `${outside}/${FOREIGN_NAME} ${OUTSIDE_CONTENT_MARKER}`;

      valueOf(
        await h.handler.acceptEditorResult(
          answerFrame(forwardedId, {
            status: 'failed',
            error: { code: CODES.fileMissing, message: secret, hint: secret },
          }),
          editor,
        ),
      );

      // The failure travels to the sender unchanged; it is only kept out of the log.
      const result = await editorResult;
      expect(result.status === 'failed' && result.error.message).toBe(secret);
      const settledEntry = h.entries.find((entry) => entry.message.startsWith('Settled'));
      expect(settledEntry?.fields).toMatchObject({
        ref: forwardedId,
        status: 'failed',
        code: CODES.fileMissing,
        settled: true,
      });
      const forwardedEntry = h.entries.find((entry) => entry.message.startsWith('Forwarded'));
      expect(forwardedEntry?.fields['ref']).toBe(forwardedId);
      expectPrivateLogs(h.entries);
    });

    it('close() settles every pending forward failed, clears its deadline, and settles later forwards at once', async () => {
      const clock = fakeClock();
      const h = harness({ session: sessionRecordFor(project), timers: clock });
      const first = await forward(h);
      const second = await forward(h);
      expect(clock.active).toBe(2);

      h.handler.close();

      const anyHint: unknown = expect.any(String);
      const shutdown = {
        status: 'failed',
        error: {
          code: CODES.transport,
          message: 'The Debug Generator service is shutting down.',
          hint: anyHint,
        },
      };
      expect(await first.editorResult).toEqual(shutdown);
      expect(await second.editorResult).toEqual(shutdown);
      expect(clock.active).toBe(0);
      expect(() => {
        h.handler.close();
      }).not.toThrow();

      // A forward after close is still sent, and answered failed at once.
      const late = await forward(h);
      expect(h.sent).toHaveLength(3);
      expect(await late.editorResult).toEqual(shutdown);
      expect(clock.active).toBe(0);
      // Nothing is pending any more, so an answer settles nothing.
      expect(
        valueOf(
          await h.handler.acceptEditorResult(
            answerFrame(first.forwardedId, { status: 'opened' }),
            editor,
          ),
        ),
      ).toEqual({ settled: false });
    });

    it('registers the pending entry before sending, so an editor answering inside the send settles it', async () => {
      for (const reply of [
        { status: 'opened' },
        failedWith(CODES.fileMissing, 'The file is gone.'),
      ] satisfies SourceOpenEditorResult[]) {
        const clock = fakeClock();
        const answers: Result<unknown, DebuggenError>[] = [];
        // The send is built before the handler exists, so it reaches it through a holder.
        const wired: { handler?: SourceOpenHandler } = {};
        const h = harness({
          session: sessionRecordFor(project),
          timers: clock,
          // The editor answers synchronously, from inside the registry's send.
          send: (_sessionId, _kind, message) => {
            void wired.handler
              ?.acceptEditorResult(answerFrame(message.id, reply), editor)
              .then((answer) => answers.push(answer));
            return 1;
          },
        });
        wired.handler = h.handler;

        const { editorResult } = await forward(h);

        expect(await editorResult).toEqual(reply);
        await flushPromises();
        // An opened answer settles on arrival; a failure once the send reports one editor.
        expect(answers.map((answer) => valueOf(answer))).toEqual([
          { settled: reply.status === 'opened' },
        ]);
        expect(clock.active).toBe(0);
      }
    });

    it('drops the pending entry of a forward that reached nobody or could not be sent', async () => {
      const clock = fakeClock();
      const offered: ProtocolMessage[] = [];
      const senders: SourceOpenDeps['clients']['sendToSessionClients'][] = [
        (_sessionId, _kind, message) => {
          offered.push(message);
          return 0;
        },
        (_sessionId, _kind, message) => {
          offered.push(message);
          throw new Error('socket closed');
        },
        (_sessionId, _kind, message) => {
          offered.push(message);
          return -1;
        },
      ];

      for (const send of senders) {
        const h = harness({ session: sessionRecordFor(project), timers: clock, send });
        await h.handle({ sessionId: SESSION_ID, location }, editor);
        const message = offered.at(-1);
        if (message === undefined) {
          throw new Error('expected the frame to have been offered');
        }
        expect(clock.active).toBe(0);
        expect(
          valueOf(
            await h.handler.acceptEditorResult(
              answerFrame(message.id, { status: 'opened' }),
              editor,
            ),
          ),
        ).toEqual({ settled: false });
      }
    });

    it('bounds the pending table: past the bound the oldest forward settles failed', async () => {
      expect(DEFAULT_MAX_PENDING_EDITOR_RESULTS).toBe(256);
      const clock = fakeClock();
      const h = harness({
        session: sessionRecordFor(project),
        timers: clock,
        maxPendingEditorResults: 2,
      });

      const oldest = await forward(h);
      const middle = await forward(h);
      const newest = await forward(h);

      const evicted = await oldest.editorResult;
      expect(evicted.status === 'failed' && evicted.error.code).toBe('RATE_LIMITED');
      expect(clock.active).toBe(2);
      const warning = h.entries.find((entry) => entry.message.startsWith('Gave up'));
      expect(warning?.level).toBe('warn');
      expect(warning?.fields['ref']).toBe(oldest.forwardedId);

      // The two newer forwards are still pending and still answerable.
      for (const pendingForward of [middle, newest]) {
        expect(
          valueOf(
            await h.handler.acceptEditorResult(
              answerFrame(pendingForward.forwardedId, { status: 'opened' }),
              editor,
            ),
          ),
        ).toEqual({ settled: true });
        expect(await pendingForward.editorResult).toEqual({ status: 'opened' });
      }
      expect(clock.active).toBe(0);
      expectPrivateLogs(h.entries);
    });

    it('never throws from acceptEditorResult, whatever it is handed', async () => {
      const throwing = hostile<SourceOpenTimers>({
        setTimeout: () => {
          throw new Error('no timers here');
        },
        clearTimeout: () => {
          throw new Error('no timers here');
        },
      });
      const h = harness({ session: sessionRecordFor(project), timers: throwing });

      // A deadline that cannot be armed settles the forward rather than stranding it.
      const { editorResult } = await forward(h);
      const result = await editorResult;
      expect(result.status === 'failed' && result.error.code).toBe(CODES.internal);

      for (const principal of [
        hostile<SourceOpenPrincipal>(null),
        hostile<SourceOpenPrincipal>({ client: 'vscode', projectRoots: 'not-an-array' }),
        hostile<SourceOpenPrincipal>({ client: 'vscode', connectionId: 42 }),
      ]) {
        const answered = await h.handler.acceptEditorResult(
          { sessionId: SESSION_ID, ref: 'msg_x', status: 'opened' },
          principal,
        );
        expect(typeof answered.ok).toBe('boolean');
      }
    });
  });

  describe('resilience', () => {
    it('never throws or rejects, whatever it is handed', async () => {
      const handler = createSourceOpenHandler({
        sessions: hostile<SourceOpenDeps['sessions']>({}),
        clients: hostile<SourceOpenDeps['clients']>({}),
      });
      const inputs: unknown[] = [
        undefined,
        { sessionId: SESSION_ID, location: locationOf(LEGIT_FILE) },
      ];
      for (const input of inputs) {
        const result = await handler.handle(input, hostile<SourceOpenPrincipal>(undefined));
        expect(result.ok).toBe(false);
      }
    });

    it.skipIf(!CAN_CREATE_SYMLINKS)('uses the real filesystem by default', async () => {
      const handler = createSourceOpenHandler({
        sessions: { get: () => ok(sessionRecordFor(project)) },
        clients: { sendToSessionClients: () => 1 },
      });

      expect(
        valueOf(
          await handler.handle({ sessionId: SESSION_ID, location: locationOf(LEGIT_FILE) }, editor),
        ).delivered,
      ).toBe(true);
      expect(
        refusalOf(
          await handler.handle(
            { sessionId: SESSION_ID, location: locationOf('src/leak.ts') },
            editor,
          ),
        ).code,
      ).toBe(CODES.unsafePath);
      expectSandboxUntouched();
    });
  });
});
