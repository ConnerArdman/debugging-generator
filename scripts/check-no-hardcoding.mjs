#!/usr/bin/env node
/**
 * check-no-hardcoding.mjs
 *
 * Repository gate behind `pnpm check:no-hardcoding`, which `pnpm verify` runs. It is the static
 * half of the "No Hardcoded Behavior" guarantee (AAP 0.5.4): the product must contain no knowledge
 * of the demo application and must never shortcut the pipeline by branching on the developer's
 * question. The behavioural half lives elsewhere and is deliberately not reimplemented here
 * (`packages/model-provider/src/providers/deterministic.test.ts` proves wording-invariance and
 * `tests/e2e/generalization.spec.ts` runs the whole flow against an independent fixture app).
 *
 * The scan is AST-aware rather than a grep: product source is parsed with ts-morph and matched on
 * syntax nodes, so an identifier, an import specifier and a string literal are told apart.
 *
 * FOUR VIOLATION CLASSES, ELEVEN RULE IDS
 *
 *   A. references into the demo application
 *      `demo-import`             an import, `export ... from`, `import()` or `require()` whose
 *                                module specifier resolves under `apps/demo-app`, or names the
 *                                demo package `@debuggen/demo-app`.
 *      `demo-path`               a string literal or template chunk that normalises to a path
 *                                under `apps/demo-app`, or names the demo package.
 *
 *   B. demo vocabulary (the committed policy, regenerated from the demo's own code index)
 *      `policy-identifier`       a policy identifier used as an identifier node, or appearing as a
 *                                whole word inside a string literal or template chunk.
 *      `policy-route`            a policy route path appearing anywhere inside a string literal or
 *                                template chunk (substring, so a prefix or a query suffix matches).
 *      `policy-identifier-text`  the same identifier match against the raw text of structured
 *                                files: prompts, JSON, Markdown, plain text and the deterministic
 *                                provider's templates, "so demo instructions or pre-authored
 *                                output cannot hide in a prompt" (AAP 0.5.4).
 *      `policy-route-text`       the same for route paths.
 *
 *   C. branching on the session question -- the pattern the user wrote out (AAP 0.1.2):
 *      `question-branch`         `if (question.includes("button slow")) return checkoutDemoPanel;`
 *                                and every variant of it: a string search method called on a
 *                                question-derived expression, `RegExp.prototype.test` applied to
 *                                one, or an equality comparison between one and a string literal.
 *
 *   D. demo knowledge in repository tooling (the same policy, over raw text)
 *      `tooling-identifier-text` a policy identifier as a whole word anywhere in a tooling file:
 *                                a configuration file at the repository root (by extension, or a
 *                                named dot-file such as `.editorconfig`, `.gitignore` or
 *                                `.prettierignore`), or a file under `scripts/`, `.github/` or
 *                                `.vscode/` (`CODEOWNERS` included). Comments count, because
 *                                comments are where tooling records what it knows: a lint
 *                                exception that lists demo files is demo knowledge however it is
 *                                written, and `docs/DEMO.md` is the one place that may say where
 *                                the demo's defects live (AAP 0.7.2, 0.8.5).
 *      `tooling-route-text`      the same for route paths.
 *      `tooling-demo-file`       a path in a tooling file that names one concrete file of the demo:
 *                                `apps/demo-app/<dir>/.../<file>` resolving to a regular file, or a
 *                                glob whose last segment is a file name matching one, such as
 *                                `apps/demo-app/app/items/*\/page.tsx`. The tree, its directories,
 *                                its root-level workspace configuration and globs ending in a
 *                                wildcard (`apps/demo-app/src/**\/*.tsx`) stay allowed: that is
 *                                how tooling configures the demo as a workspace.
 *
 *   plus, independent of any file:
 *      `policy-stale`            the committed policy is not, byte for byte, what `--update` would
 *                                produce from the demo corpus: a different vocabulary, different
 *                                metadata, entries out of canonical order or repeated, or a
 *                                hand-reformatted file. Any of those means the committed artifact
 *                                cannot be reproduced from its corpus, so the gate no longer
 *                                matches what it guards.
 *
 * WHAT THIS SCRIPT WRITES
 * Nothing, except `scripts/no-hardcoding.policy.json` under `--update`. Source files are read into
 * an in-memory ts-morph project and never saved, so a normal run cannot modify the checkout.
 *
 * REGENERATION IS ONE-DIRECTIONAL BY CONSTRUCTION
 * `--update` derives the policy from the demo application alone, minus the independent fixture
 * corpus and minus the hand-reviewed allowlist. `buildPolicy()` never enumerates the product trees,
 * so an identifier that has leaked into the product cannot bless itself by being there. Newly added
 * entries that turn out to be generic vocabulary belong in `scripts/no-hardcoding.allowlist.json`,
 * after which `--update` is re-run and both files are reviewed together.
 *
 * LIMITS OF THE HEURISTICS -- READ BEFORE TIGHTENING OR LOOSENING ANYTHING
 *   * Comments are not scanned in product source files. Only string literals, template chunks and
 *     identifier nodes are, because only those can reach runtime behaviour. Prose in a product
 *     `.ts` file that mentions a demo route is therefore allowed, while the same prose in a prompt,
 *     a Markdown file or a deterministic template is not -- those are inputs to generation -- and
 *     neither is it in repository tooling, whose comments are where knowledge of the demo's
 *     internals would otherwise be written down outside `docs/DEMO.md`.
 *   * Question taint tracking is intra-file and one assignment deep (with a small fixpoint so a
 *     chain of aliases in the same file is still caught). It is tuned for zero false positives on
 *     legitimate code: `question.length === 0` does not fire, because `.length` is not a
 *     question-derived string and the compared operand is not a string literal. A cheat that
 *     launders the question through another module, a data structure or a dynamic property access
 *     is not caught here; the behavioural tests are what close that gap.
 *   * Policy matching is literal and case-sensitive. There is no pattern facility, by design: an
 *     approximate rule would either fail honest product code or quietly stop matching.
 *   * `tooling-demo-file` sees only the demo tree spelled out literally in tooling text, optionally
 *     after `/`, `./` or `../` segments. A path assembled from pieces (`path.join(demo, 'src')`),
 *     encoded or reached from another root is not seen, and a path that resolves to nothing on
 *     disk is not a finding -- the rule asks which demo files tooling pins, and only a present
 *     `apps/demo-app` can answer that. Trailing punctuation and a `:line` or `#L` location are
 *     dropped only when the longer form does not exist, symbolic links are never followed, and
 *     brace alternatives spanning a `/` are not expanded.
 *
 * STALENESS IS ENFORCED WHENEVER THE CORPUS IS PRESENT
 * The policy is defined as (demo harvest) minus (fixture harvest) minus (allowlist), so the demo
 * application is the definition of the policy rather than evidence about it. `classifyCorpus()`
 * therefore asks one question only: is `apps/demo-app` in this checkout?
 *   * absent -- a partial clone or an early build. No comparison is possible, the run says so on
 *     its own line, and the committed policy is still enforced against product source.
 *   * present -- every difference between the committed policy and a fresh harvest is drift. It is
 *     reported as `policy-stale`, it fails the gate, and `--update` writes exactly what it
 *     harvested, dropping entries the demo no longer declares. There is no coverage threshold and
 *     no partial-corpus exemption: a policy a present corpus cannot reproduce is stale, whether it
 *     lists too much or too little, because a gate nobody can regenerate is a gate nobody can
 *     trust. Enforcement of the policy against product source is unconditional either way.
 *
 * "Every difference" is literal, and the comparison is therefore byte-exact: the committed file is
 * compared with `serializePolicy()` of the fresh harvest, not only with the set of names it lists.
 * A file that lists exactly the right names in the wrong order, repeats one, carries different
 * metadata or was reformatted by hand is stale too, because AAP 0.5.4's contract is that the
 * committed bytes are what `--update` writes -- the file is prettier-ignored and hand-editing it is
 * forbidden precisely so those bytes mean something. Order-only drift is the case this exists for:
 * it survives a hand-resolved merge conflict or a sort that used `localeCompare` instead of
 * case-sensitive ASCII, it changes nothing about which names the gate matches, and a comparison of
 * membership alone would pass it while leaving a committed artifact nobody can regenerate.
 *
 * THE SCRIPT, ITS SUITE AND THE POLICY ARE ONE UNIT, OWNED HERE
 * This script, `scripts/check-no-hardcoding.test.mjs` and `scripts/no-hardcoding.policy.json` are
 * one unit owned by the repository-tooling surface -- the rules here, the evidence that they hold
 * in the suite, the vocabulary they match in the generated artifact -- and they change together.
 * The policy's committed bytes are exactly what `--update` writes from `apps/demo-app` as that tree
 * stands in the same commit, so a change to the demo corpus is complete only once `--update` has
 * been re-run and the regenerated policy committed with it -- short of that the gate enforces a
 * vocabulary the demo no longer has, and `policy-stale` says so on the next run.
 * The policy is never hand-edited, and never regenerated as a side effect of unrelated work: a
 * commit that changes the demo and re-sorts or rewrites the policy in passing produces an artifact
 * nobody reviewed, in the one file whose review is why its bytes are pinned at all. The canonical
 * form of the committed artifact is pinned a second time by the suite's "the committed policy
 * artifact" cases, because the byte comparison below runs only with the corpus in hand -- it is
 * skipped when `apps/demo-app` is absent, and when the harvest could read only part of it.
 *
 * THE SCAN FAILS CLOSED
 * A gate that returns success while part of what it covers went unexamined proves nothing, so
 * nothing is ever "skipped". A directory that cannot be read, a file that cannot be read, parsed or
 * decoded as text, a file above MAX_FILE_BYTES, and a symbolic link that would otherwise have been
 * scanned are all recorded as {@link ScanFailure} and stop the gate with exit code 2 -- distinct
 * from the exit code 1 that reports violations, because an incomplete scan is an environment
 * problem rather than a verdict. The corpus harvest fails the same way: a partial harvest would
 * silently rewrite the policy, so `--update` refuses to write and a normal run refuses to judge
 * staleness. A run that scanned no product file at all fails too, because a clean result over an
 * empty set is not evidence. The tooling pass fails closed on the same terms, and so does its demo
 * path resolution: a demo entry that cannot be inspected or listed while resolving a path named
 * in tooling is a scan failure, never a pass. An absent tree is
 * the one benign case and stays an informational note: this script runs on clones where a surface
 * has not landed yet.
 *
 * Usage:  node scripts/check-no-hardcoding.mjs [--update] [--json] [--help]
 * Exits:  0 clean | 1 violations found or policy stale | 2 usage error, environment error, or a
 *         scan that could not read part of the tree.
 */

