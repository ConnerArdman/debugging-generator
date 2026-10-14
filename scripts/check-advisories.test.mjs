/**
 * check-advisories.test.mjs
 *
 * Contracts of `scripts/check-advisories.mjs`: the range comparator (including the free-text forms
 * vendor advisories use), the lockfile and manifest inventory, strict ledger validation, the
 * offline ledger layer against a known-affected pin, and the online layer's exit codes with a
 * stubbed `fetch`.
 *
 * Every fixture tree is built under `os.tmpdir()` and removed afterwards; nothing reads or asserts
 * the state of this checkout except the committed ledger file, which is loaded to prove it
 * validates. No test touches the network. Literals stay innocuous because `pnpm check:secrets`
 * scans tracked files.
 *
 * Collected by the root Vitest `tooling` project (environment `node`, `globals: false`), so the
 * test API is imported explicitly.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  AdvisoryCheckError,
  FindingSet,
  LEDGER_REL,
  OSV_BATCH_LIMIT,
  REPO_ROOT,
  RangeSyntaxError,
  buildInventory,
  compareVersions,
  evaluateLedger,
  extractManifestPins,
  formatFeedLagWarning,
  isExempt,
  listTrackedFiles,
  loadLedger,
  main,
  parseArgs,
  parseLockfilePackages,
  parseNextLink,
  parsePatchedVersions,
  parseRange,
  parseVersion,
  readInventory,
  runCheck,
  satisfies,
  splitPackageKey,
  usage,
  validateLedger,
} from './check-advisories.mjs';

const LEDGER_PATH = path.join(REPO_ROOT, LEDGER_REL);
const VENDOR_ID = 'GHSA-vcvr-r3jv-pc5j';
const FEED_URL_PREFIX = 'https://api.github.com/repos/vercel/next.js/security-advisories';
const QUERYBATCH_URL = 'https://api.osv.dev/v1/querybatch';
const OSV_VULN_PREFIX = 'https://api.osv.dev/v1/vulns/';

/** @type {string[]} */
const tempRoots = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

/**
 * Create a throwaway fixture tree.
 *
 * @param {Record<string, string>} files repository-relative path → contents
 * @returns {string} the root
 */
function makeTree(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'check-advisories-'));
  tempRoots.push(root);
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  }
  return root;
}

/** A writable stream stand-in that keeps what was written. */
function capture() {
  /** @type {string[]} */
  const chunks = [];
  return {
    write(/** @type {string} */ text) {
      chunks.push(text);
      return true;
    },
    text() {
      return chunks.join('');
    },
  };
}

/**
 * A two-document pnpm 12 lockfile: the package-manager document, then the workspace document with
 * `next`, a scoped quoted key and a `snapshots:` section that must not be counted.
 *
 * @param {string} nextVersion
 * @returns {string}
 */
function lockfileText(nextVersion) {
  return [
    '---',
    "lockfileVersion: '9.0'",
    '',
    'importers:',
    '',
    '  .:',
    '    packageManagerDependencies:',
    '      pnpm:',
    '        specifier: 12.4.2',
    '        version: 12.4.2',
    '',
    'packages:',
    '',
    '  pnpm@12.4.2:',
    '    resolution: {integrity: sha512-fixture}',
    '',
    'snapshots:',
    '',
    '  pnpm@12.4.2: {}',
    '',
    '---',
    "lockfileVersion: '9.0'",
    '',
    'settings:',
    '  autoInstallPeers: true',
    '',
    'importers:',
    '',
    '  .:',
    '    dependencies:',
    '      next:',
    `        specifier: ${nextVersion}`,
    `        version: ${nextVersion}(react@19.3.0)`,
    '',
    'packages:',
    '',
    `  '@next/env@${nextVersion}':`,
    '    resolution: {integrity: sha512-fixture}',
    '',
    `  next@${nextVersion}:`,
    '    resolution: {integrity: sha512-fixture}',
    '    peerDependencies:',
    '      react: ^18.2.0 || ^19.0.0',
    '',
    '  react@19.3.0:',
    '    resolution: {integrity: sha512-fixture}',
    '',
    'snapshots:',
    '',
    `  next@${nextVersion}(react@19.3.0):`,
    '    dependencies:',
    `      '@next/env': ${nextVersion}`,
    '',
    '  left-pad@1.3.0: {}',
    '',
  ].join('\n');
}

/**
 * A fixture repository: the root lockfile and a standalone fixture manifest that no lockfile
 * importer covers.
 *
 * @param {{ locked: string, pinned: string }} versions
 */
function fixtureRepository({ locked, pinned }) {
  const root = makeTree({
    'pnpm-lock.yaml': lockfileText(locked),
    'package.json': JSON.stringify({ name: 'fixture-root', private: true }),
    'fixtures/app/package.json': JSON.stringify({
      name: 'fixture-app',
      dependencies: { next: pinned, react: '^19.0.0' },
    }),
  });
  return {
    root,
    trackedFiles: ['README.md', 'fixtures/app/package.json', 'package.json', 'pnpm-lock.yaml'],
  };
}

/**
 * A JSON `Response`.
 *
 * @param {unknown} body
 * @param {{ status?: number, headers?: Record<string, string> }} [init]
 */
function json(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
}

/**
 * A vendor repository advisory in the GitHub API's shape.
 *
 * @param {string} id
 * @param {Array<[string, string] | [string, string, string]>} vulnerabilities
 *   `[vulnerable_version_range, patched_versions, package name (default next)]`
 * @param {Record<string, unknown>} [extra]
 */
function vendorAdvisory(id, vulnerabilities, extra = {}) {
  return {
    ghsa_id: id,
    cve_id: null,
    html_url: `https://github.com/vercel/next.js/security/advisories/${id}`,
    severity: 'high',
    withdrawn_at: null,
    vulnerabilities: vulnerabilities.map(([range, patched, name = 'next']) => ({
      package: { ecosystem: 'npm', name },
      vulnerable_version_range: range,
      patched_versions: patched,
    })),
    ...extra,
  };
}

/**
 * Write a copy of the committed ledger whose advisory lists `vendorEntries`, and return its path.
 *
 * @param {Array<{ package: string, range: string, patched: string | null }>} vendorEntries
 * @returns {string}
 */
function ledgerReplacing(vendorEntries) {
  const ledger = JSON.parse(fs.readFileSync(LEDGER_PATH, 'utf8'));
  ledger.advisories[0].vendorEntries = vendorEntries;
  return path.join(makeTree({ 'ledger.json': JSON.stringify(ledger) }), 'ledger.json');
}

