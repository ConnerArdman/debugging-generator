/**
 * check-secrets.test.mjs
 *
 * The proof that `scripts/check-secrets.mjs` - the gate behind `pnpm check:secrets`, which
 * `pnpm verify` runs (AAP 0.8.5) - both catches what it claims to catch and lets through the files
 * this repository is required to commit.
 *
 * WHAT THIS SUITE OWNS. AAP 0.3.4 states the contract in one sentence: the script's own tests
 * "cover a positive case for each pattern and negative cases for the allowlisted placeholders, so
 * the required example files pass the required gate". Coverage is therefore defined by rule id
 * rather than by count, and the suite is laid out that way - one `describe` per rule id
 * (`env-file`, `provider-key`, `jwt`, `private-key`, `entropy`, `connection-string`), so a rule
 * that loses its coverage is visible in the test report rather than inferable from it. Three more
 * blocks carry the other half of the contract: the reviewed allowlist is the only exemption
 * channel and is narrow in both directions; the two `.env.example` files scan clean; and the
 * false positives that would make a gate inside `pnpm verify` unusable do not occur.
 *
 * WHY EVERY FIXTURE IS ASSEMBLED AT RUNTIME. This file is tracked content, and the gate scans
 * tracked content - including this file, whose path no allowlist entry names, and rightly so. A
 * credential prefix, token body, PEM delimiter or credentialed URI written here as a contiguous
 * literal would fail `pnpm check:secrets` and block every delivery, even though it is a test
 * fixture. So nothing below is a literal of that shape: alphabets are built from character ranges
 * by {@link charRange}, bodies are cycled from those alphabets by {@link cycle}, and prefixes are
 * joined from fragments by {@link assemble}. The same discipline keeps those shapes out of the
 * test *names*. The module under test is written this way, and for the same reason; the two files
 * are mutually constraining, and that is a correctness requirement rather than a matter of style.
 *
 * WHAT IT ASSERTS ABOUT REPORTING, NOT JUST DETECTION. A CI log is public, so every positive case
 * also asserts that the finding names the file, the 1-based line (fixtures put the offending text
 * on line 3 deliberately, so an off-by-one is caught) and the 1-based column, that it carries an
 * actionable hint, and that the matched value never reaches the message - at most its first four
 * characters and its length, which is what {@link expectValueNeverPrinted} pins down.
 *
 * HARNESS. The root `vitest.config.ts` collects this file into the `tooling` project
 * (`scripts/*.test.mjs`, environment `node`, `globals: false`), which `pnpm test` runs as part of
 * the blocking gate of AAP 0.8.5 and 0.7.1 Group 0. `describe`/`it`/`expect` are imported
 * explicitly because that project sets no globals. Every block but the last drives the exported
 * pure functions in process - `scanContent`, `scanPath`, `isEnvFileViolation`, `isKeyLikeName`,
 * `shannonEntropy`, `normalizeAllowlist` - which need neither git nor a checkout, and that is what
 * makes them fast, hermetic and order-independent. Only the last block spawns anything: it drives
 * `main` over a throwaway repository under `os.tmpdir()` - never inside this checkout, whose
 * `git status` must stay clean - and skips itself when `git` is unavailable rather than failing.
 */

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it, vi } from 'vitest';

import {
  ALLOWED_ENV_FILES,
  ALLOWLIST_FILENAME,
  CheckSecretsError,
  DEFAULT_ALLOWLIST_PATH,
  ENTROPY_MIN_BITS_PER_CHAR,
  ENTROPY_MIN_LENGTH,
  EXIT_ERROR,
  EXIT_FINDINGS,
  EXIT_OK,
  RULE_IDS,
  isEnvFileViolation,
  isKeyLikeName,
  loadAllowlist,
  main,
  normalizeAllowlist,
  normalizeRepoPath,
  scanContent,
  scanContentWithSuppressions,
  scanPath,
  scanRepository,
  shannonEntropy,
} from './check-secrets.mjs';

/* ---------------------------------------------------------------------------
 * Fixture assembly
 *
 * Three helpers replace every long string literal this suite would otherwise contain. Between
 * them, the longest literal in the file is a short prose sentence, which is what lets the gate
 * scan this file without an allowlist entry (see the module documentation above).
 * ------------------------------------------------------------------------ */

/**
 * The inclusive character range from `first` to `last`, by code unit.
 *
 * Used instead of writing an alphabet out: a 64-character alphabet literal is both long and
 * high-entropy, which is precisely the shape the `entropy` rule looks for.
 *
 * @param {string} first
 * @param {string} last
 * @returns {string}
 */
function charRange(first, last) {
  let result = '';
  for (let code = first.charCodeAt(0); code <= last.charCodeAt(0); code += 1) {
    result += String.fromCharCode(code);
  }
  return result;
}

/**
 * A deterministic body of `length` characters cycled from `alphabet`.
 *
 * Deterministic rather than random so a failure is reproducible, and cycled over the whole
 * alphabet so the result is as dense as real key material: cycling `n` distinct symbols for
 * `length <= n` characters yields exactly `log2(length)` bits per character.
 *
 * @param {string} alphabet
 * @param {number} length
 * @returns {string}
 */
function cycle(alphabet, length) {
  let result = '';
  for (let index = 0; index < length; index += 1) {
    result += alphabet.charAt(index % alphabet.length);
  }
  return result;
}

/**
 * Joins fixture fragments.
 *
 * Every call site exists to keep a credential prefix, PEM label or URI authority from appearing as
 * one contiguous literal in this tracked file. The split points carry no meaning beyond that,
 * which is worth knowing before "simplifying" a call away.
 *
 * @param {...string} fragments
 * @returns {string}
 */
function assemble(...fragments) {
  return fragments.join('');
}

const DIGITS = charRange('0', '9');
const LOWER_LETTERS = charRange('a', 'z');
const UPPER_LETTERS = charRange('A', 'Z');

/** Lower-case hexadecimal: 16 symbols, so at most 4 bits per character however long the run. */
const HEX_CHARS = DIGITS + charRange('a', 'f');

/** Base64url alphabet: 64 symbols, the shape of an opaque provider credential. */
const URLSAFE_CHARS = UPPER_LETTERS + LOWER_LETTERS + DIGITS + '-_';

/** Body characters of the underscore-delimited forge tokens. */
const WORD_CHARS = UPPER_LETTERS + LOWER_LETTERS + DIGITS + '_';

/** Body characters of an upper-case cloud access identifier. */
const UPPER_ID_CHARS = UPPER_LETTERS + DIGITS;

/** Standard base64 alphabet, as used by the lockfile's integrity digests. */
const BASE64_CHARS = UPPER_LETTERS + LOWER_LETTERS + DIGITS + '+/';

/**
 * The reviewed allowlist as the gate itself loads it. Loading the committed file rather than
 * hand-building one is deliberate: it makes every negative case below a statement about the
 * artifact this repository actually ships.
 */
const ALLOWLIST = loadAllowlist();

/** Absolute path of this file's directory, which in a checkout is `<root>/scripts`. */
const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));

/** Absolute path of the repository root, derived from this file's location. */
const REPOSITORY_ROOT = path.dirname(SCRIPT_DIRECTORY);

/**
 * The development database URL the product must commit (AAP 0.3.4), assembled so this file does
 * not contain it as a literal - its allowlist entry does not name this path.
 */
const DEV_DATABASE_URL = assemble(
  'postgresql',
  '://',
  'debuggen',
  ':',
  'debuggen',
  '@localhost',
  ':5432/lumen_supply',
);

/** The Compose password placeholder that is the other half of the same throwaway container. */
const DEV_COMPOSE_PASSWORD = assemble('POSTGRES_PASSWORD', ': ', 'debuggen');

/** The two literals AAP 0.3.4 permits in tracked files, and the only two. */
const REQUIRED_PLACEHOLDERS = [DEV_DATABASE_URL, DEV_COMPOSE_PASSWORD];

/**
 * Prose lines that surround every single-line fixture. They must be, and are, free of anything any
 * rule matches: their only job is to put the offending text on line 3.
 */
const PROSE_BEFORE = ['# Fixture header, deliberately free of any matchable shape.', ''];
const PROSE_AFTER = ['', '# Fixture footer.'];

/** The 1-based line number {@link scanLine} places its argument on. */
const FIXTURE_LINE = PROSE_BEFORE.length + 1;

/**
 * Scan `line` as the third line of a five-line file.
 *
 * Placing it on line 3 rather than line 1 is what makes the line number in every positive case an
 * assertion instead of a coincidence.
 *
 * @param {string} relPath Repository-relative path the findings are reported against.
 * @param {string} line The line under test.
 * @param {unknown} [allowlist] Defaults to the committed allowlist.
 * @returns {ReturnType<typeof scanContent>}
 */
function scanLine(relPath, line, allowlist = ALLOWLIST) {
  return scanContent(relPath, [...PROSE_BEFORE, line, ...PROSE_AFTER].join('\n'), allowlist);
}

/**
 * Assert that `findings` is exactly one finding of the expected rule, sub-pattern, file and
 * position, and that it carries a hint a developer can act on.
 *
 * @param {ReturnType<typeof scanContent>} findings
 * @param {{ rule: string, pattern: string, file: string, column: number }} expected
 * @returns {ReturnType<typeof scanContent>[number]} The single finding, for further assertions.
 */
function expectSingleFinding(findings, expected) {
  expect(findings).toHaveLength(1);
  const finding = findings[0];
  expect(finding.rule).toBe(expected.rule);
  expect(finding.pattern).toBe(expected.pattern);
  expect(finding.file).toBe(expected.file);
  expect(finding.line).toBe(FIXTURE_LINE);
  expect(finding.column).toBe(expected.column);
  expect(finding.hint).not.toBe('');
  return finding;
}

/**
 * Assert that a finding discloses at most the first four characters of the matched value plus its
 * length - the disclosure budget the script documents, because CI logs are public.
 *
 * @param {{ message: string, preview: string }} finding
 * @param {string} value The value that was matched.
 */
function expectValueNeverPrinted(finding, value) {
  expect(finding.preview).toBe(`${value.slice(0, 4)}\u2026 (${value.length} characters)`);
  expect(finding.message).toContain(finding.preview);
  expect(finding.message).not.toContain(value);
  expect(finding.message).not.toContain(value.slice(4));
}

