// ---------------------------------------------------------------------------
// Tests for `scripts/check-no-hardcoding.mjs` - the static half of the
// "No Hardcoded Behavior" guarantee (AAP 0.5.4).
//
// These four cases are the only automated evidence that the product's central
// promise is mechanically enforced, so AAP 0.5.4's wording is the acceptance
// criteria for this file, verbatim:
//
//   "scripts/check-no-hardcoding.test.mjs asserts: a deliberate cheat (a branch
//    on RecommendationsRail) fails; a prompt-level cheat (a prompt file naming a
//    demo route) fails; a legitimate overlap (a product Button primitive)
//    passes; and --update against a product tree containing a leaked demo
//    identifier still lists that identifier in the policy."
//
// They are the first four `describe` blocks below, in that order. The remaining
// blocks cover the rules and guarantees the four cases do not reach
// (`demo-import`, `demo-path`, the question-branch exemption, `policy-stale`,
// the policy's canonical form, the canonical form of the committed policy
// artifact itself, the exclusion list, the command-line surface, the enforcement
// of policy drift whenever the demo corpus is present, and the fail-closed
// scan), because a gate whose supporting rules are untested is a gate that can
// rot silently.
//
// THREE PROPERTIES THAT ARE THE GATE ITSELF, NOT A DETAIL
// A guard is only evidence if it fails when it cannot do its job, so three
// properties are asserted as directly as the four cases above:
//   * "policy-stale is enforced whenever the corpus is present" - drift fails
//     the run however little of the committed policy a fresh harvest reproduces.
//     There is no coverage threshold and no partially-materialized-corpus
//     exemption; the only state that skips the comparison is an absent
//     `apps/demo-app`, and the policy is still enforced against product source
//     then.
//   * "the committed policy is the generator's output, byte for byte" - the
//     policy is a generated artifact (AAP 0.5.4), so the same names in a
//     different order, a name listed twice, a reformatted file and a
//     hand-written provenance field are each drift, even though none of them
//     changes which names the gate matches. A comparison of membership alone
//     passes every one of them and leaves a committed artifact no regeneration
//     reproduces.
//   * "the scan fails closed" - an unlistable directory, an unreadable,
//     undecodable or oversized file, a symbolic link where a scanned file was
//     expected, and a corpus the harvest could only partly read each stop the
//     run with the environment exit code instead of being counted as clean.
//
// HOW EVERY CASE IS BUILT
// Every case about the scanner's behaviour writes a synthetic repository into a
// fresh `os.tmpdir()` directory and runs the scanner against it with the
// root-parameterized exports (`check(root)`, `scanProductSource(root)`,
// `buildPolicy(root)`, `main(argv, root)`). Nothing is ever written inside this
// checkout.
//
// The single exception is "the committed policy artifact", which reads the real
// `scripts/no-hardcoding.policy.json` through `DEFAULT_ROOT`, because the byte
// comparison inside `check()` runs only when `apps/demo-app` is present and
// wholly readable and the committed artifact is this unit's own output. Those
// cases assert only invariants that hold whatever the demo declares - its
// canonical form, its metadata, the harvest rule, disjointness from the
// allowlist - so they do not start failing the day the demo application grows a
// component, and they name none of its entries: the policy's vocabulary lives in
// the generated file alone.
//
// WHY THIS FILE MAY NAME DEMO SYMBOLS
// The fixtures below deliberately use real demo vocabulary
// (`RecommendationsRail`, `/api/recommendations`), because realistic names are
// what make the assertions meaningful. `pnpm check:no-hardcoding` still passes
// with this file present for two independent reasons, both asserted by the
// scanner's own exclusion list: `scripts/**` is never scanned (the policy file
// itself would otherwise fail the gate on sight), and `**/*.test.mjs` is never
// scanned as product source. If this file is ever reported by the gate, the
// scanner's exclusions are wrong - fix those rather than weakening these
// fixtures.
//
// TS-MORPH AND SKIPPING
// The scanner resolves ts-morph from `packages/code-analysis` (or
// `packages/instrumentation`), falling back to its own `node_modules`. A
// synthetic tree has no `node_modules` of its own, so the fallback is what makes
// these tests possible. Should ts-morph be unresolvable, the AST-backed cases
// are skipped with a printed reason instead of failing the run; the
// structured-text, policy-loading and command-line cases keep running, because
// they never touch the AST. A skip is therefore NOT coverage: the printed
// warning below is the signal, and CI installs the workspace before running
// `pnpm test`, so a skip there means the install regressed.
//
// Note that policy-staleness is AST-backed too, even though it asserts on no
// source file: `buildPolicy()` parses the demo corpus with ts-morph to harvest
// it. Those cases are gated with the rest.
// ---------------------------------------------------------------------------
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { afterAll, describe, expect, it } from 'vitest';

import {
  ALLOWLIST_FILE,
  DEFAULT_ROOT,
  DEMO_PACKAGE,
  DEMO_TREE,
  EXIT_ERROR,
  EXIT_FINDINGS,
  EXIT_OK,
  FIXTURE_TREE,
  HardcodingCheckError,
  MAX_FILE_BYTES,
  POLICY_FILE,
  PRODUCT_TREES,
  QUESTION_EXEMPT_FILE,
  RULE_IDS,
  SCRIPT_FILE,
  buildPolicy,
  check,
  isDemoSpecificIdentifier,
  loadAllowlist,
  loadPolicy,
  main,
  renderReport,
  scanProductSource,
  scanStructuredText,
  serializePolicy,
  updatePolicy,
} from './check-no-hardcoding.mjs';

/**
 * Generous bound for a case that parses a synthetic tree. A full scan of one of
 * these trees takes milliseconds once ts-morph is loaded; the first load is what
 * this allows for.
 */
const AST_TIMEOUT_MS = 30_000;

/**
 * Every temporary root this suite created, removed in `afterAll` whether the
 * cases passed or failed.
 *
 * @type {string[]}
 */
const temporaryRoots = [];

afterAll(() => {
  for (const root of temporaryRoots) {
    rmSync(root, { recursive: true, force: true });
  }
  temporaryRoots.length = 0;
});

/* -------------------------------------------------------------------------------------------------
 * synthetic-tree fixtures
 * ---------------------------------------------------------------------------------------------- */

/**
 * Write a synthetic repository into a fresh temporary directory.
 *
 * @param {Record<string, string>} files Repository-relative POSIX path -> file contents.
 * @returns {string} Absolute root of the new tree.
 */
function makeTree(files) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'debuggen-nohc-'));
  temporaryRoots.push(root);
  for (const [relPath, contents] of Object.entries(files)) {
    const absolute = path.join(root, ...relPath.split('/'));
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, contents, 'utf8');
  }
  return root;
}

/**
 * Absolute path of a repository-relative POSIX path inside a synthetic tree, for
 * the cases that have to manipulate the tree after `makeTree` wrote it
 * (symbolic links, permissions, oversized bodies).
 *
 * @param {string} root
 * @param {string} relPath
 * @returns {string}
 */
function at(root, relPath) {
  return path.join(root, ...relPath.split('/'));
}

/**
 * Join lines into a file body with a trailing newline, so fixture line numbers
 * read exactly as they are written.
 *
 * @param {...string} lines
 * @returns {string}
 */
function source(...lines) {
  return `${lines.join('\n')}\n`;
}

/**
 * The metadata fields a faithfully regenerated policy carries. They are taken
 * from the scanner's own exported constants rather than typed out, so a change
 * to either is a compile-time-visible change here instead of a silent
 * `exclusions` drift finding.
 */
const POLICY_METADATA = Object.freeze({
  version: 1,
  generatedBy: `${SCRIPT_FILE} --update`,
  corpus: DEMO_TREE,
  exclusions: [FIXTURE_TREE, ALLOWLIST_FILE],
});

/**
 * Serialize a policy document exactly as `--update` would write it, so a fixture
 * is byte-identical to a regenerated file and can never be the reason a
 * staleness comparison reports drift.
 *
 * @param {{ identifiers?: string[], routePaths?: string[] }} [entries]
 * @returns {string}
 */
function policyDocument(entries = {}) {
  return serializePolicy({
    ...POLICY_METADATA,
    identifiers: entries.identifiers ?? [],
    routePaths: entries.routePaths ?? [],
  });
}

/**
 * Serialize an allowlist document in the committed file's shape.
 *
 * @param {{ identifiers?: string[], routePaths?: string[] }} [entries]
 * @returns {string}
 */
function allowlistDocument(entries = {}) {
  return `${JSON.stringify(
    {
      version: 1,
      identifiers: entries.identifiers ?? [],
      routePaths: entries.routePaths ?? [],
      notes: 'Synthetic allowlist written by scripts/check-no-hardcoding.test.mjs.',
    },
    null,
    2,
  )}\n`;
}

/**
 * The two artifacts every synthetic tree needs before the scanner will run.
 *
 * @param {{ identifiers?: string[], routePaths?: string[] }} policy
 * @param {{ identifiers?: string[], routePaths?: string[] }} [allowlist]
 * @returns {Record<string, string>}
 */
function artifacts(policy, allowlist = {}) {
  return {
    [POLICY_FILE]: policyDocument(policy),
    [ALLOWLIST_FILE]: allowlistDocument(allowlist),
  };
}

/* -------------------------------------------------------------------------------------------------
 * assertion helpers
 * ---------------------------------------------------------------------------------------------- */

/**
 * The 1-based line and column of `needle` in a fixture body, which is how the
 * scanner reports a position. Missing text is a broken fixture, not a failed
 * assertion, so it throws with the needle named.
 *
 * @param {string} text
 * @param {string} needle
 * @returns {{ line: number, column: number }}
 */
function positionOf(text, needle) {
  const lines = text.split('\n');
  const index = lines.findIndex((line) => line.includes(needle));
  if (index === -1) {
    throw new Error(`fixture does not contain ${JSON.stringify(needle)}`);
  }
  const line = /** @type {string} */ (lines[index]);
  return { line: index + 1, column: line.indexOf(needle) + 1 };
}

/**
 * The 1-based position of `needle` on the fixture line identified by
 * `lineNeedle`, for the cases where the same name appears on several lines.
 *
 * @param {string} text
 * @param {string} lineNeedle Text that identifies the line.
 * @param {string} needle Text whose column is wanted on that line.
 * @returns {{ line: number, column: number }}
 */