import {
  readdirSync,
  readFileSync,
  lstatSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Exit code: no violations, policy in step with the corpus. */
export const EXIT_OK = 0;
/** Exit code: at least one violation, or a stale policy. */
export const EXIT_FINDINGS = 1;
/** Exit code: the check could not be performed. */
export const EXIT_ERROR = 2;

/** Prefix on every line this script prints, matching the other repository gates. */
const LOG_PREFIX = 'check-no-hardcoding';

/** Repository-relative path of this script, as it appears in messages and in the policy file. */
export const SCRIPT_FILE = 'scripts/check-no-hardcoding.mjs';
/** Repository-relative path of the generated policy -- the only file `--update` writes. */
export const POLICY_FILE = 'scripts/no-hardcoding.policy.json';
/** Repository-relative path of the hand-reviewed allowlist. */
export const ALLOWLIST_FILE = 'scripts/no-hardcoding.allowlist.json';
/** Direct invocation that regenerates the policy. */
const UPDATE_COMMAND = `node ${SCRIPT_FILE} --update`;
/** The same regeneration through the workspace script, as the AAP words it. */
const PNPM_UPDATE_COMMAND = 'pnpm check:no-hardcoding --update';

/** The demo application: the corpus `--update` harvests, and the tree the product may not name. */
export const DEMO_TREE = 'apps/demo-app';
/** Package name of the demo application, as declared in `apps/demo-app/package.json`. */
export const DEMO_PACKAGE = '@debuggen/demo-app';
/** The independent corpus whose names are subtracted from the policy (AAP 0.5.4). */
export const FIXTURE_TREE = 'tests/fixtures/sample-next-app';

/**
 * Product trees scanned as source. `tests/e2e/**`, `tests/browser/**`, `tests/fixtures/**`,
 * `docs/**`, `apps/demo-app/**` and `scripts/**` are deliberately absent: the first five
 * legitimately name demo symbols (AAP 0.4.2), and `scripts/` is repository tooling rather than
 * product. Tooling is not exempt, it is scanned differently: {@link TOOLING_TREES} and the
 * repository root are matched as raw text by the class D pass, with the policy file excluded by
 * exact path because it contains every forbidden token by construction.
 *
 * @type {readonly string[]}
 */
export const PRODUCT_TREES = Object.freeze([
  'apps/local-service',
  'apps/vscode-extension',
  'apps/chrome-extension',
  'packages',
]);

/** Extensions parsed as product source. */
const SOURCE_EXTENSIONS = Object.freeze(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
/** Extensions scanned as structured text anywhere under a product tree. */
const STRUCTURED_EXTENSIONS = Object.freeze(['.json', '.md', '.txt']);

/**
 * Product subtrees whose every file is structured text whatever its extension: the versioned
 * prompts, and the deterministic provider's rule and template modules, which are pre-authored
 * output if they carry demo vocabulary.
 *
 * @type {readonly string[]}
 */
const STRUCTURED_TREES = Object.freeze([
  'apps/local-service/prompts',
  'packages/model-provider/src/deterministic',
]);

/**
 * Repository-tooling trees scanned recursively by the class D pass, alongside the regular files at
 * the repository root. They hold the build, lint, test and editor configuration and the guard
 * scripts, which sit above every workspace and are exactly where knowledge of the demo's internals
 * would be written down if it were written anywhere but `docs/DEMO.md` -- a lint exception listing
 * demo files, a CI step naming a demo route. Only the root is read non-recursively: the workspace
 * directories below it are the product trees and the corpora, which other rules own.
 *
 * @type {readonly string[]}
 */
export const TOOLING_TREES = Object.freeze(['scripts', '.github', '.vscode']);

/** Extensions read as repository tooling, at the root and under {@link TOOLING_TREES}. */
const TOOLING_EXTENSIONS = Object.freeze([
  '.js',
  '.mjs',
  '.cjs',
  '.ts',
  '.mts',
  '.cts',
  '.json',
  '.yaml',
  '.yml',
]);

/**
 * Configuration files read as repository tooling by name, because an extension cannot identify
 * them: `.editorconfig`, `.gitignore`, `.prettierignore` and the other dot-files at the root, and
 * `CODEOWNERS` under `.github/`. They configure editors, git, the formatter, the package manager
 * and review routing per path, so a demo file named in one is demo knowledge in tooling like any
 * other.
 *
 * The set is closed on purpose. The pass lists the work tree, not the index, so reading every
 * dot-file would also read a developer's untracked `.env` - credentials, printed in a snippet on a
 * hit - and fail the gate on an operating system's binary folder metadata. Only names the
 * repository itself uses are listed; a new kind of tooling file is added here when it is added to
 * the repository.
 *
 * @type {readonly string[]}
 */
const TOOLING_FILE_NAMES = Object.freeze([
  '.editorconfig',
  '.env.example',
  '.gitattributes',
  '.gitignore',
  '.node-version',
  '.npmrc',
  '.nvmrc',
  '.prettierignore',
  'CODEOWNERS',
]);

/**
 * Tooling files never read, by exact repository-relative path. The lockfile is generated by pnpm
 * and names nothing an author wrote. The policy lists every forbidden token by construction, so it
 * would fail the gate on sight. The allowlist beside it is scanned like any other tooling file: it
 * may list only generic vocabulary, every entry it lists is subtracted from the matchers before
 * any text is compared, and a demo name that reached its prose is a finding like anywhere else.
 *
 * @type {ReadonlySet<string>}
 */
const TOOLING_EXCLUDED_FILES = Object.freeze(new Set(['pnpm-lock.yaml', POLICY_FILE]));

/**
 * Directory names pruned during every walk, at any depth, before anything is read and whatever the
 * entry's type is. Dependencies, build output and test-runner caches hold no product source, and
 * pruning them by name first is what keeps a symlinked `node_modules` or a symlinked
 * `.vscode-test` (which the repository's own VS Code test setup creates) out of the fail-closed
 * traversal rules below.
 */
const SKIPPED_DIRECTORIES = Object.freeze(
  new Set([
    'node_modules',
    'dist',
    'out',
    'build',
    'coverage',
    '.next',
    '.tsbuild',
    '.turbo',
    '.git',
    '.vscode-test',
    'playwright-report',
    'test-results',
    '__tests__',
    'test',
    'generated',
  ]),
);

/** Directory names skipped while harvesting the demo and fixture corpora. */
const SKIPPED_CORPUS_DIRECTORIES = Object.freeze(
  new Set(['node_modules', 'dist', 'out', 'build', '.next', '.tsbuild', '.git', 'generated']),
);

/**
 * Largest file this scan reads whole. Every scanned file is read into memory -- the AST pass needs
 * the complete text and the structured pass matches across line boundaries -- so a bound is needed;
 * a file that exceeds it is a scan failure rather than a skip, because a file nobody examined is
 * indistinguishable from a file that hides a cheat. No text file this gate covers comes close: the
 * remedy for one that does is to prune its directory from the scanned trees (generated output does
 * not belong in them) or to split it, never to let the gate pass without reading it.
 *
 * Exported so `scripts/check-no-hardcoding.test.mjs` can write a file exactly one byte over the
 * limit instead of hard-coding a size that would drift from this constant.
 */
export const MAX_FILE_BYTES = 2 * 1024 * 1024;
/** Longest excerpt printed for an offending line. */
const MAX_SNIPPET_LENGTH = 100;
/** Bound on the alias fixpoint of the question taint analysis. */
const MAX_TAINT_PASSES = 6;

/**
 * The only file allowed to branch on the question text, and only in its generic tokenizer
 * (AAP 0.5.4). The exemption is by exact repository-relative path and extends nowhere else; class
 * B still applies to it, so the tokenizer cannot smuggle demo vocabulary in.
 */
export const QUESTION_EXEMPT_FILE = 'apps/local-service/src/pipeline/stages/understand.ts';

/**
 * Identifier names treated as the session question itself. `q` and `text` are deliberately absent:
 * they are too generic to taint without producing false positives on honest code.
 *
 * @type {ReadonlySet<string>}
 */
const QUESTION_ROOT_NAMES = Object.freeze(
  new Set(['question', 'userQuestion', 'followUpQuestion', 'followUp']),
);

/**
 * Property names that make any member expression question-derived, however it is reached, so
 * `session.question`, `record.question` and `input.followUps[0]` are all covered.
 *
 * @type {ReadonlySet<string>}
 */
const QUESTION_PROPERTY_NAMES = Object.freeze(
  new Set(['question', 'userQuestion', 'followUpQuestion', 'followUp', 'followUps']),
);

/** String methods that turn a question into a decision. */
const QUESTION_SEARCH_METHODS = Object.freeze(
  new Set([
    'includes',
    'startsWith',
    'endsWith',
    'indexOf',
    'lastIndexOf',
    'search',
    'match',
    'matchAll',
  ]),
);

/** Methods that normalise a question without changing what it is, so taint flows through them. */
const QUESTION_NORMALIZING_METHODS = Object.freeze(
  new Set([
    'toLowerCase',
    'toUpperCase',
    'trim',
    'trimStart',
    'trimEnd',
    'normalize',
    'replace',
    'replaceAll',
    'slice',
    'substring',
    'toString',
    'valueOf',
  ]),
);

/** Equality operators that compare a question against a literal. */
const EQUALITY_OPERATOR_TEXTS = Object.freeze(new Set(['===', '!==', '==', '!=']));

/** Every rule id this gate can report, in the order `--help` documents them. */
export const RULE_IDS = Object.freeze([
  'demo-import',
  'demo-path',
  'policy-identifier',
  'policy-route',
  'policy-identifier-text',
  'policy-route-text',
  'question-branch',
  'tooling-identifier-text',
  'tooling-route-text',
  'tooling-demo-file',
  'policy-stale',
]);

/** Remediation hint printed with each rule, keyed by rule id. */
const RULE_HINTS = Object.freeze({
  'demo-import': `the product may not depend on ${DEMO_TREE}; the demo is an instrumentation target discovered at run time through @debuggen/code-analysis, never a dependency`,
  'demo-path': `remove the reference; a project path must come from the session's projectRoot at run time, not from a literal naming ${DEMO_TREE}`,
  'policy-identifier':
    'this name comes from the demo application; derive it from the code index or the captured telemetry instead of naming it',
  'policy-route':
    "this route belongs to the demo application; resolve routes through the target project's route map instead of naming one",
  'policy-identifier-text':
    'a prompt, manifest or template may not name demo symbols; describe the shape of the answer and let the pipeline supply the evidence',
  'policy-route-text':
    'a prompt, manifest or template may not name demo routes; describe the shape of the answer and let the pipeline supply the evidence',
  'question-branch':
    'the question must flow into Stage 1 understanding and reach the model as data; it may never select an output through control flow',
  'tooling-identifier-text': `repository tooling may not name demo symbols, in code or in comments; express a tooling exception by workspace (${DEMO_TREE}) or by rule, never by demo file or symbol -- where the demo's defects live is documented only in docs/DEMO.md`,
  'tooling-route-text': `repository tooling may not name demo routes, in code or in comments; express a tooling exception by workspace (${DEMO_TREE}) or by rule, never by demo route -- where the demo's defects live is documented only in docs/DEMO.md`,
  'tooling-demo-file': `repository tooling may not name a file of the demo application, in code or in comments, nor pin one with a glob; express a tooling exception by workspace (${DEMO_TREE}, a directory in it, or a glob ending in a wildcard such as ${DEMO_TREE}/src/**/*.tsx) or by rule, never by demo file -- where the demo's defects live is documented only in docs/DEMO.md`,
  'policy-stale': `regenerate with \`${PNPM_UPDATE_COMMAND}\` and commit ${POLICY_FILE} for review`,
});

/**
 * A single violation.
 *
 * @typedef {object} Finding
 * @property {string} rule One of {@link RULE_IDS}.
 * @property {string} file Repository-relative POSIX path, or the policy file for `policy-stale`.
 * @property {number} line 1-based line.
 * @property {number} column 1-based column.
 * @property {string} message What was found and why it is not allowed.
 * @property {string} hint How to fix it.
 * @property {string} [match] The offending literal, when one identifies the finding.
 * @property {string} [snippet] Sanitized excerpt of the offending line.
 */

/**
 * Something the scan could not examine. Every one of these fails the gate with exit code 2: the
 * check was not performed over the whole tree, so its silence is not evidence.
 *
 * Reasons:
 *   `unreadable-directory`   a directory that exists but could not be listed.
 *   `not-a-directory`        a scanned tree that exists and is not a directory.
 *   `symlink-not-followed`   an entry that would have been scanned but is a symbolic link. Links
 *                            are never followed -- one pointing out of the repository would take
 *                            the scan with it -- so the entry stops the gate instead.
 *   `unreadable-file`        a file that exists but could not be stat'ed or read.
 *   `not-a-regular-file`     a path that is not a regular file where one was required.
 *   `binary`                 a file with a scanned extension that contains NUL bytes, so it cannot
 *                            be examined as text.
 *   `too-large`              a file above {@link MAX_FILE_BYTES}.
 *   `unparseable`            source the parser could not fully understand. The parser recovers
 *                            from malformed syntax rather than throwing, so this covers an
 *                            ordinary syntax error: the tree standing in for the file is partial,
 *                            and the unparsed region went unexamined.
 *   `no-subject`             the run found no product source or structured text to scan, so its
 *                            success would say nothing about the product. Repository tooling
 *                            alone is not a subject: the gate exists for the product, and a
 *                            clean tooling pass over a root holding no product proves nothing
 *                            about it. Recorded against `.` rather than a path.
 *
 * @typedef {object} ScanFailure
 * @property {string} path Repository-relative POSIX path, or `.` for a whole-run precondition.
 * @property {'unreadable-directory'|'not-a-directory'|'symlink-not-followed'|'unreadable-file'|'not-a-regular-file'|'binary'|'too-large'|'unparseable'|'no-subject'} reason
 * @property {string} detail What happened and what to do about it.
 */

/**
 * The committed or computed policy. Key order is part of the serialization contract.
 *
 * @typedef {object} Policy
 * @property {number} version Schema version, always 1.
 * @property {string} generatedBy Command that regenerates this file.
 * @property {string} corpus Repository-relative path the identifiers were harvested from.
 * @property {string[]} exclusions The two independent exclusion sources, in a fixed order.
 * @property {string[]} identifiers Demo identifiers, ASCII-sorted and de-duplicated.
 * @property {string[]} routePaths Demo route paths, ASCII-sorted and de-duplicated.
 */

/**
 * The hand-reviewed generic vocabulary subtracted during `--update`.
 *
 * @typedef {object} Allowlist
 * @property {number} version
 * @property {string[]} identifiers
 * @property {string[]} routePaths
 * @property {string} [notes]
 */

/**
 * Whether the demo corpus `buildPolicy()` harvests is in this checkout at all. Presence is the
 * whole test: a present corpus defines the policy, so any difference from it is drift.
 *
 * @typedef {object} CorpusState
 * @property {'absent'|'ready'} state `absent` when `apps/demo-app` is not in this checkout and no
 *   comparison is possible; `ready` whenever it is, which is when drift is enforced.
 * @property {string} reason Human-readable explanation, always printed.
 */

/**
 * How the committed policy's *form* differs from the canonical form `--update` writes, once the
 * names it lists are accounted for. Order, repetition and formatting are contract, not cosmetics:
 * the committed artifact has to be reproducible from its corpus byte for byte (AAP 0.5.4).
 *
 * @typedef {object} SerializationReport
 * @property {boolean} canonical Whether the committed form is the canonical one -- no reason below,
 *   and the bytes equal {@link serializePolicy} of the fresh harvest wherever they were available.
 * @property {boolean|null} byteEqual Whether the committed bytes equal the canonical serialization;
 *   `null` when no bytes were available, which is the case for an injected policy object.
 * @property {string[]} reasons Every difference the listed names do not already explain: entries
 *   out of canonical case-sensitive ASCII order, repeated entries, and -- only when nothing else
 *   accounts for it -- bytes that are not what the generator writes.
 */

/**
 * Outcome of comparing the committed policy with a fresh computation.
 *
 * @typedef {object} StaleReport
 * @property {boolean} enforced Whether drift was reported as a `policy-stale` finding, which is
 *   true whenever the corpus is present.
 * @property {boolean} drifted Whether any difference was found.
 * @property {CorpusState} corpus
 * @property {{ identifiers: string[], routePaths: string[] }} added Corpus has them, policy lacks.
 * @property {{ identifiers: string[], routePaths: string[] }} removed Policy has them, corpus lacks.
 * @property {string[]} fields Metadata fields that differ (`version`, `generatedBy`, `corpus`,
 *   `exclusions`).
 * @property {SerializationReport} serialization How the committed form differs from the canonical
 *   one beyond the names it lists.
 */

/**
 * Everything one run produced.
 *
 * @typedef {object} CheckResult
 * @property {boolean} ok No violations and no scan failures.
 * @property {number} exitCode {@link EXIT_ERROR} when anything went unexamined, else
 *   {@link EXIT_FINDINGS} when a violation was found, else {@link EXIT_OK}.
 * @property {string} root Absolute repository root the check ran against.
 * @property {Finding[]} findings Ordered by file, then line, then column, then rule.
 * @property {StaleReport|null} stale `null` when no comparison was possible.
 * @property {number} filesScanned Source, structured and tooling files actually read.
 * @property {number} sourceFilesScanned Source files parsed with ts-morph.
 * @property {number} structuredFilesScanned Structured-text files read.
 * @property {number} toolingFilesScanned Repository-tooling files read by the class D pass.
 * @property {ScanFailure[]} failures Everything the scan could not examine; a non-empty list means
 *   the gate could not be performed and the exit code is {@link EXIT_ERROR}.
 * @property {string[]} notes Informational lines: absent trees, corpus state, defensive warnings.
 */

/**
 * Raised for every condition that makes the check impossible to perform (exit code 2), as opposed
 * to a violation (exit code 1). `code` is a stable, machine-readable discriminator.
 */
export class HardcodingCheckError extends Error {
  /**
   * @param {string} code Stable error code, for example `ts-morph-missing` or `policy-malformed`.
   * @param {string} message Human-readable, actionable description.
   * @param {{ cause?: unknown }} [options]
   */
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = 'HardcodingCheckError';
    this.code = code;
  }
}

/**
 * @param {string} message
 * @returns {HardcodingCheckError}
 */
function usageError(message) {
  return new HardcodingCheckError('usage', message);
}

/** Repository root derived from this script's own location, used when no root is passed. */
export const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * @param {string} value
 * @returns {string} `value` with every separator normalised to `/`.
 */
function toPosix(value) {
  return value.split(path.sep).join('/');
}

/**
 * @param {string} root Absolute repository root.
 * @param {string} absolute Absolute path inside it.
 * @returns {string} Repository-relative POSIX path.
 */
function relative(root, absolute) {
  return toPosix(path.relative(root, absolute));
}

/**
 * Whether `candidate` is `base` itself or sits inside it. Both must be POSIX and normalised.
 *
 * @param {string} candidate
 * @param {string} base
 * @returns {boolean}
 */
function isUnder(candidate, base) {
  return candidate === base || candidate.startsWith(`${base}/`);
}

/**
 * @param {unknown} error
 * @returns {string} The message of a thrown value, whatever it is.
 */
function describeError(error) {
  if (error instanceof Error) {
    const code = /** @type {{ code?: unknown }} */ (error).code;
    // Node's own messages already start with the code; only add it when it is missing, so the
    // detail never reads `EACCES: EACCES: ...`.
    return typeof code === 'string' && !error.message.startsWith(code)
      ? `${code}: ${error.message}`
      : error.message;
  }
  return String(error);
}

/**
 * `lstat` with the one distinction this script has to make: a path that is not there (benign -- a
 * surface that has not landed in this clone) versus a path that is there but could not be
 * inspected (a hole in the scan). Symbolic links are not followed.
 *
 * @param {string} absolute
 * @returns {{ stat: import('node:fs').Stats }|{ missing: true }|{ error: unknown }}
 */
function statEntry(absolute) {
  try {
    return { stat: lstatSync(absolute) };
  } catch (error) {
    const code = /** @type {{ code?: unknown }} */ (error).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return { missing: true };
    }
    return { error };
  }
}

/**
 * Classify a tree the scan is about to walk. `absent` is informational -- this script runs on
 * clones where a surface has not landed yet -- while anything else that is not a readable directory
 * is a scan failure.
 *
 * @param {string} root Absolute repository root.
 * @param {string} absolute Absolute path of the tree.
 * @returns {{ state: 'directory' }|{ state: 'absent' }|{ state: 'failed', failure: ScanFailure }}
 */
function classifyDirectory(root, absolute) {
  const entry = statEntry(absolute);
  if ('missing' in entry) {
    return { state: 'absent' };
  }
  if ('error' in entry) {
    return {
      state: 'failed',
      failure: {
        path: relative(root, absolute),
        reason: 'unreadable-directory',
        detail: `could not be inspected (${describeError(entry.error)}); the scan cannot cover a tree it cannot stat`,
      },
    };
  }
  if (!entry.stat.isDirectory()) {
    return {
      state: 'failed',
      failure: {
        path: relative(root, absolute),
        reason: 'not-a-directory',
        detail: 'exists but is not a directory, so the tree it should contain went unscanned',
      },
    };
  }
  return { state: 'directory' };
}

/**
 * @param {string} absolute
 * @returns {boolean} Whether the path exists and is a directory (symlinks are not followed).
 */
function isDirectory(absolute) {
  const entry = statEntry(absolute);
  return 'stat' in entry && entry.stat.isDirectory();
}

/**
 * @param {string} absolute
 * @returns {boolean} Whether the path exists and is a regular file.
 */
function isFile(absolute) {
  const entry = statEntry(absolute);
  return 'stat' in entry && entry.stat.isFile();
}

/**
 * Whether a symbolic link leads to a directory. The link is resolved for this classification only
 * -- the walk still never descends through it and nothing is ever read through it -- so that a
 * directory link can be reported as the hole in the scan that it is.
 *
 * @param {string} absolute Path of the link itself.
 * @returns {boolean} `false` for a dangling or unreadable link.
 */
function linkLeadsToDirectory(absolute) {
  try {
    return statSync(absolute).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Collapse an offending line into a short, single-line excerpt. Control characters are removed so a
 * crafted source file cannot write escape sequences to the reviewer's terminal.
 *
 * @param {string} line
 * @returns {string}
 */
function snippet(line) {
  const flattened = line.replace(/\s+/g, ' ').trim();
  // eslint-disable-next-line no-control-regex
  const printable = flattened.replace(/[\u0000-\u001f\u007f-\u009f]/g, '');
  return printable.length > MAX_SNIPPET_LENGTH
    ? `${printable.slice(0, MAX_SNIPPET_LENGTH - 1)}…`
    : printable;
}

/**
 * Read a text file, classifying every reason it might not be readable rather than throwing. A
 * classification is never a pass: each one becomes a {@link ScanFailure} at the call site and stops
 * the gate, because an unread file is a file that could hide anything this gate exists to find.
 *
 * @param {string} absolute
 * @param {string} relPath Repository-relative POSIX path, for the failure record.
 * @returns {{ text: string }|{ failure: ScanFailure }}
 */
function readTextFile(absolute, relPath) {
  const entry = statEntry(absolute);
  if ('missing' in entry) {
    return {
      failure: {
        path: relPath,
        reason: 'unreadable-file',
        detail: 'disappeared between listing and reading; re-run the check on a settled tree',
      },
    };
  }
  if ('error' in entry) {
    return {
      failure: {
        path: relPath,
        reason: 'unreadable-file',
        detail: `could not be inspected (${describeError(entry.error)}); make it readable and re-run`,
      },
    };
  }
  if (!entry.stat.isFile()) {
    return {
      failure: {
        path: relPath,
        reason: 'not-a-regular-file',
        detail: 'is not a regular file, so its contents could not be examined',
      },
    };
  }
  if (entry.stat.size > MAX_FILE_BYTES) {
    return {
      failure: {
        path: relPath,
        reason: 'too-large',
        detail: `is ${entry.stat.size} bytes, above the ${MAX_FILE_BYTES}-byte limit this scan reads whole; prune its directory from the scanned trees if it is generated output, or split it -- the gate will not pass on a file it did not read`,
      },
    };
  }
  /** @type {Buffer} */
  let buffer;
  try {
    buffer = readFileSync(absolute);
  } catch (error) {
    return {
      failure: {
        path: relPath,
        reason: 'unreadable-file',
        detail: `could not be read (${describeError(error)}); make it readable and re-run`,
      },
    };
  }
  if (buffer.includes(0)) {
    return {
      failure: {
        path: relPath,
        reason: 'binary',
        detail:
          'contains NUL bytes, so it cannot be examined as text; move it out of the scanned trees if it is not source',
      },
    };
  }
  return { text: buffer.toString('utf8') };
}

/**
 * Offsets at which each line of `text` starts, so a match index can be turned into a 1-based line
 * and column without rescanning the file.
 *
 * @param {string} text
 * @returns {number[]}
 */
function lineStarts(text) {
  const starts = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '\n') {
      starts.push(index + 1);
    }
  }
  return starts;
}

/**
 * Binary-search `starts` for the line containing `offset`.
 *
 * @param {number[]} starts Result of {@link lineStarts}.
 * @param {number} offset 0-based character offset.
 * @returns {{ line: number, column: number, lineStart: number }} 1-based line and column.
 */
function positionAt(starts, offset) {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if ((starts[middle] ?? 0) <= offset) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  const lineStart = starts[low] ?? 0;
  return { line: low + 1, column: offset - lineStart + 1, lineStart };
}

/**
 * Depth-first, deterministic file walk. `fs.globSync` is deliberately not used: this script must
 * run on the pinned Node 24 runtime and on older interpreters a developer may have on PATH, and
 * the demo application contains dynamic-route directories such as `[slug]` whose brackets are glob
 * character-class syntax.
 *
 * The walk fails closed. A directory that cannot be listed is recorded rather than passed over, so
 * an unreadable subtree can never leave the gate reporting success over a tree it did not see.
 *
 * Symbolic links are never followed -- a link out of the repository would take the scan with it --
 * but a link that would otherwise have been scanned is recorded too, so the no-follow rule cannot
 * be used to hide a file. Pruned directory names are honoured first and whatever the entry's type,
 * which is what keeps a symlinked `node_modules` or `.vscode-test` out of that rule.
 *
 * @param {string} absoluteDir Directory to walk; it must already be a readable directory (see
 *   {@link classifyDirectory}).
 * @param {(relativePosixPath: string, name: string) => boolean} accept File predicate.
 * @param {ReadonlySet<string>} skippedDirectories Directory names pruned at any depth.
 * @param {string} root Absolute repository root, for the relative paths handed to `accept`.
 * @returns {{ files: string[], failures: ScanFailure[] }} Absolute paths, sorted so output is
 *   stable across platforms, and everything the walk could not cover.
 */
function walkFiles(absoluteDir, accept, skippedDirectories, root) {
  /** @type {string[]} */
  const found = [];
  /** @type {ScanFailure[]} */
  const failures = [];
  /** @type {string[]} */
  const queue = [absoluteDir];
  while (queue.length > 0) {
    const current = /** @type {string} */ (queue.pop());
    /** @type {import('node:fs').Dirent[]} */
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch (error) {
      failures.push({
        path: relative(root, current),
        reason: 'unreadable-directory',
        detail: `could not be listed (${describeError(error)}); everything below it went unscanned`,
      });
      continue;
    }
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      const relPath = relative(root, absolute);
      if (skippedDirectories.has(entry.name)) {
        continue;
      }
      if (entry.isSymbolicLink()) {
        // Refused when a real entry in its place would have been read: a link whose name the
        // predicate accepts, or one leading to a directory the walk would have descended into. A
        // link named like a file this scan ignores anyway hides nothing, so it is passed over as
        // its regular-file namesake would be.
        if (accept(relPath, entry.name)) {
          failures.push({
            path: relPath,
            reason: 'symlink-not-followed',
            detail:
              'is a symbolic link where a scanned file was expected, and links are never followed; replace it with a regular file or move it out of the scanned trees',
          });
        } else if (linkLeadsToDirectory(absolute)) {
          failures.push({
            path: relPath,
            reason: 'symlink-not-followed',
            detail:
              'is a symbolic link to a directory, which this scan never follows, so everything below it went unscanned; replace it with a real directory or add its name to the pruned directories',
          });
        }
        continue;
      }
      if (entry.isDirectory()) {
        queue.push(absolute);
        continue;
      }
      if (entry.isFile()) {
        if (accept(relPath, entry.name)) {
          found.push(absolute);
        }
        continue;
      }
      // A socket, FIFO or device node where source was expected: not readable as text, and not
      // something to pass over silently.
      if (accept(relPath, entry.name)) {
        failures.push({
          path: relPath,
          reason: 'not-a-regular-file',
          detail: 'is not a regular file, so its contents could not be examined',
        });
      }
    }
  }
  return { files: found.sort(), failures };
}

/**
 * Whether a file name belongs to a test suite. Tests inside product packages and beside the guard
 * scripts legitimately name demo symbols -- `scripts/check-no-hardcoding.test.mjs` itself asserts
 * on a deliberate cheat -- so every pass excludes them (AAP 0.5.4 scans product source "excluding
 * tests").
 *
 * @param {string} name Base name.
 * @returns {boolean}
 */