/**
 * The 1-based column at which `value` starts in `line`.
 *
 * @param {string} line
 * @param {string} value
 * @returns {number}
 */
function columnOf(line, value) {
  const index = line.indexOf(value);
  expect(index).toBeGreaterThanOrEqual(0);
  return index + 1;
}

/**
 * Assert that `run` fails with a {@link CheckSecretsError} carrying `code`.
 *
 * The code, not the message, is the contract: it is what separates "the check could not run"
 * (exit 2) from "the check found something" (exit 1), and a gate that confused the two would
 * either block delivery for an environment problem or pass a repository it never read.
 *
 * @param {() => unknown} run
 * @param {string} code
 */
function expectCheckSecretsError(run, code) {
  let thrown;
  try {
    run();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(CheckSecretsError);
  expect(/** @type {CheckSecretsError} */ (thrown).code).toBe(code);
}

/**
 * Directories this suite creates, all under the system temporary directory and all removed in
 * `afterAll`. Nothing is ever written inside this checkout: the repository's `git status` must
 * stay clean while the tests run.
 *
 * @type {string[]}
 */
const temporaryDirectories = [];

/**
 * A fresh, empty directory under the system temporary directory.
 *
 * @returns {string} Absolute path of the new directory.
 */
function createTemporaryDirectory() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'debuggen-secrets-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterAll(() => {
  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
  temporaryDirectories.length = 0;
});

/* ---------------------------------------------------------------------------
 * Credential fixtures, one shape per rule alternative
 * ------------------------------------------------------------------------ */

/** Prefix of a vendor-scoped model provider key. */
const VENDOR_KEY_PREFIX = assemble('s', 'k-', 'ant-');

/** Prefix of a short-form model provider key. */
const SHORT_KEY_PREFIX = assemble('s', 'k-');

/** Prefix of a classic forge personal access token. */
const FORGE_CLASSIC_PREFIX = assemble('gh', 'p_');

/** Prefix of a fine-grained forge personal access token. */
const FORGE_FINE_PREFIX = assemble('git', 'hub_', 'pat_');

/** Prefix of a cloud access key identifier. */
const ACCESS_KEY_PREFIX = assemble('AK', 'IA');

/**
 * One fixture per alternative of the `provider-key` rule. `pattern` is the sub-pattern label the
 * finding must report, which is how a reviewer learns *which* provider to go and revoke at.
 *
 * Every body is longer than the minimum its shape requires, except the cloud access key
 * identifier, whose rule is exactly sixteen characters wide.
 *
 * @type {readonly { label: string, value: string, pattern: string }[]}
 */
const PROVIDER_KEY_FIXTURES = [
  {
    label: 'a vendor-scoped model provider key',
    value: VENDOR_KEY_PREFIX + cycle(URLSAFE_CHARS, 40),
    pattern: VENDOR_KEY_PREFIX,
  },
  {
    label: 'a short-form model provider key',
    value: SHORT_KEY_PREFIX + cycle(URLSAFE_CHARS, 32),
    pattern: SHORT_KEY_PREFIX,
  },
  {
    label: 'a classic forge personal access token',
    value: FORGE_CLASSIC_PREFIX + cycle(WORD_CHARS, 36),
    pattern: FORGE_CLASSIC_PREFIX,
  },
  {
    label: 'a fine-grained forge personal access token',
    value: FORGE_FINE_PREFIX + cycle(WORD_CHARS, 40),
    pattern: FORGE_FINE_PREFIX,
  },
  {
    label: 'a cloud access key identifier',
    value: ACCESS_KEY_PREFIX + cycle(UPPER_ID_CHARS, 16),
    pattern: ACCESS_KEY_PREFIX,
  },
];

/** A JOSE compact serialization: header, payload and signature, each base64url. */
const JWT_VALUE = [
  assemble('ey', 'J') + cycle(URLSAFE_CHARS, 16),
  cycle(WORD_CHARS, 24),
  cycle(URLSAFE_CHARS, 30),
].join('.');

/** The two words every PEM private-key label shares, kept apart so neither file contains them. */
const PEM_KEY_WORDS = assemble('PRIVATE', ' KEY');

/** The five-dash delimiter that opens a PEM block. */
const PEM_DELIMITER = '-'.repeat(5);

/**
 * One fixture per PEM label this suite pins: two specific ones and the bare one, which together
 * show that the reported `pattern` is the label rather than a constant.
 *
 * `value` is the header as it appears in a key file, closing delimiter and all; `matched` is the
 * part the rule matches, which is the opening delimiter plus the label. The two differ on purpose,
 * so the position and preview assertions are made against what the rule actually reports.
 *
 * @type {readonly { label: string, value: string, matched: string, pattern: string }[]}
 */
const PRIVATE_KEY_FIXTURES = [
  {
    label: 'an RSA key file header',
    value: assemble(PEM_DELIMITER, 'BEGIN ', 'RSA ', PEM_KEY_WORDS, PEM_DELIMITER),
    matched: assemble(PEM_DELIMITER, 'BEGIN ', 'RSA ', PEM_KEY_WORDS),
    pattern: assemble('RSA ', PEM_KEY_WORDS),
  },
  {
    label: 'an OpenSSH key file header',
    value: assemble(PEM_DELIMITER, 'BEGIN ', 'OPENSSH ', PEM_KEY_WORDS, PEM_DELIMITER),
    matched: assemble(PEM_DELIMITER, 'BEGIN ', 'OPENSSH ', PEM_KEY_WORDS),
    pattern: assemble('OPENSSH ', PEM_KEY_WORDS),
  },
  {
    label: 'an unlabelled key file header',
    value: assemble(PEM_DELIMITER, 'BEGIN ', PEM_KEY_WORDS, PEM_DELIMITER),
    matched: assemble(PEM_DELIMITER, 'BEGIN ', PEM_KEY_WORDS),
    pattern: PEM_KEY_WORDS,
  },
];

/**
 * The value every `entropy` case measures: 40 characters cycled from a 64-symbol alphabet, so all
 * 40 are distinct and the density is log2(40) = 5.32 bits per character, comfortably above the
 * rule's threshold. The suite asserts both properties rather than assuming them.
 */
const DENSE_VALUE = cycle(URLSAFE_CHARS, 40);

/**
 * One fixture per name form AAP 0.3.4 names (`key`, `token`, `secret`, `password`), written in the
 * syntax each actually appears in: an environment file, YAML, JSON and a code assignment. The
 * reported `pattern` is the name the value was bound to.
 *
 * @type {readonly { label: string, line: string, pattern: string }[]}
 */
const ENTROPY_FIXTURES = [
  {
    label: 'an environment-file assignment',
    line: `API_KEY=${DENSE_VALUE}`,
    pattern: 'API_KEY',
  },
  {
    label: 'a YAML mapping entry',
    line: `  token: ${DENSE_VALUE}`,
    pattern: 'token',
  },
  {
    label: 'a quoted JSON property',
    line: `  "clientSecret": "${DENSE_VALUE}",`,
    pattern: 'clientSecret',
  },
  {
    label: 'a spaced code assignment',
    line: `password = "${DENSE_VALUE}"`,
    pattern: 'password',
  },
];

/**
 * The punctuation a generated password draws on beyond letters and digits. Written out because
 * these ten characters are the point: none of them belongs to the dense-run alphabet the rule's
 * second candidate source uses, so a value containing them is only measurable when the rule reads
 * the complete assigned value.
 */
const PUNCTUATION_CHARS = '!@#$%^&*()';

/**
 * The punctuated alphabet: 34 symbols, a third of them punctuation. The ordering keeps `(` and `)`
 * adjacent and inside the first pass of {@link cycle}, so the generated value's brackets balance -
 * the rule treats an unquoted run with unbalanced brackets as a fragment of a larger expression,
 * and this fixture is testing punctuation rather than that exclusion.
 */
const PUNCTUATED_CHARS = assemble(
  UPPER_LETTERS.slice(0, 8),
  DIGITS.slice(0, 8),
  PUNCTUATION_CHARS,
  LOWER_LETTERS.slice(0, 8),
);

/**
 * The punctuation-heavy value the complete-value cases measure: 36 characters at log2(34) = 5.06
 * bits per character, so it clears both halves of the threshold, while its longest run of
 * dense-alphabet characters is only 16 - shorter than {@link ENTROPY_MIN_LENGTH}, which is exactly
 * why a candidate pattern restricted to that alphabet could not see it at all.
 */
const PUNCTUATED_VALUE = cycle(PUNCTUATED_CHARS, 36);

/**
 * The runs of {@link PUNCTUATED_VALUE} that the dense-run alphabet (`[A-Za-z0-9+/_.~-]`) can see,
 * which the suite asserts are each too short to be measured on their own.
 *
 * @type {readonly string[]}
 */
const PUNCTUATED_DENSE_RUNS = PUNCTUATED_VALUE.split(/[^A-Za-z0-9+/_.~-]+/).filter(
  (run) => run !== '',
);

/**
 * The same four name forms as {@link ENTROPY_FIXTURES} - an environment file, YAML, JSON and a
 * code assignment - carrying the punctuated value instead of the dense one. The JSON and code
 * forms quote it, which is the case the rule can only get right by reading the quoted string in
 * full.
 *
 * @type {readonly { label: string, line: string, pattern: string }[]}
 */
const PUNCTUATED_ENTROPY_FIXTURES = [
  {
    label: 'an environment-file assignment',
    line: `password=${PUNCTUATED_VALUE}`,
    pattern: 'password',
  },
  {
    label: 'a YAML mapping entry',
    line: `  password: ${PUNCTUATED_VALUE}`,
    pattern: 'password',
  },
  {
    label: 'a quoted JSON property',
    line: `  "clientSecret": "${PUNCTUATED_VALUE}",`,
    pattern: 'clientSecret',
  },
  {
    label: 'a spaced code assignment',
    line: `password = "${PUNCTUATED_VALUE}"`,
    pattern: 'password',
  },
];