/** The vendor's own record of the ledger advisory, as the GitHub API returns it. */
const VENDOR_RECORD = vendorAdvisory(VENDOR_ID, [['>= 16.2.0 < 16.3.6', '16.3.6']], {
  cve_id: 'CVE-2026-94545',
  severity: 'critical',
});

/**
 * A stubbed `fetch` for the three endpoints the online layer calls. Each handler may be replaced;
 * every call is recorded.
 *
 * @param {{
 *   vendor?: (url: string, init: RequestInit) => Response | Promise<Response>,
 *   osvBatch?: (queries: Array<{ package: { name: string }, version: string, page_token?: string }>) => unknown,
 *   osvVuln?: (id: string) => Response,
 * }} handlers
 */
function stubFetch(handlers = {}) {
  /** @type {Array<{ url: string, init: RequestInit }>} */
  const calls = [];
  /** @type {typeof fetch} */
  const fetchImpl = async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.startsWith(FEED_URL_PREFIX) || url.startsWith('https://api.github.com/')) {
      return handlers.vendor === undefined ? json([VENDOR_RECORD]) : handlers.vendor(url, init);
    }
    if (url === QUERYBATCH_URL) {
      const { queries } = JSON.parse(String(init.body));
      return json(
        handlers.osvBatch === undefined
          ? { results: queries.map(() => ({})) }
          : handlers.osvBatch(queries),
      );
    }
    if (url.startsWith(OSV_VULN_PREFIX)) {
      const id = decodeURIComponent(url.slice(OSV_VULN_PREFIX.length));
      return handlers.osvVuln === undefined
        ? json({ code: 5, message: 'Vulnerability not found' }, { status: 404 })
        : handlers.osvVuln(id);
    }
    throw new Error(`unexpected request ${url}`);
  };
  return { fetchImpl, calls };
}

/**
 * Run the check against a fixture repository.
 *
 * @param {{ root: string, trackedFiles: string[] }} repository
 * @param {Partial<import('./check-advisories.mjs').RunOptions>} [options]
 */
async function run(repository, options = {}) {
  const stdout = capture();
  const stderr = capture();
  const code = await runCheck({
    root: repository.root,
    trackedFiles: repository.trackedFiles,
    ledgerPath: LEDGER_PATH,
    env: {},
    stdout,
    stderr,
    ...options,
  });
  return { code, stdout: stdout.text(), stderr: stderr.text() };
}

describe('versions', () => {
  it('parses complete versions with an optional v or = prefix and rejects partial ones', () => {
    expect(parseVersion('16.3.6')).toMatchObject({ major: 16, minor: 3, patch: 6, text: '16.3.6' });
    expect(parseVersion('v16.0.7')?.text).toBe('16.0.7');
    expect(parseVersion('=1.2.3-rc.1+build.5')).toMatchObject({ prerelease: ['rc', 1] });
    expect(parseVersion('16.3')).toBeNull();
    expect(parseVersion('^1.2.3')).toBeNull();
    expect(parseVersion(42)).toBeNull();
  });

  it('orders versions by semver precedence, prereleases included', () => {
    const ordered = [
      '1.0.0-alpha',
      '1.0.0-alpha.1',
      '1.0.0-alpha.beta',
      '1.0.0-beta',
      '1.0.0-beta.2',
      '1.0.0-beta.11',
      '1.0.0-rc.1',
      '1.0.0',
      '1.0.1',
      '1.1.0',
      '2.0.0',
    ];
    const parsed = ordered.map(
      (text) => /** @type {NonNullable<ReturnType<typeof parseVersion>>} */ (parseVersion(text)),
    );
    const shuffled = [...parsed].reverse().sort(compareVersions);
    expect(shuffled.map((version) => version.text)).toEqual(ordered);
    expect(compareVersions(parsed[7], /** @type {any} */ (parseVersion('1.0.0+build')))).toBe(0);
  });
});

