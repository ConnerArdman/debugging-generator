/**
 * Tests for `./normalize.ts`: the source-URL normaliser, and the fixture
 * contract it is the executable form of.
 *
 * This suite's value comes from where its expectations came from. The table in
 * {@link CONTRACT_TABLE} is **transcribed** from the "Source URL normalisation"
 * section of `../../test/fixtures/source-maps/README.md` — the committed
 * contract document — row for row, including the one row that must be rejected.
 * It is deliberately not derived from the module under test: a table read out of
 * the implementation would agree with it forever and prove nothing, while a
 * table read out of the contract fails the moment the two diverge, which is the
 * only thing worth asserting here. The cross-folder invariant behind those rows
 * is that every expected path really exists under
 * `../../test/fixtures/sample-next-app/`, with the `node_modules` frame the
 * single deliberate exception.
 *
 * Every `sources` entry committed in that folder appears in the table: the
 * three from `webpack-basin-page.js.map`, the four the sectioned
 * `turbopack-gauge-route.js.map` flattens to, the two from
 * `turbopack-station-widget-6f3ad91c.js.map` and the one carried inline by
 * `inline-map-basin-detail.js`. A committed source string absent from here
 * would be a coverage hole, so the table is also asserted to hold exactly ten
 * distinct sources spanning all four maps.
 *
 * Beyond the contract, the rest of the file is adversarial: the module is a
 * security boundary (its last step is `isSafeRelativePath`, and its inputs are
 * bundler output derived from a page the developer opened, so they are
 * untrusted), and it is documented as **total** — `undefined` for every input
 * it cannot turn into a project path, a throw for none of them. Both claims are
 * only worth as much as the inputs they are tried with, hence the traversal,
 * Windows-root, UNC, control-character, malformed-escape, foreign-scheme,
 * bundler-internal, degenerate and pathological-length cases below.
 *
 * Three habits here are deliberate.
 *
 * 1. **No filesystem, no network, no temp directory, no mock.** The subject is
 *    pure string work over an explicitly supplied project root, so the suite
 *    needs none of that machinery, and the fixture tree — which is read-only —
 *    is never even opened: its table is transcribed as literals. That is what
 *    keeps this suite fast, hermetic and free of any chance of writing into a
 *    fixture.
 * 2. **Rejections are asserted as `undefined`, not as a thrown error**, because
 *    that is the contract `./resolver.ts` depends on: `undefined` means "skip
 *    this frame and let another resolution route answer" (AAP 0.4.2, 0.5.5).
 *    Where the *reason* matters it is observed through the injected logger,
 *    which is the only channel the module exposes it on.
 * 3. **Returned values are re-checked against the gate.** Every path the
 *    contract table produces is passed back through `isSafeRelativePath` from
 *    `@debuggen/shared`, so the caller-facing guarantee is asserted directly
 *    rather than inferred from the module's internal ordering.
 */
import type { LogFields, Logger } from '@debuggen/shared';
import { isSafeRelativePath } from '@debuggen/shared';
import { describe, expect, it } from 'vitest';

import type { NormalizeSourcePathOptions } from './normalize.js';
import {
  isWebpackInternalSource,
  normalizeSourcePath,
  REJECTED_PATH_SEGMENTS,
  SOURCE_URL_MARKERS,
  SOURCE_URL_SCHEMES,
} from './normalize.js';

// ---------------------------------------------------------------------------
// Harness.
// ---------------------------------------------------------------------------

/**
 * The project root every contract row resolves against.
 *
 * Invented, absolute and POSIX: nothing here touches a filesystem, so the root
 * only has to be a plausible absolute path, and an invented one keeps the suite
 * independent of where the repository happens to be checked out.
 */
const PROJECT_ROOT = '/workspace/sample-project';

/**
 * A second, unrelated root used by the containment cases, so "inside" and
 * "outside" are judged against a root the contract table never mentions.
 */
const CONTAINMENT_ROOT = '/srv/checkouts/station-app';

/**
 * A directory whose path has {@link CONTAINMENT_ROOT} as a string prefix but is
 * not inside it — the case a containment check written with `startsWith` and no
 * separator gets wrong.
 */
const SIBLING_PREFIX_ROOT = `${CONTAINMENT_ROOT}-evil`;

/** The options every case starts from; one root, no extras, no logger. */
function options(overrides: Partial<NormalizeSourcePathOptions> = {}): NormalizeSourcePathOptions {
  return { projectRoot: PROJECT_ROOT, ...overrides };
}

/** One record a {@link recordingLogger} captured. */
interface RecordedLog {
  readonly level: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
  readonly message: string;
  readonly fields: LogFields | undefined;
}

/**
 * A {@link Logger} that records instead of writing, so the module's single
 * `debug` record can be asserted on — both that it happened and that nothing
 * louder did.
 */
