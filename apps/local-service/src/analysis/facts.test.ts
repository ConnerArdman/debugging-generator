/**
 * Suggested-location verification of `./facts.ts` against a real filesystem.
 *
 * A model-authored `likelyCauses[i].suggestedLocation.file` is untrusted text
 * that later becomes a click-to-source target, so it must name a regular file
 * inside the session project once every symbolic link is resolved — not only
 * as text. Each case builds one `mkdtemp` sandbox holding a project and a
 * sibling directory outside it, plants links between the two, and runs the
 * real `collectFactVerificationReport` and `createAnalysisFacts` over an
 * in-memory evidence port whose one event every finding cites, so the
 * location check is the only one that can fail.
 *
 * Sandbox layout (`<sandbox>` is canonical):
 *
 * ```text
 * <sandbox>/outside/secret.txt           a file outside the project
 * <sandbox>/project/src/app.ts           a regular project file
 * <sandbox>/project/src/dir/             a project directory
 * <sandbox>/project/src/alias.ts   → app.ts             in-project link to a project file
 * <sandbox>/project/src/link       → ../../outside      directory link leaving the project
 * <sandbox>/project/src/escape.ts  → ../../outside/secret.txt   final-component link leaving it
 * <sandbox>/project-link           → project            the project root reached through a link
 * ```
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AnalysisFindings } from '@debuggen/protocol';
import { DebuggenError, err, ok } from '@debuggen/shared';
import type { LogFields, Logger, LogLevel, Result } from '@debuggen/shared';

import { collectFactVerificationReport, createAnalysisFacts } from './facts.js';
import type {
  AnalysisStorePort,
  EvidenceLookupPort,
  FactVerificationContext,
  FactVerificationReport,
  LocationFilePort,
} from './facts.js';

const SESSION_ID = 'ses_4k2p9dq7m1zx0c3v';
const CAPTURE_ID = 'cap_8d1r6t0w2y4u9i3o';
const EVENT_ID = 'evt_5n7b3v1c9x0z2l4k';

/** The one issue a refused suggested location produces. */
const OUTSIDE_PROJECT_ISSUE = 'likelyCauses[0].suggestedLocation.file location-outside-project';

/** Every path the cases build on; set by `beforeEach`. */
interface Sandbox {
  readonly root: string;
  readonly project: string;
  readonly projectLink: string;
  readonly outside: string;
}

let sandbox: Sandbox | undefined;

beforeEach(() => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'debuggen-facts-')));
  const project = join(root, 'project');
  const outside = join(root, 'outside');
  const projectLink = join(root, 'project-link');
  mkdirSync(join(project, 'src', 'dir'), { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(project, 'src', 'app.ts'), 'export const app = 1;\n');
  writeFileSync(join(outside, 'secret.txt'), 'outside the project\n');
  symlinkSync('app.ts', join(project, 'src', 'alias.ts'));
  symlinkSync(join('..', '..', 'outside'), join(project, 'src', 'link'), 'dir');
  symlinkSync(join('..', '..', 'outside', 'secret.txt'), join(project, 'src', 'escape.ts'));
  symlinkSync('project', projectLink, 'dir');
  sandbox = { root, project, projectLink, outside };
});

afterEach(() => {
  if (sandbox !== undefined) {
    rmSync(sandbox.root, { recursive: true, force: true });
    sandbox = undefined;
  }
});

/** The current case's sandbox, failing the case when `beforeEach` did not build one. */
function paths(): Sandbox {
  if (sandbox === undefined) {
    throw new Error('the sandbox was not created');
  }
  return sandbox;
}

/** The verification context of `projectRoot`. */
function contextFor(projectRoot: string): FactVerificationContext {
  return { sessionId: SESSION_ID, captureId: CAPTURE_ID, projectRoot };
}