function positionOnLine(text, lineNeedle, needle) {
  const lines = text.split('\n');
  const index = lines.findIndex((line) => line.includes(lineNeedle));
  if (index === -1) {
    throw new Error(`fixture does not contain ${JSON.stringify(lineNeedle)}`);
  }
  const line = /** @type {string} */ (lines[index]);
  const column = line.indexOf(needle);
  if (column === -1) {
    throw new Error(
      `fixture line ${index + 1} does not contain ${JSON.stringify(needle)}: ${line}`,
    );
  }
  return { line: index + 1, column: column + 1 };
}

/**
 * Findings of one rule, in the order the scanner reported them.
 *
 * @param {{ rule: string }[]} findings
 * @param {string} rule
 * @returns {any[]}
 */
function byRule(findings, rule) {
  return findings.filter((finding) => finding.rule === rule);
}

/**
 * Every rule id present in a finding list, de-duplicated and sorted, which is
 * the cheapest way to assert "these rules and no others fired".
 *
 * @param {{ rule: string }[]} findings
 * @returns {string[]}
 */
function rulesOf(findings) {
  return [...new Set(findings.map((finding) => finding.rule))].sort();
}

/**
 * The scan failures recorded for one path, which is how a fail-closed case says
 * "this is the hole the run refused to pass over".
 *
 * @param {{ path: string, reason: string, detail: string }[]} failures
 * @param {string} relPath
 * @returns {any[]}
 */
function failuresFor(failures, relPath) {
  return failures.filter((failure) => failure.path === relPath);
}

/**
 * Write a file whose body is `size` bytes, creating its parent directories. Used
 * to put a file one byte over the scanner's read limit into a synthetic tree.
 *
 * @param {string} root
 * @param {string} relPath
 * @param {number} size
 * @returns {void}
 */
function writeFileOfSize(root, relPath, size) {
  const absolute = at(root, relPath);
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, 'x'.repeat(size), 'utf8');
}

/**
 * Whether this process can be denied read access by a mode bit. Root cannot: it
 * bypasses the permission check, so the one case built on `chmod` is declared
 * skipped there rather than silently asserting nothing. Every other fail-closed
 * case below is uid-independent by construction, and CI runs as a normal user,
 * where this case does run.
 */
const canBeDeniedByMode = typeof process.getuid === 'function' && process.getuid() !== 0;
if (!canBeDeniedByMode) {
  process.stderr.write(
    'check-no-hardcoding.test: skipping the permission-denied traversal case - this process is root, ' +
      'which bypasses mode bits; the other fail-closed cases assert the same propagation without permissions.\n',
  );
}

/**
 * Whether this filesystem lets the test create a symbolic link. Linux and macOS
 * do; a Windows checkout without the privilege does not, and the two link cases
 * are declared skipped there instead of failing for an unrelated reason.
 */
const canCreateSymlinks = (() => {
  const probe = mkdtempSync(path.join(os.tmpdir(), 'debuggen-nohc-link-'));
  temporaryRoots.push(probe);
  try {
    writeFileSync(path.join(probe, 'target.txt'), 'probe\n', 'utf8');
    symlinkSync('./target.txt', path.join(probe, 'link.txt'));
    return true;
  } catch {
    return false;
  }
})();

/**
 * Run the command-line entry point against a synthetic root, capturing both
 * streams. `main()` deliberately never calls `process.exit`, so the exit code is
 * a return value an in-process test can assert on.
 *
 * @param {string[]} argv Arguments after the script path.
 * @param {string} [root] Absolute repository root; defaults to this repository.
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
async function runCli(argv, root) {
  /** @type {string[]} */
  const out = [];
  /** @type {string[]} */
  const err = [];
  const originalStdout = process.stdout.write.bind(process.stdout);
  const originalStderr = process.stderr.write.bind(process.stderr);
  process.stdout.write = (/** @type {any} */ chunk) => {
    out.push(String(chunk));
    return true;
  };
  process.stderr.write = (/** @type {any} */ chunk) => {
    err.push(String(chunk));
    return true;
  };
  try {
    const code = root === undefined ? await main(argv) : await main(argv, root);
    return { code, stdout: out.join(''), stderr: err.join('') };
  } finally {
    process.stdout.write = originalStdout;
    process.stderr.write = originalStderr;
  }
}

/* -------------------------------------------------------------------------------------------------
 * ts-morph capability probe
 * ---------------------------------------------------------------------------------------------- */

/**
 * Ask the scanner itself whether it can parse, rather than re-implementing its
 * resolution order here. The probe doubles as a warm-up: ts-morph is cached
 * inside the scanner module, so the first AST case does not pay for the import.
 *
 * @returns {Promise<{ available: boolean, reason: string }>}
 */
async function probeAstScan() {
  const root = makeTree({
    ...artifacts({ identifiers: ['RecommendationsRail'] }),
    'apps/local-service/src/probe.ts': source('export const probe = 1;'),
  });
  try {
    const scan = await scanProductSource(root, undefined, { allowlist: null });
    return { available: scan.filesScanned === 1, reason: '' };
  } catch (error) {
    if (
      error instanceof HardcodingCheckError &&
      (error.code === 'ts-morph-missing' || error.code === 'ts-morph-incompatible')
    ) {
      return { available: false, reason: `${error.code}: ${error.message}` };
    }
    throw error;
  }
}

const astScan = await probeAstScan();
if (!astScan.available) {
  process.stderr.write(
    `check-no-hardcoding.test: skipping the AST-backed cases - ${astScan.reason}\n` +
      'check-no-hardcoding.test: a skip is not coverage; run `pnpm install` and re-run `pnpm test`.\n',
  );
}

/**
 * Declaration options for a case that needs the AST scan: skipped when ts-morph
 * could not be resolved, and bounded so a pathological parse cannot hang the
 * run. A fresh object per call, because the runner owns what it is handed.
 *
 * The options form is used rather than `it.skipIf(...)` deliberately: a test
 * declared through a chained modifier is not enumerated by `vitest list`
 * (measured with Vitest 5.0.1), which would hide these cases from any tooling
 * that inventories the suite.
 *
 * @returns {{ skip: boolean, timeout: number }}
 */
function astCase() {
  return { skip: !astScan.available, timeout: AST_TIMEOUT_MS };
}

/* -------------------------------------------------------------------------------------------------
 * AAP 0.5.4 case 1: a deliberate cheat fails
 * ---------------------------------------------------------------------------------------------- */

/**
 * The forbidden pattern of AAP 0.1.2, written as a product file would have to
 * write it to work: a pre-authored panel for a demo component, selected by
 * matching the developer's question. It trips two rules at once, which is the
 * point - the gate does not depend on either half alone.
 */
const DELIBERATE_CHEAT = source(
  "import type { PanelSpec } from '@debuggen/panel-schema';",
  '',
  '// A pre-authored panel kept in the product, selected from the question wording.',
  "import { RecommendationsRail } from './authored/panels';",
  '',
  'export function generatePanel(question: string): PanelSpec | null {',
  "  if (question.includes('button slow')) {",
  '    return RecommendationsRail;',
  '  }',
  '  return null;',
  '}',
);

describe('case 1: a deliberate cheat fails', () => {
  /** @returns {string} A tree whose only product file is the cheat. */
  function cheatTree() {
    return makeTree({
      ...artifacts(
        {
          identifiers: ['RecommendationsRail', 'useRecommendations'],
          routePaths: ['/api/recommendations'],
        },
        { identifiers: ['Button'] },
      ),
      'apps/local-service/src/panels/generate.ts': DELIBERATE_CHEAT,
    });
  }

  it(
    'reports the demo identifier at both of its positions and the question branch',
    astCase(),
    async () => {
      const root = cheatTree();
      const { findings, filesScanned } = await scanProductSource(root);

      expect(filesScanned).toBe(1);
      expect(rulesOf(findings)).toEqual(['policy-identifier', 'question-branch']);

      const identifiers = byRule(findings, 'policy-identifier');
      expect(identifiers).toHaveLength(2);
      for (const finding of identifiers) {
        expect(finding.file).toBe('apps/local-service/src/panels/generate.ts');
        expect(finding.match).toBe('RecommendationsRail');
        expect(finding.hint).not.toBe('');
      }
      expect({ line: identifiers[0].line, column: identifiers[0].column }).toEqual(
        positionOnLine(DELIBERATE_CHEAT, 'import { RecommendationsRail }', 'RecommendationsRail'),
      );
      expect({ line: identifiers[1].line, column: identifiers[1].column }).toEqual(
        positionOnLine(DELIBERATE_CHEAT, 'return RecommendationsRail', 'RecommendationsRail'),
      );

      const [branch] = byRule(findings, 'question-branch');
      expect(branch.file).toBe('apps/local-service/src/panels/generate.ts');
      expect({ line: branch.line, column: branch.column }).toEqual(
        positionOf(DELIBERATE_CHEAT, 'question.includes'),
      );
      expect(branch.message).toContain('includes');
      expect(branch.snippet).toContain("question.includes('button slow')");
    },
  );

  it(
    'fails the gate: check() is not ok and the command line exits non-zero',
    astCase(),
    async () => {
      const root = cheatTree();

      const result = await check(root, { stale: false });
      expect(result.ok).toBe(false);
      expect(result.exitCode).toBe(EXIT_FINDINGS);
      expect(rulesOf(result.findings)).toEqual(['policy-identifier', 'question-branch']);
      // Findings arrive ordered by file, then line, then column - the import, then the branch,
      // then the pre-authored panel the branch returns.
      expect(result.findings.map((finding) => [finding.line, finding.rule])).toEqual([
        [
          positionOnLine(DELIBERATE_CHEAT, 'import { RecommendationsRail }', 'RecommendationsRail')
            .line,
          'policy-identifier',
        ],
        [positionOf(DELIBERATE_CHEAT, 'question.includes').line, 'question-branch'],
        [
          positionOnLine(DELIBERATE_CHEAT, 'return RecommendationsRail', 'RecommendationsRail')
            .line,
          'policy-identifier',
        ],
      ]);

      const cli = await runCli([], root);
      expect(cli.code).toBe(EXIT_FINDINGS);
      expect(cli.stdout).toContain('apps/local-service/src/panels/generate.ts');
      expect(cli.stdout).toContain('policy-identifier');
      expect(cli.stdout).toContain('question-branch');
      expect(cli.stdout).toContain('3 violations');
    },
  );
});