/**
 * Lines whose value is code rather than committed key material. Each `value` is what the rule
 * extracts from `line`, and each is long enough and dense enough to clear both halves of the
 * threshold - which is what makes these cases a test of the exclusion rather than of the
 * thresholds. Every one is modelled on a shape this repository's own tracked source contains, and
 * none of them is visible to the dense-run alphabet, so what keeps them quiet is the exclusion
 * under test.
 *
 * @type {readonly { label: string, line: string, value: string }[]}
 */
const EXPRESSION_VALUE_FIXTURES = (() => {
  const callExpression = assemble('normalizeSqlStatement', '(', 'fixture.sql', ')');
  const memberExpression = assemble(
    'credentials',
    '[',
    cycle(UPPER_LETTERS, 12),
    ']',
    '.',
    'secretValue',
  );
  const truncatedRun = assemble('readCredential', '(', cycle(URLSAFE_CHARS, 24));
  const optionalChain = assemble('credential', '.tokenType', '?.', 'toLowerCase', '()');
  const assertedChain = assemble('descriptors', '[', 'activeProfileName', ']', '!', '.secret');
  const nestedCall = assemble(
    'this',
    '.generateAccountKey',
    '(',
    'CredentialUtilities.getAccountInfo',
    '(',
    'account',
    ')',
    ')',
  );
  return [
    {
      label: 'a call expression that computes the value',
      line: `const key = ${callExpression};`,
      value: callExpression,
    },
    {
      label: 'a member expression that reads the value from a lookup',
      line: `const key = ${memberExpression};`,
      value: memberExpression,
    },
    {
      // The run stops at the comma, so what the rule sees is a fragment of the call rather than a
      // value: its opening bracket never closes.
      label: 'a run cut out of a larger expression, so its brackets do not balance',
      line: `const key = ${truncatedRun}, fallbackProfile);`,
      value: truncatedRun,
    },
    {
      // Optional chaining is how TypeScript reads a nullable credential, so this is the shape a
      // real codebase produces most often: 17 lines of the @azure/msal-common package installed
      // in this workspace are exactly this, each binding such a lookup to a key-like name.
      label: 'an optionally chained lookup, the shape a nullable credential read takes',
      line: `const key = ${optionalChain};`,
      value: optionalChain,
    },
    {
      label: 'an index lookup with a non-null assertion',
      line: `const key = ${assertedChain};`,
      value: assertedChain,
    },
    {
      // A call whose argument is itself a call. No regular expression matches nested parentheses,
      // so the groups are collapsed innermost-first before the expression test - and a codebase is
      // full of these, which is why the collapse matters more than it looks.
      label: 'a call nested inside another call',
      line: `const key = ${nestedCall};`,
      value: nestedCall,
    },
  ];
})();

/**
 * Values a credential really takes that a boundary-guessing extraction truncates instead of
 * measuring: one that begins with `/`, one carrying an escaped quote inside a quoted literal, one
 * with colon-separated segments, one with an internal `=`, and base64 padding. Each is built from
 * {@link PUNCTUATED_VALUE}'s alphabet, so each clears both halves of the threshold on its own, and
 * each `value` is exactly what the rule must report - the whole of it, not the longest fragment
 * between two delimiters.
 *
 * @type {readonly { label: string, file: string, line: string, value: string }[]}
 */
const COMPLETE_VALUE_FIXTURES = (() => {
  const body = cycle(PUNCTUATED_CHARS, 34);
  const slashLed = `/${body}`;
  const escaped = `${body.slice(0, 20)}\\"${body.slice(21)}`;
  const segmented = `v1:${body}:x9`;
  const internalEquals = `${body}=zT7`;
  const padded = `${cycle(BASE64_CHARS, 38)}==`;
  return [
    {
      label: 'a quoted value that begins with a slash',
      file: 'src/config.ts',
      line: `const password = "${slashLed}";`,
      value: slashLed,
    },
    {
      label: 'a quoted value carrying an escaped quote',
      file: 'src/config.ts',
      line: `const password = "${escaped}";`,
      value: escaped,
    },
    {
      label: 'an unquoted value with colon-separated segments',
      file: 'config/runtime.conf',
      line: `password=${segmented}`,
      value: segmented,
    },
    {
      label: 'an unquoted value with an internal equals sign',
      file: 'config/runtime.conf',
      line: `password=${internalEquals}`,
      value: internalEquals,
    },
    {
      label: 'an unquoted base64 value with its padding',
      file: 'config/runtime.conf',
      line: `password=${padded}`,
      value: padded,
    },
  ];
})();

/**
 * The private-key regular expression a published secret scanner assigns to `PRIVATE_KEY_PATTERN`,
 * cut where the rule's extraction cuts it: at the space before `KEY`. The fragment is 48
 * characters at 4.47 bits per character, its brackets balance, and it is not a closed literal, so
 * nothing but the leading `/` distinguishes it from a value - which is why the rule refuses a
 * value that begins with one. Assembled from fragments, as everything in this file is, so the
 * tracked line carries no contiguous key-file header.
 */
const PATTERN_VALUE_FRAGMENT = assemble(
  '/',
  '-{5}',
  'BEGIN',
  '\\s?(DSA|RSA|EC|PGP|OPENSSH)?',
  '\\s?',
  'PRIVATE',
);

/** A credentialed URI no allowlist entry covers: a different scheme, host and database entirely. */
const FOREIGN_CONNECTION_STRING = assemble(
  'mysql',
  '://',
  'reporting',
  ':',
  'hunter2',
  '@db.example.com',
  ':3306/app',
);

/** The password half of {@link FOREIGN_CONNECTION_STRING}, asserted never to be printed. */
const FOREIGN_CONNECTION_PASSWORD = 'hunter2';

/* ---------------------------------------------------------------------------
 * The rule vocabulary and the reviewed allowlist
 * ------------------------------------------------------------------------ */

describe('the enforced contract', () => {
  it('enforces exactly the six rules AAP 0.3.4 specifies, in reporting order', () => {
    expect([...RULE_IDS]).toEqual([
      'env-file',
      'provider-key',
      'jwt',
      'private-key',
      'entropy',
      'connection-string',
    ]);
  });

  it('treats the two required example files as the only committable environment files', () => {
    expect([...ALLOWED_ENV_FILES]).toEqual(['.env.example', 'apps/demo-app/.env.example']);
  });

  it('applies the entropy thresholds the specification states', () => {
    expect(ENTROPY_MIN_LENGTH).toBe(32);
    expect(ENTROPY_MIN_BITS_PER_CHAR).toBe(4);
  });

  it('measures entropy as bits per character over the value alone', () => {
    // Bounds that make the threshold meaningful: nothing for an empty or uniform value, at most
    // log2(alphabet) for a cycled one, and never more than 4 bits/char for hexadecimal - which is
    // why a git object name can never reach the threshold.
    expect(shannonEntropy('')).toBe(0);
    expect(shannonEntropy('a'.repeat(64))).toBe(0);
    expect(shannonEntropy(cycle(HEX_CHARS, 40))).toBeLessThan(ENTROPY_MIN_BITS_PER_CHAR);
    expect(shannonEntropy(DENSE_VALUE)).toBeCloseTo(Math.log2(DENSE_VALUE.length), 6);
  });
});

describe('the reviewed allowlist', () => {
  it('ships next to the script under the documented name', () => {
    expect(path.basename(DEFAULT_ALLOWLIST_PATH)).toBe(ALLOWLIST_FILENAME);
    expect(DEFAULT_ALLOWLIST_PATH).toBe(path.join(SCRIPT_DIRECTORY, ALLOWLIST_FILENAME));
    expect(existsSync(DEFAULT_ALLOWLIST_PATH)).toBe(true);
  });

  it('holds exactly the two development placeholders, and nothing more', () => {
    expect(ALLOWLIST.literals.map((literal) => literal.value).sort()).toEqual(
      [...REQUIRED_PLACEHOLDERS].sort(),
    );
  });

  it('gives every exemption a written justification and an exact, normalized path list', () => {
    for (const literal of ALLOWLIST.literals) {
      expect(literal.reason.trim().length).toBeGreaterThan(0);
      expect(literal.files.length).toBeGreaterThan(0);
      for (const file of literal.files) {
        expect(file).toBe(normalizeRepoPath(file));
      }
      // Each entry necessarily names this allowlist itself: the literal is committed there too.
      expect(literal.files).toContain(`scripts/${ALLOWLIST_FILENAME}`);
    }
  });

  it('covers the files that have to carry the database placeholder', () => {
    const entry = ALLOWLIST.literals.find((literal) => literal.value === DEV_DATABASE_URL);
    expect(entry).toBeDefined();
    for (const required of [...ALLOWED_ENV_FILES, 'docker-compose.yml']) {
      expect(entry?.files).toContain(required);
    }
  });

  it('rejects a malformed allowlist instead of silently exempting nothing', () => {
    // Silently degrading to "nothing is exempt" would fail the gate on the two example files the
    // product is required to commit, which is a worse outcome than refusing to run.
    const malformed = [
      {},
      { version: 2, literals: [] },
      { literals: [{ value: 'placeholder', files: ['docker-compose.yml'] }] },
      { literals: [{ value: '', reason: 'empty value', files: ['docker-compose.yml'] }] },
      { literals: [{ value: 'placeholder', reason: 'no paths', files: [] }] },
      { literals: [{ value: 'placeholder', reason: 'not a path', files: ['  '] }] },
      { literals: ['not an object'] },
      [],
      'not an object',
    ];
    for (const candidate of malformed) {
      expectCheckSecretsError(() => normalizeAllowlist(candidate), 'allowlist-invalid');
    }
  });

  it('treats a missing or unparseable allowlist file as an error', () => {
    const directory = createTemporaryDirectory();

    const absent = path.join(directory, ALLOWLIST_FILENAME);
    expectCheckSecretsError(() => loadAllowlist(absent), 'allowlist-missing');

    // A path that exists but cannot be read as a file is a different failure with its own code,
    // because the two need different fixes.
    expectCheckSecretsError(() => loadAllowlist(directory), 'allowlist-unreadable');

    const truncated = path.join(directory, 'truncated.json');
    writeFileSync(truncated, '{ "version": 1, "literals": [');
    expectCheckSecretsError(() => loadAllowlist(truncated), 'allowlist-invalid');

    const unversioned = path.join(directory, 'unversioned.json');
    writeFileSync(unversioned, JSON.stringify({ literals: [] }));
    expectCheckSecretsError(() => loadAllowlist(unversioned), 'allowlist-invalid');

    // And the shape it does accept, so the three rejections above are about the shape and not
    // about reading files from a temporary directory.
    const accepted = path.join(directory, 'accepted.json');
    writeFileSync(
      accepted,
      JSON.stringify({
        version: 1,
        literals: [
          { value: DEV_COMPOSE_PASSWORD, reason: 'reviewed', files: ['./docker-compose.yml'] },
        ],
      }),
    );
    const loaded = loadAllowlist(accepted);
    expect(loaded.literals).toHaveLength(1);
    expect(loaded.literals[0].files).toEqual(['docker-compose.yml']);
  });

  it('exempts nothing when a caller supplies no allowlist', () => {
    expect(normalizeAllowlist(undefined).literals).toHaveLength(0);
    expect(normalizeAllowlist(null).literals).toHaveLength(0);
  });

  it('compares paths after the normalization the allowlist itself is stored in', () => {
    expect(normalizeRepoPath('./apps/demo-app/.env.example')).toBe('apps/demo-app/.env.example');
    expect(normalizeRepoPath('/.env.example')).toBe('.env.example');
    expect(normalizeRepoPath('scripts\\check-secrets.mjs')).toBe('scripts/check-secrets.mjs');
    expect(normalizeRepoPath('')).toBe('');
  });
});