describe('range evaluation', () => {
  it.each([
    ['>= 16.2.0 < 16.3.6', '16.2.0', true],
    ['>= 16.2.0 < 16.3.6', '16.3.5', true],
    ['>= 16.2.0 < 16.3.6', '16.3.6', false],
    ['>= 16.2.0 < 16.3.6', '16.1.9', false],
    ['< 16.3.3', '16.3.2', true],
    ['< 16.3.3', '16.3.3', false],
    ['< 16.3.3', '0.1.0', true],
    ['>= 13.4 < 15.5.24', '13.4.0', true],
    ['>= 13.4 < 15.5.24', '13.3.9', false],
    ['>= 13.4 < 15.5.24', '15.5.23', true],
    ['>= 13.4 < 15.5.24', '15.5.24', false],
  ])('the GitHub example %s against %s is %s', (range, version, expected) => {
    expect(satisfies(version, range)).toBe(expected);
  });

  it('accepts operators with and without a following space', () => {
    expect(satisfies('16.3.5', '>=16.2.0 <16.3.6')).toBe(true);
    expect(satisfies('16.3.5', '> 16.3.4 <= 16.3.5')).toBe(true);
    expect(satisfies('16.3.5', '= 16.3.5')).toBe(true);
    expect(satisfies('16.3.5', '16.3.5')).toBe(true);
    expect(satisfies('16.3.5', '16.3.4')).toBe(false);
  });

  it('reads a comma between a lower-bound segment and an upper-bound segment as AND', () => {
    const range = '>= 1.2.0, < 1.3.0';
    expect(satisfies('1.2.5', range)).toBe(true);
    expect(satisfies('1.3.0', range)).toBe(false);
    expect(satisfies('1.1.9', range)).toBe(false);
    expect(parseRange(range).alternatives).toHaveLength(1);
  });

  it('reads a comma between complete intervals or same-side bounds as OR', () => {
    const intervals = '>=13.0.0 < 15.5.15, >= 16.0 < 16.2.3';
    expect(satisfies('15.5.14', intervals)).toBe(true);
    expect(satisfies('16.2.2', intervals)).toBe(true);
    expect(satisfies('15.9.0', intervals)).toBe(false);
    expect(satisfies('16.2.3', intervals)).toBe(false);
    expect(satisfies('13.5.9', '<=12.3.5, <=13.5.9')).toBe(true);
    expect(satisfies('14.0.0', '<=12.3.5, <=13.5.9')).toBe(false);
  });

  it('evaluates || alternatives', () => {
    const range = '>= 1.0.0 < 1.0.5 || >= 2.0.0 < 2.1.0';
    expect(satisfies('1.0.4', range)).toBe(true);
    expect(satisfies('2.0.9', range)).toBe(true);
    expect(satisfies('1.5.0', range)).toBe(false);
  });

  it('applies prerelease precedence, and a >= bound admits the prereleases it leads up to', () => {
    expect(satisfies('16.3.6-canary.1', '< 16.3.6')).toBe(true);
    expect(satisfies('15.6.0-canary.60', '< 15.6.0-canary.61')).toBe(true);
    expect(satisfies('15.6.0-canary.61', '< 15.6.0-canary.61')).toBe(false);
    expect(satisfies('16.0.0-beta.0', '>= 16.0.0')).toBe(true);
    expect(satisfies('15.9.9', '>= 16.0.0')).toBe(false);
    expect(satisfies('1.0.0-rc.1', '>= 1.0.0-rc.2')).toBe(false);
    expect(satisfies('1.0.0-rc.3', '= 1.0.0-rc.3')).toBe(true);
  });

  it('pads partial versions and never narrows a range with them', () => {
    expect(satisfies('16.0.0', '>= 16')).toBe(true);
    expect(satisfies('15.99.99', '>= 16')).toBe(false);
    expect(satisfies('13.5.9', '<= 13.5')).toBe(true);
    expect(satisfies('13.6.0', '<= 13.5')).toBe(false);
    expect(satisfies('10.9.3', '10.x')).toBe(true);
    expect(satisfies('11.0.0', '10.x')).toBe(false);
    expect(satisfies('13.4.7', '13.4')).toBe(true);
    expect(satisfies('4.2.0', '*')).toBe(true);
  });

  it('reads the vendor spellings: v prefix, =>, unicode operators, and, hyphen ranges', () => {
    expect(satisfies('13.0.0', '>= v12.2.0 < 15.5.16')).toBe(true);
    expect(satisfies('12.0.0', '=> 11.1.4 < 12.3.5')).toBe(true);
    expect(satisfies('15.2.0', '≥15.2.0')).toBe(true);
    expect(satisfies('15.1.0', '>15.0.4 and <15.2.0')).toBe(true);
    expect(satisfies('15.2.0', '>15.0.4 and <15.2.0')).toBe(false);
    expect(satisfies('15.4.4', '< 14.2.31, 15.0.0 - 15.4.4')).toBe(true);
    expect(satisfies('15.4.5', '< 14.2.31, 15.0.0 - 15.4.4')).toBe(false);
    expect(satisfies('11.0.3', '10.0.0 <= 12.0.10')).toBe(true);
    expect(satisfies('12.0.11', '10.0.0 <= 12.0.10')).toBe(false);
  });

  it.each([
    [''],
    ['   '],
    ['>='],
    ['>= banana'],
    ['>= 1.0.0 ||'],
    ['>= 1.0.0,'],
    ['^1.2.3'],
    ['~1.2'],
    ['1.x.3'],
    ['>= 1.2-rc.1'],
    ['< *'],
    ['and >= 1.0.0'],
    ['- 1.0.0'],
  ])('throws RangeSyntaxError (fail closed) for %j', (range) => {
    expect(() => parseRange(range)).toThrow(RangeSyntaxError);
  });

  it('marks a malformed range as an exit-2 failure', () => {
    try {
      parseRange('>= 1.0.0 banana');
      expect.unreachable('parseRange accepted a malformed range');
    } catch (error) {
      expect(error).toBeInstanceOf(AdvisoryCheckError);
      expect(/** @type {AdvisoryCheckError} */ (error).exitCode).toBe(2);
    }
  });
});

describe('patched versions', () => {
  const versionsOf = (/** @type {string} */ text) => parsePatchedVersions(text).map((v) => v.text);

  it('reads the fix versions a vendor lists and drops upper bounds and words', () => {
    expect(versionsOf('16.3.6')).toEqual(['16.3.6']);
    expect(versionsOf('v16.0.7, v15.5.7, 15.6.0-canary.58')).toEqual([
      '15.5.7',
      '15.6.0-canary.58',
      '16.0.7',
    ]);
    expect(versionsOf('≤15.0.4 and ≥15.2.0')).toEqual(['15.2.0']);
    expect(versionsOf('=>12.3.6, >= 15.2.2, >=13.5')).toEqual(['12.3.6', '13.5.0', '15.2.2']);
    expect(versionsOf('')).toEqual([]);
    expect(parsePatchedVersions(null)).toEqual([]);
  });

  /**
   * Whether an entry exempts `version` under the only alternative of `range`.
   *
   * @param {string} version
   * @param {string} range
   * @param {string} patched
   */
  const exempt = (version, range, patched) =>
    isExempt(
      /** @type {any} */ (parseVersion(version)),
      /** @type {any} */ (parseRange(range).alternatives[0]),
      parsePatchedVersions(patched),
    );

  it('closes an open range at the newest fix and at fixes on the version’s own line', () => {
    const fixes = '15.0.8, 15.1.12, 15.6.0-canary.61, 16.1.5';
    expect(exempt('16.3.6', '>= 10.0.0', fixes)).toBe(true);
    expect(exempt('16.1.5', '>= 10.0.0', fixes)).toBe(true);
    expect(exempt('16.1.4', '>= 10.0.0', fixes)).toBe(false);
    expect(exempt('15.1.13', '>= 10.0.0', fixes)).toBe(true);
    expect(exempt('15.1.5', '>= 10.0.0', fixes)).toBe(false);
    expect(exempt('15.2.0', '>= 10.0.0', fixes)).toBe(false);
    expect(exempt('15.6.0-canary.50', '>= 10.0.0', fixes)).toBe(false);
    expect(exempt('14.2.0', '>= 10.0.0', fixes)).toBe(false);
    expect(exempt('1.0.0', '>= 0.0.0', '')).toBe(false);
  });

  it('keeps a bounded range authoritative past fixes on other lines', () => {
    expect(exempt('16.3.6', '>= 16.3.0 < 16.4.0', '16.4.0')).toBe(false);
    expect(exempt('16.3.6', '>= 16.0.0 < 16.4.0', '16.1.4, 16.4.0')).toBe(false);
    expect(exempt('16.3.6', '>= 16.0.0 < 16.4.0', '16.3.3, 16.4.0')).toBe(true);
  });

  it('keeps a regression window affected although an earlier fix exists on the same line', () => {
    expect(exempt('16.3.7', '>= 16.3.6 < 16.3.9', '16.3.5, 16.3.9')).toBe(false);
    expect(exempt('16.3.7', '>= 16.3.4 < 16.3.9', '16.3.5, 16.3.9')).toBe(true);
  });
});