/* -------------------------------------------------------------------------------------------------
 * AAP 0.5.4 case 2: a prompt-level cheat fails
 * ---------------------------------------------------------------------------------------------- */

/** A versioned prompt that names a demo route instead of describing the answer's shape. */
const PROMPT_CHEAT = source(
  '# Panel generation (v001)',
  '',
  'Compose the panel from catalogued node types only.',
  '',
  'When the question is about duplicate requests, put the calls to /api/recommendations first.',
);

/** The prompt manifest, carrying the same knowledge in a JSON value. */
const MANIFEST_CHEAT = source(
  '{',
  '  "version": 1,',
  '  "stages": {',
  '    "generate-panel": {',
  '      "version": "v001",',
  '      "guidance": "Lead with the RecommendationsRail duplicate requests."',
  '    }',
  '  }',
  '}',
);

/** The deterministic provider's template module: pre-authored output if it carries demo names. */
const TEMPLATE_CHEAT = source(
  'export const duplicateRequestPanel = {',
  "  title: 'Duplicate requests',",
  "  request: { method: 'GET', url: '/api/recommendations' },",
  '};',
);

describe('case 2: a prompt-level cheat fails', () => {
  /** @returns {string} A tree whose three generation inputs each carry demo knowledge. */
  function promptTree() {
    return makeTree({
      ...artifacts(
        {
          identifiers: ['RecommendationsRail', 'useRecommendations'],
          routePaths: ['/api/recommendations'],
        },
        { identifiers: ['Button'] },
      ),
      'apps/local-service/prompts/generate-panel/v001.md': PROMPT_CHEAT,
      'apps/local-service/prompts/manifest.json': MANIFEST_CHEAT,
      'packages/model-provider/src/deterministic/templates.ts': TEMPLATE_CHEAT,
    });
  }

  it('reports the prompt file that names a demo route', () => {
    const root = promptTree();
    const { findings } = scanStructuredText(root);

    const routes = byRule(findings, 'policy-route-text');
    const prompt = routes.find(
      (finding) => finding.file === 'apps/local-service/prompts/generate-panel/v001.md',
    );
    expect(prompt).toBeDefined();
    expect(prompt.match).toBe('/api/recommendations');
    expect({ line: prompt.line, column: prompt.column }).toEqual(
      positionOf(PROMPT_CHEAT, '/api/recommendations'),
    );
    expect(prompt.message).toContain('/api/recommendations');
    expect(prompt.hint).not.toBe('');
  });

  it('covers all three structured-text surfaces with the same policy', () => {
    const root = promptTree();
    const { findings, filesScanned } = scanStructuredText(root);

    expect(filesScanned).toBe(3);
    expect(rulesOf(findings)).toEqual(['policy-identifier-text', 'policy-route-text']);

    const [manifest] = byRule(findings, 'policy-identifier-text');
    expect(manifest.file).toBe('apps/local-service/prompts/manifest.json');
    expect(manifest.match).toBe('RecommendationsRail');
    expect({ line: manifest.line, column: manifest.column }).toEqual(
      positionOf(MANIFEST_CHEAT, 'RecommendationsRail'),
    );

    const template = byRule(findings, 'policy-route-text').find(
      (finding) => finding.file === 'packages/model-provider/src/deterministic/templates.ts',
    );
    expect(template).toBeDefined();
    expect({ line: template.line, column: template.column }).toEqual(
      positionOf(TEMPLATE_CHEAT, '/api/recommendations'),
    );
  });

  it(
    'fails the whole gate, and the template module is caught by the source pass as well',
    astCase(),
    async () => {
      const root = promptTree();

      const sourcePass = await scanProductSource(root);
      const [route] = byRule(sourcePass.findings, 'policy-route');
      expect(route.file).toBe('packages/model-provider/src/deterministic/templates.ts');
      expect(route.match).toBe('/api/recommendations');

      const result = await check(root, { stale: false });
      expect(result.ok).toBe(false);
      expect(result.exitCode).toBe(EXIT_FINDINGS);
      expect(rulesOf(result.findings)).toEqual([
        'policy-identifier-text',
        'policy-route',
        'policy-route-text',
      ]);
      expect(result.structuredFilesScanned).toBe(3);
    },
  );
});

/* -------------------------------------------------------------------------------------------------
 * AAP 0.5.4 case 3: a legitimate overlap passes
 * ---------------------------------------------------------------------------------------------- */

/** A product primitive of the design system. `Button` is generic vocabulary, not demo knowledge. */
const BUTTON_PRIMITIVE = source(
  "import type { ReactNode } from 'react';",
  '',
  'export interface ButtonProps {',
  '  children: ReactNode;',
  '  onClick?: () => void;',
  '}',
  '',
  'export function Button({ children, onClick }: ButtonProps) {',
  '  return (',
  '    <button type="button" className="dg-button" onClick={onClick}>',
  '      {children}',
  '    </button>',
  '  );',
  '}',
);

/** A second product file that imports and renders the primitive. */
const BUTTON_USAGE = source(
  "import { Button } from '../primitives/Button';",
  '',
  'export function Toolbar() {',
  '  return <Button>Reload</Button>;',
  '}',
);

describe('case 3: a legitimate overlap passes', () => {
  /** @returns {string} A tree whose only product files declare and use `Button`. */
  function buttonTree() {
    return makeTree({
      ...artifacts(
        { identifiers: ['RecommendationsRail'], routePaths: ['/api/recommendations'] },
        { identifiers: ['Button'] },
      ),
      'packages/panel-renderer/src/primitives/Button.tsx': BUTTON_PRIMITIVE,
      'packages/panel-renderer/src/layout/Toolbar.tsx': BUTTON_USAGE,
    });
  }

  it(
    'finds nothing in a product Button primitive that the allowlist covers',
    astCase(),
    async () => {
      const root = buttonTree();
      const result = await check(root, { stale: false });

      expect(result.findings).toEqual([]);
      expect(result.ok).toBe(true);
      expect(result.exitCode).toBe(EXIT_OK);
      // The files really were parsed, so "no findings" is not "nothing scanned".
      expect(result.sourceFilesScanned).toBe(2);
    },
  );

  it(
    'still passes when a hand-edited policy lists an allowlisted name, and warns about it',
    astCase(),
    async () => {
      const root = buttonTree();
      // A policy that lists an allowlisted entry cannot be a faithful regeneration, because
      // `--update` subtracts the allowlist. The scanner subtracts it defensively at check time so
      // that honest product code never fails, and says so in a note.
      writeFileSync(
        path.join(root, ...POLICY_FILE.split('/')),
        policyDocument({
          identifiers: ['Button', 'RecommendationsRail'],
          routePaths: ['/api/recommendations'],
        }),
        'utf8',
      );

      const result = await check(root, { stale: false });
      expect(result.findings).toEqual([]);
      expect(result.ok).toBe(true);

      const warning = result.notes.find((note) => note.startsWith('warning:'));
      expect(warning).toBeDefined();
      expect(warning).toContain('Button');
      expect(warning).toContain(POLICY_FILE);
      expect(warning).toContain(ALLOWLIST_FILE);
      expect(warning).toContain('not a faithful regeneration');
    },
  );
});

/* -------------------------------------------------------------------------------------------------
 * AAP 0.5.4 case 4: `--update` cannot be blessed by a leak
 * ---------------------------------------------------------------------------------------------- */

/**
 * The demo corpus: one component and one route handler. `formatUnitPrice` is
 * deliberately shared with the independent fixture corpus and `Button` with the
 * allowlist, so the two documented subtractions are observed here too.
 */
const DEMO_COMPONENT = source(
  "import { RecommendationTile } from './RecommendationTile';",
  "import { Button } from '../ui/Button';",
  '',
  'export function RecommendationsRail() {',
  '  return (',
  '    <section>',
  '      <RecommendationTile />',
  '      <Button>More</Button>',
  '    </section>',
  '  );',
  '}',
  '',
  'export function formatUnitPrice(cents: number) {',
  '  return `$${(cents / 100).toFixed(2)}`;',
  '}',
);

/** The demo's App Router handler, which is where `/api/recommendations` is harvested from. */
const DEMO_ROUTE_HANDLER = source(
  'export async function GET() {',
  '  return Response.json([]);',
  '}',
);

/** The independent corpus (AAP 0.5.4), whose names are subtracted from the policy. */
const FIXTURE_FORMAT = source(
  'export function formatUnitPrice(cents: number) {',
  '  return String(cents);',
  '}',
);

/**
 * The leak: a product file that already names the demo component, declares an
 * identifier of its own that would qualify for the policy if the product tree
 * were ever harvested, and names a route of its own.
 */
const PRODUCT_LEAK = source(
  "import { RecommendationsRail } from './authored/panels';",
  '',
  "export const internalPanelRoute = '/api/local-service-internal';",
  '',
  'export function leakedPanelFactory() {',
  '  return RecommendationsRail;',
  '}',
);

