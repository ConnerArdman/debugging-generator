/**
 * Suggested-location verification of `./facts.ts` against a real filesystem,
 * and the render fact candidates it offers for a context cascade.
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
 *
 * The last block covers the `repeated-query` fact candidate of
 * `buildFactCandidates` over a hand-built analysis input: the costlier
 * statement shape outranks a cheaper one that ran more often, its evidence names
 * the `db.query` kind, and its location is the call site its executions share,
 * else its costliest caller's, else its first located execution's. Fixture
 * vocabulary is invented and generic.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createDeterministicProvider,
  generateStructuredWithRepair,
} from '@debuggen/model-provider';
import type { JsonObject } from '@debuggen/model-provider';
import { analysisFindingsSchema } from '@debuggen/protocol';
import type { AnalysisFindings } from '@debuggen/protocol';
import { DebuggenError, err, ok } from '@debuggen/shared';
import type { LogFields, Logger, LogLevel, Result, SourceLocation } from '@debuggen/shared';
import { TELEMETRY_KINDS, TELEMETRY_TIERS, computeCaptureSummary } from '@debuggen/telemetry';
import type { RenderStat, RenderTrigger, TelemetryKind, TelemetryTier } from '@debuggen/telemetry';

import {
  FACT_CANDIDATE_LIMITS,
  buildFactCandidateReport,
  buildFactCandidates,
  collectFactVerificationReport,
  createAnalysisFacts,
} from './facts.js';
import type {
  AnalysisStorePort,
  EvidenceLookupPort,
  FactCandidate,
  FactVerificationContext,
  FactVerificationReport,
  LocationFilePort,
} from './facts.js';
import { toRenderRow } from './summarize.js';
import type {
  AnalysisQueryCallerRow,
  AnalysisQueryOccurrenceRow,
  AnalysisQueryRow,
  AnalysisRenderRow,
  AnalysisStageInput,
} from './summarize.js';

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

/* -------------------------------------------------------------------------------------------------
 * repeated-query candidates
 * ---------------------------------------------------------------------------------------------- */

/** A well-formed 32-hex trace identifier shared by every fixture execution. */
const QUERY_TRACE_ID = '0f1e2d3c4b5a69788796a5b4c3d2e1f0';

/** Two statement shapes: one cheap, one costly. */
const CHEAP_STATEMENT = 'INSERT INTO tally_log (bucket) VALUES ($1)';
const COSTLY_STATEMENT = 'SELECT id FROM tally_rows WHERE bucket = $1';

/** Where the fixture executions are issued from. */
const STORE_FILE = 'src/services/tally-store.ts';
const HELPER_FILE = 'src/services/tally-helper.ts';

/** A code-graph location in `file` at `line`. */
function queryLocation(file: string, line: number): SourceLocation {
  return { file, line, column: 3, resolvedBy: 'code-graph', confidence: 0.8 };
}

/** The `ordinal`-th execution of the `group`-th shape, with fixed product-shaped ids. */
function queryOccurrence(
  group: number,
  ordinal: number,
  durationMs: number,
  source?: SourceLocation,
): AnalysisQueryOccurrenceRow {
  const suffix = `${String(group)}${String(ordinal).padStart(2, '0')}`;
  return {
    eventId: `evt_query_${suffix}`,
    spanId: suffix.padStart(16, 'a'),
    traceId: QUERY_TRACE_ID,
    startTime: 1_000 + ordinal,
    durationMs,
    status: 'ok',
    ...(source === undefined ? {} : { source }),
  };
}