/* ---------------------------------------------------------------------------
 * One positive case per rule id (AAP 0.3.4)
 * ------------------------------------------------------------------------ */

/**
 * The line a content fixture is embedded in. The receiving name is deliberately not key-like, so
 * each case exercises the rule under test and nothing else.
 *
 * @param {string} value
 * @returns {string}
 */
function fixtureAssignment(value) {
  return `const fixture = '${value}';`;
}

describe('env-file', () => {
  it('reports a tracked environment file at any depth', () => {
    expect(isEnvFileViolation('.env')).toBe(true);
    expect(isEnvFileViolation('apps/demo-app/.env.local')).toBe(true);
    expect(isEnvFileViolation('services/.env.production')).toBe(true);
    // The leading `./` and `/` forms name the same file, and are violations just the same.
    expect(isEnvFileViolation('./.env')).toBe(true);
    expect(isEnvFileViolation('/apps/demo-app/.env.local')).toBe(true);
  });

  it('permits the two required example files and no third copy', () => {
    for (const allowed of ALLOWED_ENV_FILES) {
      expect(isEnvFileViolation(allowed)).toBe(false);
    }
    // An example file anywhere else is a copy nobody maintains, so it is still a finding.
    expect(isEnvFileViolation('packages/shared/.env.example')).toBe(true);
  });

  it('reports the finding from the path alone, before any content is read', () => {
    const findings = scanPath('apps/demo-app/.env.local');
    expect(findings).toHaveLength(1);
    const finding = findings[0];
    expect(finding.rule).toBe('env-file');
    expect(finding.pattern).toBe('.env.local');
    expect(finding.file).toBe('apps/demo-app/.env.local');
    expect(finding.line).toBe(1);
    expect(finding.column).toBe(1);
    // Nothing was matched inside the file, so there is nothing to preview.
    expect(finding.preview).toBe('');
    expect(finding.hint).not.toBe('');
    for (const allowed of ALLOWED_ENV_FILES) {
      expect(finding.message).toContain(allowed);
    }
  });

  it('reports it even when the file is empty, and alongside any content finding', () => {
    expect(scanContent('apps/demo-app/.env.local', '', ALLOWLIST)).toHaveLength(1);

    const line = fixtureAssignment(FORGE_CLASSIC_PREFIX + cycle(WORD_CHARS, 36));
    const findings = scanContent('.env.staging', [...PROSE_BEFORE, line].join('\n'), ALLOWLIST);
    expect(findings.map((finding) => finding.rule)).toEqual(['env-file', 'provider-key']);
  });

  it('does not mistake a similarly named file for an environment file', () => {
    for (const benign of ['.environment', 'docs/environment.md', 'env.example', 'src/env.ts']) {
      expect(isEnvFileViolation(benign)).toBe(false);
      expect(scanPath(benign)).toHaveLength(0);
    }
    expect(isEnvFileViolation('')).toBe(false);
  });
});

describe('provider-key', () => {
  it.each(PROVIDER_KEY_FIXTURES)('reports $label under its own prefix', ({ value, pattern }) => {
    const line = fixtureAssignment(value);
    const finding = expectSingleFinding(scanLine('apps/local-service/src/config.ts', line), {
      rule: 'provider-key',
      pattern,
      file: 'apps/local-service/src/config.ts',
      column: columnOf(line, value),
    });
    expect(finding.message).toContain(pattern);
    expectValueNeverPrinted(finding, value);
  });

  it('reports the most specific prefix once when two shapes overlap', () => {
    // The vendor-scoped prefix extends the short-form one, so both patterns match the same bytes.
    const [vendorScoped] = PROVIDER_KEY_FIXTURES;
    expect(vendorScoped.value.startsWith(SHORT_KEY_PREFIX)).toBe(true);

    const findings = scanLine('docs/notes.md', fixtureAssignment(vendorScoped.value));
    expect(findings).toHaveLength(1);
    expect(findings[0].pattern).toBe(VENDOR_KEY_PREFIX);
    expect(findings[0].pattern).not.toBe(SHORT_KEY_PREFIX);
  });

  it('requires the prefix to start a word, so hyphenated prose is not a finding', () => {
    // Both of these contain the short-form prefix mid-word followed by a long token body; a gate
    // that reported them would be noise inside `pnpm verify` rather than a source of trust.
    for (const benign of ['task-oriented_configuration_reference', 'disk-usage_report_threshold']) {
      expect(scanLine('docs/notes.md', `const note = '${benign}';`)).toHaveLength(0);
    }
  });

  it('requires a plausible credential body after the prefix', () => {
    // A bare prefix, or one followed by too short a body, identifies nothing.
    for (const short of [SHORT_KEY_PREFIX, SHORT_KEY_PREFIX + cycle(URLSAFE_CHARS, 8)]) {
      expect(scanLine('docs/notes.md', fixtureAssignment(short))).toHaveLength(0);
    }
  });
});

describe('jwt', () => {
  it('reports a three-segment token', () => {
    const line = fixtureAssignment(JWT_VALUE);
    const finding = expectSingleFinding(scanLine('packages/protocol/src/auth.ts', line), {
      rule: 'jwt',
      // The rule has a single shape, so there is no sub-pattern to report.
      pattern: '',
      file: 'packages/protocol/src/auth.ts',
      column: columnOf(line, JWT_VALUE),
    });
    expectValueNeverPrinted(finding, JWT_VALUE);
  });

  it('does not report a two-segment dotted identifier', () => {
    const [header, payload] = JWT_VALUE.split('.');
    expect(scanLine('docs/notes.md', fixtureAssignment(`${header}.${payload}`))).toHaveLength(0);
  });
});

describe('private-key', () => {
  it.each(PRIVATE_KEY_FIXTURES)('reports $label with its label', ({ value, matched, pattern }) => {
    const line = fixtureAssignment(value);
    const finding = expectSingleFinding(scanLine('packages/shared/src/keys.ts', line), {
      rule: 'private-key',
      pattern,
      file: 'packages/shared/src/keys.ts',
      column: columnOf(line, matched),
    });
    expect(finding.message).toContain(pattern);
    expectValueNeverPrinted(finding, matched);
  });

  it('does not report a public-key header', () => {
    const publicHeader = assemble(PEM_DELIMITER, 'BEGIN ', 'PUBLIC', ' KEY', PEM_DELIMITER);
    expect(scanLine('docs/notes.md', fixtureAssignment(publicHeader))).toHaveLength(0);
  });
});