/** An evidence port holding {@link EVENT_ID} in {@link CAPTURE_ID}, and nothing else. */
function evidencePort(): EvidenceLookupPort {
  const known = (sessionId: string, ids: readonly string[], captureId?: string): Set<string> =>
    new Set(
      sessionId === SESSION_ID && (captureId === undefined || captureId === CAPTURE_ID)
        ? ids.filter((id) => id === EVENT_ID)
        : [],
    );
  return {
    existingEventIds: (sessionId, ids, captureId) => ok(known(sessionId, ids, captureId)),
    existingTraceIds: () => ok(new Set<string>()),
    getBySpanId: () => ok(undefined),
    listByTrace: () => ok({ rows: [] }),
  };
}

/** Findings with one evidenced fact and one likely cause suggesting `file`. */
function suggesting(file: string): AnalysisFindings {
  return {
    observed: [{ statement: 'One request took 300 ms.', evidence: [{ eventId: EVENT_ID }] }],
    likelyCauses: [
      {
        statement: 'The handler waits on a sequential query.',
        evidence: [{ eventId: EVENT_ID }],
        confidence: 'medium',
        suggestedLocation: {
          file,
          line: 3,
          column: 1,
          resolvedBy: 'code-graph',
          confidence: 0.8,
        },
      },
    ],
  };
}

/** The report of `findings`; a lookup failure fails the case. */
function reportOf(
  findings: AnalysisFindings,
  projectRoot: string,
  files?: LocationFilePort,
): FactVerificationReport {
  const report = collectFactVerificationReport(
    findings,
    contextFor(projectRoot),
    evidencePort(),
    files,
  );
  if (!report.ok) {
    throw report.error;
  }
  return report.value;
}

/** Each issue as `path code`, in report order. */
function issuesOf(report: FactVerificationReport): string[] {
  return report.issues.map((issue) => `${issue.path} ${issue.code}`);
}

/** One call a {@link recordingLogger} received. */
interface LogRecord {
  readonly level: LogLevel;
  readonly message: string;
  readonly fields: LogFields | undefined;
  readonly bindings: LogFields;
}

/** A logger that records every call, at every level, with its child bindings. */
function recordingLogger(records: LogRecord[], bindings: LogFields = {}): Logger {
  const at =
    (level: LogLevel) =>
    (message: string, fields?: LogFields): void => {
      records.push({ level, message, fields, bindings });
    };
  return {
    level: 'trace',
    trace: at('trace'),
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
    fatal: at('fatal'),
    child: (extra) => recordingLogger(records, { ...bindings, ...extra }),
  };
}

/** An analysis store that records every call and refuses it: a rejected analysis must not reach it. */
function refusingStore(): { readonly store: AnalysisStorePort; readonly calls: string[] } {
  const calls: string[] = [];
  const refuse = (operation: string): Result<never, DebuggenError> => {
    calls.push(operation);
    return err(new DebuggenError('STORE_ERROR', `${operation} was called for rejected findings.`));
  };
  return {
    calls,
    store: {
      insertAnalysis: () => refuse('insertAnalysis'),
      getLatestAnalysis: () => refuse('getLatestAnalysis'),
      nextAnalysisVersion: () => refuse('nextAnalysisVersion'),
      listAnalyses: () => refuse('listAnalyses'),
    },
  };
}

/**
 * A {@link LocationFilePort} over a fixed table: `links` maps an absolute path
 * to what it resolves to, `files` lists the regular files, and every path is
 * recorded in `calls` in the order the port was asked.
 */
function tablePort(
  links: Readonly<Record<string, string>>,
  files: readonly string[],
  calls: string[] = [],
): LocationFilePort {
  return {
    realpath: (absolutePath) => {
      calls.push(`realpath ${absolutePath}`);
      return links[absolutePath] ?? absolutePath;
    },
    isRegularFile: (absolutePath) => {
      calls.push(`isRegularFile ${absolutePath}`);
      return files.includes(absolutePath);
    },
  };
}