describe('case 4: `--update` cannot be blessed by a leak', () => {
  /** @returns {string} A tree with a demo corpus, a fixture corpus and a leaking product file. */
  function leakTree() {
    return makeTree({
      ...artifacts({}, { identifiers: ['Button'] }),
      [`${DEMO_TREE}/src/components/product/RecommendationsRail.tsx`]: DEMO_COMPONENT,
      [`${DEMO_TREE}/app/api/recommendations/route.ts`]: DEMO_ROUTE_HANDLER,
      [`${FIXTURE_TREE}/src/lib/format.ts`]: FIXTURE_FORMAT,
      'apps/local-service/src/panels/generate.ts': PRODUCT_LEAK,
    });
  }

  it('harvests the demo identifier and route from the corpus alone', astCase(), async () => {
    const root = leakTree();
    const policy = await buildPolicy(root);

    // Exactly the demo's two-token declarations, minus the fixture corpus and the allowlist.
    expect(policy.identifiers).toEqual(['RecommendationTile', 'RecommendationsRail']);
    expect(policy.routePaths).toEqual(['/api/recommendations']);
    expect(policy.corpusState.state).toBe('ready');
    expect(policy.corpus).toBe(DEMO_TREE);
    expect(policy.exclusions).toEqual([FIXTURE_TREE, ALLOWLIST_FILE]);

    // The negative property this case exists for: the product tree is never consulted, so a
    // name that has leaked into it cannot bless itself, and a product-only name cannot enter.
    expect(policy.identifiers).not.toContain('leakedPanelFactory');
    expect(policy.routePaths).not.toContain('/api/local-service-internal');
    // The two documented subtractions.
    expect(policy.identifiers).not.toContain('formatUnitPrice');
    expect(policy.identifiers).not.toContain('Button');
  });

  it('writes a policy that still lists the leaked identifier', astCase(), async () => {
    const root = leakTree();
    const cli = await runCli(['--update'], root);

    expect(cli.code).toBe(EXIT_OK);
    expect(cli.stdout).toContain(`wrote ${POLICY_FILE}`);
    expect(cli.stdout).toContain('RecommendationsRail');

    const written = readFileSync(path.join(root, ...POLICY_FILE.split('/')), 'utf8');
    expect(written).toBe(
      policyDocument({
        identifiers: ['RecommendationTile', 'RecommendationsRail'],
        routePaths: ['/api/recommendations'],
      }),
    );
    expect(written).not.toContain('leakedPanelFactory');
    expect(written).not.toContain('/api/local-service-internal');

    // The written file is a policy this scanner accepts and enforces.
    const reloaded = await loadPolicy(root);
    expect(reloaded.identifiers).toContain('RecommendationsRail');
    expect(reloaded.routePaths).toContain('/api/recommendations');

    // And enforcing it flags the leak that the regeneration refused to bless.
    const result = await check(root, { stale: false });
    const leak = byRule(result.findings, 'policy-identifier').find(
      (finding) => finding.file === 'apps/local-service/src/panels/generate.ts',
    );
    expect(leak).toBeDefined();
    expect(leak.match).toBe('RecommendationsRail');
  });
});

/* -------------------------------------------------------------------------------------------------
 * class A: references into the demo application
 * ---------------------------------------------------------------------------------------------- */

/** Three ways a product file can reach for the demo: a relative path, the package, a bare string. */
const DEMO_REFERENCES = source(
  "import { reserveStock } from '../../../apps/demo-app/src/server/services/inventory.service';",
  `import { placeOrder } from '${DEMO_PACKAGE}/checkout';`,
  '',
  "export const demoProjectRoot = 'apps/demo-app';",
  '',
  'export function run() {',
  '  return reserveStock(placeOrder());',
  '}',
);

describe('demo-import and demo-path', () => {
  it('reports imports and path strings that name the demo application', astCase(), async () => {
    const root = makeTree({
      // No identifiers: this case is about class A alone, so nothing else can fire.
      ...artifacts({}),
      'apps/chrome-extension/src/background/leak.ts': DEMO_REFERENCES,
    });
    const { findings } = await scanProductSource(root);

    expect(rulesOf(findings)).toEqual(['demo-import', 'demo-path']);

    const imports = byRule(findings, 'demo-import');
    expect(imports).toHaveLength(2);
    expect({ line: imports[0].line, column: imports[0].column }).toEqual(
      positionOnLine(DEMO_REFERENCES, 'inventory.service', "'../../../apps/demo-app"),
    );
    expect(imports[0].match).toContain('apps/demo-app');
    expect(imports[1].match).toBe(`${DEMO_PACKAGE}/checkout`);

    const [demoPath] = byRule(findings, 'demo-path');
    expect({ line: demoPath.line, column: demoPath.column }).toEqual(
      positionOnLine(DEMO_REFERENCES, 'demoProjectRoot', "'apps/demo-app'"),
    );
    expect(demoPath.match).toBe('apps/demo-app');

    // One finding per position: an import specifier is also a string literal, and the more
    // specific rule owns it.
    const atImport = findings.filter(
      (finding) => finding.line === imports[0].line && finding.column === imports[0].column,
    );
    expect(atImport).toHaveLength(1);
    expect(atImport[0].rule).toBe('demo-import');
  });

  it('scans every product tree', astCase(), async () => {
    // Pinned to the trees AAP 0.5.4 names, so shrinking the list is a failure here rather than
    // a silently narrower gate: the expectations below are derived from the constant.
    expect([...PRODUCT_TREES]).toEqual([
      'apps/local-service',
      'apps/vscode-extension',
      'apps/chrome-extension',
      'packages',
    ]);

    /** @type {Record<string, string>} */
    const files = { ...artifacts({ identifiers: ['RecommendationsRail'] }) };
    /** @type {string[]} */
    const expected = [];
    for (const tree of PRODUCT_TREES) {
      // `packages` is a directory of workspaces, so its file needs one more level.
      const relPath =
        tree === 'packages' ? `${tree}/panel-schema/src/spec.ts` : `${tree}/src/leak.ts`;
      files[relPath] = source("export const authored = 'RecommendationsRail';");
      expected.push(relPath);
    }
    const root = makeTree(files);

    const { findings, filesScanned } = await scanProductSource(root);
    expect(filesScanned).toBe(PRODUCT_TREES.length);
    expect(findings.map((finding) => finding.file).sort()).toEqual([...expected].sort());
    expect(rulesOf(findings)).toEqual(['policy-identifier']);
  });
});

/* -------------------------------------------------------------------------------------------------
 * class C: the question-branch rule and its single exemption
 * ---------------------------------------------------------------------------------------------- */

/** The generic tokenizer: the one file allowed to look at the question's wording. */
const TOKENIZER = source(
  "const stopWords = new Set(['the', 'is', 'why']);",
  '',
  'export function tokenize(question: string): string[] {',
  "  const collapsed = question.includes('  ') ? question.replace(/\\s+/g, ' ') : question;",
  '  return collapsed',
  '    .toLowerCase()',
  '    .split(/[^a-z0-9]+/)',
  '    .filter((token) => token.length > 2 && !stopWords.has(token));',
  '}',
  '',
  '// Class B still applies to this file, exemption or not.',
  "export const authoredHint = 'RecommendationsRail';",
);

/** The same construct in a file with no exemption. */
const NON_EXEMPT_BRANCH = source(
  'export function pickPanel(session: { question: string }) {',
  "  if (session.question.toLowerCase().includes('slow')) {",
  "    return 'latency';",
  '  }',
  "  return 'generic';",
  '}',
);

/** Honest control flow the rule must not fire on. */
const LENGTH_GUARD = source(
  'export function isBlank(question: string): boolean {',
  '  if (question.length === 0) {',
  '    return true;',
  '  }',
  '  return question.trim().length === 0;',
  '}',
);

describe('question-branch', () => {
  it(
    'fires outside the tokenizer, never inside it, and never on question.length',
    astCase(),
    async () => {
      const root = makeTree({
        ...artifacts({ identifiers: ['RecommendationsRail'] }),
        [QUESTION_EXEMPT_FILE]: TOKENIZER,
        'apps/local-service/src/panels/generate.ts': NON_EXEMPT_BRANCH,
        'apps/local-service/src/sessions/guard.ts': LENGTH_GUARD,
      });
      const { findings } = await scanProductSource(root);

      // The exemption is class C only, and it is scoped to the one file.
      const inTokenizer = findings.filter((finding) => finding.file === QUESTION_EXEMPT_FILE);
      expect(rulesOf(inTokenizer)).toEqual(['policy-identifier']);
      expect(inTokenizer).toHaveLength(1);
      expect({ line: inTokenizer[0].line, column: inTokenizer[0].column }).toEqual(
        positionOnLine(TOKENIZER, 'authoredHint', 'RecommendationsRail'),
      );

      const branches = byRule(findings, 'question-branch');
      expect(branches).toHaveLength(1);
      expect(branches[0].file).toBe('apps/local-service/src/panels/generate.ts');
      expect({ line: branches[0].line, column: branches[0].column }).toEqual(
        positionOnLine(NON_EXEMPT_BRANCH, 'session.question', 'session.question'),
      );

      // Comparing the length of a question is not matching on its wording.
      expect(findings.filter((finding) => finding.file.endsWith('guard.ts'))).toEqual([]);
    },
  );
});

/* -------------------------------------------------------------------------------------------------
 * policy-stale
 * ---------------------------------------------------------------------------------------------- */

/** A demo corpus that declares one more name than the committed policy knows about. */
const DRIFTED_DEMO = source(
  'export function RecommendationsRail() {',
  '  return null;',
  '}',
  '',
  'export function useRecommendations() {',
  '  return [];',
  '}',
);

describe('policy-stale', () => {
  /** @returns {string} A tree whose committed policy omits one harvested identifier. */
  function driftedTree() {
    return makeTree({
      ...artifacts(
        { identifiers: ['RecommendationsRail'], routePaths: ['/api/recommendations'] },
        { identifiers: ['Button'] },
      ),
      [`${DEMO_TREE}/src/components/product/RecommendationsRail.tsx`]: DRIFTED_DEMO,
      [`${DEMO_TREE}/app/api/recommendations/route.ts`]: DEMO_ROUTE_HANDLER,
      'apps/local-service/src/sessions/manager.ts': source(
        'export function createSessionManager() {',
        '  return { sessions: new Map<string, unknown>() };',
        '}',
      ),
    });
  }

  it(
    'reports a committed policy the corpus no longer produces, naming what is missing',
    astCase(),
    async () => {
      const root = driftedTree();
      const result = await check(root);

      const [stale] = byRule(result.findings, 'policy-stale');
      expect(stale).toBeDefined();
      expect(stale.file).toBe(POLICY_FILE);
      expect(stale.line).toBe(1);
      expect(stale.column).toBe(1);
      expect(stale.message).toContain('pnpm check:no-hardcoding --update');
      expect(stale.message).toContain(DEMO_TREE);
      expect(stale.hint).toContain(POLICY_FILE);

      expect(result.stale).not.toBeNull();
      expect(result.stale.corpus.state).toBe('ready');
      expect(result.stale.enforced).toBe(true);
      expect(result.stale.drifted).toBe(true);
      expect(result.stale.added.identifiers).toContain('useRecommendations');
      expect(result.stale.removed.identifiers).toEqual([]);

      // The report is where a developer reads which entry is missing.
      const report = renderReport(result);
      expect(report).toContain('identifiers to add:');
      expect(report).toContain('useRecommendations');
      expect(report).toContain('pnpm check:no-hardcoding --update');
      expect(result.exitCode).toBe(EXIT_FINDINGS);
    },
  );

  it('is cleared by `--update`, which is idempotent', astCase(), async () => {
    const root = driftedTree();

    const update = await runCli(['--update'], root);
    expect(update.code).toBe(EXIT_OK);
    expect(update.stdout).toContain('useRecommendations');

    const after = await check(root);
    expect(after.findings).toEqual([]);
    expect(after.ok).toBe(true);
    expect(after.stale.drifted).toBe(false);
    expect(after.stale.corpus.state).toBe('ready');

    // Running it again changes nothing.
    const again = await runCli(['--update'], root);
    expect(again.code).toBe(EXIT_OK);
    expect(again.stdout).toContain('already up to date');
  });
});