function isTestFileName(name) {
  return /\.(test|spec)\.[cm]?[jt]sx?$/.test(name);
}

/**
 * Whether a repository-relative path sits in a tree the product passes must never enter, whatever
 * the tree it was reached from. `scripts/` is here because it is not product; the class D pass
 * reads it as repository tooling instead (see {@link TOOLING_TREES}).
 *
 * @param {string} relPath
 * @returns {boolean}
 */
function isExcludedPath(relPath) {
  return (
    isUnder(relPath, DEMO_TREE) ||
    isUnder(relPath, 'scripts') ||
    isUnder(relPath, 'docs') ||
    isUnder(relPath, 'tests')
  );
}

/* -------------------------------------------------------------------------------------------------
 * ts-morph
 * ---------------------------------------------------------------------------------------------- */

/**
 * Workspaces that declare ts-morph, in the order they are tried. It is not a root dependency, and
 * this script may not add one, so its installed copy is resolved through a workspace manifest.
 *
 * @type {readonly string[]}
 */
const TS_MORPH_HOSTS = Object.freeze([
  'packages/code-analysis/package.json',
  'packages/instrumentation/package.json',
]);

/** @type {{ Project: any, Node: any, SyntaxKind: any }|null} */
let tsMorphCache = null;

/**
 * Load ts-morph from a workspace's installed copy. There is no regex fallback on purpose: AAP
 * 0.5.4 requires this scanner to be AST-aware, and a grep-only pass would report a gate that is
 * not the gate the plan specifies.
 *
 * The scanned root is tried first, then this script's own repository, which is what lets the tests
 * scan synthetic trees in temporary directories that have no `node_modules` of their own. The
 * library is a parser: which installed copy provides it changes nothing about the result.
 *
 * @param {string} root Absolute repository root being scanned.
 * @returns {Promise<{ Project: any, Node: any, SyntaxKind: any }>}
 */
async function loadTsMorph(root) {
  if (tsMorphCache !== null) {
    return tsMorphCache;
  }
  /** @type {string[]} */
  const attempted = [];
  /** @type {string|null} */
  let resolved = null;
  const searchRoots = path.resolve(root) === DEFAULT_ROOT ? [DEFAULT_ROOT] : [root, DEFAULT_ROOT];
  for (const searchRoot of searchRoots) {
    for (const host of TS_MORPH_HOSTS) {
      const manifest = path.join(searchRoot, host);
      attempted.push(toPosix(manifest));
      try {
        resolved = createRequire(manifest).resolve('ts-morph');
        break;
      } catch {
        resolved = null;
      }
    }
    if (resolved !== null) {
      break;
    }
  }
  if (resolved === null) {
    attempted.push('<this script>');
    try {
      resolved = createRequire(import.meta.url).resolve('ts-morph');
    } catch {
      resolved = null;
    }
  }
  if (resolved === null) {
    throw new HardcodingCheckError(
      'ts-morph-missing',
      [
        'ts-morph could not be resolved, so the AST scan cannot run.',
        `Tried, in order: ${attempted.join(', ')}.`,
        'Run `pnpm install` at the repository root first.',
        'ts-morph 28.0.0 is declared by packages/code-analysis and packages/instrumentation, not by',
        'the root manifest, so at least one of those workspaces must be installed.',
      ].join(' '),
    );
  }
  /** @type {any} */
  const module = await import(pathToFileURL(resolved).href);
  const { Project, Node, SyntaxKind } = module;
  if (
    typeof Project !== 'function' ||
    typeof Node !== 'function' ||
    typeof SyntaxKind !== 'object'
  ) {
    throw new HardcodingCheckError(
      'ts-morph-incompatible',
      `the ts-morph copy at ${resolved} does not export Project, Node and SyntaxKind; expected ts-morph 28.x`,
    );
  }
  tsMorphCache = { Project, Node, SyntaxKind };
  return tsMorphCache;
}

/**
 * A syntax-only project. No tsconfig is read, no dependency is resolved and the type checker is
 * never asked a question, which is what keeps a full scan to a couple of seconds. `allowJs` and
 * `jsx: 4` (react-jsx) make the same project parse every extension the scan covers.
 *
 * @param {{ Project: any }} tsMorph
 * @returns {any}
 */
function createSyntaxProject(tsMorph) {
  return new tsMorph.Project({
    skipAddingFilesFromTsConfig: true,
    skipFileDependencyResolution: true,
    skipLoadingLibFiles: true,
    compilerOptions: { allowJs: true, jsx: 4, target: 99, module: 99, noLib: true },
  });
}

/**
 * Parse one file's text. The text is supplied by the caller rather than read by ts-morph, so
 * oversized and binary files are filtered first and nothing is ever written back to disk.
 *
 * A returned source file is NOT yet evidence that the text parsed: the TypeScript parser recovers
 * from malformed syntax and hands back a partial tree carrying diagnostics instead of throwing, so
 * every caller must ask {@link syntaxErrorsOf} before scanning or harvesting what it got.
 *
 * @param {any} project
 * @param {string} relPath Repository-relative POSIX path, kept as the in-project path so findings
 *   report the path a developer recognises.
 * @param {string} text
 * @returns {any|null} The source file, or `null` when ts-morph refused the text outright.
 */
function addSourceText(project, relPath, text) {
  try {
    return project.createSourceFile(relPath, text, { overwrite: true });
  } catch {
    return null;
  }
}

/**
 * The parser's own complaints about one file: a non-empty result means part of the text was not
 * understood, so the tree standing in for it is partial and anything hiding in the unparsed region
 * would go unreported. That is the fail-open case this gate must refuse (scanning a file the
 * parser gave up on is indistinguishable from not scanning it), so callers turn a non-empty result
 * into a `ScanFailure` rather than proceeding.
 *
 * Only *syntactic* diagnostics are consulted. Semantic ones are unavailable and meaningless here
 * by design: the project is syntax-only (`noLib`, no dependency resolution, no type checker), so
 * every unresolved import would otherwise read as an error.
 *
 * The parser attaches its diagnostics to the source file, which is the cheap way to read them --
 * measured at about 5 ms per file against roughly 70 ms for building a program per file. That
 * field is internal to the compiler, so when a future TypeScript stops providing it the public
 * `Program#getSyntacticDiagnostics` path is used instead: slower, never silent, which is the
 * property that matters for a guard.
 *
 * @param {{ ts: any }} tsMorph
 * @param {any} project
 * @param {any} sourceFile
 * @returns {{ code: number|undefined, message: string, start: number|undefined }[]}
 */
function syntaxErrorsOf(tsMorph, project, sourceFile) {
  const attached = /** @type {{ parseDiagnostics?: unknown }} */ (sourceFile.compilerNode)
    .parseDiagnostics;
  const raw = Array.isArray(attached)
    ? attached
    : project
        .getProgram()
        .getSyntacticDiagnostics(sourceFile)
        .map((/** @type {any} */ diagnostic) => diagnostic.compilerObject ?? diagnostic);
  return raw.map((/** @type {any} */ diagnostic) => ({
    code: typeof diagnostic.code === 'number' ? diagnostic.code : undefined,
    message:
      typeof diagnostic.messageText === 'string'
        ? diagnostic.messageText
        : tsMorph.ts.flattenDiagnosticMessageText(diagnostic.messageText, ' '),
    start: typeof diagnostic.start === 'number' ? diagnostic.start : undefined,
  }));
}

/**
 * The `ScanFailure` for a file the parser could not fully understand, naming the first error and
 * where it is, so the developer can fix the file rather than hunt for what the gate disliked.
 *
 * @param {string} relPath
 * @param {string} text
 * @param {{ code: number|undefined, message: string, start: number|undefined }[]} errors
 * @param {string} consequence What the unparsed region cost this pass.
 * @returns {ScanFailure}
 */
function unparseableFailure(relPath, text, errors, consequence) {
  const first = errors[0];
  if (first === undefined) {
    return {
      path: relPath,
      reason: 'unparseable',
      detail: `could not be parsed at all -- the parser rejected the text outright -- so ${consequence}; fix the file or, if it is not source, move it out of the scanned trees`,
    };
  }
  const at = first.start === undefined ? undefined : positionAt(lineStarts(text), first.start);
  const where = at === undefined ? '' : ` at line ${at.line}, column ${at.column}`;
  const code = first.code === undefined ? '' : `TS${first.code}: `;
  return {
    path: relPath,
    reason: 'unparseable',
    detail: `has ${pluralize(errors.length, 'syntax error')} -- ${code}${first.message}${where} -- so ${consequence}; fix the file or, if it is not source, move it out of the scanned trees`,
  };
}

/* -------------------------------------------------------------------------------------------------
 * policy and allowlist
 * ---------------------------------------------------------------------------------------------- */

/**
 * @param {string} value
 * @returns {string} `value` with every regular-expression metacharacter escaped.
 */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isStringArray(value) {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

/**
 * Read and validate a JSON artifact this script depends on.
 *
 * The raw text is returned alongside the parsed object because the committed policy's *bytes* are
 * part of its contract: `comparePolicies()` compares them with `serializePolicy()` of a fresh
 * harvest, which is the only way order-only and formatting-only drift is visible at all.
 *
 * @param {string} root Absolute repository root.
 * @param {string} relPath Repository-relative POSIX path.
 * @param {string} missingCode Error code when the file is absent.
 * @param {string} malformedCode Error code when it cannot be parsed.
 * @returns {{ text: string, value: Record<string, unknown> }}
 */
function readJsonArtifact(root, relPath, missingCode, malformedCode) {
  const absolute = path.join(root, relPath);
  const entry = statEntry(absolute);
  if ('missing' in entry) {
    throw new HardcodingCheckError(
      missingCode,
      `${relPath} is missing; regenerate it with \`${UPDATE_COMMAND}\` (or \`${PNPM_UPDATE_COMMAND}\`)`,
    );
  }
  const read = readTextFile(absolute, relPath);
  if ('failure' in read) {
    throw new HardcodingCheckError(
      malformedCode,
      `${relPath} could not be read (${read.failure.reason}): ${read.failure.detail}`,
    );
  }
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(read.text);
  } catch (error) {
    throw new HardcodingCheckError(
      malformedCode,
      `${relPath} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new HardcodingCheckError(malformedCode, `${relPath} must contain a JSON object`);
  }
  return { text: read.text, value: /** @type {Record<string, unknown>} */ (parsed) };
}

/**
 * Validate the parsed policy document and return it as a {@link Policy}. Every rejection is an
 * exit-code-2 condition: a policy this script cannot trust must stop the gate rather than silently
 * enforce less than it should.
 *
 * @param {Record<string, unknown>} raw
 * @returns {Policy}
 */
function validatePolicyShape(raw) {
  const { version, generatedBy, corpus, exclusions, identifiers, routePaths } = raw;
  if (version !== 1) {
    throw new HardcodingCheckError(
      'policy-malformed',
      `${POLICY_FILE} has version ${JSON.stringify(version)}; this script understands version 1 only`,
    );
  }
  if (typeof generatedBy !== 'string' || typeof corpus !== 'string') {
    throw new HardcodingCheckError(
      'policy-malformed',
      `${POLICY_FILE} must declare string \`generatedBy\` and \`corpus\` fields`,
    );
  }
  if (!isStringArray(exclusions) || !isStringArray(identifiers) || !isStringArray(routePaths)) {
    throw new HardcodingCheckError(
      'policy-malformed',
      `${POLICY_FILE} must declare \`exclusions\`, \`identifiers\` and \`routePaths\` as arrays of strings`,
    );
  }
  const malformedIdentifier = identifiers.find(
    (entry) => !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(entry),
  );
  if (malformedIdentifier !== undefined) {
    throw new HardcodingCheckError(
      'policy-malformed',
      `${POLICY_FILE} identifier ${JSON.stringify(malformedIdentifier)} is not a JavaScript identifier; the policy holds literal names, not patterns`,
    );
  }
  const malformedRoute = routePaths.find((entry) => !entry.startsWith('/'));
  if (malformedRoute !== undefined) {
    throw new HardcodingCheckError(
      'policy-malformed',
      `${POLICY_FILE} route path ${JSON.stringify(malformedRoute)} must start with \`/\``,
    );
  }
  return {
    version,
    generatedBy,
    corpus,
    exclusions: [...exclusions],
    identifiers: [...identifiers],
    routePaths: [...routePaths],
  };
}

/**
 * Load and validate the committed policy: the demo identifiers and route paths the product may not
 * contain.
 *
 * @param {string} [root] Absolute repository root; defaults to this script's repository.
 * @returns {Promise<Policy>}
 * @throws {HardcodingCheckError} With code `policy-missing` or `policy-malformed` (exit code 2).
 */
export async function loadPolicy(root = DEFAULT_ROOT) {
  return loadPolicySync(root);
}

/**
 * Load and validate the hand-reviewed allowlist of generic vocabulary.
 *
 * It is subtracted during `--update`, so a faithfully regenerated policy never contains an
 * allowlisted entry. It is loaded at check time as well, and any overlap is subtracted and warned
 * about, so that a hand-edited policy cannot fail legitimate product code.
 *
 * @param {string} [root] Absolute repository root.
 * @returns {Allowlist}
 * @throws {HardcodingCheckError} With code `allowlist-missing` or `allowlist-malformed`.
 */
export function loadAllowlist(root = DEFAULT_ROOT) {
  const { value: raw } = readJsonArtifact(
    root,
    ALLOWLIST_FILE,
    'allowlist-missing',
    'allowlist-malformed',
  );
  const { version, identifiers, routePaths, notes } = raw;
  if (version !== 1) {
    throw new HardcodingCheckError(
      'allowlist-malformed',
      `${ALLOWLIST_FILE} has version ${JSON.stringify(version)}; this script understands version 1 only`,
    );
  }
  if (!isStringArray(identifiers) || !isStringArray(routePaths)) {
    throw new HardcodingCheckError(
      'allowlist-malformed',
      `${ALLOWLIST_FILE} must declare \`identifiers\` and \`routePaths\` as arrays of strings`,
    );
  }
  /** @type {Allowlist} */
  const allowlist = { version, identifiers: [...identifiers], routePaths: [...routePaths] };
  if (typeof notes === 'string') {
    allowlist.notes = notes;
  }
  return allowlist;
}

/**
 * One compiled matcher per policy category, built once per run and reused for every file.
 *
 * Identifier boundaries are `(?<![A-Za-z0-9_$])` / `(?![A-Za-z0-9_$])` rather than `\b`, which
 * behaves identically for plain names and additionally refuses to match inside a name containing
 * `$` or `_`. Alternatives are sorted longest-first so the most specific entry wins at a given
 * position, which keeps `/api/widgets/archive` from being reported as `/api/widgets`.
 *
 * @typedef {object} PolicyMatchers
 * @property {ReadonlySet<string>} identifierNames Exact identifier-node matches.
 * @property {RegExp|null} identifierPattern Whole-word matches inside text.
 * @property {RegExp|null} routePattern Substring matches inside text.
 * @property {string[]} suppressed Policy entries skipped because the allowlist also lists them.
 */

/**
 * @param {Policy} policy
 * @param {Allowlist|null} allowlist
 * @returns {PolicyMatchers}
 */
export function compileMatchers(policy, allowlist) {
  const allowedIdentifiers = new Set(allowlist?.identifiers ?? []);
  const allowedRoutes = new Set(allowlist?.routePaths ?? []);
  /** @type {string[]} */
  const suppressed = [];

  /** @type {string[]} */
  const identifiers = [];
  for (const entry of policy.identifiers) {
    if (allowedIdentifiers.has(entry)) {
      suppressed.push(entry);
      continue;
    }
    identifiers.push(entry);
  }
  /** @type {string[]} */
  const routePaths = [];
  for (const entry of policy.routePaths) {
    if (allowedRoutes.has(entry)) {
      suppressed.push(entry);
      continue;
    }
    routePaths.push(entry);
  }

  const byLengthDescending = (/** @type {string} */ a, /** @type {string} */ b) =>
    b.length - a.length || (a < b ? -1 : a > b ? 1 : 0);
  const identifierAlternation = [...identifiers].sort(byLengthDescending).map(escapeRegExp);
  const routeAlternation = [...routePaths].sort(byLengthDescending).map(escapeRegExp);

  return {
    identifierNames: new Set(identifiers),
    identifierPattern:
      identifierAlternation.length === 0
        ? null
        : new RegExp(
            `(?<![A-Za-z0-9_$])(?:${identifierAlternation.join('|')})(?![A-Za-z0-9_$])`,
            'g',
          ),
    routePattern:
      routeAlternation.length === 0 ? null : new RegExp(`(?:${routeAlternation.join('|')})`, 'g'),
    suppressed,
  };
}

/**
 * Every non-overlapping match of `pattern` in `text`.
 *
 * @param {RegExp|null} pattern A global regular expression, or `null` for "nothing to match".
 * @param {string} text
 * @returns {{ match: string, index: number }[]}
 */
function findMatches(pattern, text) {
  if (pattern === null || text.length === 0) {
    return [];
  }
  /** @type {{ match: string, index: number }[]} */
  const matches = [];
  pattern.lastIndex = 0;
  for (let hit = pattern.exec(text); hit !== null; hit = pattern.exec(text)) {
    matches.push({ match: hit[0], index: hit.index });
    if (hit[0].length === 0) {
      pattern.lastIndex += 1;
    }
  }
  return matches;
}

/* -------------------------------------------------------------------------------------------------
 * scanning product source
 * ---------------------------------------------------------------------------------------------- */

/**
 * Collects findings in insertion order and keeps one record per position and rule, so a literal
 * that is both an import specifier and a demo path is reported once, under the more specific rule.
 */
class FindingCollector {
  constructor() {
    /** @type {Finding[]} */
    this.findings = [];
    /** @type {Set<string>} */
    this.seen = new Set();
  }

  /**
   * @param {Finding} finding
   * @returns {boolean} Whether the finding was new.
   */
  add(finding) {
    const key = `${finding.file}:${finding.line}:${finding.column}:${finding.rule}:${finding.match ?? ''}`;
    if (this.seen.has(key)) {
      return false;
    }
    this.seen.add(key);
    this.findings.push({ ...finding, hint: finding.hint || RULE_HINTS[finding.rule] || '' });
    return true;
  }

  /**
   * @param {string} file
   * @param {number} line
   * @param {number} column
   * @returns {boolean} Whether any finding was already recorded at this position.
   */
  hasPosition(file, line, column) {
    for (const finding of this.findings) {
      if (finding.file === file && finding.line === line && finding.column === column) {
        return true;
      }
    }
    return false;
  }
}

/**
 * Text and position helpers for one parsed file.
 *
 * @typedef {object} FileContext
 * @property {string} file Repository-relative POSIX path.
 * @property {string} text Full file text.
 * @property {number[]} starts Result of {@link lineStarts}.
 * @property {boolean} questionExempt Whether class C is suppressed for this file.
 */

/**
 * Turn an absolute character offset in a file into a finding position and line excerpt.
 *
 * @param {FileContext} context
 * @param {number} offset
 * @returns {{ line: number, column: number, snippet: string }}
 */
function locate(context, offset) {
  const { line, column, lineStart } = positionAt(context.starts, offset);
  const lineEnd = context.text.indexOf('\n', lineStart);
  const raw = context.text.slice(lineStart, lineEnd === -1 ? context.text.length : lineEnd);
  return { line, column, snippet: snippet(raw) };
}

/**
 * Unwrap the wrappers that do not change what an expression is, so taint survives parentheses, a
 * type assertion, a non-null assertion and `satisfies`.
 *
 * @param {{ Node: any }} tsMorph
 * @param {any} node
 * @returns {any}
 */
function unwrapExpression(tsMorph, node) {
  const { Node } = tsMorph;
  let current = node;
  for (let guard = 0; guard < 8 && current !== undefined; guard += 1) {
    if (Node.isParenthesizedExpression(current) || Node.isNonNullExpression(current)) {
      current = current.getExpression();
      continue;
    }
    if (
      (Node.isAsExpression?.(current) ?? false) ||
      (Node.isSatisfiesExpression?.(current) ?? false) ||
      (Node.isTypeAssertion?.(current) ?? false)
    ) {
      current = current.getExpression();
      continue;
    }
    break;
  }
  return current;
}