describe('lockfile parsing', () => {
  it('reads every packages: key of every document, scoped and quoted keys included', () => {
    expect(parseLockfilePackages(lockfileText('16.3.5'))).toEqual([
      { name: 'pnpm', version: '12.4.2' },
      { name: '@next/env', version: '16.3.5' },
      { name: 'next', version: '16.3.5' },
      { name: 'react', version: '19.3.0' },
    ]);
  });

  it('never counts snapshots: entries', () => {
    const names = parseLockfilePackages(lockfileText('16.3.6')).map((pkg) => pkg.name);
    expect(names).not.toContain('left-pad');
    expect(names.filter((name) => name === 'next')).toHaveLength(1);
  });

  it('accepts CRLF line endings and double-quoted keys', () => {
    const text =
      'lockfileVersion: \'9.0\'\r\n\r\npackages:\r\n\r\n  "@scope/pkg@1.0.0":\r\n    resolution: {}\r\n';
    expect(parseLockfilePackages(text)).toEqual([{ name: '@scope/pkg', version: '1.0.0' }]);
  });

  it('splits package keys on the first @ after the first character', () => {
    expect(splitPackageKey('@next/env@16.3.6')).toEqual({ name: '@next/env', version: '16.3.6' });
    expect(splitPackageKey('pkg@git+ssh://git@example.invalid/repo.git')).toEqual({
      name: 'pkg',
      version: 'git+ssh://git@example.invalid/repo.git',
    });
    expect(() => splitPackageKey('no-version')).toThrow(AdvisoryCheckError);
    expect(() => splitPackageKey('@scope/pkg')).toThrow(AdvisoryCheckError);
  });

  it('fails closed on an unsupported or missing lockfileVersion and on unexpected entries', () => {
    expect(() => parseLockfilePackages("lockfileVersion: '6.0'\npackages:\n")).toThrow(
      /not supported/,
    );
    expect(() => parseLockfilePackages('packages:\n\n  next@16.3.6:\n')).toThrow(
      /no lockfileVersion/,
    );
    expect(() =>
      parseLockfilePackages("lockfileVersion: '9.0'\npackages:\n  next@16.3.6: {resolution: {}}\n"),
    ).toThrow(/unexpected packages entry/);
  });
});

describe('manifest pins', () => {
  it('extracts exact pins from the three dependency fields and skips everything else', () => {
    const pins = extractManifestPins({
      dependencies: {
        next: '16.3.5',
        react: '^19.0.0',
        local: 'workspace:*',
        tagged: 'latest',
        tarball: 'https://example.invalid/pkg.tgz',
        aliased: 'npm:@scope/real@2.0.0-rc.1',
      },
      devDependencies: { vitest: 'v5.0.1', range: '>=1.0.0 <2.0.0' },
      optionalDependencies: { fsevents: '=2.3.3' },
      peerDependencies: { ignored: '1.0.0' },
    });
    expect(pins).toEqual([
      { name: 'next', version: '16.3.5', field: 'dependencies' },
      { name: '@scope/real', version: '2.0.0-rc.1', field: 'dependencies' },
      { name: 'vitest', version: '5.0.1', field: 'devDependencies' },
      { name: 'fsevents', version: '2.3.3', field: 'optionalDependencies' },
    ]);
  });

  it('rejects malformed manifests', () => {
    expect(() => extractManifestPins([])).toThrow(AdvisoryCheckError);
    expect(() => extractManifestPins({ dependencies: ['next'] })).toThrow(/not an object/);
    expect(() => extractManifestPins({ dependencies: { next: 16 } })).toThrow(/not a string/);
  });

  it('merges lockfile packages and pins into one inventory that keeps every origin', () => {
    const inventory = buildInventory({
      lockfiles: [{ path: 'pnpm-lock.yaml', text: lockfileText('16.3.5') }],
      manifests: [
        { path: 'fixtures/app/package.json', json: { dependencies: { next: '16.3.5' } } },
        { path: 'fixtures/other/package.json', json: { devDependencies: { next: '16.3.4' } } },
      ],
    });
    const next = inventory.entries.filter((entry) => entry.name === 'next');
    expect(next.map((entry) => [entry.version, entry.origins])).toEqual([
      ['16.3.4', ['fixtures/other/package.json (devDependencies)']],
      ['16.3.5', ['fixtures/app/package.json (dependencies)', 'pnpm-lock.yaml']],
    ]);
    expect(inventory).toMatchObject({
      lockfileCount: 1,
      lockedCount: 4,
      manifestCount: 2,
      pinCount: 2,
    });
  });

  it('keeps non-registry lockfile entries out of the inventory and lists them', () => {
    const inventory = buildInventory({
      lockfiles: [
        {
          path: 'pnpm-lock.yaml',
          text: "lockfileVersion: '9.0'\npackages:\n  pkg@https://example.invalid/pkg.tgz:\n    resolution: {}\n",
        },
      ],
    });
    expect(inventory.entries).toEqual([]);
    expect(inventory.unevaluated).toEqual(['pkg@https://example.invalid/pkg.tgz (pnpm-lock.yaml)']);
  });

  it('reads tracked lockfiles and manifests from a tree and fails closed on bad JSON', () => {
    const root = makeTree({
      'pnpm-lock.yaml': lockfileText('16.3.6'),
      'a/package.json': JSON.stringify({ dependencies: { next: '16.3.6' } }),
      'b/package.json': '{ not json',
    });
    expect(readInventory(root, ['pnpm-lock.yaml', 'a/package.json']).entries).toHaveLength(4);
    expect(() => readInventory(root, ['b/package.json'])).toThrow(/not valid JSON/);
    expect(() => readInventory(root, ['missing/package.json'])).toThrow(/cannot read/);
  });

  it('lists tracked files through git', () => {
    const root = makeTree({ 'package.json': '{}', 'untracked/package.json': '{}' });
    const init = spawnSync('git', ['init', '-q'], { cwd: root });
    const add = spawnSync('git', ['add', 'package.json'], { cwd: root });
    expect(init.status).toBe(0);
    expect(add.status).toBe(0);
    expect(listTrackedFiles(root)).toEqual(['package.json']);
  });
});