/* -------------------------------------------------------------------------------------------------
 * the policy's canonical form
 * ---------------------------------------------------------------------------------------------- */

// AAP 0.5.4 makes the policy a generated artifact: `--update` from the demo's
// code index is the only way it is produced, it is committed and reviewed, "and
// the check fails if the committed policy is stale". The committed BYTES are
// therefore the contract - the file is prettier-ignored precisely so its
// generator owns them - and the cases below are the ones a comparison of
// membership alone lets through: the same names in a different order, a name
// listed twice, a reformatted file, a hand-written provenance field. Each leaves
// a committed artifact no regeneration reproduces while changing nothing about
// which names the gate matches, which is exactly why the gate has to see them.

/**
 * Two demo component names that order differently under a case-sensitive ASCII
 * sort than under a case-insensitive or locale-aware one: `T` (0x54) sorts
 * before `r` (0x72), so `AddToCartControl` comes first and `AddressFields`
 * second. Every case below is built on this one pair, because it is the
 * smallest difference a set comparison cannot see - both orders list the same
 * two names - and it is what a hand-resolved merge or a `localeCompare` sort
 * actually produces.
 */
const CANONICAL_PAIR = Object.freeze(['AddToCartControl', 'AddressFields']);

/** The same two names in the order a case-insensitive sort puts them. */
const CASE_INSENSITIVE_PAIR = Object.freeze(['AddressFields', 'AddToCartControl']);

/** The demo corpus for these cases: two components, and nothing else to harvest. */
const CANONICAL_PAIR_CORPUS = Object.freeze({
  [`${DEMO_TREE}/src/components/cart/AddToCartControl.tsx`]: source(
    'export function AddToCartControl() {',
    '  return null;',
    '}',
  ),
  [`${DEMO_TREE}/src/components/checkout/AddressFields.tsx`]: source(
    'export function AddressFields() {',
    '  return null;',
    '}',
  ),
});

/**
 * Write a policy document **verbatim**: the arrays keep the order they are
 * given, the indentation and the trailing newline are the caller's, and the
 * metadata can be overridden. This is the only way a fixture can express a
 * non-canonical file at all - `policyDocument()` goes through
 * `serializePolicy()`, which would sort and reformat the drift away before the
 * scanner ever saw it.
 *
 * @param {{ identifiers?: string[], routePaths?: string[], metadata?: Record<string, unknown>, indent?: number, trailingNewline?: boolean }} [options]
 * @returns {string}
 */
function verbatimPolicyDocument(options = {}) {
  const body = JSON.stringify(
    {
      ...POLICY_METADATA,
      ...(options.metadata ?? {}),
      identifiers: options.identifiers ?? [...CANONICAL_PAIR],
      routePaths: options.routePaths ?? [],
    },
    null,
    options.indent ?? 2,
  );
  return options.trailingNewline === false ? body : `${body}\n`;
}

/**
 * A tree whose demo corpus declares exactly {@link CANONICAL_PAIR} and whose
 * committed policy is the given text, byte for byte.
 *
 * @param {string} policyText
 * @returns {string} Absolute root of the new tree.
 */
function canonicalFormTree(policyText) {
  return makeTree({
    [POLICY_FILE]: policyText,
    [ALLOWLIST_FILE]: allowlistDocument({ identifiers: ['Button'] }),
    ...CANONICAL_PAIR_CORPUS,
    'apps/local-service/src/sessions/manager.ts': source(
      'export function createSessionManager() {',
      '  return { sessions: new Map<string, unknown>() };',
      '}',
    ),
  });
}

describe('policy canonical form', () => {
  it(
    'fails an order-only difference, which a membership comparison cannot see',
    astCase(),
    async () => {
      const root = canonicalFormTree(
        verbatimPolicyDocument({ identifiers: [...CASE_INSENSITIVE_PAIR] }),
      );
      const result = await check(root);

      expect(result.stale).not.toBeNull();
      expect(result.stale.corpus.state).toBe('ready');
      expect(result.stale.enforced).toBe(true);
      expect(result.stale.drifted).toBe(true);

      // Nothing to add, nothing to remove, no metadata difference: the file
      // lists exactly the harvest's names. Order is the whole of the drift, so
      // these four assertions are what makes this case a regression test rather
      // than a restatement of the membership comparison.
      expect(result.stale.added).toEqual({ identifiers: [], routePaths: [] });
      expect(result.stale.removed).toEqual({ identifiers: [], routePaths: [] });
      expect(result.stale.fields).toEqual([]);
      expect(result.stale.serialization.canonical).toBe(false);
      expect(result.stale.serialization.byteEqual).toBe(false);
      expect(result.stale.serialization.reasons).toHaveLength(1);
      expect(result.stale.serialization.reasons[0]).toContain(
        'not in canonical case-sensitive ASCII order',
      );
      expect(result.stale.serialization.reasons[0]).toContain(
        '"AddressFields" precedes "AddToCartControl"',
      );

      const [stale] = byRule(result.findings, 'policy-stale');
      expect(stale).toBeDefined();
      expect(stale.file).toBe(POLICY_FILE);
      expect(stale.line).toBe(1);
      expect(stale.column).toBe(1);
      expect(stale.message).toContain('pnpm check:no-hardcoding --update');
      // The message carries the reason, so a compact log says what to look at.
      expect(stale.message).toContain('not in canonical case-sensitive ASCII order');
      expect(result.ok).toBe(false);
      expect(result.exitCode).toBe(EXIT_FINDINGS);

      const report = renderReport(result);
      expect(report).toContain(
        'form: `identifiers` is not in canonical case-sensitive ASCII order',
      );
      expect(report).toContain('identifiers to add:    none');
      expect(report).toContain('pnpm check:no-hardcoding --update');

      const cli = await runCli([], root);
      expect(cli.code).toBe(EXIT_FINDINGS);
    },
  );

  it(
    'is cured byte-for-byte by `--update`, which says why it rewrote the file',
    astCase(),
    async () => {
      const root = canonicalFormTree(
        verbatimPolicyDocument({ identifiers: [...CASE_INSENSITIVE_PAIR] }),
      );

      const update = await runCli(['--update'], root);
      expect(update.code).toBe(EXIT_OK);
      // No entry was added or removed, so the summary has to account for the
      // rewrite some other way or the reviewer cannot tell why it happened.
      expect(update.stdout).toContain('added 0 identifiers and 0 route paths');
      expect(update.stdout).toContain("was not the generator's canonical form");
      expect(update.stdout).toContain('not in canonical case-sensitive ASCII order');

      expect(readFileSync(at(root, POLICY_FILE), 'utf8')).toBe(
        policyDocument({ identifiers: [...CANONICAL_PAIR] }),
      );

      const after = await check(root);
      expect(after.findings).toEqual([]);
      expect(after.stale.drifted).toBe(false);
      expect(after.stale.serialization).toEqual({
        canonical: true,
        byteEqual: true,
        reasons: [],
      });
      expect(after.exitCode).toBe(EXIT_OK);

      const again = await runCli(['--update'], root);
      expect(again.code).toBe(EXIT_OK);
      expect(again.stdout).toContain('already up to date');
    },
  );

  it('fails a repeated entry, which the generator never writes', astCase(), async () => {
    const root = canonicalFormTree(
      verbatimPolicyDocument({
        identifiers: ['AddToCartControl', 'AddToCartControl', 'AddressFields'],
      }),
    );
    const result = await check(root);

    // Set arithmetic sees nothing: a repeat is the same membership twice.
    expect(result.stale.added).toEqual({ identifiers: [], routePaths: [] });
    expect(result.stale.removed).toEqual({ identifiers: [], routePaths: [] });
    expect(result.stale.drifted).toBe(true);
    expect(result.stale.serialization.reasons).toHaveLength(1);
    expect(result.stale.serialization.reasons[0]).toContain('`identifiers` repeats 1 entry');
    expect(result.stale.serialization.reasons[0]).toContain('AddToCartControl');
    expect(rulesOf(result.findings)).toEqual(['policy-stale']);
    expect(result.exitCode).toBe(EXIT_FINDINGS);

    const cured = await runCli(['--update'], root);
    expect(cured.code).toBe(EXIT_OK);
    expect(readFileSync(at(root, POLICY_FILE), 'utf8')).toBe(
      policyDocument({ identifiers: [...CANONICAL_PAIR] }),
    );
  });

  it('fails a file that differs only in its formatting', astCase(), async () => {
    const reindented = canonicalFormTree(verbatimPolicyDocument({ indent: 4 }));
    const result = await check(reindented);

    expect(result.stale.drifted).toBe(true);
    expect(result.stale.added).toEqual({ identifiers: [], routePaths: [] });
    expect(result.stale.removed).toEqual({ identifiers: [], routePaths: [] });
    expect(result.stale.fields).toEqual([]);
    expect(result.stale.serialization.byteEqual).toBe(false);
    expect(result.stale.serialization.reasons).toHaveLength(1);
    expect(result.stale.serialization.reasons[0]).toContain('the committed bytes are not what');
    expect(result.stale.serialization.reasons[0]).toContain('indentation');
    expect(rulesOf(result.findings)).toEqual(['policy-stale']);
    expect(result.exitCode).toBe(EXIT_FINDINGS);

    // A missing trailing newline is the same class of difference: correct
    // names, correct order, not the generator's output.
    const unterminated = canonicalFormTree(verbatimPolicyDocument({ trailingNewline: false }));
    const second = await check(unterminated);
    expect(second.stale.serialization.byteEqual).toBe(false);
    expect(second.stale.drifted).toBe(true);
    expect(byRule(second.findings, 'policy-stale')).toHaveLength(1);

    const cured = await runCli(['--update'], unterminated);
    expect(cured.code).toBe(EXIT_OK);
    expect(readFileSync(at(unterminated, POLICY_FILE), 'utf8')).toBe(
      policyDocument({ identifiers: [...CANONICAL_PAIR] }),
    );
  });

  it('fails a hand-written provenance field, and says so once', astCase(), async () => {
    const root = canonicalFormTree(
      verbatimPolicyDocument({ metadata: { generatedBy: 'hand-written by a developer' } }),
    );
    const result = await check(root);

    expect(result.stale.drifted).toBe(true);
    expect(result.stale.fields).toEqual(['generatedBy']);
    // The metadata difference already explains the bytes, so the form report
    // stays silent rather than reporting the same drift a second time.
    expect(result.stale.serialization.reasons).toEqual([]);
    expect(result.stale.serialization.byteEqual).toBe(false);

    const [stale] = byRule(result.findings, 'policy-stale');
    expect(stale.message).toContain('pnpm check:no-hardcoding --update');
    expect(stale.message).not.toContain('the committed bytes are not what');
    expect(renderReport(result)).toContain('metadata fields differ: generatedBy');
    expect(result.exitCode).toBe(EXIT_FINDINGS);
  });

  it("judges an injected policy's form when there are no bytes to compare", astCase(), async () => {
    // The committed file here is canonical; the policy handed to `check()` is
    // not. An injected policy is what the scanner cases use, so its form is
    // judged from the object alone and the byte comparison reports "no answer"
    // rather than a false match.
    const root = canonicalFormTree(policyDocument({ identifiers: [...CANONICAL_PAIR] }));
    const result = await check(root, {
      policy: {
        ...POLICY_METADATA,
        exclusions: [...POLICY_METADATA.exclusions],
        identifiers: [...CASE_INSENSITIVE_PAIR],
        routePaths: [],
      },
    });

    expect(result.stale.serialization.byteEqual).toBeNull();
    expect(result.stale.serialization.canonical).toBe(false);
    expect(result.stale.serialization.reasons[0]).toContain(
      'not in canonical case-sensitive ASCII order',
    );
    expect(result.stale.drifted).toBe(true);
    expect(rulesOf(result.findings)).toEqual(['policy-stale']);
  });

  it('accepts the file the generator writes, byte for byte', astCase(), async () => {
    // The fixture helper and the generator have to agree, or every case above
    // would be asserting against a difference of its own making.
    expect(verbatimPolicyDocument()).toBe(policyDocument({ identifiers: [...CANONICAL_PAIR] }));

    const root = canonicalFormTree(policyDocument({ identifiers: [...CANONICAL_PAIR] }));
    const result = await check(root);

    expect(result.findings).toEqual([]);
    expect(result.failures).toEqual([]);
    expect(result.stale.drifted).toBe(false);
    expect(result.stale.serialization).toEqual({ canonical: true, byteEqual: true, reasons: [] });
    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(EXIT_OK);
  });
});