describe('entropy', () => {
  it('measures a fixture that clears both halves of the threshold', () => {
    // Asserted rather than assumed, so this suite documents the threshold it relies on.
    expect(DENSE_VALUE.length).toBeGreaterThanOrEqual(ENTROPY_MIN_LENGTH);
    expect(shannonEntropy(DENSE_VALUE)).toBeGreaterThan(ENTROPY_MIN_BITS_PER_CHAR);
  });

  it.each(ENTROPY_FIXTURES)('reports a dense value bound by $label', ({ line, pattern }) => {
    expect(isKeyLikeName(pattern)).toBe(true);
    const finding = expectSingleFinding(scanLine('apps/local-service/src/config.ts', line), {
      rule: 'entropy',
      pattern,
      file: 'apps/local-service/src/config.ts',
      column: columnOf(line, DENSE_VALUE),
    });
    expect(finding.message).toContain(pattern);
    expect(finding.message).toContain(String(DENSE_VALUE.length));
    expectValueNeverPrinted(finding, DENSE_VALUE);
  });

  it('stays bound to the name: the same value under a neutral name is not a finding', () => {
    // A bare entropy scan produces so much noise that the gate stops being trusted, so the rule
    // fires only when the value is assigned to a credential-like name.
    expect(isKeyLikeName('buildId')).toBe(false);
    expect(scanLine('src/build-info.ts', `const buildId = '${DENSE_VALUE}';`)).toHaveLength(0);
    expect(scanLine('src/build-info.ts', `hash('${DENSE_VALUE}');`)).toHaveLength(0);
  });

  it('fires on assignments only, so an arrow or a comparison is not one', () => {
    // `=>` is an arrow and `===` is a comparison; reading either as an assignment would attribute
    // the value to whatever identifier happened to precede the operator. The trade-off is stated
    // in the module under test: a false positive inside `pnpm verify` costs as much as a miss.
    expect(scanLine('src/build-info.ts', `const key = () => '${DENSE_VALUE}';`)).toEqual([]);
    expect(scanLine('src/build-info.ts', `if (token === '${DENSE_VALUE}') {`)).toEqual([]);
  });

  it('measures a punctuated fixture that clears both halves of the threshold', () => {
    // Asserted rather than assumed, exactly as the dense fixture above is.
    expect(PUNCTUATED_VALUE.length).toBeGreaterThanOrEqual(ENTROPY_MIN_LENGTH);
    expect(shannonEntropy(PUNCTUATED_VALUE)).toBeGreaterThan(ENTROPY_MIN_BITS_PER_CHAR);
    // A third of the value is punctuation, which is what the case is about.
    expect([...PUNCTUATED_VALUE].some((character) => PUNCTUATION_CHARS.includes(character))).toBe(
      true,
    );
  });

  it.each(PUNCTUATED_ENTROPY_FIXTURES)(
    'reports a punctuated value bound by $label',
    ({ line, pattern }) => {
      expect(isKeyLikeName(pattern)).toBe(true);
      const finding = expectSingleFinding(scanLine('apps/local-service/src/config.ts', line), {
        rule: 'entropy',
        pattern,
        file: 'apps/local-service/src/config.ts',
        // The column is the first character of the value, not of the longest dense run inside it.
        column: columnOf(line, PUNCTUATED_VALUE),
      });
      expect(finding.message).toContain(pattern);
      expect(finding.message).toContain(String(PUNCTUATED_VALUE.length));
      expectValueNeverPrinted(finding, PUNCTUATED_VALUE);
    },
  );

  it('measures the complete value, not the longest dense run inside it', () => {
    // Every run of dense-alphabet characters in the punctuated value is shorter than the minimum
    // length, so a candidate pattern restricted to that alphabet cannot see this value at all.
    expect(PUNCTUATED_DENSE_RUNS.length).toBeGreaterThan(1);
    for (const run of PUNCTUATED_DENSE_RUNS) {
      expect(run.length).toBeLessThan(ENTROPY_MIN_LENGTH);
    }
    const line = `password=${PUNCTUATED_VALUE}`;
    const finding = expectSingleFinding(scanLine('apps/local-service/src/config.ts', line), {
      rule: 'entropy',
      pattern: 'password',
      file: 'apps/local-service/src/config.ts',
      column: columnOf(line, PUNCTUATED_VALUE),
    });
    // The reported extent is the whole value: its full length, and no dense sub-run's length.
    expect(finding.preview).toContain(`${PUNCTUATED_VALUE.length} characters`);
    for (const run of PUNCTUATED_DENSE_RUNS) {
      expect(finding.preview).not.toContain(`${run.length} characters`);
    }
  });

  it('does not flag an interpolated or command-substituted value', () => {
    // What such a value holds is computed when the file runs, so the committed text is a template
    // and not a literal. `scripts/check-no-hardcoding.mjs` builds a key this way.
    const interpolation = assemble('$', '{');
    const substitution = assemble('$', '(');
    for (const value of [
      `${interpolation}profile}${DENSE_VALUE}`,
      `${substitution}read-credential)${DENSE_VALUE}`,
    ]) {
      expect(scanLine('src/config.ts', `const apiKey = "${value}";`)).toEqual([]);
      expect(scanLine('.env.example', `API_KEY=${value}`)).toEqual([]);
    }
  });

  it('does not flag a quoted URI, whose credentials are connection-string\u2019s business', () => {
    // The unquoted form is pinned among the legitimate-content cases below; this is the quoted one,
    // which only the complete-value pass can see in full.
    const url = `https://assets.example.com/${DENSE_VALUE}`;
    expect(url.length).toBeGreaterThanOrEqual(ENTROPY_MIN_LENGTH);
    expect(scanLine('src/config.ts', `const apiKey = "${url}";`)).toEqual([]);
  });

  it.each(EXPRESSION_VALUE_FIXTURES)(
    'does not flag $label, which is code rather than a committed value',
    ({ line, value }) => {
      // Both thresholds are cleared, so the exclusion under test is what keeps the line quiet -
      // and the name is key-like, so the name binding is not doing the work either.
      expect(value.length).toBeGreaterThanOrEqual(ENTROPY_MIN_LENGTH);
      expect(shannonEntropy(value)).toBeGreaterThan(ENTROPY_MIN_BITS_PER_CHAR);
      expect(isKeyLikeName('key')).toBe(true);
      expect(scanLine('packages/telemetry/src/redaction/sql.test.ts', line)).toEqual([]);
    },
  );

  it('does not flag a pattern, closed or cut short, which is not key material', () => {
    // A closed literal and a fragment are both patterns, and both are refused for the one property
    // they share: a value that begins with `/`. The fragment is the case that needs it - the
    // extraction stops at the space before `KEY`, so its brackets balance and no anchored literal
    // test recognises what is left.
    expect(PATTERN_VALUE_FRAGMENT.length).toBeGreaterThanOrEqual(ENTROPY_MIN_LENGTH);
    expect(shannonEntropy(PATTERN_VALUE_FRAGMENT)).toBeGreaterThan(ENTROPY_MIN_BITS_PER_CHAR);
    expect(isKeyLikeName('PRIVATE_KEY_PATTERN')).toBe(true);
    expect(
      scanLine('src/rules.ts', `const PRIVATE_KEY_PATTERN = ${PATTERN_VALUE_FRAGMENT} KEY/gm;`),
    ).toEqual([]);

    const closedLiteral = assemble('/', '^[A-Za-z0-9_-]{24}', '\\.', '[A-Z]{4}$', '/gu');
    expect(closedLiteral.length).toBeGreaterThanOrEqual(ENTROPY_MIN_LENGTH);
    expect(shannonEntropy(closedLiteral)).toBeGreaterThan(ENTROPY_MIN_BITS_PER_CHAR);
    expect(scanLine('src/rules.ts', `const keyPattern = ${closedLiteral};`)).toEqual([]);
    // Quoted, it is still a pattern rather than a credential - and the quoted form is the one the
    // slash rule does not cover, so this is the case that keeps the literal test load-bearing.
    expect(scanLine('src/rules.ts', `const keyPattern = "${closedLiteral}";`)).toEqual([]);
  });

  it('does not flag a type annotation, whose value is a type and not a value', () => {
    // A `:` assigns in YAML and JSON and annotates in TypeScript, and the annotation of a
    // credential-carrying variable is exactly where a key-like name meets a long, mixed-case
    // identifier: `<` and `>` therefore end an unquoted value, which leaves `ReadonlyArray` and
    // not the whole 35-character annotation as the candidate.
    const annotation = assemble('ReadonlyArray', '<', 'CredentialDescriptor', '>');
    expect(annotation.length).toBeGreaterThanOrEqual(ENTROPY_MIN_LENGTH);
    expect(shannonEntropy(annotation)).toBeGreaterThan(ENTROPY_MIN_BITS_PER_CHAR);
    expect(isKeyLikeName('token')).toBe(true);
    expect(scanLine('src/config.ts', `const token: ${annotation} = descriptors;`)).toEqual([]);
    // Quoted, the angle brackets are part of the value again, so a password containing one is
    // still measured in full.
    const bracketed = assemble(PUNCTUATED_VALUE.slice(0, 20), '<', PUNCTUATED_VALUE.slice(21));
    expect(bracketed.length).toBeGreaterThanOrEqual(ENTROPY_MIN_LENGTH);
    const finding = expectSingleFinding(
      scanLine('src/config.ts', `const password = "${bracketed}";`),
      {
        rule: 'entropy',
        pattern: 'password',
        file: 'src/config.ts',
        column: columnOf(`const password = "${bracketed}";`, bracketed),
      },
    );
    expect(finding.preview).toContain(`${bracketed.length} characters`);
  });

  it.each(COMPLETE_VALUE_FIXTURES)(
    'measures $label, because the rule reads the whole value',
    ({ file, line, value }) => {
      expect(value.length).toBeGreaterThanOrEqual(ENTROPY_MIN_LENGTH);
      expect(shannonEntropy(value)).toBeGreaterThan(ENTROPY_MIN_BITS_PER_CHAR);
      const finding = expectSingleFinding(scanLine(file, line), {
        rule: 'entropy',
        pattern: 'password',
        file,
        column: columnOf(line, value),
      });
      // The reported extent is the value's own length, so nothing was cut at a quote, a colon, an
      // equals sign or a size limit.
      expect(finding.preview).toContain(`${value.length} characters`);
      expectValueNeverPrinted(finding, value);
    },
  );

  it('measures a value of any length, because the rule states a minimum and no maximum', () => {
    // AAP 0.3.4 bounds the rule from below at 32 characters and not from above, so a value of
    // kilobytes is measured rather than exempted. What keeps a long line affordable is the bounded
    // name lookup, which the case below pins.
    const long = cycle(PUNCTUATED_CHARS + URLSAFE_CHARS, 8193);
    expect(long.length).toBeGreaterThan(8192);
    const line = `const password = "${long}";`;
    const finding = expectSingleFinding(scanLine('src/config.ts', line), {
      rule: 'entropy',
      pattern: 'password',
      file: 'src/config.ts',
      column: columnOf(line, long),
    });
    expect(finding.preview).toContain(`${long.length} characters`);
  });

  it('reads the name through a bounded window, which is what keeps a long line linear', () => {
    // The name lookup only ever needs the tail of the line before the value, and reading the whole
    // prefix at every assignment site is what made a long line quadratic. The window is why a name
    // longer than it is reported truncated - deliberately, and pinned here so that restoring the
    // unbounded lookup fails a test rather than a build's patience.
    const longName = `${cycle(LOWER_LETTERS, 300)}_token`;
    const line = `const ${longName} = "${DENSE_VALUE}";`;
    const findings = scanLine('src/config.ts', line);
    expect(findings).toHaveLength(1);
    const [finding] = findings;
    expect(finding.rule).toBe('entropy');
    expect(finding.column).toBe(columnOf(line, DENSE_VALUE));
    // The name is the tail of the identifier, not the whole of it, and it is still key-like -
    // truncation cannot turn a credential-like name into a neutral one when the suffix is what
    // makes it credential-like.
    expect(finding.pattern.length).toBeLessThan(longName.length);
    expect(longName.endsWith(finding.pattern)).toBe(true);
    expect(isKeyLikeName(finding.pattern)).toBe(true);
  });

  it('does not flag prose, which is what a value with whitespace in it is', () => {
    // Only a quoted value can contain whitespace, and an English sentence measures about 4 bits
    // per character - right at the threshold. A documented example in a README would otherwise be
    // a finding, while no issued credential contains a space.
    const sentence = assemble(
      'This has ',
      "'single'",
      ' and ',
      '"double"',
      ' quotes inside of it.',
    );
    expect(sentence.length).toBeGreaterThanOrEqual(ENTROPY_MIN_LENGTH);
    expect(shannonEntropy(sentence)).toBeGreaterThan(ENTROPY_MIN_BITS_PER_CHAR);
    expect(isKeyLikeName('BACKTICK_KEY')).toBe(true);
    expect(scanLine('docs/environment.md', `BACKTICK_KEY=\`${sentence}\``)).toEqual([]);
    expect(scanLine('src/config.ts', `const apiKey = "${sentence}";`)).toEqual([]);
  });
});