describe('ledger', () => {
  /** A valid ledger, cloned per test. */
  const validLedger = () => ({
    notes: 'fixture',
    vendorFeeds: [{ package: 'next', repository: 'vercel/next.js' }],
    advisories: [
      {
        id: VENDOR_ID,
        aliases: ['CVE-2026-94545'],
        package: 'next',
        severity: 'critical',
        vulnerableRanges: ['>= 16.2.0 < 16.3.6'],
        patched: '16.3.6',
        published: '2026-09-22',
        source: `https://github.com/vercel/next.js/security/advisories/${VENDOR_ID}`,
        vendorEntries: [],
      },
    ],
  });

  it('loads and validates the committed ledger', () => {
    const ledger = loadLedger(LEDGER_PATH);
    expect(ledger.vendorFeeds).toEqual([{ package: 'next', repository: 'vercel/next.js' }]);
    const advisory = ledger.advisories.find((entry) => entry.id === VENDOR_ID);
    expect(advisory).toMatchObject({
      aliases: ['CVE-2026-94545'],
      package: 'next',
      severity: 'critical',
      vulnerableRanges: ['>= 16.2.0 < 16.3.6'],
      patched: '16.3.6',
      vendorEntries: [],
    });
  });

  it('accepts a valid ledger, a null patched version and verbatim vendor entries', () => {
    const value = validLedger();
    /** @type {any} */ (value.advisories[0]).patched = null;
    /** @type {any} */ (value.advisories[0]).vendorEntries = [
      { package: 'next', range: 'not a range at all', patched: null },
    ];
    const advisory = validateLedger(value).advisories[0];
    expect(advisory?.patched).toBeNull();
    expect(advisory?.vendorEntries).toEqual([
      { package: 'next', range: 'not a range at all', patched: null },
    ]);
  });

  it.each([
    ['an unknown top-level key', (/** @type {any} */ l) => (l.extra = true), /unknown key "extra"/],
    ['a missing key', (/** @type {any} */ l) => delete l.notes, /missing key "notes"/],
    ['a bad id', (/** @type {any} */ l) => (l.advisories[0].id = 'CVE-2026-94545'), /GHSA/],
    [
      'a duplicate id',
      (/** @type {any} */ l) => l.advisories.push({ ...l.advisories[0] }),
      /duplicate id/,
    ],
    [
      'an unparseable range',
      (/** @type {any} */ l) => (l.advisories[0].vulnerableRanges = ['^16']),
      /cannot parse/,
    ],
    [
      'an empty range list',
      (/** @type {any} */ l) => (l.advisories[0].vulnerableRanges = []),
      /non-empty/,
    ],
    ['a bad severity', (/** @type {any} */ l) => (l.advisories[0].severity = 'severe'), /severity/],
    [
      'a partial patched version',
      (/** @type {any} */ l) => (l.advisories[0].patched = '16.3'),
      /patched/,
    ],
    [
      'an impossible date',
      (/** @type {any} */ l) => (l.advisories[0].published = '2026-02-30'),
      /published/,
    ],
    [
      'a non-https source',
      (/** @type {any} */ l) => (l.advisories[0].source = 'http://example.invalid'),
      /https/,
    ],
    [
      'a bad repository',
      (/** @type {any} */ l) => (l.vendorFeeds[0].repository = 'next.js'),
      /owner\/name/,
    ],
    [
      'a duplicate feed',
      (/** @type {any} */ l) => l.vendorFeeds.push({ ...l.vendorFeeds[0] }),
      /duplicate vendor feed/,
    ],
    [
      'an unknown advisory key',
      (/** @type {any} */ l) => (l.advisories[0].fixed = '16.3.6'),
      /unknown key "fixed"/,
    ],
    [
      'a missing vendorEntries list',
      (/** @type {any} */ l) => delete l.advisories[0].vendorEntries,
      /missing key "vendorEntries"/,
    ],
    [
      'a vendorEntries value that is not an array',
      (/** @type {any} */ l) => (l.advisories[0].vendorEntries = {}),
      /"vendorEntries" is not an array/,
    ],
    [
      'a vendor entry without its patched text',
      (/** @type {any} */ l) =>
        (l.advisories[0].vendorEntries = [{ package: 'next', range: '< 16.4.0' }]),
      /vendorEntries\[0\]: missing key "patched"/,
    ],
    [
      'a vendor entry whose range is not text',
      (/** @type {any} */ l) =>
        (l.advisories[0].vendorEntries = [{ package: 'next', range: null, patched: null }]),
      /"range" must be the vendor's range text/,
    ],
    [
      'a vendor entry whose patched value is not text or null',
      (/** @type {any} */ l) =>
        (l.advisories[0].vendorEntries = [{ package: 'next', range: '', patched: 16 }]),
      /"patched" must be the vendor's patched text or null/,
    ],
  ])('rejects %s', (_label, mutate, message) => {
    const value = validLedger();
    mutate(value);
    expect(() => validateLedger(value)).toThrow(message);
  });

  it('exits 2 when the ledger file is malformed', async () => {
    const repository = fixtureRepository({ locked: '16.3.6', pinned: '16.3.6' });
    const ledgerPath = path.join(makeTree({ 'ledger.json': '{"notes": "x"' }), 'ledger.json');
    const result = await run(repository, { ledgerPath });
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/not valid JSON/);
  });
});

describe('offline layer: known-affected pin fixture', () => {
  it('fails on next@16.3.5 from a lockfile and a fixture manifest, naming the advisory', async () => {
    const result = await run(fixtureRepository({ locked: '16.3.5', pinned: '16.3.5' }));
    expect(result.code).toBe(1);
    expect(result.stdout).toContain(
      `check-advisories: ${VENDOR_ID} (CVE-2026-94545) [critical] affects next@16.3.5`,
    );
    expect(result.stdout).toContain(
      'origins:  fixtures/app/package.json (dependencies); pnpm-lock.yaml',
    );
    expect(result.stdout).toContain('patched:  16.3.6');
    expect(result.stdout).toContain(
      `source:   https://github.com/vercel/next.js/security/advisories/${VENDOR_ID}`,
    );
    expect(result.stdout).toContain('found by: committed ledger');
    expect(result.stdout).toMatch(/FAIL - 1 finding\(s\)/);
  });

  it('fails on a fixture manifest pin that no lockfile importer covers', async () => {
    const result = await run(fixtureRepository({ locked: '16.3.6', pinned: '16.3.5' }));
    expect(result.code).toBe(1);
    expect(result.stdout).toContain('affects next@16.3.5');
    expect(result.stdout).toContain('origins:  fixtures/app/package.json (dependencies)\n');
  });

  it('passes on next@16.3.6', async () => {
    const result = await run(fixtureRepository({ locked: '16.3.6', pinned: '16.3.6' }));
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/^check-advisories: ok - no advisory affects 4 package versions/);
    expect(result.stderr).toBe('');
  });

  it('records ledger findings directly from an inventory', () => {
    const inventory = buildInventory({
      manifests: [{ path: 'a/package.json', json: { dependencies: { next: '16.2.0' } } }],
    });
    const findings = new FindingSet();
    evaluateLedger(inventory, loadLedger(LEDGER_PATH), findings);
    expect(findings.list().map((finding) => [finding.id, finding.version])).toEqual([
      [VENDOR_ID, '16.2.0'],
    ]);
  });
});