/* -------------------------------------------------------------------------------------------------
 * the committed policy artifact
 * ---------------------------------------------------------------------------------------------- */

// The cases above prove the gate sees drift in a synthetic tree. None of them
// says anything about the artifact this repository actually ships, and
// `check()`'s byte comparison is not a substitute: it is skipped when
// `apps/demo-app` is absent and skipped when the harvest could read only part of
// it, which is precisely the state of a partial clone, a sparse checkout or an
// unreadable corpus file. The committed policy is this unit's own output, so the
// cases below read it through `DEFAULT_ROOT` and assert what holds whatever the
// demo declares. None of them names a policy entry: the vocabulary belongs to
// the generated file, and duplicating it here would make every demo change a
// test change and every test edit a second, unreviewed policy.

/**
 * The committed policy artifact's exact bytes. `DEFAULT_ROOT` is the scanner's
 * own notion of the repository root, so these cases read the very file the gate
 * reads, and the read happens per case rather than at import time - a missing
 * artifact then fails the cases that assert on it instead of the whole suite.
 *
 * @returns {string}
 */
function committedPolicyText() {
  return readFileSync(at(DEFAULT_ROOT, POLICY_FILE), 'utf8');
}

describe('the committed policy artifact', () => {
  it('is byte-identical to its own canonical serialization', () => {
    // The order-only and formatting drift class, asserted on the committed file
    // and without the corpus: entries out of case-sensitive ASCII order, an
    // entry listed twice, a changed key order, a reindentation. This is the
    // class that reached `main` before, because the comparison that would have
    // caught it needs a corpus and a membership comparison cannot see it at all.
    const text = committedPolicyText();

    expect(text).toBe(serializePolicy(JSON.parse(text)));
  });

  it('carries the metadata a faithful regeneration writes', () => {
    // A hand-written `generatedBy`, a repointed `corpus` or a dropped exclusion
    // makes the file claim a provenance or a subtraction `--update` never
    // performed. `comparePolicies()` reports those as metadata `fields` - again
    // only when the corpus is present - so without this case an artifact
    // produced by hand can look generated on any checkout without the demo.
    const policy = JSON.parse(committedPolicyText());

    expect({
      version: policy.version,
      generatedBy: policy.generatedBy,
      corpus: policy.corpus,
      exclusions: policy.exclusions,
    }).toEqual(POLICY_METADATA);
  });

  it('lists only identifiers the harvest rule keeps', async () => {
    // An entry `--update` could not have produced - a generic name added by
    // hand, an all-caps constant, a single-token name - would fail honest
    // product code under a rule AAP 0.5.4 does not grant. `loadPolicy()` is used
    // rather than `JSON.parse` so the committed document also has to satisfy the
    // shape the gate refuses to run without.
    const policy = await loadPolicy(DEFAULT_ROOT);
    const rejected = policy.identifiers.filter((name) => !isDemoSpecificIdentifier(name));

    expect(
      rejected,
      'committed identifiers the harvest rule would not keep (fewer than two camel-case tokens, ' +
        'shorter than four characters, or an all-caps constant)',
    ).toEqual([]);
  });

  it('shares no entry with the committed allowlist', async () => {
    // `--update` subtracts the allowlist (AAP 0.5.4), so an overlap means the
    // committed policy is not a faithful regeneration of its corpus. `check()`
    // only warns about that and enforces the rest, which is the right runtime
    // behaviour and the reason nothing else in the suite fails on it.
    const policy = await loadPolicy(DEFAULT_ROOT);
    const allowlist = loadAllowlist(DEFAULT_ROOT);

    expect({
      identifiers: policy.identifiers.filter((name) => allowlist.identifiers.includes(name)),
      routePaths: policy.routePaths.filter((route) => allowlist.routePaths.includes(route)),
    }).toEqual({ identifiers: [], routePaths: [] });
  });

  it('is written with no CR, no BOM and exactly one trailing newline', () => {
    // A CRLF checkout filter or an editor-added BOM changes every byte the
    // generator wrote while leaving the parsed document identical, so only a
    // byte-level assertion can see it. Named separately from the serialization
    // case above because the failure message is what tells a developer to look
    // at their line endings rather than at the demo's vocabulary.
    const text = committedPolicyText();

    expect(text).not.toContain('\r');
    expect(text.startsWith('\uFEFF')).toBe(false);
    expect(text.endsWith('}\n')).toBe(true);
    expect(text.endsWith('\n\n')).toBe(false);
  });

  it('is not empty, so no case above can pass by listing nothing', async () => {
    // An emptied policy satisfies every invariant above vacuously while
    // disarming the gate completely. `updatePolicy()` refuses to write one; this
    // asserts the same thing about the file as committed, which is what a
    // hand-edit or a bad merge resolution could still produce.
    const policy = await loadPolicy(DEFAULT_ROOT);

    expect(policy.identifiers.length).toBeGreaterThan(0);
    expect(policy.routePaths.length).toBeGreaterThan(0);
  });
});

/* -------------------------------------------------------------------------------------------------
 * the exclusion list
 * ---------------------------------------------------------------------------------------------- */

describe('exclusions', () => {
  it(
    'lets tests, docs, the demo corpus and product test suites name demo symbols',
    astCase(),
    async () => {
      const root = makeTree({
        ...artifacts({
          identifiers: ['RecommendationsRail'],
          routePaths: ['/api/recommendations'],
        }),
        'tests/e2e/demo-duplicate-requests.spec.ts': source(
          "test('the rail duplicates its request', async () => {",
          '  await page.click(\'[data-component="RecommendationsRail"]\');',
          '});',
        ),
        'docs/DEMO.md': source(
          '# Demo walkthrough',
          '',
          'The RecommendationsRail calls /api/recommendations twice on the product page.',
        ),
        [`${DEMO_TREE}/src/components/product/RecommendationsRail.tsx`]: DRIFTED_DEMO,
        'apps/local-service/src/panels/generate.test.ts': source(
          "it('does not name RecommendationsRail', () => {});",
        ),
        'packages/panel-schema/src/spec.ts': source('export const version = 1;'),
      });

      const result = await check(root, { stale: false });
      expect(result.findings).toEqual([]);
      // The one product file that is not excluded really was parsed.
      expect(result.sourceFilesScanned).toBe(1);
    },
  );
});

/* -------------------------------------------------------------------------------------------------
 * the command-line surface
 * ---------------------------------------------------------------------------------------------- */

describe('command line', () => {
  it('documents every rule id under --help and exits 0', async () => {
    const cli = await runCli(['--help']);

    expect(cli.code).toBe(EXIT_OK);
    for (const rule of RULE_IDS) {
      expect(cli.stdout).toContain(rule);
    }
    expect(cli.stdout).toContain(POLICY_FILE);
    expect(cli.stdout).toContain(ALLOWLIST_FILE);
    expect(cli.stdout).toContain(QUESTION_EXEMPT_FILE);
    expect(cli.stdout).toContain(FIXTURE_TREE);
  });

  it('rejects an unknown flag with the environment exit code', async () => {
    const cli = await runCli(['--not-a-flag']);

    expect(cli.code).toBe(EXIT_ERROR);
    expect(cli.stderr).toContain('unknown option: --not-a-flag');
  });

  it('prints a machine-readable report under --json', astCase(), async () => {
    const root = makeTree({
      ...artifacts({ identifiers: ['RecommendationsRail'] }),
      'apps/local-service/src/panels/generate.ts': DELIBERATE_CHEAT,
    });
    const cli = await runCli(['--json'], root);

    expect(cli.code).toBe(EXIT_FINDINGS);
    const report = JSON.parse(cli.stdout);
    expect(report.ok).toBe(false);
    expect(report.exitCode).toBe(EXIT_FINDINGS);
    expect(rulesOf(report.findings)).toEqual(['policy-identifier', 'question-branch']);
    expect(report.root).toBe(root);
  });
});