/** One query group of `executions` equal executions summing to `totalMs`. */
function queryRow(
  group: number,
  statement: string,
  executions: number,
  totalMs: number,
  options: {
    readonly sources?: readonly (SourceLocation | undefined)[];
    readonly callers?: readonly AnalysisQueryCallerRow[];
  } = {},
): AnalysisQueryRow {
  const each = totalMs / executions;
  const occurrences = Array.from({ length: executions }, (_, ordinal) =>
    queryOccurrence(group, ordinal, each, options.sources?.[ordinal]),
  );
  return {
    id: `qry:g:${String(group)}`,
    statement,
    executionCount: executions,
    totalDurationMs: totalMs,
    averageDurationMs: each,
    minDurationMs: each,
    maxDurationMs: each,
    firstStartTime: 1_000,
    lastStartTime: 1_000 + executions - 1,
    errorCount: 0,
    callers: options.callers ?? [],
    occurrences,
    occurrencesTruncated: false,
  };
}

/** An analysis input carrying only `queries`, for a capture of 2000 ms. */
function queryInput(queries: readonly AnalysisQueryRow[]): AnalysisStageInput {
  const summary = computeCaptureSummary([], { captureId: CAPTURE_ID, sessionId: SESSION_ID });
  return {
    sessionId: SESSION_ID,
    captureId: CAPTURE_ID,
    question: 'Why is this slow?',
    capture: {
      captureId: CAPTURE_ID,
      planVersion: 1,
      startedAt: 1_000,
      startTime: 1_000,
      endTime: 3_000,
      durationMs: 2_000,
      eventCount: queries.reduce((total, row) => total + row.executionCount, 0),
      eventsConsidered: queries.reduce((total, row) => total + row.executionCount, 0),
      eventsExcluded: 0,
      eventsTruncated: false,
      traceCount: 1,
      primaryTraceId: QUERY_TRACE_ID,
      producerCount: 1,
      tierCounts: summary.tierCounts,
      kindCounts: summary.kindCounts,
      unavailableMetrics: [],
    },
    metrics: [],
    traces: [],
    topSpans: [],
    renders: [],
    requests: [],
    queries,
    stateTransitions: [],
    errors: [],
    relevantFiles: [],
    excerpts: [],
    factCandidates: [],
    truncated: { sections: [] },
  };
}

/** The `repeated-query` candidates of `queries`, in rank order. */
function repeatedQueryCandidates(
  queries: readonly AnalysisQueryRow[],
  maxPerKind?: number,
): readonly FactCandidate[] {
  const summary = computeCaptureSummary([], { captureId: CAPTURE_ID, sessionId: SESSION_ID });
  const candidates = buildFactCandidates(
    { input: queryInput(queries), summary },
    maxPerKind === undefined ? undefined : { limits: { maxPerKind } },
  );
  return candidates.filter((candidate) => candidate.kind === 'repeated-query');
}