describe('suggested locations are verified on the filesystem', () => {
  it('accepts a regular file inside the project', () => {
    const report = reportOf(suggesting('src/app.ts'), paths().project);

    expect(report.valid).toBe(true);
    expect(report.issues).toEqual([]);
    expect(report.checkedLocations).toBe(1);
  });

  it('refuses a path through an in-project directory link that leaves the project', () => {
    const report = reportOf(suggesting('src/link/secret.txt'), paths().project);

    expect(report.valid).toBe(false);
    expect(issuesOf(report)).toEqual([OUTSIDE_PROJECT_ISSUE]);
  });

  it('refuses a final-component link to a file outside the project', () => {
    const report = reportOf(suggesting('src/escape.ts'), paths().project);

    expect(issuesOf(report)).toEqual([OUTSIDE_PROJECT_ISSUE]);
  });

  it('accepts an in-project link to an in-project file', () => {
    const report = reportOf(suggesting('src/alias.ts'), paths().project);

    expect(report.valid).toBe(true);
    expect(report.issues).toEqual([]);
  });

  it('accepts a project file when the project root itself is reached through a link', () => {
    const report = reportOf(suggesting('src/app.ts'), paths().projectLink);

    expect(report.valid).toBe(true);
  });

  it.each([
    ['a missing file', 'src/missing.ts'],
    ['a file under a missing directory', 'src/absent/app.ts'],
    ['a directory', 'src/dir'],
    ['a directory link that leaves the project', 'src/link'],
  ])('refuses %s', (_label, file) => {
    const report = reportOf(suggesting(file), paths().project);

    expect(issuesOf(report)).toEqual([OUTSIDE_PROJECT_ISSUE]);
  });

  it('checks every likely cause and reports each refused location at its own path', () => {
    const findings = suggesting('src/app.ts');
    const first = findings.likelyCauses[0];
    if (first?.suggestedLocation === undefined) {
      throw new Error('the fixture has no suggested location');
    }
    const report = reportOf(
      {
        ...findings,
        likelyCauses: [
          first,
          { ...first, suggestedLocation: { ...first.suggestedLocation, file: 'src/escape.ts' } },
        ],
      },
      paths().project,
    );

    expect(report.checkedLocations).toBe(2);
    expect(issuesOf(report)).toEqual([
      'likelyCauses[1].suggestedLocation.file location-outside-project',
    ]);
  });
});

describe('the injected filesystem port', () => {
  const root = '/virtual/app';

  it('is what decides, and is asked only with absolute paths', () => {
    const calls: string[] = [];
    const port = tablePort({}, [`${root}/src/a.ts`], calls);

    const report = reportOf(suggesting('src/a.ts'), root, port);

    expect(report.valid).toBe(true);
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.split(' ')[1]?.startsWith('/')).toBe(true);
    }
    expect(calls.at(-1)).toBe(`isRegularFile ${root}/src/a.ts`);
  });

  it('refuses a location whose directory the port resolves outside the root', () => {
    const port = tablePort({ [`${root}/src/link`]: '/etc' }, ['/etc/passwd']);

    expect(issuesOf(reportOf(suggesting('src/link/passwd'), root, port))).toEqual([
      OUTSIDE_PROJECT_ISSUE,
    ]);
  });

  it('refuses a location whose final component the port resolves outside the root', () => {
    const port = tablePort({ [`${root}/src/a.ts`]: '/etc/passwd' }, ['/etc/passwd']);

    expect(issuesOf(reportOf(suggesting('src/a.ts'), root, port))).toEqual([OUTSIDE_PROJECT_ISSUE]);
  });

  it('refuses a location the port says is not a regular file', () => {
    expect(issuesOf(reportOf(suggesting('src/a.ts'), root, tablePort({}, [])))).toEqual([
      OUTSIDE_PROJECT_ISSUE,
    ]);
  });

  it('refuses, without throwing, when the port throws or answers with the wrong type', () => {
    const throwing: LocationFilePort = {
      realpath: () => {
        throw new Error('EACCES: permission denied, realpath /virtual/app/src');
      },
      isRegularFile: () => true,
    };
    const throwingFileCheck: LocationFilePort = {
      realpath: (absolutePath) => absolutePath,
      isRegularFile: () => {
        throw new Error('EIO: i/o error, lstat /virtual/app/src/a.ts');
      },
    };
    const illTyped = {
      realpath: (absolutePath: string): unknown =>
        absolutePath.endsWith('a.ts') ? 42 : absolutePath,
      isRegularFile: (): unknown => 'yes',
    } as unknown as LocationFilePort;
    const truthyNotTrue = {
      realpath: (absolutePath: string): string => absolutePath,
      isRegularFile: (): unknown => 1,
    } as unknown as LocationFilePort;

    for (const port of [throwing, throwingFileCheck, illTyped, truthyNotTrue]) {
      expect(issuesOf(reportOf(suggesting('src/a.ts'), root, port))).toEqual([
        OUTSIDE_PROJECT_ISSUE,
      ]);
    }
  });

  it('is never consulted for a location the lexical gate already refused', () => {
    const calls: string[] = [];
    const port = tablePort({}, [], calls);

    const report = reportOf(suggesting('src/a.ts'), 'relative/root', port);

    expect(issuesOf(report)).toEqual([OUTSIDE_PROJECT_ISSUE]);
    expect(calls).toEqual([]);
  });
});