/**
 * Every string value a node contributes to the scan: a plain string literal, a template with no
 * substitutions, or one literal chunk of a template that has them. Returns both the cooked value
 * (for path arithmetic) and the raw text with its start offset (for exact match columns).
 *
 * @param {{ Node: any, SyntaxKind: any }} tsMorph
 * @param {any} node
 * @returns {{ value: string, raw: string, rawStart: number }|null}
 */
function stringPartOf(tsMorph, node) {
  const { Node, SyntaxKind } = tsMorph;
  if (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node)) {
    return { value: node.getLiteralValue(), raw: node.getText(), rawStart: node.getStart() };
  }
  const kind = node.getKind();
  if (
    kind === SyntaxKind.TemplateHead ||
    kind === SyntaxKind.TemplateMiddle ||
    kind === SyntaxKind.TemplateTail
  ) {
    const value =
      typeof node.getLiteralText === 'function' ? node.getLiteralText() : node.getText();
    return { value, raw: node.getText(), rawStart: node.getStart() };
  }
  return null;
}

/**
 * Whether a module specifier or path-like literal denotes the demo application.
 *
 * Relative specifiers are resolved against the containing file; a bare specifier is matched against
 * the demo's package name; anything else is normalised against the repository root as well, so both
 * `'../../apps/demo-app/app/api/widgets/route.ts'` and `'apps/demo-app'` are caught. Existence on
 * disk is never consulted: the violation is the product *naming* the demo, not resolvability.
 *
 * @param {string} specifier
 * @param {string} fromFile Repository-relative POSIX path of the file holding the specifier.
 * @returns {boolean}
 */
function referencesDemo(specifier, fromFile) {
  if (specifier.length === 0) {
    return false;
  }
  if (specifier === DEMO_PACKAGE || specifier.startsWith(`${DEMO_PACKAGE}/`)) {
    return true;
  }
  // Cheap rejection before any path arithmetic: a path can only normalise under `apps/demo-app` if
  // it spells the directory out, because no scanned file lives inside the demo tree.
  if (!specifier.includes('demo-app')) {
    return false;
  }
  // Both interpretations are tried, as AAP 0.5.4 requires: relative to the containing file, and
  // relative to the repository root. The second strips leading `./` and `../` segments, so
  // `'../../apps/demo-app/app/api/widgets/route.ts'` is caught from any depth -- a literal that
  // spells the demo tree out is a violation however many levels precede it.
  const fileRelative = path.posix.normalize(
    path.posix.join(path.posix.dirname(fromFile), specifier),
  );
  const rootRelative = path.posix.normalize(
    specifier.replace(/^\/+/, '').replace(/^(?:\.{1,2}\/)+/, ''),
  );
  return isUnder(fileRelative, DEMO_TREE) || isUnder(rootRelative, DEMO_TREE);
}

/**
 * Class A: imports, re-exports, dynamic imports and `require()` calls that reach into the demo.
 *
 * @param {{ Node: any }} tsMorph
 * @param {any} node
 * @param {FileContext} context
 * @param {FindingCollector} collector
 */
function checkDemoModuleReference(tsMorph, node, context, collector) {
  const { Node } = tsMorph;
  /** @type {{ specifier: string, node: any, form: string }|null} */
  let reference = null;

  if (Node.isImportDeclaration(node)) {
    reference = {
      specifier: node.getModuleSpecifierValue(),
      node: node.getModuleSpecifier(),
      form: 'import',
    };
  } else if (Node.isExportDeclaration(node)) {
    const specifier = node.getModuleSpecifier();
    if (specifier !== undefined) {
      reference = {
        specifier: specifier.getLiteralValue(),
        node: specifier,
        form: 'export ... from',
      };
    }
  } else if (Node.isImportEqualsDeclaration?.(node) ?? false) {
    const moduleReference = node.getModuleReference?.();
    const argument = moduleReference?.getExpression?.();
    if (argument !== undefined && Node.isStringLiteral(argument)) {
      reference = { specifier: argument.getLiteralValue(), node: argument, form: 'import =' };
    }
  } else if (Node.isCallExpression(node)) {
    const calleeText = node.getExpression().getText();
    if (calleeText === 'import' || calleeText === 'require' || calleeText === 'require.resolve') {
      const [first] = node.getArguments();
      if (first !== undefined && Node.isStringLiteral(first)) {
        reference = {
          specifier: first.getLiteralValue(),
          node: first,
          form: calleeText === 'import' ? 'dynamic import()' : `${calleeText}()`,
        };
      }
    }
  }

  if (reference === null || !referencesDemo(reference.specifier, context.file)) {
    return;
  }
  const at = locate(context, reference.node.getStart());
  collector.add({
    rule: 'demo-import',
    file: context.file,
    line: at.line,
    column: at.column,
    match: reference.specifier,
    message: `${reference.form} of ${JSON.stringify(reference.specifier)} resolves to the demo application`,
    hint: RULE_HINTS['demo-import'],
    snippet: at.snippet,
  });
}

/**
 * Classes A and B over one string literal or template chunk: a path into the demo, a demo
 * identifier used as a whole word, or a demo route path as a substring.
 *
 * @param {{ Node: any, SyntaxKind: any }} tsMorph
 * @param {any} node
 * @param {FileContext} context
 * @param {PolicyMatchers} matchers
 * @param {FindingCollector} collector
 */
function checkStringPart(tsMorph, node, context, matchers, collector) {
  const part = stringPartOf(tsMorph, node);
  if (part === null) {
    return;
  }

  if (referencesDemo(part.value, context.file)) {
    const at = locate(context, part.rawStart);
    // An import specifier is also a string literal. It was already reported under the more
    // specific `demo-import`, so only add `demo-path` when nothing holds this position.
    if (!collector.hasPosition(context.file, at.line, at.column)) {
      collector.add({
        rule: 'demo-path',
        file: context.file,
        line: at.line,
        column: at.column,
        match: part.value,
        message: `string ${JSON.stringify(part.value)} names the demo application`,
        hint: RULE_HINTS['demo-path'],
        snippet: at.snippet,
      });
    }
  }

  for (const hit of findMatches(matchers.identifierPattern, part.raw)) {
    const at = locate(context, part.rawStart + hit.index);
    collector.add({
      rule: 'policy-identifier',
      file: context.file,
      line: at.line,
      column: at.column,
      match: hit.match,
      message: `string contains the demo identifier ${JSON.stringify(hit.match)}`,
      hint: RULE_HINTS['policy-identifier'],
      snippet: at.snippet,
    });
  }

  for (const hit of findMatches(matchers.routePattern, part.raw)) {
    const at = locate(context, part.rawStart + hit.index);
    collector.add({
      rule: 'policy-route',
      file: context.file,
      line: at.line,
      column: at.column,
      match: hit.match,
      message: `string contains the demo route path ${JSON.stringify(hit.match)}`,
      hint: RULE_HINTS['policy-route'],
      snippet: at.snippet,
    });
  }
}

/**
 * Class B over one identifier node: a demo name used as a declaration, a reference, a property, an
 * imported binding or a JSX tag.
 *
 * @param {{ Node: any }} tsMorph
 * @param {any} node
 * @param {FileContext} context
 * @param {PolicyMatchers} matchers
 * @param {FindingCollector} collector
 */
function checkIdentifier(tsMorph, node, context, matchers, collector) {
  const { Node } = tsMorph;
  if (!Node.isIdentifier(node) && !Node.isPrivateIdentifier(node)) {
    return;
  }
  const text = node.getText();
  const name = text.startsWith('#') ? text.slice(1) : text;
  if (!matchers.identifierNames.has(name)) {
    return;
  }
  const at = locate(context, node.getStart());
  collector.add({
    rule: 'policy-identifier',
    file: context.file,
    line: at.line,
    column: at.column,
    match: name,
    message: `identifier ${JSON.stringify(name)} is demo application vocabulary`,
    hint: RULE_HINTS['policy-identifier'],
    snippet: at.snippet,
  });
}

/* -------------------------------------------------------------------------------------------------
 * class C: branching on the session question
 * ---------------------------------------------------------------------------------------------- */

/**
 * Whether `node` evaluates to the developer's question, as far as this file can tell.
 *
 * Tainted: a known question identifier; any member expression whose accessed name is a question
 * field (`session.question`, `record.followUp`); an element access on a tainted expression
 * (`input.followUps[0]`); and a normalising call applied to one (`question.trim().toLowerCase()`).
 *
 * Not tainted: anything else, including `question.length` -- the length of a question is a number,
 * and comparing it is legitimate control flow, not question matching.
 *
 * @param {{ Node: any }} tsMorph
 * @param {any} node
 * @param {ReadonlySet<string>} taintedNames
 * @returns {boolean}
 */
function isQuestionDerived(tsMorph, node, taintedNames) {
  const { Node } = tsMorph;
  const current = unwrapExpression(tsMorph, node);
  if (current === undefined || current === null) {
    return false;
  }
  if (Node.isIdentifier(current)) {
    return taintedNames.has(current.getText());
  }
  if (Node.isPropertyAccessExpression(current)) {
    // Only the question fields themselves taint. Deliberately *not* recursive into the receiver:
    // `question.length` is a number and comparing it is honest control flow.
    return QUESTION_PROPERTY_NAMES.has(current.getName());
  }
  if (Node.isElementAccessExpression(current)) {
    return isQuestionDerived(tsMorph, current.getExpression(), taintedNames);
  }
  if (Node.isCallExpression(current)) {
    const callee = unwrapExpression(tsMorph, current.getExpression());
    if (
      Node.isPropertyAccessExpression(callee) &&
      QUESTION_NORMALIZING_METHODS.has(callee.getName())
    ) {
      return isQuestionDerived(tsMorph, callee.getExpression(), taintedNames);
    }
    return false;
  }
  return false;
}

/**
 * Names that hold the question in this file: the known question identifiers, plus one assignment
 * level of aliases, resolved to a fixpoint so `const a = session.question; const b = a;` is caught.
 * The analysis is intentionally intra-file (see the header's note on limits).
 *
 * @param {{ Node: any }} tsMorph
 * @param {any} sourceFile
 * @returns {Set<string>}
 */
function collectTaintedNames(tsMorph, sourceFile) {
  const { Node } = tsMorph;
  const tainted = new Set(QUESTION_ROOT_NAMES);

  /** @type {{ name: string, initializer: any }[]} */
  const bindings = [];
  sourceFile.forEachDescendant((/** @type {any} */ node) => {
    if (Node.isVariableDeclaration(node) || Node.isParameterDeclaration(node)) {
      const nameNode = node.getNameNode();
      const initializer = node.getInitializer?.();
      if (Node.isIdentifier(nameNode) && initializer !== undefined) {
        bindings.push({ name: nameNode.getText(), initializer });
      }
      return;
    }
    if (Node.isPropertyAssignment(node)) {
      // `const view = { question: session.question }` keeps the field name, so a later
      // `view.question` is caught by the member-expression rule and needs no alias here.
      return;
    }
    if (Node.isBindingElement(node)) {
      // `const { question: asked } = session` -- the destructured field carries the taint.
      const propertyName = node.getPropertyNameNode?.();
      const nameNode = node.getNameNode();
      if (
        propertyName !== undefined &&
        Node.isIdentifier(propertyName) &&
        QUESTION_PROPERTY_NAMES.has(propertyName.getText()) &&
        Node.isIdentifier(nameNode)
      ) {
        tainted.add(nameNode.getText());
      }
    }
  });

  for (let pass = 0; pass < MAX_TAINT_PASSES; pass += 1) {
    let grew = false;
    for (const binding of bindings) {
      if (tainted.has(binding.name)) {
        continue;
      }
      if (isQuestionDerived(tsMorph, binding.initializer, tainted)) {
        tainted.add(binding.name);
        grew = true;
      }
    }
    if (!grew) {
      break;
    }
  }
  return tainted;
}

/**
 * Class C: a question-derived value used to choose an answer.
 *
 * Four forms are reported, all under `question-branch`: a string search method
 * (`includes`, `startsWith`, `match`, ...) called on the question; `test`/`exec` applied to it; an
 * equality comparison against a string literal; and a `switch` whose discriminant is the question
 * and which has at least one string-literal case.
 *
 * @param {{ Node: any }} tsMorph
 * @param {any} node
 * @param {FileContext} context
 * @param {ReadonlySet<string>} taintedNames
 * @param {FindingCollector} collector
 */
function checkQuestionBranch(tsMorph, node, context, taintedNames, collector) {
  const { Node } = tsMorph;
  if (context.questionExempt) {
    return;
  }

  /**
   * @param {any} at
   * @param {string} message
   */
  const report = (at, message) => {
    const position = locate(context, at.getStart());
    collector.add({
      rule: 'question-branch',
      file: context.file,
      line: position.line,
      column: position.column,
      message,
      hint: RULE_HINTS['question-branch'],
      snippet: position.snippet,
    });
  };

  if (Node.isCallExpression(node)) {
    const callee = unwrapExpression(tsMorph, node.getExpression());
    if (Node.isPropertyAccessExpression(callee)) {
      const method = callee.getName();
      if (
        QUESTION_SEARCH_METHODS.has(method) &&
        isQuestionDerived(tsMorph, callee.getExpression(), taintedNames)
      ) {
        report(
          node,
          `\`${method}\` is called on the developer's question, which decides behaviour from its wording`,
        );
        return;
      }
      if (method === 'test' || method === 'exec') {
        const [first] = node.getArguments();
        if (first !== undefined && isQuestionDerived(tsMorph, first, taintedNames)) {
          report(
            node,
            `a regular expression is matched against the developer's question with \`${method}\``,
          );
          return;
        }
      }
    }
    return;
  }

  if (Node.isBinaryExpression(node)) {
    const operator = node.getOperatorToken().getText();
    if (!EQUALITY_OPERATOR_TEXTS.has(operator)) {
      return;
    }
    const left = unwrapExpression(tsMorph, node.getLeft());
    const right = unwrapExpression(tsMorph, node.getRight());
    const isStringOperand = (/** @type {any} */ operand) =>
      Node.isStringLiteral(operand) ||
      Node.isNoSubstitutionTemplateLiteral(operand) ||
      Node.isTemplateExpression(operand);
    const leftTainted = isQuestionDerived(tsMorph, left, taintedNames);
    const rightTainted = isQuestionDerived(tsMorph, right, taintedNames);
    if ((leftTainted && isStringOperand(right)) || (rightTainted && isStringOperand(left))) {
      report(
        node,
        `the developer's question is compared with a string literal using \`${operator}\``,
      );
    }
    return;
  }

  if (Node.isSwitchStatement(node)) {
    if (!isQuestionDerived(tsMorph, node.getExpression(), taintedNames)) {
      return;
    }
    const hasStringCase = node
      .getClauses()
      .some(
        (/** @type {any} */ clause) =>
          Node.isCaseClause(clause) &&
          (Node.isStringLiteral(clause.getExpression()) ||
            Node.isNoSubstitutionTemplateLiteral(clause.getExpression())),
      );
    if (hasStringCase) {
      report(node, "a `switch` selects behaviour from the wording of the developer's question");
    }
  }
}

/* -------------------------------------------------------------------------------------------------
 * the product-source pass
 * ---------------------------------------------------------------------------------------------- */

/**
 * @param {string} root
 * @returns {{ files: string[], notes: string[], failures: ScanFailure[] }} Product source files, a
 *   note per absent tree, and everything the walk could not cover.
 */
function listProductSourceFiles(root) {
  /** @type {string[]} */
  const files = [];
  /** @type {string[]} */
  const notes = [];
  /** @type {ScanFailure[]} */
  const failures = [];
  for (const tree of PRODUCT_TREES) {
    const absolute = path.join(root, tree);
    const classified = classifyDirectory(root, absolute);
    if (classified.state === 'absent') {
      notes.push(`skipped ${tree}: not present in this checkout`);
      continue;
    }
    if (classified.state === 'failed') {
      failures.push(classified.failure);
      continue;
    }
    const walked = walkFiles(
      absolute,
      (relPath, name) =>
        SOURCE_EXTENSIONS.includes(path.extname(name)) &&
        !isTestFileName(name) &&
        !isExcludedPath(relPath),
      SKIPPED_DIRECTORIES,
      root,
    );
    files.push(...walked.files);
    failures.push(...walked.failures);
  }
  return { files: files.sort(), notes, failures };
}

/**
 * Scan every product source file for all three violation classes.
 *
 * @param {string} [root] Absolute repository root.
 * @param {Policy} [policy] Policy to enforce; loaded from `root` when omitted.
 * @param {{ allowlist?: Allowlist|null, matchers?: PolicyMatchers }} [options]
 * @returns {Promise<{ findings: Finding[], filesScanned: number, failures: ScanFailure[], notes: string[] }>}
 */
export async function scanProductSource(root = DEFAULT_ROOT, policy, options = {}) {
  const effectivePolicy = policy ?? (await loadPolicy(root));
  const matchers =
    options.matchers ??
    compileMatchers(
      effectivePolicy,
      options.allowlist === undefined ? loadAllowlist(root) : options.allowlist,
    );
  const tsMorph = await loadTsMorph(root);
  const project = createSyntaxProject(tsMorph);

  const { files, notes, failures } = listProductSourceFiles(root);
  const collector = new FindingCollector();
  let filesScanned = 0;

  for (const absolute of files) {
    const file = relative(root, absolute);
    const read = readTextFile(absolute, file);
    if ('failure' in read) {
      failures.push(read.failure);
      continue;
    }
    const sourceFile = addSourceText(project, file, read.text);
    if (sourceFile === null) {
      failures.push(unparseableFailure(file, read.text, [], 'none of its syntax was examined'));
      continue;
    }
    // The parser recovers from malformed syntax, so a source file in hand is not a parsed file:
    // an unexamined region could hold exactly what this gate looks for.
    const syntaxErrors = syntaxErrorsOf(tsMorph, project, sourceFile);
    if (syntaxErrors.length > 0) {
      project.removeSourceFile(sourceFile);
      failures.push(
        unparseableFailure(file, read.text, syntaxErrors, 'part of it went unexamined'),
      );
      continue;
    }
    filesScanned += 1;

    /** @type {FileContext} */
    const context = {
      file,
      text: read.text,
      starts: lineStarts(read.text),
      questionExempt: file === QUESTION_EXEMPT_FILE,
    };

    // Class C needs the whole file's aliases before any node can be judged, and the analysis is
    // only worth its second traversal when the file mentions a question field at all.
    const mentionsQuestion = /question|followUp/i.test(read.text);
    const taintedNames = mentionsQuestion
      ? collectTaintedNames(tsMorph, sourceFile)
      : QUESTION_ROOT_NAMES;

    sourceFile.forEachDescendant((/** @type {any} */ node) => {
      checkDemoModuleReference(tsMorph, node, context, collector);
      checkStringPart(tsMorph, node, context, matchers, collector);
      checkIdentifier(tsMorph, node, context, matchers, collector);
      if (mentionsQuestion) {
        checkQuestionBranch(tsMorph, node, context, taintedNames, collector);
      }
    });

    // Free the parsed file: a full scan otherwise holds every AST in memory at once.
    project.removeSourceFile(sourceFile);
  }

  return { findings: collector.findings, filesScanned, failures, notes };
}

/* -------------------------------------------------------------------------------------------------
 * the structured-text pass
 * ---------------------------------------------------------------------------------------------- */

/**
 * @param {string} root
 * @returns {{ files: string[], notes: string[], failures: ScanFailure[] }}
 */