describe('repeated-query candidates rank by cost and point where the statements are issued', () => {
  it('ranks a costly shape above a cheap one that ran more often, even under a cap of one', () => {
    const cheap = queryRow(1, CHEAP_STATEMENT, 12, 9);
    const costly = queryRow(2, COSTLY_STATEMENT, 10, 550);

    const ranked = repeatedQueryCandidates([cheap, costly]);
    expect(ranked).toHaveLength(2);
    expect(ranked[0]?.statement).toContain('550 ms in total');
    expect(ranked[1]?.statement).toContain('9 ms in total');

    const capped = repeatedQueryCandidates([cheap, costly], 1);
    expect(capped).toHaveLength(1);
    expect(capped[0]?.statement).toContain('550 ms in total');
  });

  it('breaks an equal-cost tie by executions', () => {
    const fewer = queryRow(1, CHEAP_STATEMENT, 3, 120);
    const more = queryRow(2, COSTLY_STATEMENT, 6, 120);

    const ranked = repeatedQueryCandidates([fewer, more]);
    expect(ranked[0]?.statement).toContain('ran 6 times');
    expect(ranked[1]?.statement).toContain('ran 3 times');
  });

  it('cites every execution as a db.query event with a duration label', () => {
    const [candidate] = repeatedQueryCandidates([queryRow(2, COSTLY_STATEMENT, 4, 200)]);

    expect(candidate?.evidence.length).toBeGreaterThan(0);
    for (const reference of candidate?.evidence ?? []) {
      expect(reference.kind).toBe('db.query');
      expect(reference.label).toBe('statement (50 ms)');
      expect(reference.traceId).toBe(QUERY_TRACE_ID);
    }
  });

  it('locates the shape at the call site every located execution shares', () => {
    const shared = queryLocation(STORE_FILE, 42);
    const row = queryRow(2, COSTLY_STATEMENT, 3, 150, {
      sources: [shared, undefined, shared],
      callers: [
        {
          name: 'loadTallyRows',
          executionCount: 3,
          totalDurationMs: 150,
          source: queryLocation(HELPER_FILE, 7),
        },
      ],
    });

    const [candidate] = repeatedQueryCandidates([row]);
    expect(candidate?.suggestedLocation).toEqual(shared);
  });

  it('falls back to the costliest caller when the executions disagree', () => {
    const row = queryRow(2, COSTLY_STATEMENT, 2, 150, {
      sources: [queryLocation(STORE_FILE, 42), queryLocation(STORE_FILE, 60)],
      callers: [
        {
          name: 'aCheapCaller',
          executionCount: 1,
          totalDurationMs: 20,
          source: queryLocation(HELPER_FILE, 7),
        },
        {
          name: 'theCostlyCaller',
          executionCount: 1,
          totalDurationMs: 130,
          source: queryLocation(HELPER_FILE, 19),
        },
      ],
    });

    const [candidate] = repeatedQueryCandidates([row]);
    expect(candidate?.suggestedLocation).toEqual(queryLocation(HELPER_FILE, 19));
    expect(candidate?.statement).toContain('from 2 callers');
  });

  it('falls back to the first located execution when they disagree and no caller is located', () => {
    const row = queryRow(2, COSTLY_STATEMENT, 3, 150, {
      sources: [undefined, queryLocation(STORE_FILE, 60), queryLocation(STORE_FILE, 42)],
      callers: [{ name: 'loadTallyRows', executionCount: 3, totalDurationMs: 150 }],
    });

    const [candidate] = repeatedQueryCandidates([row]);
    expect(candidate?.suggestedLocation).toEqual(queryLocation(STORE_FILE, 60));
    expect(candidate?.statement).toContain('all from loadTallyRows');
  });

  it('builds byte-identical candidates on every run', () => {
    const rows = [queryRow(1, CHEAP_STATEMENT, 12, 9), queryRow(2, COSTLY_STATEMENT, 12, 550)];

    expect(JSON.stringify(repeatedQueryCandidates(rows))).toBe(
      JSON.stringify(repeatedQueryCandidates(rows)),
    );
  });
});

/* -------------------------------------------------------------------------------------------------
 * Render fact candidates: a context cascade
 *
 * A capture where a memoised card consumes a context whose provider publishes
 * a fresh value on every render, beside a framework component that rendered
 * more often. Rows are built the way the service builds them — upstream
 * `RenderStat`s projected through `toRenderRow` — and every name is invented.
 * ---------------------------------------------------------------------------------------------- */

/** A trace id and a span id in their W3C formats, so references keep their coordinates. */
const RENDER_TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';
const RENDER_SPAN_ID = '00f067aa0ba902b7';

/** How one fixture render statistic is described. */
interface StatSpec {
  readonly component: string;
  readonly renderCount: number;
  readonly triggers: Readonly<Partial<Record<RenderTrigger, number>>>;
  readonly contexts?: readonly (readonly [string, number])[];
  readonly declared: boolean;
  /** The trigger of the carried occurrences, and the providers they name. */
  readonly occurrenceTrigger: RenderTrigger;
  readonly occurrenceContexts?: readonly string[];
  /** Event-id stem; three occurrences `‹stem›-1` … `‹stem›-3` are carried. */
  readonly stem: string;
}