describe('createAnalysisFacts: a refused location rejects the analysis without disclosing a path', () => {
  it('verifies through the injected port and through node:fs when none is given', async () => {
    const { store } = refusingStore();
    const injected = createAnalysisFacts({
      evidence: evidencePort(),
      store,
      files: tablePort({}, ['/virtual/app/src/a.ts']),
    });
    const defaulted = createAnalysisFacts({ evidence: evidencePort(), store });

    const viaPort = await injected.verifyFindings(
      suggesting('src/a.ts'),
      contextFor('/virtual/app'),
    );
    const viaDisk = await defaulted.verifyFindings(
      suggesting('src/app.ts'),
      contextFor(paths().project),
    );
    const escapedOnDisk = await defaulted.verifyFindings(
      suggesting('src/link/secret.txt'),
      contextFor(paths().project),
    );

    expect(viaPort.ok).toBe(true);
    expect(viaDisk.ok).toBe(true);
    expect(escapedOnDisk.ok).toBe(false);
  });

  it.each([
    ['node:fs', undefined],
    ['a port whose failure names a path and an errno', 'throwing'],
  ] as const)(
    'rejects with JSON paths and codes only, logs no path, and stores nothing (%s)',
    async (_label, portKind) => {
      const records: LogRecord[] = [];
      const { store, calls } = refusingStore();
      const throwing: LocationFilePort = {
        realpath: (absolutePath) => {
          throw new Error(`ENOENT: no such file or directory, realpath '${absolutePath}'`);
        },
        isRegularFile: () => false,
      };
      const facts = createAnalysisFacts({
        evidence: evidencePort(),
        store,
        logger: recordingLogger(records),
        ...(portKind === 'throwing' ? { files: throwing } : {}),
      });

      const accepted = await facts.acceptFindings(suggesting('src/link/secret.txt'), {
        ...contextFor(paths().project),
        metrics: [],
      });

      expect(accepted.ok).toBe(false);
      const error = accepted.ok ? undefined : accepted.error;
      expect(error?.code).toBe('MODEL_OUTPUT_INVALID');
      expect(error?.details?.['issueCodes']).toEqual(['location-outside-project']);
      expect(error?.details?.['paths']).toEqual(['likelyCauses[0].suggestedLocation.file']);
      expect(error?.cause).toBeUndefined();
      expect(calls).toEqual([]);

      const disclosed = [
        error?.message ?? '',
        error?.hint ?? '',
        JSON.stringify(error?.details),
        ...records.map((record) => JSON.stringify(record)),
      ];
      expect(records.some((record) => record.level === 'warn')).toBe(true);
      for (const text of disclosed) {
        expect(text).not.toContain(paths().root);
        expect(text).not.toContain('secret.txt');
        expect(text).not.toContain('src/link');
        expect(text).not.toMatch(/\bE(?:NOENT|NOTDIR|ACCES|PERM|LOOP|IO)\b/u);
      }
    },
  );
});