function listStructuredTextFiles(root) {
  /** @type {Set<string>} */
  const files = new Set();
  /** @type {string[]} */
  const notes = [];
  /** @type {ScanFailure[]} */
  const failures = [];

  // Every file of the versioned prompts and of the deterministic provider, whatever its extension:
  // both are generation inputs, so demo vocabulary in prose is as forbidden as in code.
  for (const tree of STRUCTURED_TREES) {
    const absolute = path.join(root, tree);
    const classified = classifyDirectory(root, absolute);
    if (classified.state === 'absent') {
      notes.push(`skipped ${tree}: not present in this checkout`);
      continue;
    }
    if (classified.state === 'failed') {
      failures.push(classified.failure);
      continue;
    }
    const walked = walkFiles(
      absolute,
      (relPath, name) => !isTestFileName(name) && !isExcludedPath(relPath),
      SKIPPED_DIRECTORIES,
      root,
    );
    for (const file of walked.files) {
      files.add(file);
    }
    failures.push(...walked.failures);
  }

  // JSON, Markdown and plain text anywhere under a product tree. Workspace manifests are in this
  // set on purpose: no demo identifier belongs in a product `package.json`.
  for (const tree of PRODUCT_TREES) {
    const absolute = path.join(root, tree);
    const classified = classifyDirectory(root, absolute);
    if (classified.state === 'absent') {
      // Already reported as an absent tree by the source pass, which walks the same list.
      continue;
    }
    if (classified.state === 'failed') {
      failures.push(classified.failure);
      continue;
    }
    const walked = walkFiles(
      absolute,
      (relPath, name) =>
        STRUCTURED_EXTENSIONS.includes(path.extname(name)) &&
        !isTestFileName(name) &&
        !isExcludedPath(relPath),
      SKIPPED_DIRECTORIES,
      root,
    );
    for (const file of walked.files) {
      files.add(file);
    }
    failures.push(...walked.failures);
  }

  return { files: [...files].sort(), notes, failures };
}

/**
 * Apply the policy to the raw text of structured files. JSON is matched as text rather than parsed,
 * so keys are covered as well as values, and Markdown and prompt prose are covered as written.
 *
 * @param {string} [root] Absolute repository root.
 * @param {Policy} [policy] Policy to enforce; loaded from `root` when omitted.
 * @param {{ allowlist?: Allowlist|null, matchers?: PolicyMatchers }} [options]
 * @returns {{ findings: Finding[], filesScanned: number, failures: ScanFailure[], notes: string[] }}
 */
export function scanStructuredText(root = DEFAULT_ROOT, policy, options = {}) {
  const effectivePolicy = policy ?? loadPolicySync(root);
  const matchers =
    options.matchers ??
    compileMatchers(
      effectivePolicy,
      options.allowlist === undefined ? loadAllowlist(root) : options.allowlist,
    );

  const { files, notes, failures } = listStructuredTextFiles(root);
  const collector = new FindingCollector();
  let filesScanned = 0;

  for (const absolute of files) {
    const file = relative(root, absolute);
    const read = readTextFile(absolute, file);
    if ('failure' in read) {
      failures.push(read.failure);
      continue;
    }
    filesScanned += 1;
    const starts = lineStarts(read.text);
    /** @type {FileContext} */
    const context = { file, text: read.text, starts, questionExempt: false };

    for (const hit of findMatches(matchers.identifierPattern, read.text)) {
      const at = locate(context, hit.index);
      collector.add({
        rule: 'policy-identifier-text',
        file,
        line: at.line,
        column: at.column,
        match: hit.match,
        message: `structured file names the demo identifier ${JSON.stringify(hit.match)}`,
        hint: RULE_HINTS['policy-identifier-text'],
        snippet: at.snippet,
      });
    }
    for (const hit of findMatches(matchers.routePattern, read.text)) {
      const at = locate(context, hit.index);
      collector.add({
        rule: 'policy-route-text',
        file,
        line: at.line,
        column: at.column,
        match: hit.match,
        message: `structured file names the demo route path ${JSON.stringify(hit.match)}`,
        hint: RULE_HINTS['policy-route-text'],
        snippet: at.snippet,
      });
    }
  }

  return { findings: collector.findings, filesScanned, failures, notes };
}

/**
 * Read the committed policy as both the validated object and the exact bytes it is stored as.
 *
 * Callers that judge staleness need both: the object says which names the gate enforces, and the
 * text says whether the committed artifact is the one `--update` writes. Nothing normalises the
 * text on the way through -- a re-serialization of the parsed object would hide the very drift the
 * comparison exists to find.
 *
 * @param {string} root
 * @returns {{ policy: Policy, text: string }}
 */
function readPolicyDocument(root) {
  const { text, value } = readJsonArtifact(root, POLICY_FILE, 'policy-missing', 'policy-malformed');
  return { policy: validatePolicyShape(value), text };
}

/**
 * Synchronous policy load, used by {@link scanStructuredText} and {@link scanTooling}, which need
 * no AST and are therefore synchronous themselves. {@link loadPolicy} is the asynchronous public
 * form; both read the same file through the same validation.
 *
 * @param {string} root
 * @returns {Policy}
 */
function loadPolicySync(root) {
  return readPolicyDocument(root).policy;
}

/* -------------------------------------------------------------------------------------------------
 * the repository-tooling pass (class D)
 * ---------------------------------------------------------------------------------------------- */

/**
 * Whether a file is repository tooling the class D pass reads: a tooling extension or one of the
 * {@link TOOLING_FILE_NAMES}, not a test suite, and not one of {@link TOOLING_EXCLUDED_FILES}.
 *
 * @param {string} relPath Repository-relative POSIX path.
 * @param {string} name Base name.
 * @returns {boolean}
 */
function isToolingFile(relPath, name) {
  return (
    (TOOLING_EXTENSIONS.includes(path.extname(name)) || TOOLING_FILE_NAMES.includes(name)) &&
    !isTestFileName(name) &&
    !TOOLING_EXCLUDED_FILES.has(relPath)
  );
}

/**
 * The tooling files directly at the repository root. The root is listed but never descended: the
 * directories below it are the product trees, the corpora, the documentation and the tooling
 * trees, and each of those is scanned -- or deliberately not -- by its own rule.
 *
 * The listing fails closed on the same terms as {@link walkFiles}: a root that cannot be listed, a
 * symbolic link where a tooling file would have been read, and a non-regular entry with a tooling
 * name are each recorded rather than passed over. A directory, or a link or special file with a
 * name this pass does not read, hides nothing from it and is ignored.
 *
 * @param {string} root Absolute repository root.
 * @returns {{ files: string[], failures: ScanFailure[] }}
 */
function listRootToolingFiles(root) {
  /** @type {string[]} */
  const files = [];
  /** @type {ScanFailure[]} */
  const failures = [];
  /** @type {import('node:fs').Dirent[]} */
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch (error) {
    failures.push({
      path: '.',
      reason: 'unreadable-directory',
      detail: `could not be listed (${describeError(error)}); the tooling files at the repository root went unscanned`,
    });
    return { files, failures };
  }
  for (const entry of entries) {
    if (entry.isDirectory() || !isToolingFile(entry.name, entry.name)) {
      continue;
    }
    const absolute = path.join(root, entry.name);
    if (entry.isSymbolicLink()) {
      failures.push({
        path: entry.name,
        reason: 'symlink-not-followed',
        detail:
          'is a symbolic link where a scanned tooling file was expected, and links are never followed; replace it with a regular file',
      });
      continue;
    }
    if (entry.isFile()) {
      files.push(absolute);
      continue;
    }
    failures.push({
      path: entry.name,
      reason: 'not-a-regular-file',
      detail: 'is not a regular file, so its contents could not be examined',
    });
  }
  return { files: files.sort(), failures };
}

/**
 * Every repository-tooling file the class D pass reads: the root-level files, then everything
 * under {@link TOOLING_TREES} with the same extensions and {@link TOOLING_FILE_NAMES}, pruning
 * {@link SKIPPED_DIRECTORIES}.
 *
 * @param {string} root Absolute repository root.
 * @returns {{ files: string[], notes: string[], failures: ScanFailure[] }} Tooling files, a note per
 *   absent tree, and everything the listing could not cover.
 */
function listToolingFiles(root) {
  const rootListing = listRootToolingFiles(root);
  /** @type {Set<string>} */
  const files = new Set(rootListing.files);
  /** @type {string[]} */
  const notes = [];
  /** @type {ScanFailure[]} */
  const failures = [...rootListing.failures];

  for (const tree of TOOLING_TREES) {
    const absolute = path.join(root, tree);
    const classified = classifyDirectory(root, absolute);
    if (classified.state === 'absent') {
      notes.push(`skipped ${tree}: not present in this checkout`);
      continue;
    }
    if (classified.state === 'failed') {
      failures.push(classified.failure);
      continue;
    }
    const walked = walkFiles(absolute, isToolingFile, SKIPPED_DIRECTORIES, root);
    for (const file of walked.files) {
      files.add(file);
    }
    failures.push(...walked.failures);
  }

  return { files: [...files].sort(), notes, failures };
}

/* -------------------------------------------------------------------------------------------------
 * class D: concrete demo files named in repository tooling (`tooling-demo-file`)
 * ---------------------------------------------------------------------------------------------- */

/**
 * A path token naming the demo tree in raw tooling text: optional `./` and `../` segments, the
 * tree itself, then an optional tail of path characters.
 *
 * The left boundary refuses a token that continues a longer name (`foo-apps/demo-app`,
 * `x.apps/demo-app`), while a `/` may precede it, so `${workspaceFolder}/apps/demo-app/...`, an
 * absolute path and a repository URL are all seen. The right boundary refuses a sibling such as
 * `apps/demo-app-v2`. The tail stops at whitespace, a quote, a backtick, `<`, `>`, `|`, `\` and a
 * comma, except that a balanced `{...}` group is kept whole, commas included, so a brace glob is
 * one token. Parentheses and brackets are path characters: Next.js route groups and dynamic
 * segments (`(group)`, `[id]`) are directory names. The pattern is built from {@link DEMO_TREE},
 * so this file's own source spells no demo path out.
 *
 * Group 1 is the relative prefix; group 2 is the tail, starting at its `/`, empty for the bare tree.
 */
const DEMO_PATH_TOKEN = new RegExp(
  String.raw`(?<![\w$@.\-])((?:\.{1,2}/)*)${escapeRegExp(DEMO_TREE)}(?![\w$@\-]|\.[\w$@\-])((?:/(?:\{[^\s'"\x60{}]*\}|[^\s'"\x60<>|\\{},])*)?)`,
  'g',
);