/** A zero for every member of a vocabulary. */
function zeroCounts<K extends string>(keys: readonly K[]): Record<K, number> {
  const counts = {} as Record<K, number>;
  for (const key of keys) {
    counts[key] = 0;
  }
  return counts;
}

/** One upstream render statistic. */
function renderStat(spec: StatSpec): RenderStat {
  const triggers = { props: 0, state: 0, context: 0, unchanged: 0, unknown: 0, ...spec.triggers };
  const contexts = spec.contexts ?? [];
  return {
    id: `component:${spec.component}`,
    component: spec.component,
    renderCount: spec.renderCount,
    totalDurationMs: spec.renderCount * 0.5,
    averageDurationMs: 0.5,
    maxDurationMs: 3,
    firstStartTime: 1_700_000_000_000,
    lastStartTime: 1_700_000_030_000,
    triggers,
    unchangedRenderCount: triggers.unchanged,
    unknownTriggerCount: triggers.unknown,
    phaseCounts: { mount: 1, update: spec.renderCount - 1 },
    changedPropKeys: [],
    changedPropCounts: {},
    changedContexts: contexts.map(([name]) => name),
    changedContextCounts: Object.fromEntries(contexts),
    source: {
      file: `src/${spec.component.toLowerCase()}.tsx`,
      line: 7,
      column: 1,
      resolvedBy: spec.declared ? 'code-graph' : 'react-owner',
      confidence: 0.9,
    },
    declaredInProject: spec.declared,
    occurrences: [1, 2, 3].map((index) => ({
      id: `${spec.stem}-${String(index)}`,
      eventId: `${spec.stem}-${String(index)}`,
      spanId: RENDER_SPAN_ID,
      traceId: RENDER_TRACE_ID,
      startTime: 1_700_000_000_000 + index,
      durationMs: 0.5,
      phase: 'update' as const,
      trigger: spec.occurrenceTrigger,
      changedPropKeys: [],
      changedContexts: [...(spec.occurrenceContexts ?? [])],
    })),
    occurrencesTruncated: true,
  };
}

/** The consumer, its provider, and a framework row with more renders than either. */
const CASCADE_STATS: readonly StatSpec[] = [
  {
    component: 'zQ',
    renderCount: 12_000,
    triggers: { unchanged: 10_000, props: 2_000 },
    declared: false,
    occurrenceTrigger: 'unchanged',
    stem: 'ev-min',
  },
  {
    component: 'ItemTile',
    renderCount: 9_000,
    triggers: { context: 8_800, props: 200 },
    contexts: [['BasketProvider', 8_800]],
    declared: true,
    occurrenceTrigger: 'context',
    occurrenceContexts: ['BasketProvider'],
    stem: 'ev-tile',
  },
  {
    component: 'BasketProvider',
    renderCount: 186,
    triggers: { context: 184, state: 2 },
    contexts: [['TickerProvider', 184]],
    declared: true,
    occurrenceTrigger: 'context',
    occurrenceContexts: ['TickerProvider'],
    stem: 'ev-basket',
  },
];

/** The analysis input of a capture whose only material is `renders`. */
function renderStageInput(renders: readonly AnalysisRenderRow[]): AnalysisStageInput {
  return {
    sessionId: SESSION_ID,
    captureId: CAPTURE_ID,
    question: 'Why does the tile keep rendering?',
    capture: {
      captureId: CAPTURE_ID,
      planVersion: 1,
      startedAt: 1_700_000_000_000,
      startTime: 1_700_000_000_000,
      endTime: 1_700_000_030_000,
      durationMs: 30_000,
      eventCount: 21_186,
      eventsConsidered: 21_186,
      eventsExcluded: 0,
      eventsTruncated: false,
      traceCount: 1,
      producerCount: 1,
      tierCounts: zeroCounts<TelemetryTier>(TELEMETRY_TIERS),
      kindCounts: zeroCounts<TelemetryKind>(TELEMETRY_KINDS),
      unavailableMetrics: [],
    },
    metrics: [],
    traces: [],
    topSpans: [],
    renders,
    requests: [],
    queries: [],
    stateTransitions: [],
    errors: [],
    relevantFiles: [],
    excerpts: [],
    factCandidates: [],
    truncated: { sections: [] },
  };
}