describe('connection-string', () => {
  it('reports a credentialed URI that the allowlist does not cover', () => {
    const line = fixtureAssignment(FOREIGN_CONNECTION_STRING);
    const finding = expectSingleFinding(scanLine('apps/local-service/src/store/db.ts', line), {
      rule: 'connection-string',
      // The sub-pattern is the URI scheme, which is what tells a reviewer which system to rotate.
      pattern: 'mysql',
      file: 'apps/local-service/src/store/db.ts',
      column: columnOf(line, FOREIGN_CONNECTION_STRING),
    });
    expect(finding.message).toContain('mysql');
    expect(finding.message).not.toContain(FOREIGN_CONNECTION_PASSWORD);
    expectValueNeverPrinted(finding, FOREIGN_CONNECTION_STRING);
  });

  it('does not report a credential-free URL', () => {
    const line = 'See https://registry.npmjs.org/zod for the published manifest.';
    expect(scanLine('README.md', line)).toHaveLength(0);
  });
});

/* ---------------------------------------------------------------------------
 * The allowlisted placeholders: exempt where reviewed, reported everywhere else
 * ------------------------------------------------------------------------ */

/** The paths at which the committed allowlist permits the development database URL. */
const DATABASE_URL_PATHS =
  ALLOWLIST.literals.find((literal) => literal.value === DEV_DATABASE_URL)?.files ?? [];

describe('the reviewed allowlist is the only exemption channel', () => {
  it.each([...DATABASE_URL_PATHS])('exempts the database placeholder at %s', (relPath) => {
    const result = scanContentWithSuppressions(
      relPath,
      [...PROSE_BEFORE, `DATABASE_URL=${DEV_DATABASE_URL}`, ...PROSE_AFTER].join('\n'),
      ALLOWLIST,
    );
    expect(result.findings).toHaveLength(0);
    // The match is not ignored, it is accounted for: the report says how many exemptions were used
    // and which literal used them.
    expect(result.allowlisted).toHaveLength(1);
    expect(result.allowlisted[0].allowlistValue).toBe(DEV_DATABASE_URL);
    expect(result.allowlisted[0].rule).toBe('connection-string');
    expect(result.allowlisted[0].line).toBe(FIXTURE_LINE);
  });

  it('still reports the same placeholder at a path the entry does not list', () => {
    const relPath = 'apps/local-service/src/config.ts';
    expect(DATABASE_URL_PATHS).not.toContain(relPath);
    const finding = expectSingleFinding(scanLine(relPath, fixtureAssignment(DEV_DATABASE_URL)), {
      rule: 'connection-string',
      pattern: 'postgresql',
      file: relPath,
      column: columnOf(fixtureAssignment(DEV_DATABASE_URL), DEV_DATABASE_URL),
    });
    expect(finding.hint).toContain(`scripts/${ALLOWLIST_FILENAME}`);
  });

  it('reports it when the caller applies no allowlist at all', () => {
    // The exemption comes from the reviewed file, never from the path: without the allowlist the
    // very same line in the very same required example file is a finding.
    const findings = scanContent('.env.example', `DATABASE_URL=${DEV_DATABASE_URL}\n`);
    expect(findings).toHaveLength(1);
    expect(findings[0].rule).toBe('connection-string');
  });

  it('does not exempt a second credential that merely shares the line', () => {
    const line = `DATABASE_URL=${DEV_DATABASE_URL} # migrated from ${FOREIGN_CONNECTION_STRING}`;
    const result = scanContentWithSuppressions(
      '.env.example',
      [...PROSE_BEFORE, line, ...PROSE_AFTER].join('\n'),
      ALLOWLIST,
    );
    expect(result.allowlisted).toHaveLength(1);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].pattern).toBe('mysql');
  });

  it('exempts a match that an allowlisted literal quotes in full', () => {
    // The exemption is narrow in both directions: a match may contain the allowlisted literal (a
    // connection string whose match spans host and database) or lie entirely inside an occurrence
    // of it (a documented example whose literal quotes the value). This is the second direction,
    // driven through a caller-supplied allowlist so the committed one stays exactly as reviewed.
    const quoted = `EXAMPLE_TOKEN=${FORGE_CLASSIC_PREFIX}${cycle(WORD_CHARS, 36)}`;
    const allowlist = normalizeAllowlist({
      version: 1,
      literals: [{ value: quoted, reason: 'documented example token', files: ['docs/notes.md'] }],
    });

    const exempted = scanContentWithSuppressions(
      'docs/notes.md',
      [...PROSE_BEFORE, `  ${quoted}`, ...PROSE_AFTER].join('\n'),
      allowlist,
    );
    expect(exempted.findings).toHaveLength(0);
    expect(exempted.allowlisted).toHaveLength(1);
    expect(exempted.allowlisted[0].rule).toBe('provider-key');

    const elsewhere = scanLine('docs/other.md', `  ${quoted}`, allowlist);
    expect(elsewhere).toHaveLength(1);
    expect(elsewhere[0].rule).toBe('provider-key');
  });

  it('accepts the Compose password placeholder at docker-compose.yml', () => {
    const compose = [
      'services:',
      '  postgres:',
      '    image: postgres:18.6-alpine',
      '    environment:',
      `      ${DEV_COMPOSE_PASSWORD}`,
      '',
    ].join('\n');
    expect(scanContent('docker-compose.yml', compose, ALLOWLIST)).toHaveLength(0);
  });

  it('leaves the committed docker-compose.yml clean', () => {
    const absolute = path.join(REPOSITORY_ROOT, 'docker-compose.yml');
    if (!existsSync(absolute)) {
      // The Compose file is a separate deliverable; asserting against it when it is absent would
      // couple this suite to another file's landing order.
      expect(existsSync(DEFAULT_ALLOWLIST_PATH)).toBe(true);
      return;
    }
    expect(scanContent('docker-compose.yml', readFileSync(absolute, 'utf8'), ALLOWLIST)).toEqual(
      [],
    );
  });
});

/* ---------------------------------------------------------------------------
 * The two required example files pass the required gate (AAP 0.3.4)
 * ------------------------------------------------------------------------ */

/**
 * The root example environment, as AAP 0.3.4 enumerates it. Used as written when the committed
 * file is absent, so this assertion is meaningful today and stronger once the file lands.
 */
const ROOT_ENV_EXAMPLE_FIXTURE = [
  '# Debug Generator - example environment. Copy to `.env`, which is git-ignored.',
  '',
  'ANTHROPIC_API_KEY=',
  'DEBUGGEN_PROVIDER=deterministic',
  'DEBUGGEN_MODEL=',
  'DEBUGGEN_HOST=127.0.0.1',
  'DEBUGGEN_PORT=43117',
  'DEBUGGEN_HOME=~/.debuggen',
  'DEBUGGEN_LOG_LEVEL=info',
  'DEBUGGEN_RETENTION_DAYS=30',
  `DATABASE_URL=${DEV_DATABASE_URL}`,
  'NEXT_OTEL_VERBOSE=0',
  '',
].join('\n');

/** The demo application's example environment, which repeats the same database URL for Prisma. */
const DEMO_ENV_EXAMPLE_FIXTURE = [
  '# Lumen Supply - example environment, read by prisma.config.ts.',
  '',
  `DATABASE_URL=${DEV_DATABASE_URL}`,
  '',
].join('\n');

/**
 * The only two environment files that may be tracked, each with the content to fall back on.
 *
 * @type {readonly { path: string, fixture: string }[]}
 */
const REQUIRED_EXAMPLE_FILES = [
  { path: '.env.example', fixture: ROOT_ENV_EXAMPLE_FIXTURE },
  { path: 'apps/demo-app/.env.example', fixture: DEMO_ENV_EXAMPLE_FIXTURE },
];

/**
 * The committed content of `relPath`, or `fixture` when the file has not landed yet.
 *
 * @param {string} relPath
 * @param {string} fixture
 * @returns {string}
 */
function committedOrFixture(relPath, fixture) {
  const absolute = path.join(REPOSITORY_ROOT, relPath);
  return existsSync(absolute) ? readFileSync(absolute, 'utf8') : fixture;
}

describe('the required example files pass the gate', () => {
  it.each(REQUIRED_EXAMPLE_FILES)('scans $path clean', ({ path: relPath, fixture }) => {
    const content = committedOrFixture(relPath, fixture);
    // The assertion is only worth making because these files really do carry the placeholder.
    expect(content).toContain(DEV_DATABASE_URL);
    expect(isEnvFileViolation(relPath)).toBe(false);
    expect(scanContent(relPath, content, ALLOWLIST)).toEqual([]);
  });

  it.each(REQUIRED_EXAMPLE_FILES)(
    'owes that pass to the reviewed allowlist, not to $path itself',
    ({ path: relPath, fixture }) => {
      const content = committedOrFixture(relPath, fixture);
      const findings = scanContent(relPath, content);
      expect(findings.length).toBeGreaterThan(0);
      expect(findings.every((finding) => finding.rule === 'connection-string')).toBe(true);
    },
  );

  it('keeps the canonical example content clean even before those files land', () => {
    for (const { path: relPath, fixture } of REQUIRED_EXAMPLE_FILES) {
      expect(scanContent(relPath, fixture, ALLOWLIST)).toEqual([]);
    }
  });
});

/* ---------------------------------------------------------------------------
 * False positives cost as much as misses: one case per shape this repository commits
 * ------------------------------------------------------------------------ */