/** Whether a path segment holds a glob metacharacter, which makes it a pattern, not a name. */
const GLOB_METACHARACTER = /[*?[{]/;

/**
 * Punctuation that commonly trails a path written in prose or code -- the end of a sentence, a
 * clause, a closing parenthesis or bracket, a closing quote. It is removed from a token only when
 * the longer form does not exist, because a demo directory may legitimately end in one (a route
 * group such as `app/(group)`). A comma needs no entry: outside a brace group it already ends the
 * token. Quotes and backticks end a token too; they stay listed so that stripping does not depend
 * on {@link DEMO_PATH_TOKEN} excluding them.
 *
 * @type {ReadonlySet<string>}
 */
const TRAILING_PATH_PUNCTUATION = Object.freeze(
  new Set(['.', ':', ';', '!', ')', ']', "'", '"', '`']),
);

/** A source location after a file name, `:12`, `:12:5`, `#L12` or `#L12-L20`. */
const SOURCE_LOCATION_SUFFIX = /(?::\d+(?::\d+)?|#L\d+(?:-L?\d+)?)$/;

/**
 * Every demo path token in `text`, with a non-empty tail.
 *
 * @param {string} text
 * @returns {{ index: number, prefix: string, rest: string }[]} `index` is the offset of the token
 *   (its relative prefix included) and `rest` its tail below the demo tree, without the leading `/`.
 */
function findDemoPathTokens(text) {
  /** @type {{ index: number, prefix: string, rest: string }[]} */
  const tokens = [];
  DEMO_PATH_TOKEN.lastIndex = 0;
  for (let hit = DEMO_PATH_TOKEN.exec(text); hit !== null; hit = DEMO_PATH_TOKEN.exec(text)) {
    const rest = (hit[2] ?? '').slice(1);
    if (rest.length > 0) {
      tokens.push({ index: hit.index, prefix: hit[1] ?? '', rest });
    }
  }
  return tokens;
}

/**
 * The forms of a token's tail worth resolving, longest first: the tail as written, then with each
 * trailing punctuation character removed in turn, and, after any of those that ends in a source
 * location, the same form without it. The resolver stops at the first form that resolves to
 * anything, which is what "only when the longer form does not exist" means in practice.
 *
 * @param {string} rest
 * @returns {string[]}
 */
function demoPathForms(rest) {
  /** @type {string[]} */
  const forms = [];
  const add = (/** @type {string} */ form) => {
    if (form.length > 0 && !forms.includes(form)) {
      forms.push(form);
    }
  };
  let current = rest;
  for (;;) {
    add(current);
    add(current.replace(SOURCE_LOCATION_SUFFIX, ''));
    if (!TRAILING_PATH_PUNCTUATION.has(current.slice(-1))) {
      return forms;
    }
    current = current.slice(0, -1);
  }
}

/**
 * Index of the `}` closing the `{` at `open`, counting nested groups, or -1 when it is unbalanced.
 *
 * @param {string} text
 * @param {number} open
 * @returns {number}
 */
function closingBrace(text, open) {
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    if (text[index] === '{') {
      depth += 1;
    } else if (text[index] === '}') {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return -1;
}

/**
 * Split a brace group's body on the commas that are not inside a nested group.
 *
 * @param {string} body
 * @returns {string[]}
 */
function braceAlternatives(body) {
  /** @type {string[]} */
  const alternatives = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < body.length; index += 1) {
    const character = body[index];
    if (character === '{') {
      depth += 1;
    } else if (character === '}') {
      depth -= 1;
    } else if (character === ',' && depth === 0) {
      alternatives.push(body.slice(start, index));
      start = index + 1;
    }
  }
  alternatives.push(body.slice(start));
  return alternatives;
}

/**
 * Regular-expression source for one glob path segment: `*`, `?`, a `[...]` class (negated with `!`
 * or `^`) and `{a,b}` alternatives, which may nest. Anything else, an unclosed `[` or `{` included,
 * is literal.
 *
 * @param {string} text
 * @returns {string}
 */
function globFragment(text) {
  let source = '';
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index] ?? '';
    if (character === '*') {
      source += '[^/]*';
      continue;
    }
    if (character === '?') {
      source += '[^/]';
      continue;
    }
    if (character === '[') {
      // A `]` directly after the opening bracket is a member, as in every glob dialect.
      const close = text.indexOf(']', index + 2);
      const body = close === -1 ? '' : text.slice(index + 1, close);
      const negated = body.startsWith('!') || body.startsWith('^');
      const members = negated ? body.slice(1) : body;
      if (members.length > 0) {
        source += `[${negated ? '^' : ''}${members.replace(/[\\\]^[]/g, '\\$&')}]`;
        index = close;
        continue;
      }
    }
    if (character === '{') {
      const close = closingBrace(text, index);
      const alternatives = close === -1 ? [] : braceAlternatives(text.slice(index + 1, close));
      if (alternatives.length > 1) {
        source += `(?:${alternatives.map(globFragment).join('|')})`;
        index = close;
        continue;
      }
    }
    source += escapeRegExp(character);
  }
  return source;
}

/**
 * Compile one glob path segment. A wildcard does not match a leading `.` unless the segment itself
 * starts with one, which is how the linters and test runners configuring this repository read a
 * glob. A segment that compiles to an invalid expression (a reversed range such as `[z-a]`) is
 * matched literally rather than thrown out of the gate.
 *
 * @param {string} segment
 * @returns {RegExp}
 */
function globSegmentPattern(segment) {
  const guard = segment.startsWith('.') ? '' : String.raw`(?!\.)`;
  try {
    return new RegExp(`^${guard}${globFragment(segment)}$`);
  } catch {
    return new RegExp(`^${escapeRegExp(segment)}$`);
  }
}

/**
 * How one demo path token resolved against the demo tree.
 *
 * @typedef {object} DemoPathResolution
 * @property {'file'|'allowed'|'none'|'failed'|'unresolved'} kind `file` when the token names a
 *   concrete demo file, which is the finding; `allowed` for a directory, a workspace-root entry, a
 *   path through a pruned directory or `..`, a symbolic link and a glob whose last segment is a
 *   wildcard; `none` when no form resolves to anything; `failed` when resolving hit a path that
 *   could not be inspected, recorded as a {@link ScanFailure}; `unresolved` when the demo tree is
 *   absent from this checkout.
 * @property {string} form The form of the tail that decided the outcome.
 * @property {boolean} glob Whether that form was matched as a pattern.
 */

/**
 * Resolves the demo path tokens found in repository tooling against `apps/demo-app`, for one run.
 *
 * Nothing is ever followed or read: every entry is examined with `lstat`, directories are listed
 * only to match a glob segment, and a symbolic link -- the file itself or a directory on the way
 * to it -- ends the resolution as `allowed` rather than being traversed. Each distinct tail is
 * resolved once, and every `lstat` and listing is cached, so a token repeated across the tooling
 * costs nothing after its first sighting. A path that exists but cannot be inspected, and a
 * directory that cannot be listed, are {@link ScanFailure}s: the gate cannot say whether tooling
 * names a demo file it could not look at.
 */
class DemoFileResolver {
  /**
   * @param {string} root Absolute repository root.
   */
  constructor(root) {
    this.root = root;
    this.demoRoot = path.join(root, DEMO_TREE);
    /** @type {'directory'|'absent'|'failed'|null} */
    this.demoState = null;
    /** @type {Map<string, DemoPathResolution>} */
    this.resolutions = new Map();
    /** @type {Map<string, ReturnType<typeof statEntry>>} */
    this.stats = new Map();
    /** @type {Map<string, string[]|null>} */
    this.listings = new Map();
    /** @type {Map<string, RegExp>} */
    this.patterns = new Map();
    /** @type {ScanFailure[]} */
    this.failures = [];
    /** Distinct tails that needed the demo tree while it was absent. */
    this.unresolved = 0;
  }

  /**
   * @param {string} rest A token's tail below the demo tree.
   * @param {string} fromFile Tooling file the token was first seen in, for a failure's detail.
   * @returns {DemoPathResolution}
   */
  resolve(rest, fromFile) {
    const cached = this.resolutions.get(rest);
    if (cached !== undefined) {
      return cached;
    }
    const resolution = this.resolveForms(rest, fromFile);
    this.resolutions.set(rest, resolution);
    return resolution;
  }

  /**
   * @param {string} rest
   * @param {string} fromFile
   * @returns {DemoPathResolution}
   */
  resolveForms(rest, fromFile) {
    for (const form of demoPathForms(rest)) {
      const segments = form.split('/').filter((segment) => segment !== '' && segment !== '.');
      // A workspace-root entry (package.json, tsconfig.json, .env.example, a top-level directory)
      // is workspace configuration; `..` leaves the tree; a pruned directory holds no source.
      if (
        segments.length < 2 ||
        segments.some((segment) => segment === '..' || SKIPPED_CORPUS_DIRECTORIES.has(segment))
      ) {
        return { kind: 'allowed', form, glob: false };
      }
      const state = this.demoTreeState();
      if (state !== 'directory') {
        if (state === 'absent') {
          this.unresolved += 1;
        }
        return { kind: state === 'absent' ? 'unresolved' : 'failed', form, glob: false };
      }
      const outcome = this.classify(segments, form, fromFile);
      if (outcome.kind !== 'none') {
        return outcome;
      }
    }
    return { kind: 'none', form: rest, glob: false };
  }

  /**
   * The demo tree's own state, classified once. A tree that exists but is not a readable directory
   * is a failure, recorded the first time a token needs it.
   *
   * @returns {'directory'|'absent'|'failed'}
   */
  demoTreeState() {
    if (this.demoState === null) {
      const classified = classifyDirectory(this.root, this.demoRoot);
      if (classified.state === 'failed') {
        this.failures.push(classified.failure);
      }
      this.demoState = classified.state;
    }
    return this.demoState;
  }

  /**
   * @param {string[]} segments The form's path segments below the demo tree.
   * @param {string} form
   * @param {string} fromFile
   * @returns {DemoPathResolution}
   */
  classify(segments, form, fromFile) {
    const context = { failed: false, fromFile };
    // The literal path comes first, so a bracketed dynamic segment (`[id]`) that exists on disk is
    // resolved as the name it is, not as a character class.
    const literal = this.literalEntry(segments, context);
    if (context.failed) {
      return { kind: 'failed', form, glob: false };
    }
    if (literal !== 'missing') {
      return { kind: literal === 'file' ? 'file' : 'allowed', form, glob: false };
    }
    if (!segments.some((segment) => GLOB_METACHARACTER.test(segment))) {
      return { kind: 'none', form, glob: false };
    }
    // A glob whose last segment is a wildcard selects a kind of file, which is how tooling
    // configures the demo as a workspace; one whose last segment is a name pins that file.
    if (GLOB_METACHARACTER.test(segments[segments.length - 1] ?? '')) {
      return { kind: 'allowed', form, glob: true };
    }
    if (this.globMatchesFile(segments, context)) {
      return { kind: 'file', form, glob: true };
    }
    return { kind: context.failed ? 'failed' : 'none', form, glob: true };
  }

  /**
   * `lstat` through the cache. A path that exists but cannot be inspected is recorded once, and
   * marks every resolution that meets it as failed. A name longer than the filesystem accepts
   * (`ENAMETOOLONG`, as a long run of text after the demo tree produces) is missing rather than
   * failed: no entry can have it, so it hides nothing.
   *
   * @param {string} absolute
   * @param {{ failed: boolean, fromFile: string }} context
   * @param {'unreadable-file'|'unreadable-directory'} reason
   * @returns {import('node:fs').Stats|null} `null` when the path is missing or uninspectable.
   */
  inspect(absolute, context, reason) {
    let entry = this.stats.get(absolute);
    if (entry === undefined) {
      entry = statEntry(absolute);
      if (
        'error' in entry &&
        /** @type {{ code?: unknown }} */ (entry.error).code === 'ENAMETOOLONG'
      ) {
        entry = { missing: true };
      }
      this.stats.set(absolute, entry);
      if ('error' in entry) {
        this.failures.push({
          path: relative(this.root, absolute),
          reason,
          detail: `could not be inspected (${describeError(entry.error)}) while resolving a demo path named in ${context.fromFile}; make it readable and re-run -- the gate cannot say whether tooling names a demo file it cannot see`,
        });
      }
    }
    if ('error' in entry) {
      context.failed = true;
      return null;
    }
    return 'stat' in entry ? entry.stat : null;
  }

  /**
   * The names of the real, non-pruned subdirectories of `directory`, listed once. Symbolic links
   * are not directories here, so a glob never descends through one.
   *
   * @param {string} directory
   * @param {{ failed: boolean, fromFile: string }} context
   * @returns {string[]}
   */
  subdirectories(directory, context) {
    let listing = this.listings.get(directory);
    if (listing === undefined) {
      try {
        listing = readdirSync(directory, { withFileTypes: true })
          .filter((entry) => entry.isDirectory() && !SKIPPED_CORPUS_DIRECTORIES.has(entry.name))
          .map((entry) => entry.name)
          .sort();
      } catch (error) {
        listing = null;
        this.failures.push({
          path: relative(this.root, directory),
          reason: 'unreadable-directory',
          detail: `could not be listed (${describeError(error)}) while matching a demo path glob named in ${context.fromFile}; make it readable and re-run`,
        });
      }
      this.listings.set(directory, listing);
    }
    if (listing === null) {
      context.failed = true;
      return [];
    }
    return listing;
  }

  /**
   * What the literal path is, walked one segment at a time so that no symbolic link on the way is
   * followed.
   *
   * @param {string[]} segments
   * @param {{ failed: boolean, fromFile: string }} context
   * @returns {'file'|'other'|'missing'} `other` for a directory, a link or a special file.
   */
  literalEntry(segments, context) {
    let current = this.demoRoot;
    for (let index = 0; index < segments.length; index += 1) {
      current = path.join(current, segments[index] ?? '');
      const last = index === segments.length - 1;
      const stat = this.inspect(
        current,
        context,
        last ? 'unreadable-file' : 'unreadable-directory',
      );
      if (stat === null) {
        return 'missing';
      }
      if (last) {
        return stat.isFile() ? 'file' : 'other';
      }
      if (stat.isSymbolicLink()) {
        return 'other';
      }
      if (!stat.isDirectory()) {
        return 'missing';
      }
    }
    return 'missing';
  }

  /**
   * Whether a glob whose last segment is a literal name matches at least one regular file. Only
   * the glob's literal directory prefix is entered directly; below it, directories are listed and
   * matched segment by segment, pruned names and links excluded, and the walk stops at the first
   * match.
   *
   * @param {string[]} segments
   * @param {{ failed: boolean, fromFile: string }} context
   * @returns {boolean}
   */
  globMatchesFile(segments, context) {
    const firstPattern = segments.findIndex((segment) => GLOB_METACHARACTER.test(segment));
    let directory = this.demoRoot;
    for (const segment of segments.slice(0, firstPattern)) {
      directory = path.join(directory, segment);
      const stat = this.inspect(directory, context, 'unreadable-directory');
      if (stat === null || !stat.isDirectory()) {
        return false;
      }
    }
    return this.matchFrom(directory, segments, firstPattern, context);
  }

  /**
   * @param {string} directory Absolute directory matched so far.
   * @param {string[]} segments
   * @param {number} index Segment to match inside `directory`.
   * @param {{ failed: boolean, fromFile: string }} context
   * @returns {boolean}
   */
  matchFrom(directory, segments, index, context) {
    const segment = segments[index] ?? '';
    if (index === segments.length - 1) {
      // The last segment is a literal file name: that is what makes this glob pin a file.
      const stat = this.inspect(path.join(directory, segment), context, 'unreadable-file');
      return stat !== null && stat.isFile();
    }
    if (segment === '**') {
      if (this.matchFrom(directory, segments, index + 1, context)) {
        return true;
      }
      return this.subdirectories(directory, context).some(
        (child) =>
          !child.startsWith('.') &&
          this.matchFrom(path.join(directory, child), segments, index, context),
      );
    }
    if (!GLOB_METACHARACTER.test(segment)) {
      const next = path.join(directory, segment);
      const stat = this.inspect(next, context, 'unreadable-directory');
      return (
        stat !== null && stat.isDirectory() && this.matchFrom(next, segments, index + 1, context)
      );
    }
    const pattern = this.patterns.get(segment) ?? globSegmentPattern(segment);
    this.patterns.set(segment, pattern);
    return this.subdirectories(directory, context).some(
      (child) =>
        pattern.test(child) &&
        this.matchFrom(path.join(directory, child), segments, index + 1, context),
    );
  }
}

/**
 * Class D: apply the policy to the raw text of repository tooling -- the configuration files at
 * the repository root and everything under `scripts/`, `.github/` and `.vscode/`.
 *
 * Tooling is matched as text, never parsed, and comments count. Unlike product source, tooling
 * cannot leak demo knowledge into runtime behaviour, but it can record it: a lint exception keyed
 * on demo files, a CI step naming a demo route, a guard whose comments describe where a defect
 * lives. Any of those puts the demo's internals somewhere other than `docs/DEMO.md` (AAP 0.7.2,
 * 0.8.5), so an exception tooling needs has to be expressed by workspace or by rule instead.
 * `apps/demo-app` itself is not policy vocabulary, which is what lets tooling configure the demo
 * workspace as a whole.
 *
 * A path is demo knowledge as much as a name is, so the same text is also searched for paths
 * under `apps/demo-app` (`tooling-demo-file`). The tree itself, a directory in it, an entry at its
 * root (package.json, tsconfig.json, .env.example and the other workspace configuration) and a
 * glob whose last segment is a wildcard configure the demo as a workspace and are allowed. A path
 * that resolves, without following a symbolic link, to a regular file below the root, and a glob
 * whose last segment is a file name matching at least one such file, pin one demo file and are
 * reported. A path that resolves to nothing is not a finding here. The heuristic sees only the
 * demo tree spelled out literally: a path assembled from pieces (`path.join(demo, 'src', ...)`)
 * or encoded is not seen, brace alternatives spanning a `/` are not expanded, and an absent
 * `apps/demo-app` leaves every token unresolved, which the run reports as a note.
 *
 * @param {string} [root] Absolute repository root.
 * @param {Policy} [policy] Policy to enforce; loaded from `root` when omitted.
 * @param {{ allowlist?: Allowlist|null, matchers?: PolicyMatchers }} [options]
 * @returns {{ findings: Finding[], filesScanned: number, failures: ScanFailure[], notes: string[] }}
 */
export function scanTooling(root = DEFAULT_ROOT, policy, options = {}) {
  const effectivePolicy = policy ?? loadPolicySync(root);
  const matchers =
    options.matchers ??
    compileMatchers(
      effectivePolicy,
      options.allowlist === undefined ? loadAllowlist(root) : options.allowlist,
    );

  const { files, notes, failures } = listToolingFiles(root);
  const collector = new FindingCollector();
  const demoFiles = new DemoFileResolver(root);
  let filesScanned = 0;

  for (const absolute of files) {
    const file = relative(root, absolute);
    const read = readTextFile(absolute, file);
    if ('failure' in read) {
      failures.push(read.failure);
      continue;
    }
    filesScanned += 1;
    /** @type {FileContext} */
    const context = { file, text: read.text, starts: lineStarts(read.text), questionExempt: false };

    for (const token of findDemoPathTokens(read.text)) {
      const resolution = demoFiles.resolve(token.rest, file);
      if (resolution.kind !== 'file') {
        continue;
      }
      const at = locate(context, token.index);
      const match = `${token.prefix}${DEMO_TREE}/${resolution.form}`;
      collector.add({
        rule: 'tooling-demo-file',
        file,
        line: at.line,
        column: at.column,
        match,
        message: resolution.glob
          ? `repository tooling pins a demo file with the glob ${JSON.stringify(match)}`
          : `repository tooling names the demo file ${JSON.stringify(match)}`,
        hint: RULE_HINTS['tooling-demo-file'],
        snippet: at.snippet,
      });
    }

    for (const hit of findMatches(matchers.identifierPattern, read.text)) {
      const at = locate(context, hit.index);
      collector.add({
        rule: 'tooling-identifier-text',
        file,
        line: at.line,
        column: at.column,
        match: hit.match,
        message: `repository tooling names the demo identifier ${JSON.stringify(hit.match)}`,
        hint: RULE_HINTS['tooling-identifier-text'],
        snippet: at.snippet,
      });
    }
    for (const hit of findMatches(matchers.routePattern, read.text)) {
      const at = locate(context, hit.index);
      collector.add({
        rule: 'tooling-route-text',
        file,
        line: at.line,
        column: at.column,
        match: hit.match,
        message: `repository tooling names the demo route path ${JSON.stringify(hit.match)}`,
        hint: RULE_HINTS['tooling-route-text'],
        snippet: at.snippet,
      });
    }
  }

  failures.push(...demoFiles.failures);
  if (demoFiles.unresolved > 0) {
    notes.push(
      `tooling-demo-file not checked: ${DEMO_TREE} is not present in this checkout, so ${pluralize(demoFiles.unresolved, 'path')} below it named in repository tooling could not be resolved`,
    );
  }
  return { findings: collector.findings, filesScanned, failures, notes };
}

/* -------------------------------------------------------------------------------------------------
 * `--update`: regenerating the policy from the demo corpus
 * ---------------------------------------------------------------------------------------------- */

/**
 * Split an identifier into camel-case tokens. The boundaries are: lower or digit followed by upper
 * (`loadCart`), a letter/digit transition (`api2Client`), and an acronym followed by a word
 * (`APIClient` -> `API`, `Client`). Separators are not boundaries, so an all-caps constant stays a
 * single token and is filtered out.
 *
 * @param {string} name
 * @returns {string[]}
 */
export function camelTokens(name) {
  const spaced = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([A-Za-z])([0-9])/g, '$1 $2')
    .replace(/([0-9])([A-Za-z])/g, '$1 $2');
  return spaced.split(/\s+/).filter((token) => token.length > 0);
}

/**
 * The filter AAP 0.5.4 specifies for the harvest: keep only identifiers with two or more camel-case
 * tokens, drop anything shorter than four characters, and drop all-caps constants with no camel
 * boundary. `WidgetCard`, `useWidgetSummary` and `apiClient` qualify; `Product`, `Cart` and `GET`
 * do not, which is why the generic ones live in the allowlist instead.
 *
 * @param {string} name
 * @returns {boolean}
 */
export function isDemoSpecificIdentifier(name) {
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) {
    return false;
  }
  if (name.length < 4) {
    return false;
  }
  if (/^[A-Z0-9_$]+$/.test(name)) {
    return false;
  }
  return camelTokens(name).length >= 2;
}

/**
 * Whether a corpus file whose path is `relPath` is source the harvest should read.
 *
 * @param {string} relPath
 * @param {string} name
 * @returns {boolean}
 */
function isCorpusSourceFile(relPath, name) {
  return (
    SOURCE_EXTENSIONS.includes(path.extname(name)) &&
    !relPath.includes('/src/generated/') &&
    !name.endsWith('.d.ts')
  );
}

/**
 * Whether object-literal member names in this file are harvested. Service modules describe the
 * demo's own domain operations, so their member names are demo vocabulary; object literals
 * elsewhere are mostly props and configuration and would add noise.
 *
 * @param {string} relPath
 * @returns {boolean}
 */
function isServiceModule(relPath) {
  return relPath.includes('/server/services/') || relPath.endsWith('.service.ts');
}

/**
 * Harvest declared names and `/api/...` literals from one corpus tree.
 *
 * Declarations read: functions, classes, variables, interfaces, type aliases, enums and enum
 * members, export specifiers (so a renamed re-export is covered), JSX tag names, and object-literal
 * members in service modules. Parameters and type members are not read: their names are mostly
 * generic and would fill the policy with words the product legitimately uses.
 *
 * A corpus file the harvest cannot read is a scan failure, not a gap to work around: the policy is
 * defined as what this harvest yields, so a partial harvest would rewrite the gate.
 *
 * @param {{ Project: any, Node: any, SyntaxKind: any }} tsMorph
 * @param {string} root
 * @param {string} tree Repository-relative tree to harvest.
 * @returns {{ identifiers: Set<string>, routePaths: Set<string>, files: number, failures: ScanFailure[] }}
 */
function harvestTree(tsMorph, root, tree) {
  const { Node } = tsMorph;
  /** @type {Set<string>} */
  const identifiers = new Set();
  /** @type {Set<string>} */
  const routePaths = new Set();
  /** @type {ScanFailure[]} */
  const failures = [];
  const absoluteTree = path.join(root, tree);
  const classified = classifyDirectory(root, absoluteTree);
  if (classified.state === 'absent') {
    return { identifiers, routePaths, files: 0, failures };
  }
  if (classified.state === 'failed') {
    return { identifiers, routePaths, files: 0, failures: [classified.failure] };
  }

  const project = createSyntaxProject(tsMorph);
  const walked = walkFiles(absoluteTree, isCorpusSourceFile, SKIPPED_CORPUS_DIRECTORIES, root);
  failures.push(...walked.failures);
  let parsed = 0;

  for (const absolute of walked.files) {
    const file = relative(root, absolute);
    const read = readTextFile(absolute, file);
    if ('failure' in read) {
      failures.push(read.failure);
      continue;
    }
    const sourceFile = addSourceText(project, file, read.text);
    if (sourceFile === null) {
      failures.push(
        unparseableFailure(
          file,
          read.text,
          [],
          'none of the vocabulary it declares reached the regenerated policy',
        ),
      );
      continue;
    }
    const syntaxErrors = syntaxErrorsOf(tsMorph, project, sourceFile);
    if (syntaxErrors.length > 0) {
      project.removeSourceFile(sourceFile);
      failures.push(
        unparseableFailure(
          file,
          read.text,
          syntaxErrors,
          'the vocabulary declared in the unparsed region is missing from the regenerated policy',
        ),
      );
      continue;
    }
    parsed += 1;
    const harvestMembers = isServiceModule(file);

    sourceFile.forEachDescendant((/** @type {any} */ node) => {
      if (
        Node.isFunctionDeclaration(node) ||
        Node.isClassDeclaration(node) ||
        Node.isVariableDeclaration(node) ||
        Node.isInterfaceDeclaration(node) ||
        Node.isTypeAliasDeclaration(node) ||
        Node.isEnumDeclaration(node) ||
        Node.isEnumMember(node)
      ) {
        const nameNode = node.getNameNode?.();
        if (nameNode !== undefined && Node.isIdentifier(nameNode)) {
          identifiers.add(nameNode.getText());
        }
        return;
      }
      if (Node.isExportSpecifier(node)) {
        for (const nameNode of [node.getNameNode(), node.getAliasNode()]) {
          if (nameNode !== undefined && Node.isIdentifier(nameNode)) {
            identifiers.add(nameNode.getText());
          }
        }
        return;
      }
      if (
        harvestMembers &&
        (Node.isPropertyAssignment(node) ||
          Node.isShorthandPropertyAssignment(node) ||
          Node.isMethodDeclaration(node))
      ) {
        const nameNode = node.getNameNode?.();
        if (nameNode !== undefined && Node.isIdentifier(nameNode)) {
          identifiers.add(nameNode.getText());
        }
        return;
      }
      if (Node.isJsxOpeningElement(node) || Node.isJsxSelfClosingElement(node)) {
        const tagNode = node.getTagNameNode();
        if (Node.isIdentifier(tagNode)) {
          identifiers.add(tagNode.getText());
        } else {
          for (const part of tagNode.getText().split('.')) {
            identifiers.add(part);
          }
        }
        return;
      }
      const part = stringPartOf(tsMorph, node);
      if (part !== null) {
        const route = normalizeRoutePath(part.value);
        if (route !== null) {
          routePaths.add(route);
        }
      }
    });

    project.removeSourceFile(sourceFile);
  }

  return { identifiers, routePaths, files: parsed, failures };
}

/**
 * Reduce a literal to the `/api/...` path it names, or `null` when it names none. Query strings and
 * fragments are dropped, a trailing slash is removed, and `/api` alone is not a route.
 *
 * @param {string} value
 * @returns {string|null}
 */
