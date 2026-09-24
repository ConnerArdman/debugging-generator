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
 * The symbolic-link cases run twice: against a real temporary directory with
 * real `realpath` and `lstat`, and against an injected table-based resolver,
 * which is how the edge cases a real filesystem cannot stage on demand (a
 * resolver answering with a relative or Windows path, an `ELOOP`) are reached.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createEnvelope,
  encodeMessage,
  parseSessionRecord,
  toErrorPayload,
} from '@debuggen/protocol';
import type { ProtocolMessage, SessionRecord, SourceOpenPayload } from '@debuggen/protocol';
import { DebuggenError, err, ok } from '@debuggen/shared';
import type { LogFields, Logger, Result, SourceLocation } from '@debuggen/shared';

import {
  SOURCE_OPEN_REJECTIONS,
  assertLocationWithinProject,
  createSourceOpenHandler,
  resolveRealPathWithinProject,
  sourceOpenRejectionOf,
} from './open.js';
import type {
  SourceOpenBinding,
  SourceOpenDeps,
  SourceOpenOutcome,
  SourceOpenPrincipal,
  SourceOpenRealPath,
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
    candidate['boundTab'] = { tabId: boundTabId, url: 'http://127.0.0.1:3000/catalog' };
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
}

/** The handler wired to recording fakes. */
interface Harness {
  readonly sent: SentMessage[];
  readonly entries: LogEntry[];
  readonly lookups: string[];
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
  });

  return { sent, entries, lookups, handle: (input, principal) => handler.handle(input, principal) };
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

/* -------------------------------------------------------------------------------------------------
 * The public vocabulary
 * ---------------------------------------------------------------------------------------------- */

describe('the rejection vocabulary', () => {
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
    const refused = new DebuggenError('PATH_OUTSIDE_PROJECT', 'refused', {
      details: { rejection: 'outside-project' },
    });
    const foreign = new DebuggenError('PATH_OUTSIDE_PROJECT', 'refused', {
      details: { rejection: 'made-up' },
    });
    expect(sourceOpenRejectionOf(refused)).toBe('outside-project');
    expect(sourceOpenRejectionOf(foreign)).toBeUndefined();
    expect(sourceOpenRejectionOf(new DebuggenError('INTERNAL', 'x'))).toBeUndefined();
  });
});

/* -------------------------------------------------------------------------------------------------
 * The lexical half
 * ---------------------------------------------------------------------------------------------- */