/* -------------------------------------------------------------------------------------------------
 * the policy and allowlist artifacts
 * ---------------------------------------------------------------------------------------------- */

describe('policy and allowlist loading', () => {
  it('round-trips the documents these fixtures write', async () => {
    const root = makeTree(
      artifacts(
        { identifiers: ['RecommendationsRail'], routePaths: ['/api/recommendations'] },
        { identifiers: ['Button'], routePaths: [] },
      ),
    );

    const policy = await loadPolicy(root);
    expect(policy.version).toBe(1);
    expect(policy.generatedBy).toBe(`${SCRIPT_FILE} --update`);
    expect(policy.corpus).toBe(DEMO_TREE);
    expect(policy.exclusions).toEqual([FIXTURE_TREE, ALLOWLIST_FILE]);
    expect(policy.identifiers).toEqual(['RecommendationsRail']);
    expect(policy.routePaths).toEqual(['/api/recommendations']);

    const allowlist = loadAllowlist(root);
    expect(allowlist.identifiers).toEqual(['Button']);
    expect(allowlist.routePaths).toEqual([]);
  });

  it('refuses to run against a missing or unusable policy', async () => {
    const withoutPolicy = makeTree({ [ALLOWLIST_FILE]: allowlistDocument() });
    await expect(loadPolicy(withoutPolicy)).rejects.toMatchObject({
      name: 'HardcodingCheckError',
      code: 'policy-missing',
    });

    const withBadPolicy = makeTree({
      [POLICY_FILE]: `${JSON.stringify({ ...POLICY_METADATA, identifiers: ['not an identifier'], routePaths: [] }, null, 2)}\n`,
      [ALLOWLIST_FILE]: allowlistDocument(),
    });
    await expect(loadPolicy(withBadPolicy)).rejects.toMatchObject({
      name: 'HardcodingCheckError',
      code: 'policy-malformed',
    });
  });
});

/* -------------------------------------------------------------------------------------------------
 * drift is enforced whenever the demo corpus is present
 * ---------------------------------------------------------------------------------------------- */

/**
 * A committed policy the corpus mostly cannot account for: nine of its ten
 * identifiers and its one route path belong to demo code that is not in this
 * tree, and only `RecommendationsRail` is. A fresh harvest therefore reproduces
 * far less than half of it - the shape a half-written demo application produces
 * on the way to being finished - and the run must still fail, because a
 * committed policy nobody can regenerate is a gate nobody can trust.
 */
const UNREPRODUCIBLE_IDENTIFIERS = Object.freeze([
  'CartProvider',
  'CatalogGrid',
  'CheckoutButton',
  'ProductCard',
  'RecommendationsRail',
  'ShippingEtaProvider',
  'SiteHeader',
  'placeOrder',
  'reserveStock',
  'useCartSummary',
]);

describe('policy drift enforcement', () => {
  /**
   * @returns {string} A tree whose demo corpus declares one of the ten
   *   committed identifiers, and a route the policy does not list.
   */
  function partialCorpusTree() {
    return makeTree({
      ...artifacts(
        { identifiers: [...UNREPRODUCIBLE_IDENTIFIERS], routePaths: ['/api/checkout'] },
        { identifiers: ['Button'] },
      ),
      [`${DEMO_TREE}/src/components/product/RecommendationsRail.tsx`]: DRIFTED_DEMO,
      [`${DEMO_TREE}/app/api/recommendations/route.ts`]: DEMO_ROUTE_HANDLER,
      'apps/local-service/src/sessions/manager.ts': source(
        'export function createSessionManager() {',
        '  return { sessions: new Map<string, unknown>() };',
        '}',
      ),
    });
  }

  it(
    'fails the run however little of the committed policy the corpus reproduces',
    astCase(),
    async () => {
      const root = partialCorpusTree();
      const result = await check(root);

      // The corpus is present, so it is the definition of the policy and the
      // comparison is authoritative - whatever fraction of the policy it
      // happens to reproduce today.
      expect(result.stale).not.toBeNull();
      expect(result.stale.corpus.state).toBe('ready');
      expect(result.stale.enforced).toBe(true);
      expect(result.stale.drifted).toBe(true);

      const committedEntries = [...UNREPRODUCIBLE_IDENTIFIERS, '/api/checkout'];
      const removed = [...result.stale.removed.identifiers, ...result.stale.removed.routePaths];
      const reproduced = committedEntries.filter((entry) => !removed.includes(entry));
      // One entry of eleven: an exemption keyed on how much of the policy the
      // corpus accounts for would have suppressed exactly this run.
      expect(reproduced).toEqual(['RecommendationsRail']);
      expect(reproduced.length / committedEntries.length).toBeLessThan(0.5);

      const [stale] = byRule(result.findings, 'policy-stale');
      expect(stale).toBeDefined();
      expect(stale.file).toBe(POLICY_FILE);
      expect(result.exitCode).toBe(EXIT_FINDINGS);
      expect(result.ok).toBe(false);

      const report = renderReport(result);
      expect(report).toContain('policy drift against apps/demo-app (enforced)');
      expect(report).toContain('pnpm check:no-hardcoding --update');
      expect(report).not.toContain('not enforced');

      const cli = await runCli([], root);
      expect(cli.code).toBe(EXIT_FINDINGS);
    },
  );

  it(
    '`--update` writes exactly what the corpus yields, dropping what it does not declare',
    astCase(),
    async () => {
      const root = partialCorpusTree();

      const update = await runCli(['--update'], root);
      expect(update.code).toBe(EXIT_OK);

      // No entry survives because the previous file listed it: the regenerated
      // policy is the harvest, so the nine names the demo does not declare go.
      const written = readFileSync(at(root, POLICY_FILE), 'utf8');
      expect(written).toBe(
        policyDocument({
          identifiers: ['RecommendationsRail', 'useRecommendations'],
          routePaths: ['/api/recommendations'],
        }),
      );
      for (const dropped of UNREPRODUCIBLE_IDENTIFIERS.filter(
        (entry) => entry !== 'RecommendationsRail',
      )) {
        expect(written).not.toContain(dropped);
      }
      expect(update.stdout).toContain('entries are being removed, which widens the gate');

      const after = await check(root);
      expect(after.findings).toEqual([]);
      expect(after.stale.drifted).toBe(false);
      expect(after.exitCode).toBe(EXIT_OK);
    },
  );

  it(
    'compares nothing when the demo corpus is absent, and still enforces the policy',
    astCase(),
    async () => {
      const leaking = makeTree({
        ...artifacts({ identifiers: ['RecommendationsRail'] }, { identifiers: ['Button'] }),
        'apps/local-service/src/panels/generate.ts': source(
          "import { RecommendationsRail } from './authored/panels';",
          '',
          'export function panel() {',
          '  return RecommendationsRail;',
          '}',
        ),
      });
      const result = await check(leaking);

      // Absent is the one state that skips the comparison, and skipping it does
      // not soften the policy: the leak is still reported.
      expect(result.stale).toBeNull();
      expect(result.notes.join('\n')).toContain('policy staleness not compared');
      expect(rulesOf(result.findings)).toEqual(['policy-identifier']);
      expect(result.exitCode).toBe(EXIT_FINDINGS);
      expect(result.failures).toEqual([]);

      const clean = makeTree({
        ...artifacts({ identifiers: ['RecommendationsRail'] }, { identifiers: ['Button'] }),
        'packages/panel-renderer/src/primitives/Button.tsx': source(
          'export function Button() {',
          '  return null;',
          '}',
        ),
      });
      const cleanResult = await check(clean);
      expect(cleanResult.findings).toEqual([]);
      expect(cleanResult.stale).toBeNull();
      expect(cleanResult.exitCode).toBe(EXIT_OK);
    },
  );

  it('refuses to regenerate a policy from a corpus that is not there', astCase(), async () => {
    const root = makeTree(artifacts({ identifiers: ['RecommendationsRail'] }));

    await expect(updatePolicy(root, { allowlist: null })).rejects.toMatchObject({
      name: 'HardcodingCheckError',
      code: 'corpus-empty',
    });
    // The committed policy is left exactly as it was: an empty one would pass
    // every product file.
    expect(readFileSync(at(root, POLICY_FILE), 'utf8')).toBe(
      policyDocument({ identifiers: ['RecommendationsRail'] }),
    );

    const cli = await runCli(['--update'], root);
    expect(cli.code).toBe(EXIT_ERROR);
    expect(cli.stderr).toContain('corpus-empty');
  });
});

/* -------------------------------------------------------------------------------------------------
 * the scan fails closed
 * ---------------------------------------------------------------------------------------------- */

/** A product file the scan can read, so a case can prove the rest still ran. */
const READABLE_PRODUCT_FILE = source(
  'export function createSessionManager() {',
  '  return { sessions: new Map<string, unknown>() };',
  '}',
);