function recordingLogger(): { readonly calls: RecordedLog[]; readonly logger: Logger } {
  const calls: RecordedLog[] = [];
  const record =
    (level: RecordedLog['level']) =>
    (message: string, fields?: LogFields): void => {
      calls.push({ level, message, fields });
    };

  const logger: Logger = {
    level: 'trace',
    trace: record('trace'),
    debug: record('debug'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    fatal: record('fatal'),
    child: () => logger,
  };

  return { calls, logger };
}

/**
 * The `source` field of each record, as the module rendered it for the log.
 *
 * A record whose field is missing or not a string yields the empty string, and
 * every caller asserts a non-empty value, so such a record fails the case it
 * appears in rather than passing as a blank.
 */
function loggedSources(calls: readonly RecordedLog[]): string[] {
  return calls.map((call) => {
    const source: unknown = call.fields?.['source'];
    return typeof source === 'string' ? source : '';
  });
}

/**
 * Whether a string carries a C0, DELETE or C1 control character.
 *
 * Written as a scan rather than as a regular expression on purpose: a control
 * character inside a regex literal is what `no-control-regex` (part of the
 * enabled `@eslint/js` recommended set) forbids, and the gate is blocking.
 */
function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// The fixture contract.
// ---------------------------------------------------------------------------

/** One row of the fixture README's normalisation table. */
interface ContractRow {
  /** The `sources` entry, exactly as a committed fixture map spells it. */
  readonly source: string;
  /** The project-relative path it must produce, or `undefined` when rejected. */
  readonly expected: string | undefined;
  /** Which committed map carries the entry, as the README's third column names it. */
  readonly appearsIn: string;
  /** A short label, used in the test title so a `%` in a source cannot reach it. */
  readonly label: string;
}

/** A row the table expects to resolve, with its `expected` narrowed. */
type ResolvedContractRow = ContractRow & { readonly expected: string };

/**
 * The normalisation table of `../../test/fixtures/source-maps/README.md`,
 * transcribed.
 *
 * Ten rows, in the README's order, spanning the four prefix forms that document
 * enumerates: `webpack://<namespace>/` with an explicit `./`, `turbopack:///`
 * with the `[project]` root marker, `turbopack:///` with the `_N_E` namespace,
 * and `turbopack:///` with a bare `./`. The last two rows repeat paths that
 * already appear under the webpack scheme, which is what makes the convergence
 * assertion below possible.
 *
 * Nothing here may be "corrected" against the implementation: the fixture
 * contract is the authority, and a disagreement is a finding to report.
 */
const CONTRACT_TABLE: readonly ContractRow[] = [
  {
    source: 'webpack://_N_E/./src/widgets/GaugeReadout.tsx',
    expected: 'src/widgets/GaugeReadout.tsx',
    appearsIn: 'webpack map',
    label: 'the webpack namespace form of a widget',
  },
  {
    source: 'webpack://_N_E/./src/lib/http.ts',
    expected: 'src/lib/http.ts',
    appearsIn: 'webpack map',
    label: 'the webpack namespace form of a library module',
  },
  {
    source: 'webpack://_N_E/./node_modules/react/cjs/react.development.js',
    expected: undefined,
    appearsIn: 'webpack map',
    label: 'the dependency frame, which must be rejected',
  },
  {
    source: 'webpack://_N_E/./app/(observatory)/basins/[id]/page.tsx',
    expected: 'app/(observatory)/basins/[id]/page.tsx',
    appearsIn: 'inline map',
    label: 'the webpack form with literal brackets and a route group',
  },
  {
    source: 'turbopack:///[project]/app/api/gauges/%5Bid%5D/route.ts',
    expected: 'app/api/gauges/[id]/route.ts',
    appearsIn: 'sectioned, section 0',
    label: 'the Turbopack [project] form with an encoded bracket',
  },
  {
    source: 'turbopack:///[project]/src/lib/station-service.ts',
    expected: 'src/lib/station-service.ts',
    appearsIn: 'sectioned, section 1',
    label: 'the Turbopack [project] form of a server module',
  },
  {
    source: 'turbopack:///_N_E/src/widgets/BasinSummary.tsx',
    expected: 'src/widgets/BasinSummary.tsx',
    appearsIn: 'sectioned, section 1',
    label: 'the Turbopack _N_E namespace form',
  },
  {
    source: 'turbopack:///./app/(observatory)/basins/%5Bid%5D/page.tsx',
    expected: 'app/(observatory)/basins/[id]/page.tsx',
    appearsIn: 'sectioned, section 2',
    label: 'the Turbopack bare ./ form with an encoded bracket and a route group',
  },
  {
    source: 'turbopack:///[project]/src/widgets/GaugeReadout.tsx',
    expected: 'src/widgets/GaugeReadout.tsx',
    appearsIn: 'station-widget map',
    label: 'the Turbopack spelling of the webpack widget row',
  },
  {
    source: 'turbopack:///[project]/src/lib/http.ts',
    expected: 'src/lib/http.ts',
    appearsIn: 'station-widget map',
    label: 'the Turbopack spelling of the webpack library row',
  },
];

/** The rows of {@link CONTRACT_TABLE} that resolve, with `expected` narrowed. */
const RESOLVED_CONTRACT_ROWS: readonly ResolvedContractRow[] = CONTRACT_TABLE.filter(
  (row): row is ResolvedContractRow => row.expected !== undefined,
);

describe('normalizeSourcePath — the fixture contract', () => {
  it.each(CONTRACT_TABLE)('normalises $label', ({ source, expected }) => {
    expect(normalizeSourcePath(source, options())).toBe(expected);
  });

  it('covers every committed fixture source exactly once', () => {
    // The table is the whole of the README's normalisation table: ten distinct
    // entries across the four committed maps. A fixture source that stopped
    // being covered would show up here as a shrinking count.
    expect(CONTRACT_TABLE).toHaveLength(10);
    expect(new Set(CONTRACT_TABLE.map((row) => row.source)).size).toBe(10);
    expect(new Set(CONTRACT_TABLE.map((row) => row.appearsIn))).toEqual(
      new Set([
        'webpack map',
        'inline map',
        'sectioned, section 0',
        'sectioned, section 1',
        'sectioned, section 2',
        'station-widget map',
      ]),
    );
  });

  it('rejects exactly one row, the dependency frame', () => {
    const rejected = CONTRACT_TABLE.filter((row) => row.expected === undefined);
    expect(rejected.map((row) => row.source)).toEqual([
      'webpack://_N_E/./node_modules/react/cjs/react.development.js',
    ]);
  });

  it.each(RESOLVED_CONTRACT_ROWS)(
    'returns a path that passes the shared safety gate for $label',
    ({ source, expected }) => {
      const result = normalizeSourcePath(source, options());
      expect(result).toBe(expected);
      expect(isSafeRelativePath(expected)).toBe(true);
    },
  );
});

// ---------------------------------------------------------------------------
// The two bracket conventions, which pull in opposite directions.
// ---------------------------------------------------------------------------

describe('normalizeSourcePath — brackets and parentheses', () => {
  it('percent-decodes an encoded dynamic segment into literal brackets', () => {
    // Turbopack encodes `[id]`; the decoded segment is the real directory name,
    // so decoding is mandatory rather than cosmetic.
    expect(
      normalizeSourcePath('turbopack:///[project]/app/api/gauges/%5Bid%5D/route.ts', options()),
    ).toBe('app/api/gauges/[id]/route.ts');
  });

  it('never mistakes a decoded dynamic segment for a marker to strip', () => {
    // `[id]` looks exactly like the `[project]` marker to a naive strip, and a
    // deeper `[...segments]` catch-all looks like one twice over.
    expect(
      normalizeSourcePath('turbopack:///[project]/app/%5Bid%5D/%5B...segments%5D/route.ts', {
        projectRoot: PROJECT_ROOT,
      }),
    ).toBe('app/[id]/[...segments]/route.ts');
  });

  it('leaves a route group unencoded and unstripped', () => {
    // `(observatory)` is a real directory on disk. A route-group-aware URL
    // mapper would drop it and produce a path that exists nowhere.
    const result = normalizeSourcePath(
      'webpack://_N_E/./app/(observatory)/basins/[id]/page.tsx',
      options(),
    );
    expect(result).toBe('app/(observatory)/basins/[id]/page.tsx');
    expect(result).toContain('(observatory)');
  });

  it('gives the encoded and literal bracket forms of one file the identical path', () => {
    const encoded = normalizeSourcePath(
      'turbopack:///./app/(observatory)/basins/%5Bid%5D/page.tsx',
      options(),
    );
    const literal = normalizeSourcePath(
      'webpack://_N_E/./app/(observatory)/basins/[id]/page.tsx',
      options(),
    );

    expect(encoded).toBe('app/(observatory)/basins/[id]/page.tsx');
    expect(encoded).toBe(literal);
  });

  it('agrees with itself when one scheme spells a bracket both ways', () => {
    // The same Turbopack URL, encoded and literal: scheme-independence is not
    // the only axis the decoder has to be stable across.
    expect(
      normalizeSourcePath('turbopack:///[project]/app/api/gauges/[id]/route.ts', options()),
    ).toBe(
      normalizeSourcePath('turbopack:///[project]/app/api/gauges/%5Bid%5D/route.ts', options()),
    );
  });

  it.each([
    ['src/widgets/GaugeReadout.tsx', 'webpack://_N_E/./src/widgets/GaugeReadout.tsx'],
    ['src/lib/http.ts', 'webpack://_N_E/./src/lib/http.ts'],
  ])(
    'resolves %s identically from the webpack and Turbopack schemes',
    (expected, webpackSource) => {
      // The README's last two rows exist for this: a panel must not know, and
      // must not care, which bundler produced the chunk a frame pointed into.
      const turbopackSource = `turbopack:///[project]/${expected}`;

      expect(normalizeSourcePath(webpackSource, options())).toBe(expected);
      expect(normalizeSourcePath(turbopackSource, options())).toBe(expected);
    },
  );
});

// ---------------------------------------------------------------------------
// Bundler internals: generated runtime code, never a file the developer wrote.
// ---------------------------------------------------------------------------

/** The four internal shapes the module's own table enumerates, plus variants. */
const BUNDLER_INTERNAL_SOURCES: readonly (readonly [string, string])[] = [
  ['the internal scheme', 'webpack-internal:///./src/x.ts'],
  ['the internal scheme in upper case', 'WEBPACK-INTERNAL:///./src/x.ts'],
  ['a parenthesised internal namespace', '(webpack)/hot/dev-server.js'],
  ['a parenthesised dev-server namespace', '(webpack-dev-server)/client/index.js'],
  ['a bare runtime path', 'webpack/bootstrap'],
  ['a runtime path behind a scheme', 'webpack://webpack/bootstrap'],
  ['a runtime path behind a namespace', 'webpack://_N_E/webpack/bootstrap'],
  ['a runtime path behind the Turbopack marker', 'turbopack:///[project]/webpack/runtime/jsonp.js'],
];

describe('isWebpackInternalSource', () => {
  it.each(BUNDLER_INTERNAL_SOURCES)('reports %s as internal', (_label, source) => {
    expect(isWebpackInternalSource(source)).toBe(true);
  });

  it.each([
    ['project source under a namespace', 'webpack://_N_E/./src/lib/http.ts'],
    ['project source under the Turbopack marker', 'turbopack:///[project]/src/lib/http.ts'],
    ['a route group, which is not a webpack namespace', 'webpack://_N_E/./app/(observatory)/p.tsx'],
    ['a deeper webpack directory', 'webpack://_N_E/./config/webpack/rules.ts'],
    ['a dependency frame, which is refused elsewhere', 'webpack://_N_E/./node_modules/react/i.js'],
    ['the empty string', ''],
    ['whitespace only', '   '],
  ])('reports %s as not internal', (_label, source) => {
    expect(isWebpackInternalSource(source)).toBe(false);
  });
});

describe('normalizeSourcePath — bundler internals', () => {
  it.each(BUNDLER_INTERNAL_SOURCES)('refuses %s', (_label, source) => {
    expect(normalizeSourcePath(source, options())).toBeUndefined();
  });

  it('refuses a leading webpack directory but resolves a deeper one', () => {
    // The documented trade: the leading segment only. `config/webpack/rules.ts`
    // is application code and must still resolve.
    expect(normalizeSourcePath('webpack://_N_E/./webpack/rules.ts', options())).toBeUndefined();
    expect(normalizeSourcePath('webpack://_N_E/./config/webpack/rules.ts', options())).toBe(
      'config/webpack/rules.ts',
    );
  });

  it.each([
    ['[turbopack]', 'turbopack:///[turbopack]/runtime/base.js'],
    ['[next]', 'turbopack:///[next]/entry/page-loader.js'],
    ['[externals]', 'turbopack:///[externals]/node-crypto.js'],
  ])('refuses the bracketed bundler namespace %s', (_label, source) => {
    expect(normalizeSourcePath(source, options())).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Foreign schemes: nothing that is not webpack, turbopack or file.
// ---------------------------------------------------------------------------

describe('normalizeSourcePath — foreign schemes', () => {
  it.each([
    ['a dev-server HTTP origin', 'http://127.0.0.1:3000/_next/static/chunks/main.js'],
    ['a public HTTPS origin', 'https://cdn.example.com/x.js'],
    ['a data URI', 'data:application/json;base64,e30='],
    ['a blob URL', 'blob:http://127.0.0.1:3000/2f1c6c1e-6c4c-4a1c-9a2e-6f2d6a1b9c3d'],
    ['an extension origin', 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/x.js'],
    ['a Node built-in specifier', 'node:fs'],
    ['a bare package specifier with a scheme-like prefix', 'rsc://React/Server/x.js'],
    ['an eval wrapper', 'eval://anonymous'],
  ])('refuses %s', (_label, source) => {
    expect(normalizeSourcePath(source, options())).toBeUndefined();
  });

  it('accepts a bundler scheme whatever its case, as RFC 3986 requires', () => {
    expect(normalizeSourcePath('WEBPACK://_N_E/./src/lib/http.ts', options())).toBe(
      'src/lib/http.ts',
    );
    expect(normalizeSourcePath('TurboPack:///[project]/src/lib/http.ts', options())).toBe(
      'src/lib/http.ts',
    );
  });
});

// ---------------------------------------------------------------------------
// Absolute sources, `file:` URLs and the project root itself.
// ---------------------------------------------------------------------------

describe('normalizeSourcePath — containment against the project root', () => {
  const contained = options({ projectRoot: CONTAINMENT_ROOT });

  it('reduces an absolute path inside the root to its remainder', () => {
    expect(normalizeSourcePath(`${CONTAINMENT_ROOT}/src/lib/station-service.ts`, contained)).toBe(
      'src/lib/station-service.ts',
    );
  });

  it.each([
    ['a system path', '/etc/passwd'],
    ['a sibling directory sharing the root as a prefix', `${SIBLING_PREFIX_ROOT}/src/x.ts`],
    ['the parent of the root', '/srv/checkouts/other-app/src/x.ts'],
    ['a filesystem root file', '/x.ts'],
  ])('refuses %s', (_label, source) => {
    expect(normalizeSourcePath(source, contained)).toBeUndefined();
  });

  it('refuses an absolute source under a bundler scheme when it lies outside the root', () => {
    // webpack emits `<scheme>:///Users/dev/app/src/x.ts` when it records
    // absolute paths, and such a remainder must stay rooted so containment —
    // not a lucky string strip — decides it.
    expect(normalizeSourcePath('webpack:///etc/passwd', contained)).toBeUndefined();
  });

  it('resolves an absolute source under a bundler scheme when it lies inside the root', () => {
    expect(normalizeSourcePath(`webpack://${CONTAINMENT_ROOT}/src/lib/http.ts`, contained)).toBe(
      'src/lib/http.ts',
    );
  });

  it.each([
    ['an empty authority', `file://${CONTAINMENT_ROOT}/src/lib/http.ts`],
    ['the localhost authority', `file://localhost${CONTAINMENT_ROOT}/src/lib/http.ts`],
    ['no authority at all', `file:${CONTAINMENT_ROOT}/src/lib/http.ts`],
  ])('accepts a file: URL with %s', (_label, source) => {
    expect(normalizeSourcePath(source, contained)).toBe('src/lib/http.ts');
  });

  it('percent-decodes a file: URL before reducing it', () => {
    expect(
      normalizeSourcePath(
        `file://${CONTAINMENT_ROOT}/app/(observatory)/basins/%5Bid%5D/page.tsx`,
        contained,
      ),
    ).toBe('app/(observatory)/basins/[id]/page.tsx');
  });

  it.each([
    ['names a file on another host', `file://build-host${CONTAINMENT_ROOT}/src/x.ts`],
    ['carries no path', 'file://localhost'],
    ['is a relative reference with no base', 'file:src/lib/http.ts'],
  ])('refuses a file: URL that %s', (_label, source) => {
    expect(normalizeSourcePath(source, contained)).toBeUndefined();
  });

  it.each([
    ['the root itself', CONTAINMENT_ROOT],
    ['the root with a trailing separator', `${CONTAINMENT_ROOT}/`],
    ['the root as a file: URL', `file://${CONTAINMENT_ROOT}`],
    ['a bundler URL that reduces to the root', 'webpack://_N_E/./'],
    ['a relative path that reduces to the root', './'],
  ])('refuses %s, which names a directory rather than a source file', (_label, source) => {
    expect(normalizeSourcePath(source, contained)).toBeUndefined();
  });

  it('accepts a project root spelled with a trailing separator', () => {
    expect(
      normalizeSourcePath(
        'webpack://_N_E/./src/lib/http.ts',
        options({ projectRoot: `${CONTAINMENT_ROOT}/` }),
      ),
    ).toBe('src/lib/http.ts');
  });

  it('accepts a project root spelled the Windows way', () => {
    expect(
      normalizeSourcePath(
        'C:\\Users\\dev\\station-app\\src\\lib\\http.ts',
        options({ projectRoot: 'C:\\Users\\dev\\station-app' }),
      ),
    ).toBe('src/lib/http.ts');
  });

  it.each([
    ['a relative root', 'workspace/sample-project'],
    ['a bare directory name', 'sample-project'],
    ['the empty string', ''],
    ['a bare `.`', '.'],
  ])('rejects every source when the project root is %s', (_label, projectRoot) => {
    // Fail closed: without an absolute root, "inside the project" has nothing
    // to mean, and a relative source would otherwise be accepted on the
    // strength of its own spelling.
    expect(
      normalizeSourcePath('webpack://_N_E/./src/lib/http.ts', options({ projectRoot })),
    ).toBeUndefined();
  });

  it('refuses a network-share source even when the root names the same share', () => {
    // A two-separator prefix is a different volume on Windows, so it is refused
    // rather than reduced — the root's own spelling cannot bless it.
    const share = '//build-server/share/station-app';

    expect(
      normalizeSourcePath(`${share}/src/lib/http.ts`, options({ projectRoot: share })),
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The safety gate: what `isSafeRelativePath` refuses, and the rooted forms
// containment refuses before it.
// ---------------------------------------------------------------------------

describe('normalizeSourcePath — the safety gate', () => {
  it.each([
    ['a surviving traversal', 'webpack://_N_E/./../../etc/passwd'],
    ['a traversal that leaves the project by one segment', 'webpack://_N_E/./../secret.ts'],
    ['a bare relative traversal', '../secret.ts'],
    ['a Windows drive path', 'C:\\Users\\dev\\app.ts'],
    ['a Windows drive path already in POSIX form', 'C:/Users/dev/app.ts'],
    ['a drive-relative path', 'C:app.ts'],
    ['a UNC path', '\\\\build-server\\share\\app.ts'],
    ['a UNC path already in POSIX form', '//build-server/share/app.ts'],
  ])('refuses %s', (_label, source) => {
    expect(normalizeSourcePath(source, options())).toBeUndefined();
  });

  it.each([
    ['a NUL byte', 'webpack://_N_E/./src/lib/ht\u0000tp.ts'],
    ['an escape character', 'webpack://_N_E/./src/lib/\u001bhttp.ts'],
    ['an interior carriage return', 'webpack://_N_E/./src/li\rb/http.ts'],
    ['a DELETE character', 'webpack://_N_E/./src/lib/\u007fhttp.ts'],
    ['a C1 control character', 'webpack://_N_E/./src/lib/\u009fhttp.ts'],
    ['a percent-encoded NUL byte', 'turbopack:///[project]/src/lib/ht%00tp.ts'],
    ['a percent-encoded escape character', 'turbopack:///[project]/src/lib/%1Bhttp.ts'],
  ])('refuses a path carrying %s', (_label, source) => {
    expect(normalizeSourcePath(source, options())).toBeUndefined();
  });

  it('trims surrounding whitespace rather than refusing the source for it', () => {
    // Step 1 trims, so a directive copied with a trailing newline still
    // resolves; only a control character *inside* the path is fatal.
    expect(normalizeSourcePath('  webpack://_N_E/./src/lib/http.ts\n', options())).toBe(
      'src/lib/http.ts',
    );
  });

  it('resolves an interior traversal that lands back inside the project', () => {
    // Normalisation removes it, so the gate never sees a `..` — the documented
    // difference between an escape and a redundant spelling.
    expect(normalizeSourcePath('webpack://_N_E/./src/widgets/../lib/http.ts', options())).toBe(
      'src/lib/http.ts',
    );
  });

  it('never returns a path carrying a backslash, converting them instead', () => {
    // A Windows-authored `sources` entry spells its separators with
    // backslashes. They are converted, so the value a caller receives is POSIX
    // — which is the guarantee, not "a source with a backslash is refused".
    expect(normalizeSourcePath('src\\lib\\http.ts', options())).toBe('src/lib/http.ts');
    expect(normalizeSourcePath('webpack://_N_E/.\\src\\lib\\http.ts', options())).toBe(
      'src/lib/http.ts',
    );
    expect(normalizeSourcePath('turbopack:///[project]/src/lib/a%5Cb.ts', options())).toBe(
      'src/lib/a/b.ts',
    );
  });
});

// ---------------------------------------------------------------------------
// Rejected path segments: equality, never a substring.
// ---------------------------------------------------------------------------

describe('normalizeSourcePath — rejected path segments', () => {
  it.each(
    REJECTED_PATH_SEGMENTS.flatMap((segment) => [
      [`${segment} leading`, `webpack://_N_E/./${segment}/pkg/index.js`],
      [`${segment} in the middle`, `webpack://_N_E/./src/${segment}/pkg/index.js`],
      [`${segment} trailing`, `webpack://_N_E/./src/lib/${segment}`],
    ]),
  )('refuses a path with %s', (_label, source) => {
    expect(normalizeSourcePath(source, options())).toBeUndefined();
  });

  it.each(
    REJECTED_PATH_SEGMENTS.flatMap((segment) => [
      [`${segment}_backup as a directory`, `src/${segment}_backup/thing.ts`],
      [`a file named ${segment}.ts`, `src/lib/${segment}.ts`],
      [`backup_${segment} as a directory`, `src/backup_${segment}/thing.ts`],
    ]),
  )('resolves %s, because matching is by segment equality', (_label, path) => {
    expect(normalizeSourcePath(`webpack://_N_E/./${path}`, options())).toBe(path);
  });

  it.each([
    ['node_modules_backup', 'src/node_modules_backup/pkg/index.js'],
    ['distribution', 'src/distribution/bundle.ts'],
    ['outer', 'src/outer/thing.ts'],
    ['coverages', 'src/coverages/report.ts'],
    ['.nextjs', 'src/.nextjs/thing.ts'],
  ])('resolves the near-miss directory name %s', (_label, path) => {
    expect(normalizeSourcePath(`webpack://_N_E/./${path}`, options())).toBe(path);
  });

  it('honours extraRejectedSegments when the caller supplies them', () => {
    const source = 'webpack://_N_E/./src/generated/prisma/client.ts';

    expect(normalizeSourcePath(source, options())).toBe('src/generated/prisma/client.ts');
    expect(
      normalizeSourcePath(source, options({ extraRejectedSegments: ['generated'] })),
    ).toBeUndefined();
  });

  it('applies extraRejectedSegments in addition to the built-in list', () => {
    expect(
      normalizeSourcePath(
        'webpack://_N_E/./node_modules/pkg/index.js',
        options({ extraRejectedSegments: ['vendor'] }),
      ),
    ).toBeUndefined();
    expect(
      normalizeSourcePath(
        'webpack://_N_E/./vendor/pkg/index.js',
        options({ extraRejectedSegments: ['vendor'] }),
      ),
    ).toBeUndefined();
  });

  it('matches nothing for an extra entry that carries a separator', () => {
    // Each entry is a bare segment, compared against each segment of the
    // result, so a path-shaped entry cannot match one.
    expect(
      normalizeSourcePath(
        'webpack://_N_E/./src/generated/prisma/client.ts',
        options({ extraRejectedSegments: ['src/generated'] }),
      ),
    ).toBe('src/generated/prisma/client.ts');
  });

  it('ignores an empty extraRejectedSegments list', () => {
    expect(
      normalizeSourcePath(
        'webpack://_N_E/./src/lib/http.ts',
        options({ extraRejectedSegments: [] }),
      ),
    ).toBe('src/lib/http.ts');
  });
});

// ---------------------------------------------------------------------------
// Decoration a bundler adds around the path: loader chains, queries,
// fragments.
// ---------------------------------------------------------------------------

describe('normalizeSourcePath — bundler decoration', () => {
  it('takes the resource of a loader request, which is always last', () => {
    expect(
      normalizeSourcePath(
        'webpack://_N_E/./node_modules/css-loader/dist/cjs.js!./src/styles/app.css',
        options(),
      ),
    ).toBe('src/styles/app.css');
  });

  it('takes the resource of an inline-match loader request', () => {
    expect(
      normalizeSourcePath('webpack://_N_E/./loaders/swc.js!=!./src/lib/http.ts', options()),
    ).toBe('src/lib/http.ts');
  });

  it('refuses a loader request with no resource after it', () => {
    expect(normalizeSourcePath('webpack://_N_E/./loaders/swc.js!', options())).toBeUndefined();
  });

  it.each([
    ['a cache-busting query', 'webpack://_N_E/./src/lib/http.ts?ce5f', 'src/lib/http.ts'],
    [
      'a loader-option query',
      'turbopack:///[project]/src/widgets/GaugeReadout.tsx?client',
      'src/widgets/GaugeReadout.tsx',
    ],
    ['a fragment', 'turbopack:///[project]/src/lib/http.ts#L21', 'src/lib/http.ts'],
    ['a query and a fragment', 'webpack://_N_E/./src/lib/http.ts?v=2#L21', 'src/lib/http.ts'],
    ['a fragment before a query', 'webpack://_N_E/./src/lib/http.ts#L21?v=2', 'src/lib/http.ts'],
  ])('drops %s', (_label, source, expected) => {
    expect(normalizeSourcePath(source, options())).toBe(expected);
  });

  it('refuses a source that is nothing but a query', () => {
    expect(normalizeSourcePath('webpack://_N_E/./?client', options())).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Totality: `undefined` for every input it cannot resolve, a throw for none.
// ---------------------------------------------------------------------------

/** Inputs that must be refused without an exception ever leaving the module. */
const DEGENERATE_SOURCES: readonly (readonly [string, string])[] = [
  ['the empty string', ''],
  ['a single space', ' '],
  ['whitespace only', ' \t\r\n '],
  ['a bundler scheme with nothing after it', 'webpack:'],
  ['a bundler scheme with an empty authority', 'webpack://'],
  ['the three-slash form with nothing after it', 'turbopack:///'],
  ['the root marker with nothing after it', 'turbopack:///[project]'],
  ['the root marker with a trailing separator', 'turbopack:///[project]/'],
  ['the namespace with nothing after it', 'webpack://_N_E'],
  ['the namespace with a trailing separator', 'webpack://_N_E/'],
  ['a lone percent sign', '%'],
  ['an unreadable escape', '%zz'],
  ['a truncated UTF-8 escape', '%E0%A4%A'],
  ['a lone current-directory prefix', './'],
  ['the current directory', '.'],
  ['the parent directory', '..'],
  ['the filesystem root', '/'],
  ['a file scheme with nothing after it', 'file:'],
  ['a lone query', '?'],
  ['a lone fragment', '#'],
  ['a lone loader separator', '!'],
  ['a lone separator run', '////'],
];

describe('normalizeSourcePath — totality', () => {
  it.each(DEGENERATE_SOURCES)('refuses %s without throwing', (_label, source) => {
    expect(() => normalizeSourcePath(source, options())).not.toThrow();
    expect(normalizeSourcePath(source, options())).toBeUndefined();
  });

  it('refuses a value that is not a string at all, rather than throwing on it', () => {
    // The parameter is typed `string`, but the value arrives from a parsed
    // source-map document, so the module guards it. The casts here are the
    // point of the case: they reproduce what the type system cannot vouch for.
    const notStrings: readonly unknown[] = [undefined, null, 42, {}, [], true, Symbol('s')];

    for (const value of notStrings) {
      expect(() => normalizeSourcePath(value as string, options())).not.toThrow();
      expect(normalizeSourcePath(value as string, options())).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// Robustness under pathological input, and idempotence.
// ---------------------------------------------------------------------------

describe('normalizeSourcePath — robustness', () => {
  it('collapses duplicate separators', () => {
    expect(normalizeSourcePath('turbopack:///[project]//src///lib/http.ts', options())).toBe(
      'src/lib/http.ts',
    );
  });

  it('resolves a path of roughly ten thousand characters promptly', () => {
    const longName = 'a'.repeat(10_000);

    expect(normalizeSourcePath(`webpack://_N_E/./src/${longName}.ts`, options())).toBe(
      `src/${longName}.ts`,
    );
  });

  it('refuses a path built of two hundred traversals', () => {
    const source = `webpack://_N_E/./${'../'.repeat(200)}etc/passwd`;

    expect(() => normalizeSourcePath(source, options())).not.toThrow();
    expect(normalizeSourcePath(source, options())).toBeUndefined();
  });

  it('resolves a path built of two hundred current-directory segments', () => {
    // The prefix-strip cap is defence against pathological input, not a
    // rejection: whatever the loop leaves behind still goes through lexical
    // normalisation, which drops `.` segments of its own accord.
    const source = `webpack://_N_E/${'./'.repeat(200)}src/lib/http.ts`;

    expect(normalizeSourcePath(source, options())).toBe('src/lib/http.ts');
  });

  it('refuses a deeply nested path that escapes by one segment', () => {
    const inside = `webpack://_N_E/./${'deep/'.repeat(200)}thing.ts`;
    const escaping = `webpack://_N_E/./${'deep/'.repeat(200)}${'../'.repeat(201)}secret.ts`;

    expect(normalizeSourcePath(inside, options())).toBe(`${'deep/'.repeat(200)}thing.ts`);
    expect(normalizeSourcePath(escaping, options())).toBeUndefined();
  });
});

describe('normalizeSourcePath — idempotence', () => {
  it.each(RESOLVED_CONTRACT_ROWS)(
    'returns its own output unchanged when fed back in for $label',
    ({ source, expected }) => {
      const once = normalizeSourcePath(source, options());
      expect(once).toBe(expected);
      expect(normalizeSourcePath(expected, options())).toBe(expected);
    },
  );

  it('takes an already project-relative path as written', () => {
    // No scheme, no namespace vocabulary: the marker and namespace steps are
    // defined for bundler schemes only, so nothing is stripped here.
    expect(normalizeSourcePath('src/lib/http.ts', options())).toBe('src/lib/http.ts');
    expect(normalizeSourcePath('./src/lib/http.ts', options())).toBe('src/lib/http.ts');
    expect(normalizeSourcePath('app/(observatory)/basins/[id]/page.tsx', options())).toBe(
      'app/(observatory)/basins/[id]/page.tsx',
    );
  });
});

// ---------------------------------------------------------------------------
// Names are text: a file name's alphabet is not this module's business.
// ---------------------------------------------------------------------------

describe('normalizeSourcePath — non-ASCII names', () => {
  it.each([
    ['a diacritic', 'webpack://_N_E/./src/widgets/Überblick.tsx', 'src/widgets/Überblick.tsx'],
    ['a Greek letter', 'webpack://_N_E/./src/lib/Ω-scale.ts', 'src/lib/Ω-scale.ts'],
    ['CJK characters', 'turbopack:///[project]/src/widgets/観測.tsx', 'src/widgets/観測.tsx'],
    [
      'an astral-plane character',
      'turbopack:///_N_E/src/widgets/gauge-\u{1F4C8}.tsx',
      'src/widgets/gauge-\u{1F4C8}.tsx',
    ],
  ])('keeps %s intact', (_label, source, expected) => {
    expect(normalizeSourcePath(source, options())).toBe(expected);
  });

  it('decodes a percent-encoded non-ASCII name', () => {
    expect(
      normalizeSourcePath('turbopack:///[project]/src/widgets/%C3%9Cberblick.tsx', options()),
    ).toBe('src/widgets/Überblick.tsx');
  });
});

// ---------------------------------------------------------------------------
// How a rejection is reported: once, at `debug`, and never louder.
// ---------------------------------------------------------------------------

describe('normalizeSourcePath — rejection reporting', () => {
  it('explains a rejection once, at debug level', () => {
    const { calls, logger } = recordingLogger();

    expect(
      normalizeSourcePath(
        'webpack://_N_E/./node_modules/react/cjs/react.development.js',
        options({ logger }),
      ),
    ).toBeUndefined();

    expect(calls.map((call) => call.level)).toEqual(['debug']);
    expect(calls.map((call) => call.message.length > 0)).toEqual([true]);
    expect(calls.map((call) => typeof call.fields?.['reason'])).toEqual(['string']);
  });

  it('never logs above debug, whatever the rejection', () => {
    const { calls, logger } = recordingLogger();
    const rejected = [
      ...DEGENERATE_SOURCES.map(([, source]) => source),
      'https://cdn.example.com/x.js',
      'webpack-internal:///./src/x.ts',
      '/etc/passwd',
      'C:\\Users\\dev\\app.ts',
      'webpack://_N_E/./src/lib/ht\u0000tp.ts',
      'webpack://_N_E/./node_modules/react/index.js',
    ];

    for (const source of rejected) {
      expect(normalizeSourcePath(source, options({ logger }))).toBeUndefined();
    }

    expect(calls).toHaveLength(rejected.length);
    expect(new Set(calls.map((call) => call.level))).toEqual(new Set(['debug']));
  });

  it('logs nothing when a source resolves', () => {
    const { calls, logger } = recordingLogger();

    expect(normalizeSourcePath('webpack://_N_E/./src/lib/http.ts', options({ logger }))).toBe(
      'src/lib/http.ts',
    );
    expect(calls).toEqual([]);
  });

  it('neutralises control characters before they reach a log line', () => {
    // A `sources` entry is page-derived, untrusted input: NUL truncates a
    // string at many C boundaries and ESC begins a terminal escape sequence.
    const { calls, logger } = recordingLogger();

    expect(
      normalizeSourcePath('webpack://_N_E/./src/\u001b[31mlib\u0000/http.ts', options({ logger })),
    ).toBeUndefined();

    const logged = loggedSources(calls);
    expect(logged).toHaveLength(1);
    expect(logged.every((value) => value.length > 0)).toBe(true);
    expect(logged.some(hasControlCharacter)).toBe(false);
  });

  it('bounds what it repeats back from an oversized source', () => {
    const { calls, logger } = recordingLogger();
    const source = `https://cdn.example.com/${'a'.repeat(5_000)}.js`;

    expect(normalizeSourcePath(source, options({ logger }))).toBeUndefined();

    const logged = loggedSources(calls);
    expect(logged).toHaveLength(1);
    expect(logged.every((value) => value.length < source.length)).toBe(true);
    expect(logged.every((value) => value.length <= 512)).toBe(true);
  });

  it('needs no logger at all', () => {
    expect(() => normalizeSourcePath('/etc/passwd', { projectRoot: PROJECT_ROOT })).not.toThrow();
    expect(normalizeSourcePath('/etc/passwd', { projectRoot: PROJECT_ROOT })).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The exported vocabulary, asserted structurally.
// ---------------------------------------------------------------------------

describe('the exported vocabulary', () => {
  it('rejects node_modules, in a list of bare segments with no duplicates', () => {
    expect(REJECTED_PATH_SEGMENTS).toContain('node_modules');
    expect(new Set(REJECTED_PATH_SEGMENTS).size).toBe(REJECTED_PATH_SEGMENTS.length);
    expect(REJECTED_PATH_SEGMENTS.filter((segment) => segment.length === 0)).toEqual([]);
    expect(REJECTED_PATH_SEGMENTS.filter((segment) => segment.includes('/'))).toEqual([]);
    expect(Object.isFrozen(REJECTED_PATH_SEGMENTS)).toBe(true);
  });

  it('names the two bundler schemes, each lower-cased and carrying its colon', () => {
    expect([...SOURCE_URL_SCHEMES].sort()).toEqual(['turbopack:', 'webpack:']);
    expect(SOURCE_URL_SCHEMES.filter((scheme) => !scheme.endsWith(':'))).toEqual([]);
    expect(SOURCE_URL_SCHEMES.filter((scheme) => scheme !== scheme.toLowerCase())).toEqual([]);
    expect(Object.isFrozen(SOURCE_URL_SCHEMES)).toBe(true);
  });

  it('names the two markers that are not directories', () => {
    expect([...SOURCE_URL_MARKERS].sort()).toEqual(['[project]', '_N_E']);
    expect(SOURCE_URL_MARKERS.filter((marker) => marker.includes('/'))).toEqual([]);
    expect(Object.isFrozen(SOURCE_URL_MARKERS)).toBe(true);
  });

  it('strips every marker it names from a bundler URL', () => {
    // The constant and the algorithm must not drift apart: each marker, as the
    // leading segment of a bundler URL, has to disappear.
    for (const marker of SOURCE_URL_MARKERS) {
      expect(normalizeSourcePath(`turbopack:///${marker}/src/lib/http.ts`, options())).toBe(
        'src/lib/http.ts',
      );
    }
  });

  it('refuses every segment it names, wherever the segment sits', () => {
    for (const segment of REJECTED_PATH_SEGMENTS) {
      expect(
        normalizeSourcePath(`webpack://_N_E/./src/${segment}/thing.ts`, options()),
      ).toBeUndefined();
    }
  });
});