describe('content this repository legitimately commits', () => {
  /** A 40-character git object name, the shape AAP 0.3.2 pins every action to. */
  const GIT_OBJECT_NAME = cycle(HEX_CHARS, 40);

  /** A base64 subresource digest, the shape `pnpm-lock.yaml` records for every package. */
  const INTEGRITY_DIGEST = `sha512-${cycle(BASE64_CHARS, 86)}==`;

  it('does not flag a git object name pinning an action in a workflow', () => {
    const line = `      - uses: actions/checkout@${GIT_OBJECT_NAME}`;
    expect(scanLine('.github/workflows/ci.yml', line)).toEqual([]);
  });

  it('does not flag a git object name outside a workflow either', () => {
    // Hexadecimal has 16 symbols, so it cannot exceed 4 bits per character whatever its length:
    // the workflow exemption is belt and braces, not the load-bearing guard.
    expect(shannonEntropy(GIT_OBJECT_NAME)).toBeLessThan(ENTROPY_MIN_BITS_PER_CHAR);
    expect(scanLine('docs/ARCHITECTURE.md', `Pinned at ${GIT_OBJECT_NAME}.`)).toEqual([]);
  });

  it('does not flag the integrity digests in the lockfile', () => {
    const line = `    resolution: {integrity: ${INTEGRITY_DIGEST}}`;
    expect(scanLine('pnpm-lock.yaml', line)).toEqual([]);
    // The name is not key-like either, so the digest is quiet wherever it appears.
    expect(scanLine('packages/shared/asset-manifest.json', line)).toEqual([]);
  });

  it('exempts the lockfile from the entropy rule only', () => {
    const value = FORGE_FINE_PREFIX + cycle(WORD_CHARS, 40);
    const findings = scanLine('pnpm-lock.yaml', `      token: ${value}`);
    expect(findings).toHaveLength(1);
    expect(findings[0].rule).toBe('provider-key');
  });

  it('does not flag an empty credential assignment', () => {
    expect(scanLine('.env.example', 'ANTHROPIC_API_KEY=')).toEqual([]);
    expect(scanLine('.env.example', 'DEBUGGEN_MODEL=')).toEqual([]);
  });

  it('does not flag a long value with too little entropy to be key material', () => {
    const repeated = 'a'.repeat(64);
    expect(shannonEntropy(repeated)).toBe(0);
    expect(scanLine('src/fixture.ts', `const API_KEY = '${repeated}';`)).toEqual([]);
  });

  it('does not flag a dense path inside a credential-free URL', () => {
    // The same value that is a finding after `API_KEY=` is a host and a path after `API_KEY=https:`
    // - an asset URL, not key material. A credentialed URI is `connection-string`'s business.
    expect(isKeyLikeName('API_KEY')).toBe(true);
    const line = `API_KEY=https://assets.example.com/${DENSE_VALUE}`;
    expect(scanLine('.env.example', line)).toEqual([]);
  });

  it('does not flag the words this product documents itself with', () => {
    const prose = 'Rotate the database password and revoke any token before review.';
    expect(scanLine('docs/SECURITY.md', prose)).toEqual([]);
    expect(isKeyLikeName('monkey')).toBe(false);
    expect(isKeyLikeName('tokenize')).toBe(false);
  });

  it('scans its own tracked source without a finding', () => {
    // The gate and this suite are mutually constraining (see the module documentation): every
    // fixture above is assembled at runtime precisely so this assertion holds.
    const tracked = [
      'scripts/check-secrets.mjs',
      'scripts/check-secrets.test.mjs',
      // The allowlist necessarily commits both literals, which is why each entry names it.
      `scripts/${ALLOWLIST_FILENAME}`,
    ];
    for (const relPath of tracked) {
      const absolute = path.join(REPOSITORY_ROOT, relPath);
      expect(existsSync(absolute)).toBe(true);
      expect(scanContent(relPath, readFileSync(absolute, 'utf8'), ALLOWLIST)).toEqual([]);
    }
  });
});

/* ---------------------------------------------------------------------------
 * The command line, end to end over a throwaway checkout
 *
 * One thin block: the rule coverage above needs neither git nor a checkout, and keeping it that
 * way is what makes it fast and hermetic. What is left to prove here is the wiring - tracked-file
 * enumeration, the report and the exit codes - so there are two scanning cases, not twelve.
 * ------------------------------------------------------------------------ */

/**
 * Whether `git` can be spawned. The enumeration cases skip themselves when it cannot rather than
 * failing, because they are testing this script's wiring and not the host's toolchain.
 */
const GIT_AVAILABLE = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

/**
 * A fresh git repository under the system temporary directory - never inside this checkout, whose
 * `git status` must stay clean.
 *
 * @returns {string} Absolute path of the new work tree.
 */
function createThrowawayRepository() {
  const directory = createTemporaryDirectory();
  execFileSync('git', ['init', '-q'], { cwd: directory, stdio: 'ignore' });
  return directory;
}

/**
 * Write `content` to `relPath` inside `directory` and stage it, which is all the gate needs:
 * enumeration is `git ls-files`, so an added file is tracked without a commit - and without
 * touching any git identity configuration.
 *
 * @param {string} directory
 * @param {string} relPath
 * @param {string} content
 */
function trackFile(directory, relPath, content) {
  const absolute = path.join(directory, relPath);
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, content);
  execFileSync('git', ['add', '--', relPath], { cwd: directory, stdio: 'ignore' });
}

/**
 * Run the command line in process, capturing both streams.
 *
 * `main` never calls `process.exit` and writes through `process.stdout` / `process.stderr`, which
 * is precisely so a test can assert on the code and the output.
 *
 * @param {readonly string[]} argv
 * @param {{ cwd?: string, allowlist?: unknown, allowlistPath?: string }} [options]
 * @returns {Promise<{ exitCode: number, stdout: string, stderr: string }>}
 */
async function runCli(argv, options = {}) {
  let stdout = '';
  let stderr = '';
  const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdout += String(chunk);
    return true;
  });
  const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    stderr += String(chunk);
    return true;
  });
  try {
    const exitCode = await main(argv, options);
    return { exitCode, stdout, stderr };
  } finally {
    outSpy.mockRestore();
    errSpy.mockRestore();
  }
}