describe('online layer', () => {
  it('fails on a vendor advisory that matches and is missing from the ledger', async () => {
    const { fetchImpl } = stubFetch({
      vendor: () =>
        json([
          VENDOR_RECORD,
          vendorAdvisory('GHSA-2222-3333-4444', [['>= 16.3.0 < 16.3.9', '16.3.9']]),
        ]),
    });
    const result = await run(fixtureRepository({ locked: '16.3.6', pinned: '16.3.6' }), {
      online: true,
      fetch: fetchImpl,
    });
    expect(result.code).toBe(1);
    expect(result.stdout).toContain('GHSA-2222-3333-4444 [high] affects next@16.3.6');
    expect(result.stdout).toContain('affected: >= 16.3.0 < 16.3.9');
    expect(result.stdout).toContain(
      'found by: vendor feed vercel/next.js (not in the committed ledger)',
    );
    expect(result.stderr).toContain('warning: GHSA-2222-3333-4444 (next) is not in OSV yet');
  });

  it('closes open vendor ranges with each entry’s own patched list and skips withdrawn ones', async () => {
    const { fetchImpl } = stubFetch({
      vendor: () =>
        json([
          VENDOR_RECORD,
          vendorAdvisory('GHSA-4444-5555-6666', [['>=10.0.0', '15.5.14, 16.1.7']]),
          vendorAdvisory('GHSA-5555-6666-7777', [
            ['>= 10.0.0 < 15.5.24', '15.5.24'],
            ['< 16.3.3', '16.3.3'],
          ]),
          vendorAdvisory('GHSA-6666-7777-8888', [['16.3.0', '16.3.9']], {
            withdrawn_at: '2026-01-01T00:00:00Z',
          }),
        ]),
      osvVuln: (id) => json({ id }),
    });
    const result = await run(fixtureRepository({ locked: '16.3.6', pinned: '16.3.6' }), {
      online: true,
      fetch: fetchImpl,
    });
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('online: 4 vendor advisories (vercel/next.js) and OSV');
  });

  it('reads a single exact vendor version with a later fix as the interval to that fix', async () => {
    const { fetchImpl } = stubFetch({
      vendor: () => json([vendorAdvisory('GHSA-7777-8888-9999', [['16.3.0', '16.3.9']])]),
      osvVuln: (id) => json({ id }),
    });
    const result = await run(fixtureRepository({ locked: '16.3.6', pinned: '16.3.6' }), {
      online: true,
      fetch: fetchImpl,
    });
    expect(result.code).toBe(1);
    expect(result.stdout).toContain('GHSA-7777-8888-9999 [high] affects next@16.3.6');
    expect(result.stdout).toContain('affected: >= 16.3.0');
  });

  it('reports a vendor revision of a ledgered advisory that widens its range and adds a package', async () => {
    const { fetchImpl } = stubFetch({
      vendor: () =>
        json([
          vendorAdvisory(
            VENDOR_ID,
            [
              ['>= 16.2.0 < 16.3.7', '16.3.7'],
              ['>= 16.2.0 < 16.3.7', '16.3.7', '@next/env'],
            ],
            { cve_id: 'CVE-2026-94545', severity: 'critical' },
          ),
        ]),
    });
    const result = await run(fixtureRepository({ locked: '16.3.6', pinned: '16.3.6' }), {
      online: true,
      fetch: fetchImpl,
    });
    expect(result.code).toBe(1);
    expect(result.stdout).toContain(
      `${VENDOR_ID} (CVE-2026-94545) [critical] affects @next/env@16.3.6`,
    );
    expect(result.stdout).toContain(`${VENDOR_ID} (CVE-2026-94545) [critical] affects next@16.3.6`);
    expect(result.stdout).toContain('affected: >= 16.2.0 < 16.3.7');
    expect(result.stdout).toContain('patched:  16.3.7');
    expect(result.stdout).toContain('found by: vendor feed vercel/next.js\n');
    expect(result.stdout).toMatch(/FAIL - 2 finding\(s\)/);
    expect(result.stderr).toContain(`warning: ${VENDOR_ID} (next) is not in OSV yet`);
  });

  it('keeps a version affected by its own entry although another release line is fixed', async () => {
    const { fetchImpl } = stubFetch({
      vendor: () =>
        json([
          VENDOR_RECORD,
          vendorAdvisory('GHSA-8888-9999-2222', [
            ['>= 16.0.0 < 16.1.4', '16.1.4'],
            ['>= 16.3.0 < 16.4.0', '16.4.0'],
          ]),
        ]),
    });
    const result = await run(fixtureRepository({ locked: '16.3.6', pinned: '16.3.6' }), {
      online: true,
      fetch: fetchImpl,
    });
    expect(result.code).toBe(1);
    expect(result.stdout).toContain('GHSA-8888-9999-2222 [high] affects next@16.3.6');
    expect(result.stdout).toContain('affected: >= 16.3.0 < 16.4.0');
    expect(result.stdout).toContain('patched:  16.4.0');
    expect(result.stderr).toContain('warning: GHSA-8888-9999-2222 (next) is not in OSV yet');
  });

  it('replaces only a vendor entry the ledger lists verbatim', async () => {
    const overMatching = stubFetch({
      vendor: () => json([vendorAdvisory(VENDOR_ID, [['< 16.4.0', '16.4.0']])]),
      osvVuln: (id) => json({ id }),
    });
    const options = { online: true, fetch: overMatching.fetchImpl };
    const repository = fixtureRepository({ locked: '16.3.6', pinned: '16.3.6' });

    const unreviewed = await run(repository, options);
    expect(unreviewed.code).toBe(1);
    expect(unreviewed.stdout).toContain(`${VENDOR_ID} [high] affects next@16.3.6`);

    const reviewed = await run(repository, {
      ...options,
      ledgerPath: ledgerReplacing([{ package: 'next', range: '< 16.4.0', patched: '16.4.0' }]),
    });
    expect(reviewed.code).toBe(0);

    const otherText = await run(repository, {
      ...options,
      ledgerPath: ledgerReplacing([{ package: 'next', range: '< 16.4.0', patched: '16.3.9' }]),
    });
    expect(otherText.code).toBe(1);
  });

  it('accepts an unreadable vendor entry the ledger lists verbatim and fails once its text changes', async () => {
    const vendorWith = (/** @type {string} */ range) =>
      stubFetch({
        vendor: () => json([vendorAdvisory(VENDOR_ID, [[range, '16.3.6']])]),
        osvVuln: (id) => json({ id }),
      }).fetchImpl;
    const ledgerPath = ledgerReplacing([
      { package: 'next', range: 'not a range at all', patched: '16.3.6' },
    ]);
    const repository = fixtureRepository({ locked: '16.3.6', pinned: '16.3.6' });

    const listed = await run(repository, {
      online: true,
      fetch: vendorWith('not a range at all'),
      ledgerPath,
    });
    expect(listed.code).toBe(0);
    expect(listed.stderr).toBe('');

    const changed = await run(repository, {
      online: true,
      fetch: vendorWith('still not a range'),
      ledgerPath,
    });
    expect(changed.code).toBe(2);
    expect(changed.stderr).toContain(`${VENDOR_ID} (next): cannot parse version range`);
  });

  it('fails on an OSV vulnerability and reports its details', async () => {
    const { fetchImpl } = stubFetch({
      vendor: () => json([]),
      osvBatch: (queries) => ({
        results: queries.map((query) =>
          query.package.name === 'react'
            ? { vulns: [{ id: 'GHSA-9999-8888-7777', modified: '' }] }
            : {},
        ),
      }),
      osvVuln: (id) =>
        id === 'GHSA-9999-8888-7777'
          ? json({
              id,
              aliases: ['CVE-2099-0001'],
              database_specific: { severity: 'HIGH' },
              affected: [
                {
                  package: { name: 'react', ecosystem: 'npm' },
                  ranges: [
                    { type: 'SEMVER', events: [{ introduced: '19.0.0' }, { fixed: '19.3.1' }] },
                  ],
                },
              ],
            })
          : json({ id }),
    });
    const result = await run(fixtureRepository({ locked: '16.3.6', pinned: '16.3.6' }), {
      online: true,
      fetch: fetchImpl,
    });
    expect(result.code).toBe(1);
    expect(result.stdout).toContain(
      'GHSA-9999-8888-7777 (CVE-2099-0001) [high] affects react@19.3.0',
    );
    expect(result.stdout).toContain('affected: >=19.0.0 <19.3.1');
    expect(result.stdout).toContain('patched:  19.3.1');
    expect(result.stdout).toContain('source:   https://osv.dev/vulnerability/GHSA-9999-8888-7777');
    expect(result.stdout).toContain('found by: OSV');
    expect(result.stderr).toBe('');
  });

  it('merges an OSV result into the ledger finding for the same advisory', async () => {
    const { fetchImpl } = stubFetch({
      osvBatch: (queries) => ({
        results: queries.map((query) =>
          query.package.name === 'next' ? { vulns: [{ id: VENDOR_ID }] } : {},
        ),
      }),
      osvVuln: (id) => json({ id }),
    });
    const result = await run(fixtureRepository({ locked: '16.3.5', pinned: '16.3.5' }), {
      online: true,
      fetch: fetchImpl,
    });
    expect(result.code).toBe(1);
    expect(result.stdout.match(new RegExp(`${VENDOR_ID} \\(`, 'g'))).toHaveLength(1);
    expect(result.stdout).toContain('found by: committed ledger; vendor feed vercel/next.js; OSV');
  });

  it('warns about feed lag, without failing, when OSV does not carry an advisory', async () => {
    const { fetchImpl, calls } = stubFetch();
    const result = await run(fixtureRepository({ locked: '16.3.6', pinned: '16.3.6' }), {
      online: true,
      fetch: fetchImpl,
    });
    expect(result.code).toBe(0);
    expect(result.stderr).toBe(
      `warning: ${VENDOR_ID} (next) is not in OSV yet, so the aggregated advisory feeds pnpm audit relies on do not carry it; only this check reports it.\n`,
    );
    expect(calls.map((call) => call.url)).toContain(`${OSV_VULN_PREFIX}${VENDOR_ID}`);
  });

  it('emits the feed-lag warning as a GitHub Actions annotation on stdout under Actions', async () => {
    const { fetchImpl } = stubFetch();
    const result = await run(fixtureRepository({ locked: '16.3.6', pinned: '16.3.6' }), {
      online: true,
      fetch: fetchImpl,
      env: { GITHUB_ACTIONS: 'true' },
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`::warning title=Advisory feed lag::${VENDOR_ID} (next)`);
    expect(result.stderr).toBe('');
    expect(formatFeedLagWarning({ id: 'X%1', name: 'n' }, { GITHUB_ACTIONS: 'true' })).toContain(
      'X%251',
    );
  });

  it('exits 2 on a network error', async () => {
    const result = await run(fixtureRepository({ locked: '16.3.6', pinned: '16.3.6' }), {
      online: true,
      fetch: async () => {
        throw new TypeError('fetch failed', { cause: new Error('getaddrinfo ENOTFOUND') });
      },
    });
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(
      /vendor feed vercel\/next\.js: GET .* failed: fetch failed \(getaddrinfo ENOTFOUND\)/,
    );
  });

  it('exits 2 on a GitHub rate limit and says how to raise it', async () => {
    const { fetchImpl } = stubFetch({
      vendor: () =>
        json(
          { message: 'API rate limit exceeded' },
          {
            status: 403,
            headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1790437683' },
          },
        ),
    });
    const result = await run(fixtureRepository({ locked: '16.3.6', pinned: '16.3.6' }), {
      online: true,
      fetch: fetchImpl,
    });
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/returned HTTP 403 \(rate limit exceeded, resets at 2026-/);
    expect(result.stderr).toContain('set GITHUB_TOKEN to raise the limit');
  });

  it('exits 2 on other non-2xx responses, including an OSV 404 outside the id lookup', async () => {
    const { fetchImpl } = stubFetch({
      vendor: () => json({ message: 'Not Found' }, { status: 404 }),
    });
    const vendor = await run(fixtureRepository({ locked: '16.3.6', pinned: '16.3.6' }), {
      online: true,
      fetch: fetchImpl,
    });
    expect(vendor.code).toBe(2);
    expect(vendor.stderr).toMatch(/returned HTTP 404$/m);

    const batch = stubFetch({ osvBatch: () => ({ results: [] }) });
    const osv = await run(fixtureRepository({ locked: '16.3.6', pinned: '16.3.6' }), {
      online: true,
      fetch: batch.fetchImpl,
    });
    expect(osv.code).toBe(2);
    expect(osv.stderr).toMatch(/querybatch returned 0 results for 4 queries/);
  });

  it('exits 2 when a request times out', async () => {
    /** @type {typeof fetch} */
    const hanging = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      });
    const result = await run(fixtureRepository({ locked: '16.3.6', pinned: '16.3.6' }), {
      online: true,
      fetch: hanging,
      timeoutMs: 20,
    });
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/timed out after 0\.02 s/);
  });

  it('exits 2 on a body that is not JSON', async () => {
    const { fetchImpl } = stubFetch({ vendor: () => new Response('<html>', { status: 200 }) });
    const result = await run(fixtureRepository({ locked: '16.3.6', pinned: '16.3.6' }), {
      online: true,
      fetch: fetchImpl,
    });
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/not JSON/);
  });

  it('exits 2 on an unparseable vendor range the ledger does not list verbatim', async () => {
    const { fetchImpl } = stubFetch({
      vendor: () => json([vendorAdvisory('GHSA-3333-4444-5555', [['^16.0.0', '16.3.9']])]),
    });
    const result = await run(fixtureRepository({ locked: '16.3.6', pinned: '16.3.6' }), {
      online: true,
      fetch: fetchImpl,
    });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain(
      `GHSA-3333-4444-5555 (next): cannot parse version range "^16.0.0"`,
    );
    expect(result.stderr).toContain(
      `record it verbatim under "vendorEntries" of a ${LEDGER_REL} advisory for GHSA-3333-4444-5555`,
    );
  });

  it('sends GITHUB_TOKEN to the GitHub API only and never prints it', async () => {
    const { fetchImpl, calls } = stubFetch();
    const result = await run(fixtureRepository({ locked: '16.3.5', pinned: '16.3.5' }), {
      online: true,
      fetch: fetchImpl,
      env: { GITHUB_TOKEN: 'stub-credential' },
    });
    expect(result.code).toBe(1);
    const header = (/** @type {RequestInit} */ init) =>
      /** @type {Record<string, string>} */ (init.headers ?? {}).Authorization;
    const github = calls.filter((call) => call.url.startsWith('https://api.github.com/'));
    const osv = calls.filter((call) => call.url.startsWith('https://api.osv.dev/'));
    expect(github.length).toBeGreaterThan(0);
    expect(github.every((call) => header(call.init) === 'Bearer stub-credential')).toBe(true);
    expect(osv.length).toBeGreaterThan(0);
    expect(osv.every((call) => header(call.init) === undefined)).toBe(true);
    expect(`${result.stdout}${result.stderr}`).not.toContain('stub-credential');

    const anonymous = stubFetch();
    await run(fixtureRepository({ locked: '16.3.6', pinned: '16.3.6' }), {
      online: true,
      fetch: anonymous.fetchImpl,
    });
    expect(anonymous.calls.every((call) => header(call.init) === undefined)).toBe(true);
  });

  it('follows Link pagination on the GitHub origin and refuses any other origin', async () => {
    const next = `https://api.github.com/repositories/1/security-advisories?state=published&per_page=100&after=cursor`;
    const paged = stubFetch({
      vendor: (url) =>
        url === next
          ? json([vendorAdvisory('GHSA-2222-3333-4444', [['>= 16.3.0 < 16.3.9', '16.3.9']])])
          : json([VENDOR_RECORD], { headers: { link: `<${next}>; rel="next"` } }),
      osvVuln: (id) => json({ id }),
    });
    const result = await run(fixtureRepository({ locked: '16.3.6', pinned: '16.3.6' }), {
      online: true,
      fetch: paged.fetchImpl,
    });
    expect(result.code).toBe(1);
    expect(result.stdout).toContain('GHSA-2222-3333-4444');
    expect(paged.calls.map((call) => call.url)).toContain(next);

    const escaping = stubFetch({
      vendor: () => json([], { headers: { link: '<https://example.invalid/page2>; rel="next"' } }),
    });
    const refused = await run(fixtureRepository({ locked: '16.3.6', pinned: '16.3.6' }), {
      online: true,
      fetch: escaping.fetchImpl,
    });
    expect(refused.code).toBe(2);
    expect(refused.stderr).toContain('next page points outside https://api.github.com');
  });

  it('parses Link headers', () => {
    expect(parseNextLink('<https://a/2>; rel="next", <https://a/9>; rel="last"')).toBe(
      'https://a/2',
    );
    expect(parseNextLink('<https://a/1>; rel="prev"')).toBeNull();
    expect(parseNextLink(null)).toBeNull();
  });

  it('follows OSV next_page_token and batches at most the OSV limit', async () => {
    /** @type {number[]} */
    const batchSizes = [];
    const { fetchImpl } = stubFetch({
      vendor: () => json([]),
      osvBatch: (queries) => {
        batchSizes.push(queries.length);
        return {
          results: queries.map((query) => {
            if (query.package.name !== 'react') return {};
            return query.page_token === undefined
              ? { vulns: [], next_page_token: 'page-2' }
              : { vulns: [{ id: 'GHSA-8888-9999-2222' }] };
          }),
        };
      },
      osvVuln: (id) => json({ id }),
    });
    const result = await run(fixtureRepository({ locked: '16.3.6', pinned: '16.3.6' }), {
      online: true,
      fetch: fetchImpl,
    });
    expect(result.code).toBe(1);
    expect(result.stdout).toContain('GHSA-8888-9999-2222 [unknown] affects react@19.3.0');
    expect(batchSizes).toEqual([4, 1]);
    expect(Math.max(...batchSizes)).toBeLessThanOrEqual(OSV_BATCH_LIMIT);
  });
});