/** The fact candidates of `stats`, projected as the service projects them. */
function renderCandidates(stats: readonly RenderStat[]): readonly FactCandidate[] {
  const input = renderStageInput(stats.map((stat) => toRenderRow(stat)));
  // A summary of another capture: only the input's own rows may be read.
  const summary = computeCaptureSummary([], { captureId: 'cap_other00000000001' });
  return buildFactCandidateReport({ input, summary }).candidates;
}

describe('render fact candidates prefer project components and name the changed context', () => {
  it('projects context attribution and ownership into the analysis row', () => {
    const row = toRenderRow(renderStat(CASCADE_STATS[1]!));

    expect(row.changedContexts).toEqual([{ name: 'BasketProvider', count: 8_800 }]);
    expect(row.declaredInProject).toBe(true);
    expect(row.occurrences.map((occurrence) => occurrence.changedContextNames)).toEqual([
      ['BasketProvider'],
      ['BasketProvider'],
      ['BasketProvider'],
    ]);
  });

  it('reads a statistic persisted before context attribution existed', () => {
    const current = renderStat(CASCADE_STATS[1]!);
    const added = new Set(['changedContexts', 'changedContextCounts', 'declaredInProject']);
    const withoutAdded = (record: object): Record<string, unknown> =>
      Object.fromEntries(Object.entries(record).filter(([key]) => !added.has(key)));
    const legacy = {
      ...withoutAdded(current),
      occurrences: current.occurrences.map(withoutAdded),
    } as unknown as RenderStat;
    const row = toRenderRow(legacy);

    expect(row.changedContexts).toEqual([]);
    expect(row.declaredInProject).toBe(false);
    expect(row.occurrences.every((occurrence) => occurrence.changedContextNames.length === 0)).toBe(
      true,
    );
  });

  it('names the providers of a dominant context trigger and cites the context renders', () => {
    const candidates = renderCandidates(CASCADE_STATS.map(renderStat));
    const tile = candidates.find(
      (candidate) =>
        candidate.kind === 'dominant-render-trigger' && candidate.statement.includes('ItemTile'),
    );

    expect(tile?.statement).toBe(
      '8800 of the 9000 renders of ItemTile were triggered by a changed consumed context value (provided by BasketProvider).',
    );
    expect(tile?.evidence.map((ref) => ref.eventId)).toEqual([
      'ev-tile-1',
      'ev-tile-2',
      'ev-tile-3',
    ]);
    // The strongest trigger candidate is the cascade's consumer.
    expect(
      candidates.find((candidate) => candidate.kind === 'dominant-render-trigger')?.statement,
    ).toBe(tile?.statement);
  });

  it('leaves framework components out while the capture marks project components', () => {
    const candidates = renderCandidates(CASCADE_STATS.map(renderStat));
    const renderKinds = new Set([
      'render-outlier',
      'unchanged-render-burst',
      'dominant-render-trigger',
      'unknown-render-trigger',
    ]);

    const render = candidates.filter((candidate) => renderKinds.has(candidate.kind));
    expect(render.length).toBeGreaterThan(0);
    for (const candidate of render) {
      expect(candidate.statement).not.toMatch(/\bzQ\b/u);
      expect(candidate.evidence.some((ref) => ref.eventId.startsWith('ev-min-'))).toBe(false);
    }
    expect(candidates.find((candidate) => candidate.kind === 'render-outlier')?.statement).toMatch(
      /^ItemTile rendered 9000 times/u,
    );
  });

  it('keeps every row when no row is marked as a project component', () => {
    const candidates = renderCandidates(
      CASCADE_STATS.map((spec) => renderStat({ ...spec, declared: false })),
    );

    expect(candidates.find((candidate) => candidate.kind === 'render-outlier')?.statement).toMatch(
      /^zQ rendered 12000 times/u,
    );
  });

  it('drops provider names rather than cutting the statement', () => {
    const longName = (stem: string): string => `${stem}${'Provider'.repeat(12)}`;
    const providers = [longName('Alpha'), longName('Beta'), longName('Gamma')];
    const stat = renderStat({
      component: `ItemTile${'Wrapper'.repeat(12)}`,
      renderCount: 90_000,
      triggers: { context: 88_000 },
      contexts: providers.map((name, index) => [name, 88_000 - index] as const),
      declared: true,
      occurrenceTrigger: 'context',
      occurrenceContexts: providers,
      stem: 'ev-long',
    });
    const report = buildFactCandidateReport({
      input: renderStageInput([toRenderRow(stat)]),
      summary: computeCaptureSummary([], { captureId: 'cap_other00000000001' }),
    });
    const trigger = report.candidates.find(
      (candidate) => candidate.kind === 'dominant-render-trigger',
    );

    expect(trigger?.statement.length).toBeLessThanOrEqual(FACT_CANDIDATE_LIMITS.maxStatementLength);
    expect(trigger?.statement.endsWith(').')).toBe(true);
    expect(trigger?.statement).toContain('(provided by Alpha');
    expect(report.statementsTrimmed).toBe(0);
  });

  it('lets the deterministic provider explain the cascade from these rows, within the analyze schema', async () => {
    const stats = [
      ...CASCADE_STATS,
      {
        component: 'TickerProvider',
        renderCount: 186,
        triggers: { state: 186 },
        declared: true,
        occurrenceTrigger: 'state',
        stem: 'ev-ticker',
      } satisfies StatSpec,
    ].map(renderStat);
    const input = renderStageInput(stats.map((stat) => toRenderRow(stat)));
    // The analyze request's structured context, as the context builder shapes
    // it: the stage input minus the prompt-only question and the excerpts,
    // serialised to plain JSON.
    const captureSummary = JSON.parse(
      JSON.stringify(
        Object.fromEntries(
          Object.entries(input).filter(([key]) => key !== 'question' && key !== 'excerpts'),
        ),
      ),
    ) as JsonObject;
    const created = createDeterministicProvider();
    if (!created.ok) {
      throw created.error;
    }

    const answered = await generateStructuredWithRepair(
      created.value,
      analysisFindingsSchema,
      {
        prompt: 'Answer with the structured reply the schema describes.',
        input: { captureSummary, codeExcerpts: [] },
        metadata: { stage: 'analyze', promptVersion: 'v001' },
      },
      { maxRepairs: 0 },
    );
    if (!answered.ok) {
      throw answered.error;
    }
    const { observed, likelyCauses } = answered.value.value;

    expect(answered.value.repairs).toBe(0);
    expect(observed.map((fact) => fact.statement)).toContain(
      '8800 of 9000 renders of ItemTile followed a change in the context provided by BasketProvider.',
    );
    expect(likelyCauses[0]?.statement).toContain(
      '8800 renders of ItemTile followed a new value from the context of BasketProvider, driven by state updates in TickerProvider',
    );
    expect(likelyCauses[0]?.suggestedLocation?.file).toBe('src/basketprovider.tsx');
    for (const finding of [...observed, ...likelyCauses]) {
      expect(finding.statement).not.toMatch(/\bzQ\b/u);
      for (const ref of finding.evidence) {
        expect(ref.eventId.startsWith('ev-min-')).toBe(false);
      }
    }
  });
});