describe('the command line', () => {
  it.skipIf(!GIT_AVAILABLE)(
    'exits 0 with an empty report over a clean checkout',
    async () => {
      const directory = createThrowawayRepository();
      trackFile(directory, 'docs/notes.md', '# Notes\n\nNothing secret here.\n');

      const { exitCode, stdout, stderr } = await runCli(['--json'], { cwd: directory });

      expect(exitCode).toBe(EXIT_OK);
      expect(stderr).toBe('');
      const report = JSON.parse(stdout);
      expect(report.ok).toBe(true);
      expect(report.exitCode).toBe(EXIT_OK);
      expect(report.findings).toEqual([]);
      expect(report.allowlisted).toEqual([]);
      expect(report.filesTracked).toBe(1);
      expect(report.filesScanned).toBe(1);
      expect(report.rules).toEqual([...RULE_IDS]);
      // The committed allowlist stays in force even when the scan points elsewhere.
      expect(report.allowlistPath).toBe(DEFAULT_ALLOWLIST_PATH);
      expect(report.repoRoot).toBe(realpathSync(directory));
    },
    20_000,
  );

  it.skipIf(!GIT_AVAILABLE)(
    'exits 0 over a checkout carrying both required placeholders, on the committed allowlist',
    async () => {
      // The end-to-end half of AAP 0.3.4's negative requirement. The rule-level cases above prove
      // `scanContent` exempts the two placeholders; this one drives the whole gate over a
      // repository that really tracks the three files they live in, so a regression in default
      // allowlist loading, in tracked-file enumeration or in repository-level suppression fails
      // here instead of surviving until `pnpm check:secrets` runs in CI.
      const directory = createThrowawayRepository();
      trackFile(directory, '.env.example', ROOT_ENV_EXAMPLE_FIXTURE);
      trackFile(directory, 'apps/demo-app/.env.example', DEMO_ENV_EXAMPLE_FIXTURE);
      trackFile(
        directory,
        'docker-compose.yml',
        [
          '# PostgreSQL for the demo application.',
          'services:',
          '  postgres:',
          '    image: postgres:18.6-alpine',
          '    environment:',
          `      ${DEV_COMPOSE_PASSWORD}`,
          '',
        ].join('\n'),
      );

      const { exitCode, stdout, stderr } = await runCli(['--json'], { cwd: directory });

      expect(exitCode).toBe(EXIT_OK);
      expect(stderr).toBe('');
      const report = JSON.parse(stdout);
      expect(report.ok).toBe(true);
      expect(report.exitCode).toBe(EXIT_OK);
      expect(report.findings).toEqual([]);
      // All three files were enumerated and all three were read: the pass is not a scan that
      // quietly skipped the files the placeholders are in.
      expect(report.filesTracked).toBe(3);
      expect(report.filesScanned).toBe(3);
      // And the committed, reviewed allowlist is what granted it - not an empty default, and not
      // an allowlist found inside the throwaway repository.
      expect(report.allowlistPath).toBe(DEFAULT_ALLOWLIST_PATH);

      // The exemptions are accounted for, one entry per suppressed match, each naming the file it
      // was used in, the rule it suppressed and the reviewed literal that granted it.
      expect(
        report.allowlisted.map(
          (/** @type {{ file: string, rule: string, allowlistValue: string }} */ entry) => ({
            file: entry.file,
            rule: entry.rule,
            allowlistValue: entry.allowlistValue,
          }),
        ),
      ).toEqual([
        { file: '.env.example', rule: 'connection-string', allowlistValue: DEV_DATABASE_URL },
        {
          file: 'apps/demo-app/.env.example',
          rule: 'connection-string',
          allowlistValue: DEV_DATABASE_URL,
        },
      ]);
      // The Compose placeholder needs no exemption at all: `debuggen` is eight characters, so no
      // rule matches it and there is nothing to suppress. Its allowlist entry exists for the
      // literal's sake, and the file is tracked and scanned either way - which is what the
      // `filesScanned` count above states.
      expect(
        report.allowlisted.some(
          (/** @type {{ file: string }} */ entry) => entry.file === 'docker-compose.yml',
        ),
      ).toBe(false);
      // Neither example file is an `env-file` violation, which is the other half of why they pass.
      for (const allowed of ALLOWED_ENV_FILES) {
        expect(isEnvFileViolation(allowed)).toBe(false);
      }
    },
    20_000,
  );

  it.skipIf(!GIT_AVAILABLE)(
    'exits 1 and names the file, line and rule when a tracked file carries a credential',
    async () => {
      const directory = createThrowawayRepository();
      trackFile(directory, 'docs/notes.md', '# Notes\n\nNothing secret here.\n');
      const credential = FORGE_CLASSIC_PREFIX + cycle(WORD_CHARS, 36);
      trackFile(
        directory,
        'src/config.ts',
        ['export const config = {', `  token: '${credential}',`, '};', ''].join('\n'),
      );

      const { exitCode, stdout } = await runCli(['--json'], { cwd: directory });

      expect(exitCode).toBe(EXIT_FINDINGS);
      const report = JSON.parse(stdout);
      expect(report.ok).toBe(false);
      expect(report.exitCode).toBe(EXIT_FINDINGS);
      expect(report.filesTracked).toBe(2);
      expect(report.findings).toHaveLength(1);
      const [finding] = report.findings;
      expect(finding.file).toBe('src/config.ts');
      expect(finding.line).toBe(2);
      expect(finding.rule).toBe('provider-key');
      expect(finding.pattern).toBe(FORGE_CLASSIC_PREFIX);
      expectValueNeverPrinted(finding, credential);
      // A machine-readable report is public too: the value must not survive serialization.
      expect(stdout).not.toContain(credential);
    },
    20_000,
  );

  it.skipIf(!GIT_AVAILABLE)(
    'prints the file, the rule and the hint in its text report',
    async () => {
      const directory = createThrowawayRepository();
      trackFile(
        directory,
        'src/keys.ts',
        ['export const material = [', `  '${PRIVATE_KEY_FIXTURES[0].value}',`, '];', ''].join('\n'),
      );

      const { exitCode, stdout } = await runCli([], { cwd: directory });

      expect(exitCode).toBe(EXIT_FINDINGS);
      expect(stdout).toContain('src/keys.ts:2: private-key:');
      expect(stdout).toContain('hint:');
      expect(stdout).toContain('1 finding');
      expect(stdout).not.toContain(PRIVATE_KEY_FIXTURES[0].value);
    },
    20_000,
  );

  it.skipIf(!GIT_AVAILABLE)(
    'accounts for every file it deliberately did not read, and still applies the path rules',
    async () => {
      const directory = createThrowawayRepository();
      // A tracked environment file is a finding whether or not its content is readable text, so
      // this one is written as binary on purpose.
      trackFile(directory, '.env', 'PORT=3000\n\u0000\u0000binary tail\n');
      trackFile(directory, 'public/icon.png', 'not really a PNG, but the extension decides\n');
      trackFile(directory, 'assets/blob.bin', `head\u0000${cycle(URLSAFE_CHARS, 32)}\n`);
      trackFile(directory, 'docs/gone.md', '# Staged, then removed from the work tree\n');
      rmSync(path.join(directory, 'docs/gone.md'), { force: true });
      trackFile(directory, 'docs/notes.md', '# Notes\n');
      symlinkSync('notes.md', path.join(directory, 'docs/link.md'));
      execFileSync('git', ['add', '--', 'docs/link.md'], { cwd: directory, stdio: 'ignore' });
      // Oversized: reported rather than fatal, because an oversized tracked file is a hygiene
      // problem of its own and failing the secrets gate for it would only obscure that.
      trackFile(directory, 'data/dump.sql', 'a'.repeat(2 * 1024 * 1024 + 1));

      const { exitCode, stdout } = await runCli(['--json'], { cwd: directory });

      expect(exitCode).toBe(EXIT_FINDINGS);
      const report = JSON.parse(stdout);
      expect(report.filesTracked).toBe(7);
      expect(report.findings).toHaveLength(1);
      expect(report.findings[0]).toMatchObject({ file: '.env', rule: 'env-file', line: 1 });
      // Skipped files are reported rather than passed over in silence.
      const skipped = new Map(
        report.skipped.map((entry) => [entry.file, /** @type {string} */ (entry.reason)]),
      );
      expect(skipped.get('.env')).toBe('binary');
      expect(skipped.get('public/icon.png')).toBe('binary');
      expect(skipped.get('assets/blob.bin')).toBe('binary');
      expect(skipped.get('docs/gone.md')).toBe('missing');
      expect(skipped.get('docs/link.md')).toBe('symlink');
      expect(skipped.get('data/dump.sql')).toBe('too-large');
      // Only `docs/notes.md` was readable text.
      expect(report.filesScanned).toBe(1);

      const text = await runCli([], { cwd: directory });
      expect(text.stdout).toContain('6 skipped');
    },
    20_000,
  );

  it.skipIf(!GIT_AVAILABLE)(
    'exits 2, not 0, when git tracks nothing, because it would be passing over nothing',
    async () => {
      // The failure mode a gate must not have: a green exit code that proves nothing about the
      // repository. An empty tracked subject is a precondition failure, not a clean report.
      const directory = createThrowawayRepository();

      const { exitCode, stdout, stderr } = await runCli(['--json'], { cwd: directory });

      expect(exitCode).toBe(EXIT_ERROR);
      expect(exitCode).not.toBe(EXIT_OK);
      // Distinguishable from a finding, so CI can tell "nothing to scan" from "found something".
      expect(exitCode).not.toBe(EXIT_FINDINGS);
      const failure = JSON.parse(stdout);
      expect(failure.ok).toBe(false);
      expect(failure.exitCode).toBe(EXIT_ERROR);
      expect(failure.error.code).toBe('no-tracked-files');
      expect(stderr).toContain('no-tracked-files');
      // Actionable: it names the subject and the ways out of the state.
      expect(stderr).toContain(realpathSync(directory));
      expect(stderr).toContain('git add');
      expect(stderr).toContain('sparse-checkout');

      const text = await runCli([], { cwd: directory });
      expect(text.exitCode).toBe(EXIT_ERROR);
      // No report is printed, so nothing can be mistaken for a scan that happened.
      expect(text.stdout).toBe('');
      expect(text.stderr).toContain('git tracks no files in');
    },
    20_000,
  );

  it.skipIf(!GIT_AVAILABLE)(
    'refuses to return a report over nothing to an in-process caller either',
    () => {
      // The precondition is enforced where enumeration happens, so a caller that skips the
      // command line - `scanRepository` is exported - cannot get `ok: true` over an unscanned
      // tree. Were this only a CLI check, the exported seam would still fail open.
      const directory = createThrowawayRepository();

      expectCheckSecretsError(() => scanRepository({ cwd: directory }), 'no-tracked-files');
    },
    20_000,
  );

  it('documents every rule in --help and exits 0', async () => {
    const { exitCode, stdout, stderr } = await runCli(['--help']);

    expect(exitCode).toBe(EXIT_OK);
    expect(stderr).toBe('');
    expect(stdout).toContain('Usage: node scripts/check-secrets.mjs');
    for (const ruleId of RULE_IDS) {
      expect(stdout).toContain(ruleId);
    }
    for (const allowed of ALLOWED_ENV_FILES) {
      expect(stdout).toContain(allowed);
    }
  });

  it('exits 2 on an unknown option without printing a report', async () => {
    const { exitCode, stdout, stderr } = await runCli(['--scan-everything']);

    expect(exitCode).toBe(EXIT_ERROR);
    expect(stdout).toBe('');
    expect(stderr).toContain('unknown option');
  });

  it('exits 2 when handed a path, because it scans every tracked file', async () => {
    const { exitCode, stderr } = await runCli(['packages/shared/src/index.ts']);

    expect(exitCode).toBe(EXIT_ERROR);
    expect(stderr).toContain('unexpected argument');
  });

  it('exits 2, distinguishably from a finding, when the path does not exist', async () => {
    const missing = path.join(os.tmpdir(), 'debuggen-secrets-absent', 'nowhere');
    const { exitCode, stdout, stderr } = await runCli(['--json'], { cwd: missing });

    expect(exitCode).toBe(EXIT_ERROR);
    expect(exitCode).not.toBe(EXIT_FINDINGS);
    expect(JSON.parse(stdout).error.code).toBe('root-missing');
    expect(stderr).toContain('root-missing');
  });

  it.skipIf(!GIT_AVAILABLE)('exits 2 when the directory is not a checkout', async () => {
    // Nothing was ever enumerated, so reporting success here would mean a green gate over an
    // unscanned tree - the one failure mode a secrets gate must not have.
    const directory = createTemporaryDirectory();

    const { exitCode, stdout } = await runCli(['--json'], { cwd: directory });

    expect(exitCode).toBe(EXIT_ERROR);
    expect(JSON.parse(stdout).error.code).toBe('not-a-repository');
  });

  it.skipIf(!GIT_AVAILABLE)('exits 2, never 0, when git cannot be found', async () => {
    const directory = createThrowawayRepository();
    trackFile(directory, 'docs/notes.md', '# Notes\n');
    const originalPath = process.env.PATH;
    /** @type {{ exitCode: number, stdout: string }} */
    let result;
    try {
      // Enumeration is `git ls-files` and there is no filesystem-walk fallback, deliberately: a
      // fallback could reach `.git/`, whose config holds this repository's remote access token.
      process.env.PATH = '';
      result = await runCli(['--json'], { cwd: directory });
    } finally {
      if (originalPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = originalPath;
      }
    }

    expect(result.exitCode).toBe(EXIT_ERROR);
    expect(JSON.parse(result.stdout).error.code).toBe('git-missing');
  });

  it('runs as a command, which is how `pnpm check:secrets` invokes it', () => {
    // The module only self-executes when it is the entry point, so this is the one case that has
    // to spawn the script rather than import it.
    const script = path.join(REPOSITORY_ROOT, 'scripts', 'check-secrets.mjs');
    const stdout = execFileSync(process.execPath, [script, '--help'], { encoding: 'utf8' });

    expect(stdout).toContain('Usage: node scripts/check-secrets.mjs');
    for (const ruleId of RULE_IDS) {
      expect(stdout).toContain(ruleId);
    }
  });
});