describe('assertLocationWithinProject — the lexical half', () => {
  const root = '/work/app';

  it('places a project-relative file under the root', () => {
    expect(valueOf(assertLocationWithinProject(root, locationOf('src/lib/a.ts')))).toEqual({
      absolutePath: '/work/app/src/lib/a.ts',
    });
  });

  it('normalises an interior segment that stays inside', () => {
    expect(valueOf(assertLocationWithinProject(root, locationOf('src/./lib/../lib/a.ts')))).toEqual(
      { absolutePath: '/work/app/src/lib/a.ts' },
    );
  });

  it.each([
    ['parent traversal', '../secret.ts'],
    ['interior traversal that climbs out', 'src/../../secret.ts'],
    ['an absolute POSIX path', '/etc/passwd'],
    ['a Windows drive path with backslashes', 'C:\\Windows\\win.ini'],
    ['a Windows drive path with forward slashes', 'C:/Windows/win.ini'],
    ['a UNC path', '\\\\server\\share\\secret.ts'],
    ['a forward-slash network share', '//server/share/secret.ts'],
    ['a prefix sibling of the root', '../app-evil/secret.ts'],
    ['a NUL character', 'src/a.ts\u0000.png'],
    ['a backslash segment', 'src\\..\\..\\secret.ts'],
    ['an empty path', ''],
    ['a whitespace-only path', '   '],
  ])('refuses %s without quoting it', (_label, file) => {
    const error = refusalOf(assertLocationWithinProject(root, locationOf(file)));
    expect(error.code).toBe('PATH_OUTSIDE_PROJECT');
    expect(sourceOpenRejectionOf(error)).toBe('outside-project');
    const forbidden = file.trim().length === 0 ? [root] : [root, file];
    expectPrivate(error, forbidden);
  });

  it('refuses a relative project root', () => {
    const error = refusalOf(assertLocationWithinProject('work/app', locationOf('src/a.ts')));
    expect(error.code).toBe('PATH_OUTSIDE_PROJECT');
  });

  it('refuses, rather than throws on, a location that never passed the schema', () => {
    for (const value of [null, undefined, 42, 'src/a.ts', { file: 7 }, []]) {
      const error = refusalOf(assertLocationWithinProject(root, hostile<SourceLocation>(value)));
      expect(error.code).toBe('PATH_OUTSIDE_PROJECT');
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
        tableRealpath({ '/work/app/src/leak.ts': '/elsewhere/secret.ts' }),
      ),
    );
    expect(error.code).toBe('FS_UNSAFE_PATH');
    expect(sourceOpenRejectionOf(error)).toBe('unsafe-path');
    expect(error.details?.['reason']).toBe('symlink-escapes-project-root');
    expect(error.message).toContain('src/leak.ts');
    expectPrivate(error, ['/elsewhere', 'secret.ts', root]);
  });

  it('refuses a link that leads to a prefix sibling of the root', async () => {
    const error = refusalOf(
      await resolveRealPathWithinProject(
        root,
        '/work/app/src/leak.ts',
        tableRealpath({ '/work/app/src/leak.ts': '/work/app-evil/secret.ts' }),
      ),
    );
    expect(error.code).toBe('FS_UNSAFE_PATH');
    expectPrivate(error, ['app-evil', root]);
  });

  it('refuses a candidate that is not inside the root as text, before resolving anything', async () => {
    const calls: string[] = [];
    for (const candidate of ['/work/app-evil/secret.ts', '/etc/passwd', '/work', 'work/app/a.ts']) {
      const error = refusalOf(
        await resolveRealPathWithinProject(root, candidate, tableRealpath({}, {}, calls)),
      );
      expect(error.code).toBe('PATH_OUTSIDE_PROJECT');
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
    expect(error.code).toBe('PATH_OUTSIDE_PROJECT');
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
    expect(missing.code).toBe('PROJECT_NOT_FOUND');
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
    expect(looped.code).toBe('FS_UNSAFE_PATH');
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
    expect(windows.code).toBe('FS_UNSAFE_PATH');
    expectPrivate(windows, ['elsewhere']);

    // A resolver that throws something other than an Error: typed as one only
    // so the lint rule against throwing non-errors does not refuse the test.
    const throwsNonError = refusalOf(
      await resolveRealPathWithinProject(root, '/work/app/src/a.ts', (): string => {
        throw hostile<Error>('not an error object');
      }),
    );
    expect(throwsNonError.code).toBe('FS_UNSAFE_PATH');

    const nonString = refusalOf(
      await resolveRealPathWithinProject(root, '/work/app/src/a.ts', () => hostile<string>(42)),
    );
    expect(nonString.code).toBe('FS_UNSAFE_PATH');
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
});

/* -------------------------------------------------------------------------------------------------
 * The handler, over a real project on disk
 * ---------------------------------------------------------------------------------------------- */

describe('createSourceOpenHandler', () => {
  let base = '';
  let project = '';
  let outside = '';
  let editor: SourceOpenPrincipal = { client: 'vscode' };

  /** Everything that must never surface in an error or a log record. */
  const forbidden = (): string[] => [base, outside, OUTSIDE_CONTENT_MARKER, CREDENTIAL_MARKER];

  /** Asserts that no captured log record carries a forbidden string. */
  const expectPrivateLogs = (entries: readonly LogEntry[]): void => {
    const serialised = JSON.stringify(entries);
    for (const value of forbidden()) {
      expect(serialised).not.toContain(value);
    }
  };

  beforeAll(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'debuggen-source-open-')));
    project = join(base, 'proj');
    outside = join(base, 'outside');
    const sibling = join(base, 'proj-evil');

    mkdirSync(join(project, 'src', 'folder'), { recursive: true });
    mkdirSync(outside, { recursive: true });
    mkdirSync(sibling, { recursive: true });

    writeFileSync(join(project, 'src', 'app.ts'), 'export const answer = 42;\n');
    const leaked = `export const leaked = '${OUTSIDE_CONTENT_MARKER}';\n`;
    writeFileSync(join(outside, 'secret.ts'), leaked);
    writeFileSync(join(sibling, 'secret.ts'), leaked);

    // Links planted inside the project: two that escape by file, one that
    // escapes by directory, one that stays inside, and one that dangles.
    symlinkSync(join(outside, 'secret.ts'), join(project, 'src', 'leak.ts'));
    symlinkSync(join(sibling, 'secret.ts'), join(project, 'src', 'sibling-leak.ts'));
    symlinkSync(outside, join(project, 'vendor'), 'dir');
    symlinkSync(join(project, 'src', 'app.ts'), join(project, 'src', 'alias.ts'));
    symlinkSync(join(outside, 'gone.ts'), join(project, 'src', 'dangling.ts'));

    editor = { client: 'vscode', projectRoots: [project], scope: CREDENTIAL_MARKER };
  });

  afterAll(() => {
    if (base !== '') {
      rmSync(base, { recursive: true, force: true });
    }
  });

  describe('forwarding', () => {
    it('sends exactly one source.open envelope to the editor, with the location unchanged', async () => {
      const h = harness({ session: sessionRecordFor(project) });
      const input: SourceOpenPayload = {
        sessionId: SESSION_ID,
        location: locationOf('src/app.ts'),
      };

      const outcome = valueOf(await h.handle(input, editor));

      expect(outcome).toEqual({
        delivered: true,
        clients: 1,
        location: input.location,
        file: 'src/app.ts',
      });
      expect(h.sent).toHaveLength(1);
      const [sent] = h.sent;
      if (sent === undefined) {
        throw new Error('expected one message');
      }
      expect(sent.sessionId).toBe(SESSION_ID);
      expect(sent.clientKind).toBe('vscode');
      const { message } = sent;
      if (message.type !== 'source.open') {
        throw new Error(`expected a source.open message, received ${message.type}`);
      }
      expect(message.sessionId).toBe(SESSION_ID);
      expect(message.ts).toBe(FIXED_NOW);
      expect(typeof message.id).toBe('string');
      expect(message.payload).toEqual(input);
      expect(JSON.stringify(message.payload.location)).toBe(JSON.stringify(input.location));
      expectPrivateLogs(h.entries);
    });

    it('accepts a parsed envelope and a raw JSON frame as well as a bare payload', async () => {
      const h = harness({ session: sessionRecordFor(project) });
      const payload: SourceOpenPayload = {
        sessionId: SESSION_ID,
        location: locationOf('src/app.ts'),
      };
      const envelope = createEnvelope('source.open', payload);

      expect(valueOf(await h.handle(envelope, editor)).delivered).toBe(true);
      expect(valueOf(await h.handle(encodeMessage(envelope), editor)).delivered).toBe(true);
      expect(h.sent).toHaveLength(2);
    });

    it('answers delivered: false when no editor client is connected', async () => {
      const h = harness({ session: sessionRecordFor(project), deliverTo: 0 });
      const location = locationOf('src/app.ts');

      const outcome = valueOf(await h.handle({ sessionId: SESSION_ID, location }, editor));

      expect(outcome).toEqual({ delivered: false, reason: 'no-editor-client', location });
      const entry = h.entries.find((candidate) => candidate.message.startsWith('No editor client'));
      expect(entry?.fields['delivered']).toBe(0);
    });

    it('reports how many editor clients received the frame', async () => {
      const h = harness({ session: sessionRecordFor(project), deliverTo: 3 });
      const outcome = valueOf(
        await h.handle({ sessionId: SESSION_ID, location: locationOf('src/app.ts') }, editor),
      );
      expect(outcome.delivered && outcome.clients).toBe(3);
    });

    it('works with asynchronous ports', async () => {
      const h = harness({ session: sessionRecordFor(project), asyncPorts: true });
      const outcome = valueOf(
        await h.handle({ sessionId: SESSION_ID, location: locationOf('src/app.ts') }, editor),
      );
      expect(outcome.delivered).toBe(true);
    });

    it('lets an editor whose workspace folder contains the project open its source', async () => {
      const h = harness({ session: sessionRecordFor(project) });
      const outcome = valueOf(
        await h.handle(
          { sessionId: SESSION_ID, location: locationOf('src/app.ts') },
          { client: 'vscode', projectRoots: [base] },
        ),
      );
      expect(outcome.delivered).toBe(true);
    });

    it('opens a file reached through a link that stays inside the project, forwarding the location as sent', async () => {
      const h = harness({ session: sessionRecordFor(project) });
      const location = locationOf('src/alias.ts');

      const outcome = valueOf(await h.handle({ sessionId: SESSION_ID, location }, editor));

      expect(outcome).toEqual({ delivered: true, clients: 1, location, file: 'src/app.ts' });
      const message = h.sent[0]?.message;
      expect(message?.type === 'source.open' && message.payload.location.file).toBe('src/alias.ts');
    });
  });

  describe('containment through the handler', () => {
    it.each([
      [
        'a link to a file outside the project',
        'src/leak.ts',
        'FS_UNSAFE_PATH',
        'unsafe-path',
        'symlink-escapes-project-root',
      ],
      [
        'a link to a file in a prefix-sibling directory',
        'src/sibling-leak.ts',
        'FS_UNSAFE_PATH',
        'unsafe-path',
        'symlink-escapes-project-root',
      ],
      [
        'a file under a directory link that leads outside',
        'vendor/secret.ts',
        'FS_UNSAFE_PATH',
        'unsafe-path',
        'symlink-escapes-project-root',
      ],
      ['a dangling link', 'src/dangling.ts', 'PROJECT_NOT_FOUND', 'file-missing', 'not-found'],
      [
        'a file that does not exist',
        'src/missing.ts',
        'PROJECT_NOT_FOUND',
        'file-missing',
        'not-found',
      ],
      ['a directory', 'src/folder', 'PROJECT_NOT_FOUND', 'file-missing', 'not-a-file'],
      ['the project root itself', '.', 'PROJECT_NOT_FOUND', 'file-missing', 'not-a-file'],
    ])(
      'refuses %s, sends nothing and leaks nothing',
      async (_label, file, code, rejection, reason) => {
        const h = harness({ session: sessionRecordFor(project) });

        const error = refusalOf(
          await h.handle({ sessionId: SESSION_ID, location: locationOf(file) }, editor),
        );

        expect(error.code).toBe(code);
        expect(sourceOpenRejectionOf(error)).toBe(rejection);
        expect(error.details?.['reason']).toBe(reason);
        expect(h.sent).toEqual([]);
        expectPrivate(error, forbidden());
        expectPrivateLogs(h.entries);
      },
    );

    it('refuses traversal, absolute, Windows and prefix-sibling paths before anything else', async () => {
      const files = [
        '../outside/secret.ts',
        'src/../../outside/secret.ts',
        join(outside, 'secret.ts'),
        'C:\\Windows\\win.ini',
        'C:/Windows/win.ini',
        '\\\\server\\share\\secret.ts',
        '../proj-evil/secret.ts',
      ];
      for (const file of files) {
        const h = harness({ session: sessionRecordFor(project) });

        const error = refusalOf(
          await h.handle({ sessionId: SESSION_ID, location: locationOf(file) }, editor),
        );

        expect(error.code).toBe('PROTOCOL_INVALID_MESSAGE');
        expect(sourceOpenRejectionOf(error)).toBe('invalid-payload');
        expect(h.sent).toEqual([]);
        expect(h.lookups).toEqual([]);
        expectPrivate(error, [...forbidden(), file]);
        expectPrivateLogs(h.entries);
      }
    });

    it('still refuses an escaping link when shape validation passes, with the warning logged', async () => {
      const h = harness({ session: sessionRecordFor(project) });

      refusalOf(
        await h.handle({ sessionId: SESSION_ID, location: locationOf('src/leak.ts') }, editor),
      );

      const warning = h.entries.find((entry) => entry.level === 'warn');
      expect(warning?.fields['rejection']).toBe('unsafe-path');
      expect(warning?.fields['subsystem']).toBe('source');
      expect(warning?.fields['file']).toBe('src/leak.ts');
      expectPrivateLogs(h.entries);
    });

    it('refuses a link at the final component even when the canonicaliser misses it', async () => {
      // An identity resolver "resolves" nothing, so the link survives to the
      // non-following lstat, which must refuse it.
      const h = harness({ session: sessionRecordFor(project), realpath: tableRealpath({}) });

      const error = refusalOf(
        await h.handle({ sessionId: SESSION_ID, location: locationOf('src/leak.ts') }, editor),
      );

      expect(error.code).toBe('FS_UNSAFE_PATH');
      expect(error.details?.['reason']).toBe('changed-after-resolution');
      expect(h.sent).toEqual([]);
      expectPrivate(error, forbidden());
    });

    it('checks existence only when asked to, and never skips containment', async () => {
      const virtualRoot = '/virtual/app';
      const session = sessionRecordFor(virtualRoot);
      const principal: SourceOpenPrincipal = { client: 'vscode', projectRoots: [virtualRoot] };
      const location = locationOf('src/a.ts');

      const unchecked = harness({ session, realpath: tableRealpath({}), verifyExists: false });
      expect(
        valueOf(await unchecked.handle({ sessionId: SESSION_ID, location }, principal)),
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
      expect(refused.code).toBe('FS_UNSAFE_PATH');
      expect(escaping.sent).toEqual([]);
    });
  });

  describe('frame validation', () => {
    it('refuses malformed input before looking anything up, and never echoes it', async () => {
      const marker = 'MARKER-9f2c';
      const contradicting = {
        ...createEnvelope('source.open', {
          sessionId: SESSION_ID,
          location: locationOf('src/app.ts'),
        }),
        sessionId: 'ses_someone_else',
      };
      const inputs: unknown[] = [
        undefined,
        null,
        42,
        '{not json',
        `{"type":"source.open","payload":"${marker}"}`,
        { sessionId: SESSION_ID },
        { sessionId: SESSION_ID, location: locationOf('src/app.ts'), extra: marker },
        { sessionId: '', location: locationOf('src/app.ts') },
        { sessionId: SESSION_ID, location: { ...locationOf(`../../${marker}/x.ts`), line: 0 } },
        { sessionId: SESSION_ID, location: locationOf('src/app.ts', { confidence: 7 }) },
        { sessionId: SESSION_ID, location: locationOf('src/app.ts', { endLine: 3 }) },
        createEnvelope('error', { code: 'INTERNAL', message: 'not a source.open' }),
        contradicting,
      ];

      for (const input of inputs) {
        const h = harness({ session: sessionRecordFor(project) });

        const error = refusalOf(await h.handle(input, editor));

        expect(error.code).toBe('PROTOCOL_INVALID_MESSAGE');
        expect(sourceOpenRejectionOf(error)).toBe('invalid-payload');
        expect(h.lookups).toEqual([]);
        expect(h.sent).toEqual([]);
        expectPrivate(error, [...forbidden(), marker]);
      }
    });
  });

  describe('session lookup', () => {
    const location = locationOf('src/app.ts');

    it('refuses a session that does not exist', async () => {
      const h = harness({ session: undefined });

      const error = refusalOf(await h.handle({ sessionId: SESSION_ID, location }, editor));

      expect(error.code).toBe('SESSION_NOT_FOUND');
      expect(sourceOpenRejectionOf(error)).toBe('session-not-found');
      expect(h.sent).toEqual([]);
    });

    it('reports a store failure — returned, thrown or rejected — as an operational error', async () => {
      const storeError = new DebuggenError('STORE_ERROR', `corrupt row under ${base}`);
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

        expect(error.code).toBe('STORE_ERROR');
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

      expect(error.code).toBe('STORE_ERROR');
      expect(h.sent).toEqual([]);
    });
  });

  describe('authorization', () => {
    const location = locationOf('src/app.ts');

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

      expect(error.code).toBe('UNAUTHORIZED');
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
        ['proj'],
        ['C:\\work\\proj'],
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

        expect(error.code).toBe('UNAUTHORIZED');
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

        expect(error.code).toBe('TAB_NOT_BOUND');
        expect(sourceOpenRejectionOf(error)).toBe('not-authorized');
        expect(error.details?.['reason']).toBe('session-not-bound');
        expect(h.sent).toEqual([]);
      }

      const unbound = harness({ session: sessionRecordFor(project) });
      const error = refusalOf(
        await unbound.handle({ sessionId: SESSION_ID, location }, { client: 'devtools', tabId: 7 }),
      );
      expect(error.code).toBe('TAB_NOT_BOUND');
    });

    it('treats the bindings table as authoritative when the store offers it', async () => {
      const session = sessionRecordFor(project, 7);
      const binding: SourceOpenBinding = { tab: { tabId: 9 } };

      const stale = harness({ session, binding, useBindingPort: true });
      expect(
        refusalOf(
          await stale.handle({ sessionId: SESSION_ID, location }, { client: 'devtools', tabId: 7 }),
        ).code,
      ).toBe('TAB_NOT_BOUND');

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
      ).toBe('TAB_NOT_BOUND');
    });

    it('reports a bindings-table failure as a store error', async () => {
      const handler = createSourceOpenHandler({
        sessions: {
          get: () => ok(sessionRecordFor(project, 7)),
          getBindingBySession: () => err(new DebuggenError('STORE_ERROR', 'corrupt binding')),
        },
        clients: { sendToSessionClients: () => 1 },
      });

      const error = refusalOf(
        await handler.handle({ sessionId: SESSION_ID, location }, { client: 'devtools', tabId: 7 }),
      );

      expect(error.code).toBe('STORE_ERROR');
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
  });

  describe('delivery', () => {
    const location = locationOf('src/app.ts');

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

        expect(error.code).toBe('TRANSPORT_DISCONNECTED');
        expect(sourceOpenRejectionOf(error)).toBeUndefined();
      }
    });

    it('refuses to trust an invalid delivery count', async () => {
      for (const count of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, hostile<number>('1')]) {
        const h = harness({ session: sessionRecordFor(project), send: () => count });

        const error = refusalOf(await h.handle({ sessionId: SESSION_ID, location }, editor));

        expect(error.code).toBe('INTERNAL');
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

      expect(error.code).toBe('INTERNAL');
      expect(sent).toEqual([]);
    });
  });

  describe('logging', () => {
    const location = locationOf('src/app.ts');

    it('records a forward at debug with the standard bindings and project-relative fields only', async () => {
      const h = harness({ session: sessionRecordFor(project) });

      valueOf(await h.handle({ sessionId: SESSION_ID, location }, editor));

      const entry = h.entries.find((candidate) => candidate.message.startsWith('Forwarded'));
      expect(entry?.level).toBe('debug');
      expect(entry?.fields).toMatchObject({
        subsystem: 'source',
        sessionId: SESSION_ID,
        client: 'vscode',
        file: 'src/app.ts',
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

        const refused = harness({ session: sessionRecordFor(project), logger });
        expect(
          refusalOf(
            await refused.handle(
              { sessionId: SESSION_ID, location: locationOf('src/leak.ts') },
              editor,
            ),
          ).code,
        ).toBe('FS_UNSAFE_PATH');
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
        { sessionId: SESSION_ID, location: locationOf('src/app.ts') },
      ];
      for (const input of inputs) {
        const result = await handler.handle(input, hostile<SourceOpenPrincipal>(undefined));
        expect(result.ok).toBe(false);
      }
    });

    it('uses the real filesystem by default', async () => {
      const handler = createSourceOpenHandler({
        sessions: { get: () => ok(sessionRecordFor(project)) },
        clients: { sendToSessionClients: () => 1 },
      });

      expect(
        valueOf(
          await handler.handle(
            { sessionId: SESSION_ID, location: locationOf('src/app.ts') },
            editor,
          ),
        ).delivered,
      ).toBe(true);
      expect(
        refusalOf(
          await handler.handle(
            { sessionId: SESSION_ID, location: locationOf('src/leak.ts') },
            editor,
          ),
        ).code,
      ).toBe('FS_UNSAFE_PATH');
    });
  });
});