/** One carried render of `stat`, with its own trigger. */
function occurrenceOf(
  stat: RenderStat,
  eventId: string,
  trigger: RenderTrigger,
  offset: number,
): RenderStat['occurrences'][number] {
  return {
    id: eventId,
    eventId,
    spanId: RENDER_SPAN_ID,
    traceId: RENDER_TRACE_ID,
    startTime: stat.firstStartTime + offset,
    durationMs: 0.5,
    phase: 'update',
    trigger,
    changedPropKeys: trigger === 'props' ? ['onSelect'] : [],
    changedContexts: [],
  };
}

/** A statistic whose carried renders have the given triggers, in order. */
function mixedStat(component: string, stem: string, carried: readonly RenderTrigger[]): RenderStat {
  const base = renderStat({
    component,
    renderCount: 830,
    triggers: { props: 500, unchanged: 300, unknown: 20, context: 10 },
    declared: true,
    occurrenceTrigger: 'props',
    stem,
  });
  return {
    ...base,
    occurrences: carried.map((trigger, index) =>
      occurrenceOf(base, `${stem}-${String(index)}`, trigger, index),
    ),
    occurrencesTruncated: true,
  };
}

describe('render fact candidates cite only renders of the trigger they count', () => {
  const MIXED: readonly RenderTrigger[] = [
    'props',
    'props',
    'props',
    'props',
    'props',
    'props',
    'props',
    'props',
    'unchanged',
    'unchanged',
    'unknown',
    'context',
  ];

  it('keeps one render of every carried trigger in the analysis row', () => {
    const row = toRenderRow(mixedStat('StatusPanel', 'ev-mixed', MIXED));

    expect(row.occurrences.map((occurrence) => occurrence.eventId)).toEqual([
      'ev-mixed-0',
      'ev-mixed-1',
      'ev-mixed-8',
      'ev-mixed-10',
      'ev-mixed-11',
    ]);
    expect(row.occurrencesTruncated).toBe(true);
  });

  it('cites unchanged and unknown counts only by renders of those triggers', () => {
    const candidates = renderCandidates([mixedStat('StatusPanel', 'ev-mixed', MIXED)]);
    const unchanged = candidates.find((candidate) => candidate.kind === 'unchanged-render-burst');
    const unknown = candidates.find((candidate) => candidate.kind === 'unknown-render-trigger');

    expect(unchanged?.statement).toBe(
      'StatusPanel rendered 830 times; 300 of those renders had shallow-equal props, unchanged own state and no changed consumed context value.',
    );
    expect(unchanged?.evidence.map((ref) => ref.eventId)).toEqual(['ev-mixed-8']);
    expect(unknown?.statement).toBe(
      'The trigger could not be determined for 20 of the 830 renders of StatusPanel.',
    );
    expect(unknown?.evidence.map((ref) => ref.eventId)).toEqual(['ev-mixed-10']);
    // The dominant trigger is props: only the props renders substantiate it.
    const dominant = candidates.find((candidate) => candidate.kind === 'dominant-render-trigger');
    expect(dominant?.evidence.map((ref) => ref.eventId)).toEqual(['ev-mixed-0', 'ev-mixed-1']);
  });

  it('withholds a trigger count none of whose renders were carried, keeping the render count', () => {
    const allProps: readonly RenderTrigger[] = ['props', 'props', 'props', 'props'];
    const candidates = renderCandidates([mixedStat('StatusPanel', 'ev-props', allProps)]);
    const kinds = candidates.map((candidate) => candidate.kind);

    expect(kinds).not.toContain('unchanged-render-burst');
    expect(kinds).not.toContain('unknown-render-trigger');
    expect(kinds).toContain('render-outlier');
    expect(
      candidates
        .find((candidate) => candidate.kind === 'render-outlier')
        ?.evidence.map((ref) => ref.eventId),
    ).toEqual(['ev-props-0', 'ev-props-1', 'ev-props-2', 'ev-props-3']);
  });
});