describe('command line', () => {
  it('parses --online and --help and rejects anything else', () => {
    expect(parseArgs([])).toEqual({ online: false, help: false });
    expect(parseArgs(['--online'])).toEqual({ online: true, help: false });
    expect(parseArgs(['--help'])).toEqual({ online: false, help: true });
    expect(() => parseArgs(['--offline'])).toThrow(AdvisoryCheckError);
  });

  it('prints usage for --help and exits 0', async () => {
    const stdout = capture();
    expect(await main(['--help'], { stdout })).toBe(0);
    expect(stdout.text()).toBe(`${usage()}\n`);
  });

  it('exits 2 with usage on an unknown argument', async () => {
    const stderr = capture();
    expect(await main(['--bogus'], { stderr })).toBe(2);
    expect(stderr.text()).toContain('unknown argument "--bogus"');
    expect(stderr.text()).toContain('Usage: node scripts/check-advisories.mjs [--online]');
  });

  it('runs the offline check through main with injected dependencies', async () => {
    const repository = fixtureRepository({ locked: '16.3.5', pinned: '16.3.5' });
    const stdout = capture();
    const code = await main([], {
      root: repository.root,
      trackedFiles: repository.trackedFiles,
      ledgerPath: LEDGER_PATH,
      stdout,
      stderr: capture(),
    });
    expect(code).toBe(1);
    expect(stdout.text()).toContain(VENDOR_ID);
  });
});