function normalizeRoutePath(value) {
  const start = value.indexOf('/api/');
  if (start === -1) {
    return null;
  }
  const tail = value.slice(start);
  const stopped = tail.split(/[?#\s'"`]/, 1)[0] ?? '';
  const trimmed = stopped.length > 1 && stopped.endsWith('/') ? stopped.slice(0, -1) : stopped;
  if (trimmed === '/api' || trimmed.length <= '/api/'.length) {
    return null;
  }
  // A literal ending in a template hole or a concatenation leaves the last segment incomplete; keep
  // the complete prefix so `/api/widgets/` in `` `/api/widgets/${slug}` `` becomes
  // `/api/widgets`, which the App Router directory harvest also yields.
  return path.posix.normalize(trimmed);
}

/**
 * Route paths declared by the App Router file layout: every `route.ts` under `app/api`. Route
 * groups (`(group)`) and parallel-route slots (`@slot`) are not part of the URL and are dropped;
 * dynamic segments keep their literal `[slug]` form, as the policy records them.
 *
 * @param {string} root
 * @param {string} tree Repository-relative corpus tree.
 * @returns {{ routePaths: Set<string>, failures: ScanFailure[] }}
 */
function harvestRouteHandlerPaths(root, tree) {
  /** @type {Set<string>} */
  const routePaths = new Set();
  const apiDirectory = path.join(root, tree, 'app', 'api');
  const classified = classifyDirectory(root, apiDirectory);
  if (classified.state === 'absent') {
    return { routePaths, failures: [] };
  }
  if (classified.state === 'failed') {
    return { routePaths, failures: [classified.failure] };
  }
  const handlers = walkFiles(
    apiDirectory,
    (_relPath, name) => /^route\.[cm]?[jt]sx?$/.test(name),
    SKIPPED_CORPUS_DIRECTORIES,
    root,
  );
  const prefix = `${toPosix(path.join(tree, 'app'))}/`;
  for (const absolute of handlers.files) {
    const relPath = relative(root, absolute);
    const withoutPrefix = relPath.slice(prefix.length);
    const segments = withoutPrefix
      .split('/')
      .slice(0, -1)
      .filter((segment) => !(segment.startsWith('(') && segment.endsWith(')')))
      .filter((segment) => !segment.startsWith('@'));
    if (segments.length === 0) {
      continue;
    }
    routePaths.add(`/${segments.join('/')}`);
  }
  return { routePaths, failures: handlers.failures };
}

/**
 * Harvest the demo's database vocabulary from its Prisma schema: model names and field names. A
 * schema that does not exist contributes nothing.
 *
 * @param {string} root
 * @param {string} tree Repository-relative corpus tree.
 * @returns {{ identifiers: Set<string>, present: boolean, failures: ScanFailure[] }}
 */
function harvestPrismaSchema(root, tree) {
  /** @type {Set<string>} */
  const identifiers = new Set();
  const relPath = `${tree}/prisma/schema.prisma`;
  const absolute = path.join(root, relPath);
  const entry = statEntry(absolute);
  if ('missing' in entry) {
    return { identifiers, present: false, failures: [] };
  }
  const read = readTextFile(absolute, relPath);
  if ('failure' in read) {
    // A schema that is there but unreadable is not "no database vocabulary": it is a hole.
    return { identifiers, present: true, failures: [read.failure] };
  }
  let inBlock = false;
  for (const rawLine of read.text.split('\n')) {
    const line = rawLine.trim();
    if (!inBlock) {
      const blockStart = /^(model|type|view)\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{/.exec(line);
      if (blockStart !== null) {
        identifiers.add(/** @type {string} */ (blockStart[2]));
        inBlock = true;
      }
      const enumStart = /^enum\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{/.exec(line);
      if (enumStart !== null) {
        identifiers.add(/** @type {string} */ (enumStart[1]));
        inBlock = true;
      }
      continue;
    }
    if (line.startsWith('}')) {
      inBlock = false;
      continue;
    }
    const field = /^([A-Za-z_][A-Za-z0-9_]*)\s+\S/.exec(line);
    if (field !== null) {
      identifiers.add(/** @type {string} */ (field[1]));
      continue;
    }
    // An enum value is a bare name on its own line.
    const enumValue = /^([A-Za-z_][A-Za-z0-9_]*)\s*$/.exec(line);
    if (enumValue !== null) {
      identifiers.add(/** @type {string} */ (enumValue[1]));
    }
  }
  return { identifiers, present: true, failures: [] };
}

/**
 * @param {Iterable<string>} values
 * @returns {string[]} De-duplicated and ASCII-sorted, case-sensitive, as the policy file requires.
 */
function sortedUnique(values) {
  return [...new Set(values)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Compute the policy from the demo corpus. Pure: it reads the corpora and the allowlist and returns
 * the object, writing nothing.
 *
 * Inputs, and only these inputs (AAP 0.5.4):
 *   1. the demo application's own code index (`apps/demo-app`), including its Prisma schema and its
 *      App Router `app/api` layout;
 *   2. minus every name that also occurs in `tests/fixtures/sample-next-app`, an independent corpus
 *      -- a name common to both is not demo-specific;
 *   3. minus every entry of the hand-reviewed allowlist.
 *
 * The product trees are never enumerated here, so an identifier that has leaked into the product
 * cannot bless itself by being there. The corpus state and every corpus file the harvest could not
 * read are returned alongside the policy: a caller must not compare against, or write, a policy
 * computed over a tree it only partly managed to read.
 *
 * @param {string} [root] Absolute repository root.
 * @param {{ allowlist?: Allowlist|null }} [options]
 * @returns {Promise<Policy & { corpusState: CorpusState, corpusFailures: ScanFailure[] }>}
 */
export async function buildPolicy(root = DEFAULT_ROOT, options = {}) {
  const tsMorph = await loadTsMorph(root);
  const allowlist = options.allowlist === undefined ? loadAllowlist(root) : options.allowlist;

  const demo = harvestTree(tsMorph, root, DEMO_TREE);
  const prisma = harvestPrismaSchema(root, DEMO_TREE);
  const handlerRoutes = harvestRouteHandlerPaths(root, DEMO_TREE);
  const fixture = harvestTree(tsMorph, root, FIXTURE_TREE);
  const fixtureHandlerRoutes = harvestRouteHandlerPaths(root, FIXTURE_TREE);
  const fixtureRoutes = new Set([...fixture.routePaths, ...fixtureHandlerRoutes.routePaths]);

  const allowedIdentifiers = new Set(allowlist?.identifiers ?? []);
  const allowedRoutes = new Set(allowlist?.routePaths ?? []);

  const identifiers = sortedUnique(
    [...demo.identifiers, ...prisma.identifiers].filter(
      (name) =>
        isDemoSpecificIdentifier(name) &&
        !fixture.identifiers.has(name) &&
        !allowedIdentifiers.has(name),
    ),
  );
  const routePaths = sortedUnique(
    [...demo.routePaths, ...handlerRoutes.routePaths].filter(
      (route) => !fixtureRoutes.has(route) && !allowedRoutes.has(route),
    ),
  );

  return {
    version: 1,
    generatedBy: `${SCRIPT_FILE} --update`,
    corpus: DEMO_TREE,
    exclusions: [FIXTURE_TREE, ALLOWLIST_FILE],
    identifiers,
    routePaths,
    corpusState: classifyCorpus(root, {
      demoFiles: demo.files,
      fixtureFiles: fixture.files,
      prismaPresent: prisma.present,
    }),
    corpusFailures: [
      ...demo.failures,
      ...prisma.failures,
      ...handlerRoutes.failures,
      ...fixture.failures,
      ...fixtureHandlerRoutes.failures,
    ],
  };
}

/**
 * Decide whether the committed policy can be compared against a fresh harvest at all, which is one
 * question: is the demo corpus in this checkout?
 *
 * Two states:
 *   `absent` `apps/demo-app` is not here -- a partial clone or an early build. No comparison is
 *            possible, the run says so, and the committed policy is still enforced against product
 *            source.
 *   `ready`  it is here. The corpus *defines* the policy (policy = demo harvest minus fixture
 *            harvest minus allowlist), so every difference from a fresh harvest is drift: it is
 *            reported as `policy-stale` and fails the gate, whether the policy lists names the
 *            corpus no longer declares or misses names it does.
 *
 * There is deliberately no third state and no coverage threshold. A partly written demo yields a
 * smaller policy, not an exemption from having one that matches: a committed policy nobody can
 * regenerate is a gate nobody can trust, and AAP 0.5.4 makes regeneration the only way the file is
 * produced. The structural observations below are reported either way, because they explain what
 * the harvest saw.
 *
 * @param {string} root
 * @param {{ demoFiles: number, fixtureFiles: number, prismaPresent: boolean }} harvest
 * @returns {CorpusState}
 */
function classifyCorpus(root, harvest) {
  if (!isDirectory(path.join(root, DEMO_TREE))) {
    return { state: 'absent', reason: `${DEMO_TREE} is not present in this checkout` };
  }
  /** @type {string[]} */
  const observations = [`${harvest.demoFiles} demo source files harvested`];
  if (harvest.demoFiles === 0) {
    observations.push(
      `${DEMO_TREE} is present but holds no source files, so a fresh harvest reproduces nothing the committed policy lists`,
    );
  }
  if (!harvest.prismaPresent) {
    observations.push(`no ${DEMO_TREE}/prisma/schema.prisma, so no database vocabulary`);
  }
  if (harvest.fixtureFiles === 0) {
    observations.push(`no ${FIXTURE_TREE} source files to subtract`);
  } else {
    observations.push(`${harvest.fixtureFiles} fixture source files subtracted`);
  }
  return { state: 'ready', reason: observations.join('; ') };
}

/**
 * @param {readonly string[]} left
 * @param {readonly string[]} right
 * @returns {string[]} Entries of `left` that `right` does not contain.
 */
function difference(left, right) {
  const other = new Set(right);
  return left.filter((entry) => !other.has(entry));
}

/**
 * @param {readonly string[]} entries
 * @returns {string[]} The entries that occur more than once, in first-occurrence order.
 */
function duplicateEntries(entries) {
  /** @type {Set<string>} */
  const seen = new Set();
  /** @type {Set<string>} */
  const repeated = new Set();
  for (const entry of entries) {
    if (seen.has(entry)) {
      repeated.add(entry);
    } else {
      seen.add(entry);
    }
  }
  return [...repeated];
}

/**
 * Compare the committed policy's form with the canonical form, which is what makes order-only and
 * formatting-only drift visible. Membership comparison cannot see any of it: two files listing the
 * same names in a different order are the same set and different artifacts, and only one of them is
 * the one `--update` writes.
 *
 * Each reason is specific enough to act on without a diff:
 *   * a repeated entry, named -- the generator de-duplicates, so a repeat is a hand edit;
 *   * the first pair that is out of canonical case-sensitive ASCII order, named in the order they
 *     appear. `localeCompare` and a case-insensitive sort both produce exactly this, which is how
 *     a plausible-looking hand edit or merge resolution ends up unreproducible;
 *   * bytes that are not what the generator writes, raised only when the names, their order and
 *     the metadata all match -- so this reason genuinely means the key order, the indentation, an
 *     extra key, an escape or the trailing newline, and never repeats what another reason said.
 *
 * @param {Policy} committed
 * @param {Policy} computed
 * @param {string|null} committedText The bytes on disk, or `null` when the policy was injected
 *   rather than read, in which case only the order and repetition of its arrays can be judged.
 * @param {boolean} explained Whether the listed names or the metadata already account for a byte
 *   difference, which keeps the residual reason from restating drift reported elsewhere.
 * @returns {SerializationReport}
 */
function compareSerialization(committed, computed, committedText, explained) {
  /** @type {string[]} */
  const reasons = [];
  /** @type {[string, readonly string[]][]} */
  const arrays = [
    ['identifiers', committed.identifiers],
    ['routePaths', committed.routePaths],
  ];
  for (const [field, entries] of arrays) {
    const repeated = duplicateEntries(entries);
    if (repeated.length > 0) {
      reasons.push(
        `\`${field}\` repeats ${pluralize(repeated.length, 'entry', 'entries')} (${preview(repeated)}); the generator de-duplicates`,
      );
    }
    // Compare the de-duplicated sequence against the canonical one, so a repeat is reported once as
    // a repeat rather than a second time as an ordering fault.
    const asWritten = [...new Set(entries)];
    const canonicalOrder = sortedUnique(entries);
    const outOfOrder = asWritten.findIndex((entry, position) => entry !== canonicalOrder[position]);
    if (outOfOrder !== -1) {
      reasons.push(
        `\`${field}\` is not in canonical case-sensitive ASCII order: ${JSON.stringify(asWritten[outOfOrder])} precedes ${JSON.stringify(canonicalOrder[outOfOrder])}`,
      );
    }
  }

  const byteEqual = committedText === null ? null : committedText === serializePolicy(computed);
  if (byteEqual === false && reasons.length === 0 && !explained) {
    reasons.push(
      `the committed bytes are not what \`${PNPM_UPDATE_COMMAND}\` writes, although the names, their order and the metadata all match: the difference is the key order, the indentation, an extra key or the trailing newline`,
    );
  }
  return { canonical: reasons.length === 0 && byteEqual !== false, byteEqual, reasons };
}

/**
 * Compare the committed policy with a fresh computation.
 *
 * `added` is what regeneration would add: names the corpus has and the policy lacks, which means
 * the gate is currently weaker than the demo it guards. `removed` is what regeneration would drop:
 * the gate is stricter than necessary, which is safe but out of date. Either way the policy is not
 * what `--update` produces, so either way it is stale and `enforced` is true -- the corpus being
 * present is the only condition, and a caller that got here with an `absent` corpus should not have
 * compared at all.
 *
 * The names are not the whole comparison. `serialization` reports how the committed *form* differs
 * from the canonical one -- entries out of order or repeated, and, when `committedText` is given,
 * bytes that are not what the generator writes -- and any of those drifts the policy on its own. A
 * committed artifact that no regeneration reproduces is stale whatever its vocabulary says, and
 * order-only drift is invisible to every membership comparison.
 *
 * @param {Policy} committed
 * @param {Policy} computed
 * @param {CorpusState} corpus
 * @param {{ committedText?: string|null }} [options] `committedText` is the committed file's exact
 *   bytes. Omit it only when the policy did not come from disk: the byte comparison is then skipped
 *   and the order and repetition of the object's arrays are still judged.
 * @returns {StaleReport}
 */
export function comparePolicies(committed, computed, corpus, options = {}) {
  /** @type {string[]} */
  const fields = [];
  if (committed.version !== computed.version) {
    fields.push('version');
  }
  // `generatedBy` is compared too, so that a residual byte difference really is about the file's
  // form: a hand-written provenance string would otherwise drift the bytes with nothing naming it.
  if (committed.generatedBy !== computed.generatedBy) {
    fields.push('generatedBy');
  }
  if (committed.corpus !== computed.corpus) {
    fields.push('corpus');
  }
  if (committed.exclusions.join('\u0000') !== computed.exclusions.join('\u0000')) {
    fields.push('exclusions');
  }
  const added = {
    identifiers: difference(computed.identifiers, committed.identifiers),
    routePaths: difference(computed.routePaths, committed.routePaths),
  };
  const removed = {
    identifiers: difference(committed.identifiers, computed.identifiers),
    routePaths: difference(committed.routePaths, computed.routePaths),
  };
  const namesDrifted =
    added.identifiers.length > 0 ||
    added.routePaths.length > 0 ||
    removed.identifiers.length > 0 ||
    removed.routePaths.length > 0;
  const serialization = compareSerialization(
    committed,
    computed,
    options.committedText ?? null,
    fields.length > 0 || namesDrifted,
  );
  const drifted = fields.length > 0 || namesDrifted || !serialization.canonical;
  return {
    enforced: corpus.state === 'ready',
    drifted,
    corpus,
    added,
    removed,
    fields,
    serialization,
  };
}

/**
 * Serialize a policy exactly as the committed file is written: a fixed key order, sorted and
 * de-duplicated arrays, two-space indentation and a trailing newline. No timestamp, git revision or
 * machine name appears anywhere, because a volatile field would make the committed policy
 * permanently stale.
 *
 * This is both the writer and the comparison basis: a normal run compares the committed bytes with
 * this function's output over a fresh harvest, so every rule encoded here -- the key order, the
 * case-sensitive ASCII sort, the de-duplication, the indentation, the single trailing newline -- is
 * enforced on the committed artifact rather than merely applied when it happens to be rewritten.
 *
 * @param {Policy} policy
 * @returns {string}
 */
export function serializePolicy(policy) {
  const ordered = {
    version: policy.version,
    generatedBy: policy.generatedBy,
    corpus: policy.corpus,
    exclusions: [...policy.exclusions],
    identifiers: sortedUnique(policy.identifiers),
    routePaths: sortedUnique(policy.routePaths),
  };
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

/**
 * Regenerate the policy and write it. This is the only code path in the script that writes, and
 * `scripts/no-hardcoding.policy.json` is the only file it touches.
 *
 * What it writes is exactly what the corpus yields -- nothing is carried over from the file being
 * replaced. Regeneration is refused in two cases, both of which would leave a policy nobody can
 * reproduce: when the demo corpus yields no vocabulary at all (writing an empty policy would disarm
 * the gate without anyone noticing, the one failure mode this file exists to prevent), and when any
 * corpus file could not be read (the harvest is then missing vocabulary it cannot know about, so
 * writing it would silently widen the gate).
 *
 * @param {string} [root] Absolute repository root.
 * @param {{ allowlist?: Allowlist|null, write?: boolean }} [options] `write: false` computes the
 *   update and reports the diff without touching the file.
 * @returns {Promise<{ policy: Policy, corpus: CorpusState, added: StaleReport['added'], removed: StaleReport['removed'], changed: boolean, written: boolean, notes: string[] }>}
 */
export async function updatePolicy(root = DEFAULT_ROOT, options = {}) {
  const allowlist = options.allowlist === undefined ? loadAllowlist(root) : options.allowlist;

  // The previous policy is needed for the diff summary only. A missing or malformed one is not an
  // error here: regenerating is exactly how a developer recovers from it. Its bytes come along so
  // the summary can say the file was rewritten for its form rather than its vocabulary.
  /** @type {Policy|null} */
  let committed;
  /** @type {string|null} */
  let committedText;
  try {
    const document = readPolicyDocument(root);
    committed = document.policy;
    committedText = document.text;
  } catch {
    committed = null;
    committedText = null;
  }

  const computed = await buildPolicy(root, { allowlist });
  const { corpusState, corpusFailures, ...policy } = computed;

  if (corpusFailures.length > 0) {
    throw new HardcodingCheckError(
      'corpus-unreadable',
      `refusing to regenerate ${POLICY_FILE}: the harvest could not read ${pluralize(corpusFailures.length, 'corpus path')} (${describeFailures(corpusFailures)}). A policy computed over part of the corpus would silently widen the gate.`,
    );
  }

  if (
    corpusState.state === 'absent' ||
    policy.identifiers.length + policy.routePaths.length === 0
  ) {
    throw new HardcodingCheckError(
      'corpus-empty',
      `refusing to regenerate ${POLICY_FILE}: the corpus yielded no demo vocabulary (${corpusState.reason}). Writing an empty policy would disarm the gate.`,
    );
  }

  /** @type {string[]} */
  const notes = [`corpus ${corpusState.state}: ${corpusState.reason}`];

  const previous = committed ?? {
    version: 1,
    generatedBy: policy.generatedBy,
    corpus: policy.corpus,
    exclusions: policy.exclusions,
    identifiers: [],
    routePaths: [],
  };
  const comparison = comparePolicies(previous, policy, corpusState, { committedText });
  if (comparison.removed.identifiers.length + comparison.removed.routePaths.length > 0) {
    notes.push(
      'entries are being removed, which widens the gate; confirm each one really left the demo application',
    );
  }
  for (const reason of comparison.serialization.reasons) {
    // Worth saying out loud: the reviewer of this diff would otherwise see entries move with no
    // vocabulary change and have to work out why the file was rewritten at all.
    notes.push(`the committed file was not the generator's canonical form -- ${reason}`);
  }

  const serialized = serializePolicy(policy);
  const absolute = path.join(root, POLICY_FILE);
  const unchanged = isFile(absolute) && readFileSync(absolute, 'utf8') === serialized;
  const write = options.write !== false && !unchanged;
  if (write) {
    writeFileSync(absolute, serialized, 'utf8');
  }
  return {
    policy,
    corpus: corpusState,
    added: comparison.added,
    removed: comparison.removed,
    changed: !unchanged,
    written: write,
    notes,
  };
}

/* -------------------------------------------------------------------------------------------------
 * composition
 * ---------------------------------------------------------------------------------------------- */

/**
 * @param {Finding} left
 * @param {Finding} right
 * @returns {number}
 */
function byLocation(left, right) {
  if (left.file !== right.file) {
    return left.file < right.file ? -1 : 1;
  }
  if (left.line !== right.line) {
    return left.line - right.line;
  }
  if (left.column !== right.column) {
    return left.column - right.column;
  }
  return left.rule < right.rule ? -1 : left.rule > right.rule ? 1 : 0;
}

/**
 * Order scan failures the way findings are ordered, and drop the duplicates the two passes produce
 * when they classify or walk the same product tree.
 *
 * @param {readonly ScanFailure[]} failures
 * @returns {ScanFailure[]}
 */
function normalizeFailures(failures) {
  /** @type {Map<string, ScanFailure>} */
  const unique = new Map();
  for (const failure of failures) {
    const key = `${failure.path}\u0000${failure.reason}`;
    if (!unique.has(key)) {
      unique.set(key, failure);
    }
  }
  return [...unique.values()].sort((left, right) =>
    left.path === right.path
      ? left.reason < right.reason
        ? -1
        : left.reason > right.reason
          ? 1
          : 0
      : left.path < right.path
        ? -1
        : 1,
  );
}

/**
 * @param {readonly ScanFailure[]} failures
 * @param {number} [limit]
 * @returns {string} `path (reason)` for each failure, for a one-line message.
 */
function describeFailures(failures, limit = 6) {
  const shown = failures
    .slice(0, limit)
    .map((failure) => `${failure.path} (${failure.reason})`)
    .join(', ');
  return failures.length > limit ? `${shown}, … (${failures.length} total)` : shown;
}

/**
 * Run the whole gate: the product-source, structured-text and repository-tooling scans, then the
 * policy staleness comparison.
 *
 * The result's exit code is {@link EXIT_ERROR} whenever anything went unexamined, even if no
 * violation was found and even if the policy is in step: an incomplete scan is not a verdict.
 *
 * @param {string} [root] Absolute repository root.
 * @param {{ policy?: Policy, allowlist?: Allowlist|null, stale?: boolean }} [options] `stale: false`
 *   skips the staleness comparison, which the unit tests use when they only exercise the scanners.
 *   `policy` injects a policy object instead of reading the committed file, in which case there are
 *   no committed bytes to compare and the staleness comparison judges the object's form alone.
 * @returns {Promise<CheckResult>}
 */
export async function check(root = DEFAULT_ROOT, options = {}) {
  const absoluteRoot = path.resolve(root);
  // The committed bytes are read once, here, and carried to the staleness comparison: an injected
  // policy has none, and its form is then judged from the object alone.
  const document = options.policy === undefined ? readPolicyDocument(absoluteRoot) : null;
  const policy = document === null ? /** @type {Policy} */ (options.policy) : document.policy;
  const committedText = document === null ? null : document.text;
  const allowlist =
    options.allowlist === undefined ? loadAllowlist(absoluteRoot) : options.allowlist;
  const matchers = compileMatchers(policy, allowlist);

  /** @type {string[]} */
  const notes = [];
  if (matchers.suppressed.length > 0) {
    notes.push(
      `warning: ${POLICY_FILE} lists ${matchers.suppressed.length} entr${matchers.suppressed.length === 1 ? 'y' : 'ies'} that ${ALLOWLIST_FILE} also lists (${matchers.suppressed.join(', ')}); they were not enforced, and the committed policy is not a faithful regeneration`,
    );
  }

  const source = await scanProductSource(absoluteRoot, policy, { matchers });
  const structured = scanStructuredText(absoluteRoot, policy, { matchers });
  const tooling = scanTooling(absoluteRoot, policy, { matchers });
  /** @type {Finding[]} */
  const findings = [...source.findings, ...structured.findings, ...tooling.findings];
  notes.push(...source.notes, ...structured.notes, ...tooling.notes);

  /** @type {ScanFailure[]} */
  const failures = [...source.failures, ...structured.failures, ...tooling.failures];

  // An absent tree is benign, but a run in which no *product* file was scanned has no subject at
  // all: it would report "0 violations" over an empty set and satisfy the gate by inspecting
  // nothing. Tooling files do not count towards the subject -- every root carries the policy
  // artifacts beside the gate, so counting them would let a root with no product in it pass.
  if (source.filesScanned + structured.filesScanned === 0) {
    failures.push({
      path: '.',
      reason: 'no-subject',
      detail: `no product source or structured text was found to scan under ${PRODUCT_TREES.join(', ')}; a clean result over nothing is not evidence, so check the repository root passed to this gate`,
    });
  }

  /** @type {StaleReport|null} */
  let stale = null;
  if (options.stale !== false) {
    const computed = await buildPolicy(absoluteRoot, { allowlist });
    const { corpusState, corpusFailures, ...computedPolicy } = computed;
    failures.push(...corpusFailures);
    if (corpusState.state === 'absent') {
      notes.push(
        `policy staleness not compared: ${corpusState.reason}; the policy is still enforced against product source`,
      );
    } else if (corpusFailures.length > 0) {
      // A harvest that read only part of the corpus cannot say whether the policy matches it, and
      // guessing either way is worse than reporting the hole.
      notes.push(
        `policy staleness not compared: the harvest could not read ${pluralize(corpusFailures.length, 'corpus path')} (${describeFailures(corpusFailures)}); the policy is still enforced against product source`,
      );
    } else {
      stale = comparePolicies(policy, computedPolicy, corpusState, { committedText });
      if (stale.drifted) {
        const form = stale.serialization.reasons;
        findings.push({
          rule: 'policy-stale',
          file: POLICY_FILE,
          line: 1,
          column: 1,
          message:
            form.length > 0
              ? `the committed policy is not what \`${PNPM_UPDATE_COMMAND}\` would produce from ${DEMO_TREE}: ${form.join('; ')}`
              : `the committed policy is not what \`${PNPM_UPDATE_COMMAND}\` would produce from ${DEMO_TREE}`,
          hint: RULE_HINTS['policy-stale'],
        });
      }
    }
  }

  findings.sort(byLocation);
  const normalizedFailures = normalizeFailures(failures);
  const ok = findings.length === 0 && normalizedFailures.length === 0;
  return {
    ok,
    exitCode:
      normalizedFailures.length > 0 ? EXIT_ERROR : findings.length > 0 ? EXIT_FINDINGS : EXIT_OK,
    root: absoluteRoot,
    findings,
    stale,
    filesScanned: source.filesScanned + structured.filesScanned + tooling.filesScanned,
    sourceFilesScanned: source.filesScanned,
    structuredFilesScanned: structured.filesScanned,
    toolingFilesScanned: tooling.filesScanned,
    failures: normalizedFailures,
    notes,
  };
}

/* -------------------------------------------------------------------------------------------------
 * reporting
 * ---------------------------------------------------------------------------------------------- */

/**
 * @param {number} count
 * @param {string} singular
 * @param {string} [plural]
 * @returns {string}
 */
function pluralize(count, singular, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

/**
 * @param {readonly string[]} entries
 * @param {number} [limit]
 * @returns {string}
 */
function preview(entries, limit = 12) {
  if (entries.length === 0) {
    return 'none';
  }
  const shown = entries.slice(0, limit).join(', ');
  return entries.length > limit ? `${shown}, … (${entries.length} total)` : shown;
}

/**
 * Human-readable report. Scan failures come first, because they say the verdict below them is
 * incomplete; then the findings, one `path:line:col: rule: message` line each with an indented
 * remediation hint; then the drift summary, the informational notes and the tally.
 *
 * @param {CheckResult} result
 * @returns {string}
 */
export function renderReport(result) {
  /** @type {string[]} */
  const lines = [];
  if (result.failures.length > 0) {
    lines.push(
      `${LOG_PREFIX}: the scan could not examine ${pluralize(result.failures.length, 'path')}, so this run proves nothing:`,
    );
    for (const failure of result.failures) {
      lines.push(`    ${failure.path}: ${failure.reason}: ${failure.detail}`);
    }
    lines.push('');
  }
  for (const finding of result.findings) {
    lines.push(
      `${finding.file}:${finding.line}:${finding.column}: ${finding.rule}: ${finding.message}`,
    );
    if (finding.snippet !== undefined && finding.snippet.length > 0) {
      lines.push(`    ${finding.snippet}`);
    }
    if (finding.hint.length > 0) {
      lines.push(`    -> ${finding.hint}`);
    }
  }

  const stale = result.stale;
  if (stale !== null && stale.drifted) {
    lines.push('');
    lines.push(`${LOG_PREFIX}: policy drift against ${DEMO_TREE} (enforced):`);
    if (stale.fields.length > 0) {
      lines.push(`    metadata fields differ: ${stale.fields.join(', ')}`);
    }
    for (const reason of stale.serialization.reasons) {
      lines.push(`    form: ${reason}`);
    }
    lines.push(`    identifiers to add:    ${preview(stale.added.identifiers)}`);
    lines.push(`    identifiers to remove: ${preview(stale.removed.identifiers)}`);
    lines.push(`    routes to add:         ${preview(stale.added.routePaths)}`);
    lines.push(`    routes to remove:      ${preview(stale.removed.routePaths)}`);
    lines.push(`    run \`${PNPM_UPDATE_COMMAND}\` and commit ${POLICY_FILE} for review`);
  }

  if (lines.length > 0) {
    lines.push('');
  }
  for (const note of result.notes) {
    lines.push(`${LOG_PREFIX}: ${note}`);
  }
  if (result.stale !== null) {
    lines.push(`${LOG_PREFIX}: corpus ${result.stale.corpus.state}: ${result.stale.corpus.reason}`);
  }
  lines.push(
    `${LOG_PREFIX}: ${pluralize(result.filesScanned, 'file')} scanned (${result.sourceFilesScanned} source, ${result.structuredFilesScanned} structured, ${result.toolingFilesScanned} tooling), ${pluralize(result.findings.length, 'violation')}, ${pluralize(result.failures.length, 'unexaminable path')}`,
  );
  return `${lines.join('\n')}\n`;
}

/**
 * @param {Awaited<ReturnType<typeof updatePolicy>>} update
 * @returns {string}
 */
function renderUpdate(update) {
  /** @type {string[]} */
  const lines = [];
  for (const note of update.notes) {
    lines.push(`${LOG_PREFIX}: ${note}`);
  }
  lines.push(
    `${LOG_PREFIX}: added ${pluralize(update.added.identifiers.length, 'identifier')} and ${pluralize(update.added.routePaths.length, 'route path')}; removed ${pluralize(update.removed.identifiers.length, 'identifier')} and ${pluralize(update.removed.routePaths.length, 'route path')}`,
  );
  if (update.added.identifiers.length > 0) {
    lines.push(`${LOG_PREFIX}:   + identifiers: ${preview(update.added.identifiers)}`);
  }
  if (update.added.routePaths.length > 0) {
    lines.push(`${LOG_PREFIX}:   + routes: ${preview(update.added.routePaths)}`);
  }
  if (update.removed.identifiers.length > 0) {
    lines.push(`${LOG_PREFIX}:   - identifiers: ${preview(update.removed.identifiers)}`);
  }
  if (update.removed.routePaths.length > 0) {
    lines.push(`${LOG_PREFIX}:   - routes: ${preview(update.removed.routePaths)}`);
  }
  lines.push(
    update.written
      ? `${LOG_PREFIX}: wrote ${POLICY_FILE} (${update.policy.identifiers.length} identifiers, ${update.policy.routePaths.length} route paths); review the diff before committing`
      : `${LOG_PREFIX}: ${POLICY_FILE} is already up to date; nothing written`,
  );
  return `${lines.join('\n')}\n`;
}

/**
 * @returns {string}
 */
function helpText() {
  return [
    `Usage: node ${SCRIPT_FILE} [--update] [--json] [--help]`,
    '',
    'Proves that the product contains no knowledge of the demo application and never decides what',
    "to show from the wording of the developer's question (AAP 0.5.4). This is the static half of",
    'the guarantee; the behavioural half is the deterministic-provider and generalization tests.',
    '',
    'Flags',
    '  --update   Regenerate the policy from the demo corpus and write',
    `             ${POLICY_FILE}. The only file this script ever writes.`,
    '  --json     Print the machine-readable report instead of the human-readable one.',
    '  --help     Print this text and exit 0.',
    '',
    'Exit codes',
    '  0  no violations, the committed policy matches the corpus, and the whole tree was examined',
    '  1  at least one violation, or the committed policy is stale',
    '  2  the check could not run or could not finish: ts-morph missing, malformed policy or',
    '     allowlist, bad usage, or a path the scan could not read, parse or decode as text',
    '',
    'Violation classes and rule ids',
    '  A. references into the demo application',
    `     demo-import             an import, re-export, import() or require() resolving under`,
    `                             ${DEMO_TREE}, or naming ${DEMO_PACKAGE}`,
    '     demo-path               a string literal or template chunk naming that tree',
    '  B. demo vocabulary, from the committed policy',
    '     policy-identifier       a demo identifier as an identifier node, or as a whole word in a',
    '                             string literal or template chunk',
    '     policy-route            a demo route path as a substring of a string literal or template',
    '                             chunk, so a prefix or a query suffix matches too',
    '     policy-identifier-text  the same identifier match in the raw text of a structured file',
    '     policy-route-text       the same route match in the raw text of a structured file',
    "  C. branching on the developer's question",
    '     question-branch         a string search method called on the question, a regular',
    '                             expression tested against it, an equality comparison with a',
    '                             string literal, or a switch over it with string cases',
    '  D. demo knowledge in repository tooling, from the same policy',
    '     tooling-identifier-text a demo identifier as a whole word anywhere in the raw text of a',
    '                             tooling file, comments included',
    '     tooling-route-text      a demo route path anywhere in the raw text of a tooling file,',
    '                             comments included',
    `     tooling-demo-file       a path under ${DEMO_TREE} in the raw text of a tooling file that`,
    '                             resolves to one of its files below the workspace root, or a glob',
    '                             whose last segment is a file name matching one; the tree, its',
    '                             directories, its root-level configuration and globs ending in a',
    '                             wildcard stay allowed, and a path naming nothing is not reported',
    '  and, independent of any file',
    '     policy-stale            the committed policy is not, byte for byte, what --update would',
    '                             produce: a different vocabulary, different metadata, entries out',
    '                             of canonical ASCII order or repeated, or a reformatted file. It is',
    `                             enforced whenever ${DEMO_TREE} is in the checkout and compared not`,
    '                             at all when it is absent',
    '',
    'The scan fails closed',
    '  A directory that cannot be listed, a file that cannot be read, parsed or decoded as text, a',
    '  file above the size this scan reads whole, a symbolic link that would otherwise have been',
    '  scanned, and a run that found no product file to scan at all stop the gate with exit code 2.',
    '  Nothing is skipped: a tree that went unexamined is reported as such rather than counted as',
    '  clean. An absent tree is the one benign case and is reported as an informational line.',
    '',
    'Scanned as source (AST)',
    ...PRODUCT_TREES.map((tree) => `  ${tree}`),
    `  extensions: ${SOURCE_EXTENSIONS.join(' ')}`,
    '',
    'Scanned as structured text (raw content, so keys and prose count)',
    ...STRUCTURED_TREES.map((tree) => `  ${tree} (every file)`),
    `  ${STRUCTURED_EXTENSIONS.join(', ')} anywhere under the source trees above`,
    '',
    'Scanned as repository tooling (raw content, so comments count)',
    `  ${TOOLING_EXTENSIONS.join(' ')} files at the repository root (not recursively),`,
    '  and files named',
    `    ${TOOLING_FILE_NAMES.slice(0, 5).join(' ')}`,
    `    ${TOOLING_FILE_NAMES.slice(5).join(' ')}`,
    ...TOOLING_TREES.map((tree) => `  ${tree}/ (the same extensions and names, recursively)`),
    '  A tooling exception is expressed by workspace or rule, never by demo file or symbol: where',
    "  the demo's defects live is documented only in docs/DEMO.md. Demo paths are resolved with",
    '  lstat and never through a symbolic link; only a path spelled out literally is seen.',
    '',
    'Never scanned',
    `  ${DEMO_TREE} (the corpus), tests/** and docs/** (they legitimately name demo symbols),`,
    `  ${POLICY_FILE} (it lists every forbidden token by construction),`,
    '  pnpm-lock.yaml (generated), test suites anywhere, and build output.',
    '',
    'Exemption',
    `  ${QUESTION_EXEMPT_FILE} may use the class C constructs in its`,
    '  generic tokenizer. Class B still applies there, and the exemption extends nowhere else.',
    '',
    'Regenerating the policy',
    `  The policy is (${DEMO_TREE} harvest) minus (${FIXTURE_TREE} harvest)`,
    `  minus (${ALLOWLIST_FILE}). Product source is never consulted, so an`,
    '  identifier that has leaked into the product cannot bless itself. An entry that turns out to',
    '  be generic vocabulary belongs in the allowlist; add it there, re-run --update and commit',
    '  both files for review.',
  ].join('\n');
}

/**
 * @typedef {object} CliOptions
 * @property {boolean} help
 * @property {boolean} update
 * @property {boolean} json
 */

/**
 * @param {readonly string[]} argv Arguments after the script path.
 * @returns {CliOptions}
 */
function parseArgs(argv) {
  /** @type {CliOptions} */
  const options = { help: false, update: false, json: false };
  for (const arg of argv) {
    switch (arg) {
      case '--help':
      case '-h':
        options.help = true;
        break;
      case '--update':
        options.update = true;
        break;
      case '--json':
        options.json = true;
        break;
      default:
        throw usageError(
          arg.startsWith('-') ? `unknown option: ${arg}` : `unexpected argument: ${arg}`,
        );
    }
  }
  return options;
}

/**
 * Run the gate and return the process exit code. Nothing here calls `process.exit`, so in-process
 * callers -- `scripts/check-no-hardcoding.test.mjs` among them -- can assert on the code directly.
 *
 * @param {readonly string[]} [argv] Arguments after the script path, as in `process.argv.slice(2)`.
 * @param {string} [root] Absolute repository root; defaults to this script's repository.
 * @returns {Promise<number>} 0 clean, 1 violations or stale policy, 2 usage or environment error.
 */
export async function main(argv = [], root = DEFAULT_ROOT) {
  /** @type {CliOptions} */
  let options;
  try {
    options = parseArgs(Array.isArray(argv) ? argv : []);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${LOG_PREFIX}: ${message}\n\n${helpText()}\n`);
    return EXIT_ERROR;
  }

  if (options.help) {
    process.stdout.write(`${helpText()}\n`);
    return EXIT_OK;
  }

  try {
    if (options.update) {
      const update = await updatePolicy(root);
      process.stdout.write(
        options.json
          ? `${JSON.stringify({ ok: true, exitCode: EXIT_OK, ...update }, null, 2)}\n`
          : renderUpdate(update),
      );
      return EXIT_OK;
    }
    const result = await check(root);
    process.stdout.write(
      options.json ? `${JSON.stringify(result, null, 2)}\n` : renderReport(result),
    );
    return result.exitCode;
  } catch (error) {
    const code = error instanceof HardcodingCheckError ? error.code : 'internal-error';
    const message = error instanceof Error ? error.message : String(error);
    if (options.json) {
      process.stdout.write(
        `${JSON.stringify({ ok: false, exitCode: EXIT_ERROR, error: { code, message } }, null, 2)}\n`,
      );
    }
    const help = code === 'usage' && !options.json ? `\n${helpText()}\n` : '';
    process.stderr.write(`${LOG_PREFIX}: ${code}: ${message}\n${help}`);
    return EXIT_ERROR;
  }
}

/**
 * `file` with every symbolic link resolved, or merely made absolute when it cannot be resolved.
 *
 * @param {string} file
 * @returns {string}
 */
function canonicalPath(file) {
  try {
    return realpathSync(file);
  } catch {
    return path.resolve(file);
  }
}

/**
 * Whether this module is the process entry point, so importing it (the suite, other tooling) never
 * runs the command line.
 *
 * Both sides are canonicalized. Node reports `import.meta.url` as a real path but leaves
 * `process.argv[1]` as typed, so comparing the two as they come makes a run through any symbolic
 * link -- a symlinked checkout, a linked workspace, macOS's `/tmp` -- skip `main` entirely and exit
 * 0 without printing a word: a gate that passes without looking, which is the one outcome it
 * exists to rule out. `scripts/check-no-residual-instrumentation.mjs` guards its entry point the
 * same way.
 *
 * @returns {boolean}
 */
function isEntryPoint() {
  const entry = process.argv[1];
  if (entry === undefined || entry === '') {
    return false;
  }
  return canonicalPath(fileURLToPath(import.meta.url)) === canonicalPath(entry);
}

if (isEntryPoint()) {
  process.exitCode = await main(process.argv.slice(2));
}