describe('fail-closed scanning', () => {
  it('stops the run when a scanned tree exists but is not a directory', astCase(), async () => {
    const root = makeTree({
      ...artifacts({ identifiers: ['RecommendationsRail'] }),
      'apps/local-service/src/sessions/manager.ts': READABLE_PRODUCT_FILE,
      // A file where a product tree belongs: everything it should have
      // contained went unscanned.
      'apps/chrome-extension': 'not a directory\n',
    });

    const result = await check(root, { stale: false });
    const [failure] = failuresFor(result.failures, 'apps/chrome-extension');
    expect(failure).toBeDefined();
    expect(failure.reason).toBe('not-a-directory');
    expect(failure.detail).toContain('unscanned');
    // Recorded once, although both passes walk the product trees.
    expect(failuresFor(result.failures, 'apps/chrome-extension')).toHaveLength(1);

    // The readable part of the tree was still scanned, and the run still fails.
    expect(result.sourceFilesScanned).toBe(1);
    expect(result.findings).toEqual([]);
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(EXIT_ERROR);

    const cli = await runCli([], root);
    expect(cli.code).toBe(EXIT_ERROR);
    expect(cli.stdout).toContain('could not examine');
    expect(cli.stdout).toContain('apps/chrome-extension');
  });

  it('records a file it cannot decode as text rather than passing over it', () => {
    const root = makeTree({
      ...artifacts({ identifiers: ['RecommendationsRail'] }),
      // A structured-text surface whose bytes are not text: its contents were
      // never matched against the policy.
      'packages/protocol/NOTES.md': 'intro\n\u0000\u0000binary tail\n',
      'packages/protocol/README.md': '# Protocol\n\nNo demo vocabulary here.\n',
    });

    const scan = scanStructuredText(root, undefined, { allowlist: null });
    const [failure] = failuresFor(scan.failures, 'packages/protocol/NOTES.md');
    expect(failure).toBeDefined();
    expect(failure.reason).toBe('binary');
    expect(failure.detail).toContain('NUL bytes');
    expect(scan.findings).toEqual([]);
    // The readable Markdown file next to it was still read.
    expect(scan.filesScanned).toBe(1);
  });

  it('records a file above the size it reads whole', async () => {
    const root = makeTree({
      ...artifacts({ identifiers: ['RecommendationsRail'] }),
      'packages/protocol/README.md': '# Protocol\n',
    });
    // One byte over the limit, taken from the scanner's own constant so this
    // case cannot drift from it.
    writeFileOfSize(root, 'packages/protocol/HUGE.md', MAX_FILE_BYTES + 1);

    const scan = scanStructuredText(root, undefined, { allowlist: null });
    const [failure] = failuresFor(scan.failures, 'packages/protocol/HUGE.md');
    expect(failure).toBeDefined();
    expect(failure.reason).toBe('too-large');
    expect(failure.detail).toContain(String(MAX_FILE_BYTES));

    const result = await check(root, { stale: false });
    expect(result.exitCode).toBe(EXIT_ERROR);
    expect(failuresFor(result.failures, 'packages/protocol/HUGE.md')).toHaveLength(1);
  });

  it(
    'refuses a symbolic link standing where a scanned file or directory was expected',
    { skip: !canCreateSymlinks || !astScan.available, timeout: AST_TIMEOUT_MS },
    async () => {
      const root = makeTree({
        ...artifacts({ identifiers: ['RecommendationsRail'] }),
        'apps/local-service/src/sessions/manager.ts': READABLE_PRODUCT_FILE,
        'apps/local-service/elsewhere/authored.ts': source('export const authored = 1;'),
      });
      // A link in place of a source file, and a link in place of a directory:
      // neither is followed, so neither may be passed over in silence.
      symlinkSync('../elsewhere/authored.ts', at(root, 'apps/local-service/src/linked.ts'));
      symlinkSync('../elsewhere', at(root, 'apps/local-service/src/linked-tree'));

      const result = await check(root, { stale: false });

      const [linkedFile] = failuresFor(result.failures, 'apps/local-service/src/linked.ts');
      expect(linkedFile).toBeDefined();
      expect(linkedFile.reason).toBe('symlink-not-followed');
      const [linkedTree] = failuresFor(result.failures, 'apps/local-service/src/linked-tree');
      expect(linkedTree).toBeDefined();
      expect(linkedTree.reason).toBe('symlink-not-followed');

      expect(result.exitCode).toBe(EXIT_ERROR);
      expect(result.ok).toBe(false);
    },
  );

  it(
    'stops the run when a directory cannot be listed',
    { skip: !canBeDeniedByMode || !astScan.available, timeout: AST_TIMEOUT_MS },
    async () => {
      const root = makeTree({
        ...artifacts({ identifiers: ['RecommendationsRail'] }),
        'apps/local-service/src/sessions/manager.ts': READABLE_PRODUCT_FILE,
        'apps/local-service/src/panels/generate.ts': source('export const panel = 1;'),
      });
      const locked = at(root, 'apps/local-service/src/panels');
      chmodSync(locked, 0o000);
      try {
        const result = await check(root, { stale: false });
        const [failure] = failuresFor(result.failures, 'apps/local-service/src/panels');
        expect(failure).toBeDefined();
        expect(failure.reason).toBe('unreadable-directory');
        expect(result.exitCode).toBe(EXIT_ERROR);
      } finally {
        // Restored so `afterAll` can remove the tree.
        chmodSync(locked, 0o755);
      }
    },
  );

  it(
    'refuses to judge or rewrite the policy from a corpus it could only partly read',
    astCase(),
    async () => {
      const root = makeTree({
        ...artifacts({ identifiers: ['RecommendationsRail'] }, { identifiers: ['Button'] }),
        [`${DEMO_TREE}/src/components/product/RecommendationsRail.tsx`]: DRIFTED_DEMO,
        'apps/local-service/src/sessions/manager.ts': READABLE_PRODUCT_FILE,
      });
      // A corpus file the harvest cannot read is vocabulary missing from the
      // regenerated policy, and nothing downstream can tell that from a name
      // the demo no longer declares.
      writeFileOfSize(
        root,
        `${DEMO_TREE}/src/server/services/checkout.service.ts`,
        MAX_FILE_BYTES + 1,
      );

      const harvest = await buildPolicy(root, { allowlist: null });
      const [corpusFailure] = failuresFor(
        harvest.corpusFailures,
        `${DEMO_TREE}/src/server/services/checkout.service.ts`,
      );
      expect(corpusFailure).toBeDefined();
      expect(corpusFailure.reason).toBe('too-large');

      // A normal run reports the hole and makes no staleness claim either way.
      const result = await check(root);
      expect(result.stale).toBeNull();
      expect(result.notes.join('\n')).toContain('policy staleness not compared');
      expect(byRule(result.findings, 'policy-stale')).toEqual([]);
      expect(result.exitCode).toBe(EXIT_ERROR);

      // And `--update` writes nothing.
      const before = readFileSync(at(root, POLICY_FILE), 'utf8');
      const cli = await runCli(['--update'], root);
      expect(cli.code).toBe(EXIT_ERROR);
      expect(cli.stderr).toContain('corpus-unreadable');
      expect(readFileSync(at(root, POLICY_FILE), 'utf8')).toBe(before);
    },
  );

  it('stops the run when applicable source does not parse', astCase(), async () => {
    const root = makeTree({
      ...artifacts({ identifiers: ['RecommendationsRail'] }),
      'apps/local-service/src/sessions/manager.ts': READABLE_PRODUCT_FILE,
      // Malformed TypeScript. The parser recovers and returns a partial tree
      // instead of throwing, so this file used to count as scanned: a demo
      // identifier inside the region it gave up on would never be reported.
      'apps/local-service/src/panels/broken.ts': source('export const broken = ;'),
    });

    const result = await check(root, { stale: false });
    const [failure] = failuresFor(result.failures, 'apps/local-service/src/panels/broken.ts');
    expect(failure).toBeDefined();
    expect(failure.reason).toBe('unparseable');
    // The message names the parser's own complaint and where it is.
    expect(failure.detail).toContain('TS1109');
    expect(failure.detail).toContain('line 1');

    // Not counted as scanned, and the run fails rather than reporting a clean tree.
    expect(result.sourceFilesScanned).toBe(1);
    expect(result.findings).toEqual([]);
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(EXIT_ERROR);

    const cli = await runCli([], root);
    expect(cli.code).toBe(EXIT_ERROR);
    expect(cli.stdout).toContain('unparseable');
  });

  it(
    'refuses to judge or rewrite the policy from a corpus that does not parse',
    astCase(),
    async () => {
      const root = makeTree({
        ...artifacts({ identifiers: ['RecommendationsRail'] }, { identifiers: ['Button'] }),
        [`${DEMO_TREE}/src/components/product/RecommendationsRail.tsx`]: DRIFTED_DEMO,
        // A corpus file whose unparsed region may declare vocabulary, which
        // would silently drop out of a regenerated policy.
        [`${DEMO_TREE}/src/server/services/broken.service.ts`]: source(
          'export function placeOrder( {',
        ),
        'apps/local-service/src/sessions/manager.ts': READABLE_PRODUCT_FILE,
      });

      const harvest = await buildPolicy(root, { allowlist: null });
      const [corpusFailure] = failuresFor(
        harvest.corpusFailures,
        `${DEMO_TREE}/src/server/services/broken.service.ts`,
      );
      expect(corpusFailure).toBeDefined();
      expect(corpusFailure.reason).toBe('unparseable');

      const result = await check(root);
      expect(result.stale).toBeNull();
      expect(byRule(result.findings, 'policy-stale')).toEqual([]);
      expect(result.notes.join('\n')).toContain('policy staleness not compared');
      expect(result.exitCode).toBe(EXIT_ERROR);

      const before = readFileSync(at(root, POLICY_FILE), 'utf8');
      const cli = await runCli(['--update'], root);
      expect(cli.code).toBe(EXIT_ERROR);
      expect(cli.stderr).toContain('corpus-unreadable');
      expect(readFileSync(at(root, POLICY_FILE), 'utf8')).toBe(before);
    },
  );

  it('stops a run that found nothing to scan at all', astCase(), async () => {
    // Artifacts and nothing else: no product tree, so the gate has no subject
    // and "0 violations" would be a statement about an empty set.
    const root = makeTree(artifacts({ identifiers: ['RecommendationsRail'] }));

    const result = await check(root, { stale: false });
    const [failure] = failuresFor(result.failures, '.');
    expect(failure).toBeDefined();
    expect(failure.reason).toBe('no-subject');
    expect(failure.detail).toContain('not evidence');
    expect(result.filesScanned).toBe(0);
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(EXIT_ERROR);

    const cli = await runCli([], root);
    expect(cli.code).toBe(EXIT_ERROR);
  });

  it('keeps an absent tree an informational note rather than a failure', astCase(), async () => {
    // Only one of the product trees exists: this is the clone shape the gate
    // runs on before every surface has landed, and it is not a scan failure.
    const root = makeTree({
      ...artifacts({ identifiers: ['RecommendationsRail'] }),
      'packages/panel-schema/src/spec.ts': source('export const version = 1;'),
    });

    const result = await check(root, { stale: false });
    expect(result.failures).toEqual([]);
    expect(result.findings).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(EXIT_OK);
    const absent = result.notes.filter((note) => note.includes('not present in this checkout'));
    expect(absent.length).toBeGreaterThan(0);
    for (const tree of PRODUCT_TREES.filter((tree) => tree !== 'packages')) {
      expect(result.notes).toContain(`skipped ${tree}: not present in this checkout`);
    }
  });
});
