#!/usr/bin/env node
/**
 * check-secrets.mjs
 *
 * Repository gate behind `pnpm check:secrets`, which `pnpm verify` runs (AAP 0.8.5). It reads every
 * file git tracks and fails the build when one of them carries a credential, so "no committed
 * secrets" is an enforced property of the repository rather than a habit.
 *
 * Six rules, each with a stable id that is also used by the runtime redaction layer
 * (`packages/telemetry/src/redaction/rules.ts`) so findings, logs and documentation share one
 * vocabulary:
 *
 *   env-file           a tracked `.env` / `.env.*` file other than the two required example files.
 *   provider-key       a provider credential prefix with a plausible credential body after it.
 *   jwt                a JSON Web Token shaped string.
 *   private-key        a PEM private-key header.
 *   entropy            a long, dense value bound to a key-like name. This rule is deliberately
 *                      *bound*: a high-entropy string on its own (a hash, a build id, a base64
 *                      asset) is not a finding, because a bare entropy scan produces so much noise
 *                      that the gate stops being trusted.
 *   connection-string  a URI carrying an embedded user and password.
 *
 * FALSE POSITIVES COST AS MUCH AS MISSES. This check sits inside `pnpm verify`, so one noisy rule
 * blocks every delivery. Every prefix rule therefore requires a word boundary on the left and a
 * plausible continuation on the right, the entropy rule requires a key-like name, and the two
 * committed development placeholders the product needs (the demo database URL and the Compose
 * password) are exempted through `scripts/check-secrets.allowlist.json` - the single, reviewed
 * exemption channel. There is deliberately no inline `// allow-secret` pragma: an exemption that
 * never appears in a diff of one reviewed file is an exemption nobody reviews.
 *
 * SELF-DETECTION. This file is tracked content and is scanned like any other, so every pattern is
 * assembled from concatenated fragments and no credential prefix, token body or key-file header
 * appears contiguously in its source. The same reason keeps the two allowlisted literals out of it:
 * their allowlist entries do not name this path, and rightly so.
 *
 * `.git/` IS NEVER READ. The repository's `origin` URL embeds an access token (AAP 0.2.1), which
 * lives in `.git/config`. Enumeration goes through `git ls-files`, which never lists anything under
 * `.git/`, and there is no filesystem-walk fallback that could reach it. Do not add one.
 *
 * Usage:  node scripts/check-secrets.mjs [--json] [--help]
 * Exits:  0 clean | 1 findings | 2 usage or environment error (unknown option, git unavailable,
 *         not a git repository, missing or malformed allowlist).
 *
 * The check only reads: it writes nothing to disk, and it prints at most the first four characters
 * of a matched value plus its length, because CI logs are public.
 *
 * In-process callers (`scripts/check-secrets.test.mjs`) use the exported helpers -
 * {@link scanContent}, {@link isEnvFileViolation}, {@link shannonEntropy} - which need neither git
 * nor a checkout. {@link main} and {@link scanRepository} accept `{ cwd }` to scan a different
 * checkout, which is how the end-to-end cases drive a throwaway repository.
 */

import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

/* ---------------------------------------------------------------------------
 * Contract constants
 * ------------------------------------------------------------------------ */

/** Exit code: no findings. */
export const EXIT_OK = 0;
/** Exit code: at least one finding. */
export const EXIT_FINDINGS = 1;
/** Exit code: the check could not be performed (usage, git, allowlist). */
export const EXIT_ERROR = 2;

/**
 * The rule vocabulary, in reporting order. `summary` is what `--help` prints, so it is the
 * user-facing definition of each rule and must stay in step with the implementation below.
 *
 * @type {readonly { readonly id: string, readonly summary: string }[]}
 */
export const RULES = Object.freeze([
  Object.freeze({
    id: 'env-file',
    summary: 'a tracked .env or .env.* file other than the two required example files',
  }),
  Object.freeze({
    id: 'provider-key',
    summary: 'a provider credential prefix followed by a plausible credential body',
  }),
  Object.freeze({ id: 'jwt', summary: 'a JSON Web Token shaped string' }),
  Object.freeze({ id: 'private-key', summary: 'a PEM private-key header' }),
  Object.freeze({
    id: 'entropy',
    summary: 'a value of 32+ characters above 4.0 bits/char bound to a key-like name',
  }),
  Object.freeze({
    id: 'connection-string',
    summary: 'a URI with an embedded user and password',
  }),
]);

/**
 * Just the rule ids, for callers that report coverage by id.
 *
 * @type {readonly string[]}
 */
export const RULE_IDS = Object.freeze(RULES.map((rule) => rule.id));

/**
 * The only environment files that may be tracked (AAP 0.3.4). These are repository-relative POSIX
 * paths, not basenames: `/.gitignore` re-includes exactly these two paths after ignoring `.env*`,
 * and an example file anywhere else is still a finding.
 *
 * @type {readonly string[]}
 */
export const ALLOWED_ENV_FILES = Object.freeze(['.env.example', 'apps/demo-app/.env.example']);

/** Shortest value the `entropy` rule considers; below it an entropy estimate means nothing. */
export const ENTROPY_MIN_LENGTH = 32;

/** Entropy threshold in bits per character. The comparison is strict: a value must exceed it. */
export const ENTROPY_MIN_BITS_PER_CHAR = 4;

/** Basename of the reviewed allowlist, which ships next to this script. */
export const ALLOWLIST_FILENAME = 'check-secrets.allowlist.json';

/** Absolute path of this script's directory. */
const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));

/**
 * Default allowlist location: next to this script, which in a checkout is
 * `<repository root>/scripts/check-secrets.allowlist.json`. Resolving it from the script rather
 * than from the scanned root keeps the committed, reviewed allowlist in force even when an
 * in-process caller points the scan at a throwaway repository.
 */
export const DEFAULT_ALLOWLIST_PATH = path.join(SCRIPT_DIRECTORY, ALLOWLIST_FILENAME);

/** Repository-relative path of the allowlist, used in hints. */
const ALLOWLIST_HINT_PATH = `scripts/${ALLOWLIST_FILENAME}`;

/** Bytes inspected when deciding whether a tracked file is binary. */
const BINARY_SNIFF_BYTES = 8192;

/** Files larger than this are reported as skipped rather than read into memory. */
const MAX_SCAN_BYTES = 2 * 1024 * 1024;

/** `git ls-files` on a large tree produces a lot of output; give it room. */
const GIT_MAX_BUFFER = 64 * 1024 * 1024;

/** Characters of a matched value that may be printed, before its length. */
const PREVIEW_PREFIX_LENGTH = 4;

/** Suffix marking a truncated preview (U+2026 HORIZONTAL ELLIPSIS). */
const PREVIEW_SUFFIX = '\u2026';

/**
 * Extensions whose content is never text. Checked before the file is read so a tracked icon or
 * font is skipped without being loaded, and independently of the NUL sniff, which a small or
 * unusually encoded asset can slip past.
 *
 * @type {readonly string[]}
 */
const BINARY_EXTENSIONS = Object.freeze([
  '.png',
  '.ico',
  '.woff',
  '.woff2',
  '.jpg',
  '.jpeg',
  '.gif',
  '.pdf',
  '.vsix',
]);

/**
 * Files exempt from the `entropy` rule only.
 *
 * `pnpm-lock.yaml` records an `integrity:` hash for every package: hundreds of high-entropy base64
 * digests that no entropy heuristic can tell from credentials. Their names (`integrity`,
 * `resolution`) are not key-like, so the bound rule already ignores them; this list makes that
 * independent of the name heuristic. The lockfile stays subject to every other rule - a real key
 * pasted into it is still caught by `provider-key`, `jwt`, `private-key` or `connection-string`.
 *
 * @type {readonly string[]}
 */
const ENTROPY_EXEMPT_FILES = Object.freeze(['pnpm-lock.yaml']);

/** Path prefix whose `uses:` lines legitimately pin actions to 40-character commit SHAs. */
const WORKFLOW_PATH_PREFIX = '.github/workflows/';

/* ---------------------------------------------------------------------------
 * Errors
 * ------------------------------------------------------------------------ */

/**
 * Raised for every condition that makes the check impossible to perform (exit code 2) as opposed
 * to a genuine finding (exit code 1). `code` is a stable, machine-readable discriminator.
 */
export class CheckSecretsError extends Error {
  /**
   * @param {string} code Stable error code, for example `git-missing` or `allowlist-invalid`.
   * @param {string} message Human-readable, actionable description.
   * @param {{ cause?: unknown }} [options]
   */
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = 'CheckSecretsError';
    this.code = code;
  }
}

/**
 * @param {string} message
 * @returns {CheckSecretsError}
 */
function usageError(message) {
  return new CheckSecretsError('usage', message);
}

/* ---------------------------------------------------------------------------
 * Paths and text helpers
 * ------------------------------------------------------------------------ */

/**
 * Normalize a path to the repository-relative POSIX form findings are reported in: backslashes and
 * platform separators become `/`, and leading `./` or `/` segments are dropped so `/.env.example`
 * and `.env.example` name the same file.
 *
 * @param {string} filePath
 * @returns {string}
 */
export function normalizeRepoPath(filePath) {
  const text = typeof filePath === 'string' ? filePath : String(filePath ?? '');
  return text
    .split(path.sep)
    .join('/')
    .replace(/\\/g, '/')
    .replace(/^(?:\.\/)+/, '')
    .replace(/^\/+/, '');
}

/**
 * Last path segment of a repository-relative path.
 *
 * @param {string} relPath
 * @returns {string}
 */
function baseName(relPath) {
  const index = relPath.lastIndexOf('/');
  return index === -1 ? relPath : relPath.slice(index + 1);
}

/**
 * Shannon entropy of `value` in bits per character, computed over UTF-16 code units:
 * `-sum(p * log2 p)`.
 *
 * Returns 0 for an empty string and for a run of one repeated character; the maximum for a value
 * built from `n` distinct characters is `log2(n)`, which is why pure hexadecimal (16 symbols) can
 * never exceed 4 bits per character and hashes never reach the `entropy` threshold.
 *
 * Matches `shannonEntropy` in `packages/telemetry/src/redaction/rules.ts` so the gate and the
 * runtime redaction layer cannot disagree about what "dense" means.
 *
 * @param {string} value Value to measure. Never inspected for meaning.
 * @returns {number} Bits of entropy per character; always finite and non-negative.
 */
export function shannonEntropy(value) {
  const text = typeof value === 'string' ? value : String(value ?? '');
  if (text.length === 0) {
    return 0;
  }
  /** @type {Map<string, number>} */
  const counts = new Map();
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charAt(index);
    counts.set(unit, (counts.get(unit) ?? 0) + 1);
  }
  let bits = 0;
  for (const count of counts.values()) {
    const probability = count / text.length;
    bits -= probability * Math.log2(probability);
  }
  return bits;
}

/**
 * What may be printed about a matched value: its first few characters and its length. A CI log is
 * public, so the value itself never reaches it.
 *
 * @param {string} value
 * @returns {string}
 */
function preview(value) {
  if (value === '') {
    return '(empty)';
  }
  const head = value.slice(0, PREVIEW_PREFIX_LENGTH);
  const unit = value.length === 1 ? 'character' : 'characters';
  return `${head}${PREVIEW_SUFFIX} (${value.length} ${unit})`;
}

/* ---------------------------------------------------------------------------
 * The allowlist: the single reviewed exemption channel
 * ------------------------------------------------------------------------ */

/** Used when a caller scans without an allowlist: nothing is exempt. */
const EMPTY_ALLOWLIST = Object.freeze({ literals: Object.freeze([]) });

/**
 * A validated allowlist.
 *
 * @typedef {object} AllowlistLiteral
 * @property {string} value Exact bytes that may appear, compared literally and with no
 *   normalization.
 * @property {string} reason Written justification, required so every exemption is reviewable.
 * @property {readonly string[]} files Repository-relative paths where `value` is permitted.
 */

/**
 * @typedef {object} Allowlist
 * @property {readonly AllowlistLiteral[]} literals
 */

/**
 * @param {string} message
 * @returns {CheckSecretsError}
 */
function allowlistInvalid(message) {
  return new CheckSecretsError(
    'allowlist-invalid',
    `${ALLOWLIST_HINT_PATH} is malformed: ${message}. Expected ` +
      '{ "version": 1, "literals": [{ "value": string, "reason": string, "files": string[] }] }.',
  );
}

/**
 * Validate and freeze an allowlist object, accepting either the committed file shape (with
 * `version`) or an already-normalized object, so in-process callers can build one by hand.
 *
 * A malformed allowlist is an error, never an empty one: silently ignoring it would make the gate
 * fail on the two example files the product requires to be committed.
 *
 * @param {unknown} raw Parsed allowlist.
 * @returns {Allowlist}
 * @throws {CheckSecretsError} With code `allowlist-invalid`.
 */
export function normalizeAllowlist(raw) {
  if (raw === undefined || raw === null) {
    return EMPTY_ALLOWLIST;
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw allowlistInvalid('the top level is not an object');
  }
  const record = /** @type {Record<string, unknown>} */ (raw);
  if (record.version !== undefined && record.version !== 1) {
    throw allowlistInvalid(`unsupported version ${JSON.stringify(record.version)}`);
  }
  if (!Array.isArray(record.literals)) {
    throw allowlistInvalid('"literals" is missing or not an array');
  }
  const literals = record.literals.map((entry, index) => {
    const where = `literals[${index}]`;
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw allowlistInvalid(`${where} is not an object`);
    }
    const literal = /** @type {Record<string, unknown>} */ (entry);
    if (typeof literal.value !== 'string' || literal.value === '') {
      throw allowlistInvalid(`${where}.value must be a non-empty string`);
    }
    if (typeof literal.reason !== 'string' || literal.reason.trim() === '') {
      throw allowlistInvalid(`${where}.reason must explain why the literal is not a secret`);
    }
    if (!Array.isArray(literal.files) || literal.files.length === 0) {
      throw allowlistInvalid(`${where}.files must list at least one repository-relative path`);
    }
    const files = literal.files.map((file) => {
      if (typeof file !== 'string' || file.trim() === '') {
        throw allowlistInvalid(`${where}.files contains an entry that is not a path`);
      }
      return normalizeRepoPath(file);
    });
    return Object.freeze({
      value: literal.value,
      reason: literal.reason,
      files: Object.freeze(files),
    });
  });
  return Object.freeze({ literals: Object.freeze(literals) });
}

/**
 * Read, parse and validate the reviewed allowlist.
 *
 * @param {string} [allowlistPath] Absolute or cwd-relative path. Defaults to the file shipped next
 *   to this script, which in a checkout is `scripts/check-secrets.allowlist.json`.
 * @returns {Allowlist}
 * @throws {CheckSecretsError} With code `allowlist-missing`, `allowlist-unreadable` or
 *   `allowlist-invalid`.
 */
export function loadAllowlist(allowlistPath = DEFAULT_ALLOWLIST_PATH) {
  const resolved = path.resolve(allowlistPath);
  let text;
  try {
    text = readFileSync(resolved, 'utf8');
  } catch (error) {
    const code = /** @type {{ code?: string }} */ (error).code;
    if (code === 'ENOENT') {
      throw new CheckSecretsError(
        'allowlist-missing',
        `the reviewed allowlist is missing: ${resolved}. It is a committed deliverable; without ` +
          'it the gate cannot tell the required development placeholders from real credentials.',
        { cause: error instanceof Error ? error : undefined },
      );
    }
    throw new CheckSecretsError(
      'allowlist-unreadable',
      `cannot read the allowlist ${resolved}: ` +
        (error instanceof Error ? error.message : String(error)),
      { cause: error instanceof Error ? error : undefined },
    );
  }
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw allowlistInvalid(
      `it is not valid JSON (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    Array.isArray(parsed) ||
    /** @type {Record<string, unknown>} */ (parsed).version !== 1
  ) {
    throw allowlistInvalid('the committed file must declare "version": 1');
  }
  return normalizeAllowlist(parsed);
}

/**
 * Accept whatever a caller passed for the allowlist: a validated object, the parsed file, or
 * nothing at all.
 *
 * @param {unknown} value
 * @returns {Allowlist}
 */
function resolveAllowlist(value) {
  return value === undefined || value === null ? EMPTY_ALLOWLIST : normalizeAllowlist(value);
}

/**
 * Where an allowlisted literal occurs on this line, for this path.
 *
 * @typedef {object} AllowlistOccurrence
 * @property {string} value
 * @property {number} start Inclusive index in the line.
 * @property {number} end Exclusive index in the line.
 */

/**
 * Every occurrence, on `line`, of an allowlisted literal that is permitted at `relPath`.
 *
 * @param {Allowlist} allowlist
 * @param {string} relPath Repository-relative POSIX path.
 * @param {string} line
 * @returns {AllowlistOccurrence[]}
 */
function allowlistOccurrences(allowlist, relPath, line) {
  /** @type {AllowlistOccurrence[]} */
  const occurrences = [];
  for (const literal of allowlist.literals) {
    if (!literal.files.includes(relPath)) {
      continue;
    }
    let index = line.indexOf(literal.value);
    while (index !== -1) {
      occurrences.push({
        value: literal.value,
        start: index,
        end: index + literal.value.length,
      });
      index = line.indexOf(literal.value, index + 1);
    }
  }
  return occurrences;
}

/**
 * The allowlisted literal that exempts this match, or `null`.
 *
 * The exemption is narrow on purpose, and narrow in both directions: the match either contains the
 * allowlisted literal (a connection string whose match spans host and database) or lies entirely
 * inside an occurrence of it (a value the literal quotes in full). A match that merely shares a
 * line with an allowlisted literal is still a finding.
 *
 * @param {readonly AllowlistOccurrence[]} occurrences
 * @param {{ start: number, end: number, text: string }} match
 * @returns {string | null}
 */
function suppressionFor(occurrences, match) {
  for (const occurrence of occurrences) {
    if (match.text.includes(occurrence.value)) {
      return occurrence.value;
    }
    if (match.start >= occurrence.start && match.end <= occurrence.end) {
      return occurrence.value;
    }
  }
  return null;
}

/* ---------------------------------------------------------------------------
 * Pattern fragments
 *
 * Every pattern below is assembled from pieces so that this tracked file contains no contiguous
 * credential prefix, token body or key-file header and therefore never trips its own rules (see
 * the module documentation). The split points are the only reason these are not single literals.
 *
 * All quantifiers are anchored to a character class that excludes the following delimiter, and no
 * pattern uses a backreference, so none can backtrack catastrophically over hostile input.
 * ------------------------------------------------------------------------ */

/** Base64url and opaque token body characters. */
const TOKEN_CHARS = '[A-Za-z0-9_-]';

/** Body characters of an upper-case access-key identifier. */
const UPPER_CHARS = '[A-Z0-9]';

/**
 * Left word boundary for a credential prefix: the prefix must start a token.
 *
 * Without it, `sk-` matches inside ordinary words - `task-oriented_configuration` and
 * `disk-usage_report_threshold` both contain `sk-` followed by more than sixteen token characters -
 * and the gate becomes a source of noise instead of a source of trust.
 */
const LEFT_BOUNDARY = '(?<![A-Za-z0-9_-])';

/**
 * Provider credential shapes, most specific first: `sk-ant-` is tested before the generic `sk-` so
 * an Anthropic key is reported under the prefix that actually identifies it, and the generic match
 * that overlaps it is discarded by {@link dedupeOverlaps}.
 *
 * @type {readonly { readonly label: string, readonly description: string,
 *   readonly pattern: RegExp }[]}
 */
const PROVIDER_KEY_PATTERNS = Object.freeze([
  Object.freeze({
    label: 's' + 'k-ant-',
    description: 'Anthropic API key prefix',
    pattern: new RegExp(LEFT_BOUNDARY + 's' + 'k-ant-' + TOKEN_CHARS + '{16,}', 'g'),
  }),
  Object.freeze({
    label: 's' + 'k-',
    description: 'API key prefix',
    pattern: new RegExp(LEFT_BOUNDARY + 's' + 'k-' + TOKEN_CHARS + '{16,}', 'g'),
  }),
  Object.freeze({
    label: 'gh' + 'p_',
    description: 'GitHub personal access token prefix',
    pattern: new RegExp(LEFT_BOUNDARY + 'gh' + 'p_' + TOKEN_CHARS + '{20,}', 'g'),
  }),
  Object.freeze({
    label: 'git' + 'hub_pat_',
    description: 'GitHub fine-grained token prefix',
    pattern: new RegExp(LEFT_BOUNDARY + 'git' + 'hub_pat_' + TOKEN_CHARS + '{20,}', 'g'),
  }),
  Object.freeze({
    label: 'AK' + 'IA',
    description: 'AWS access key id',
    // Exactly sixteen upper-case alphanumerics, which is the shape of an AWS access key id; the
    // right-hand guard is what makes "exactly" true rather than "at least".
    pattern: new RegExp(LEFT_BOUNDARY + 'AK' + 'IA' + UPPER_CHARS + '{16}(?![A-Za-z0-9])', 'g'),
  }),
]);

/**
 * A JOSE compact serialization: three base64url segments. `eyJ` is base64 of `{"`, which is what
 * makes the first segment identifiable as a JSON header. The segment characters exclude `.`, so
 * each run stops at its separator.
 */
const JWT_PATTERN = new RegExp(
  LEFT_BOUNDARY +
    'ey' +
    'J' +
    TOKEN_CHARS +
    '{8,}' +
    '\\.' +
    TOKEN_CHARS +
    '{8,}' +
    '\\.' +
    TOKEN_CHARS +
    '{8,}',
  'g',
);

/** Words shared by every PEM private-key label. */
const PEM_KEY_WORDS = 'PRIVATE' + ' KEY';

/**
 * PEM labels this rule recognises, the bare one last so a more specific label is reported.
 *
 * @type {readonly string[]}
 */
const PEM_LABELS = Object.freeze([
  'RSA ' + PEM_KEY_WORDS,
  'EC ' + PEM_KEY_WORDS,
  'DSA ' + PEM_KEY_WORDS,
  'OPENSSH ' + PEM_KEY_WORDS,
  'PGP ' + PEM_KEY_WORDS + ' BLOCK',
  PEM_KEY_WORDS,
]);

/** The opening delimiter of a PEM private-key block. */
const PRIVATE_KEY_PATTERN = new RegExp('-{5}BEGIN (?:' + PEM_LABELS.join('|') + ')', 'g');

/** Strips the delimiter from a PEM match so the label alone can be reported. */
const PEM_PREFIX_PATTERN = /^-{5}BEGIN /;

/**
 * Characters that terminate a URI embedded in code, prose, JSON or YAML. The match deliberately
 * runs past the `@` to the end of the URI: the allowlisted development database URL includes its
 * host, port and database name, so a match that stopped at the credential could never be compared
 * against it.
 */
const URI_TERMINATORS = '\\s\'"`,;)\\]}<>';

/** A URI carrying `user:password@`, with its authority and path captured for comparison. */
const CONNECTION_STRING_PATTERN = new RegExp(
  '\\b[a-z][a-z0-9+.-]*' +
    ':\\/\\/' +
    '[^/\\s:@]+' +
    ':' +
    '[^/\\s:@]+' +
    '@' +
    '[^' +
    URI_TERMINATORS +
    ']*',
  'gi',
);

/**
 * A contiguous run long enough for the `entropy` rule to measure.
 *
 * `=` is accepted only as trailing base64 padding, never inside the run: an `=` in the middle of a
 * candidate is an assignment operator, and admitting it would swallow the name into the value -
 * `API_KEY=<value>` would become one 39-character run with nothing to its left, so the rule's
 * name binding would never fire on the most common syntax of all.
 */
const ENTROPY_CANDIDATE_PATTERN = new RegExp(
  '[A-Za-z0-9+/_.~-]{' + String(ENTROPY_MIN_LENGTH) + ',}={0,2}',
  'g',
);

/**
 * Names whose value is a credential. Matching is case-insensitive and separator-aware, and
 * {@link isKeyLikeName} splits camelCase first, so `API_KEY`, `apiKey`, `clientSecret`,
 * `x-api-key` and `--auth-token` all qualify while `monkey`, `keystore` and `tokenize` do not.
 */
const KEY_LIKE_NAME_PATTERN =
  /(^|[_.-])(key|token|secret|password|passwd|pwd|credential|apikey|api_key|auth)([_.-]|$)/i;

/** Characters between a name and its value that carry no meaning: quoting and whitespace. */
const NAME_PADDING = new Set([' ', '\t', '"', "'", '`']);

/** Identifier characters, used to read the name that precedes a value. */
const NAME_PATTERN = /[A-Za-z0-9_.-]+$/;

/** A git object name: `uses: owner/repo@<sha>` in a workflow pins actions this way. */
const GIT_SHA_PATTERN = /^[0-9a-f]{7,40}$/;

/* ---------------------------------------------------------------------------
 * Rules
 * ------------------------------------------------------------------------ */

/**
 * Whether tracking `filePath` violates the `env-file` rule.
 *
 * Environment files hold credentials by definition, so `/.gitignore` ignores `.env*` and
 * re-includes exactly the two example files the product ships. The comparison is on the whole
 * repository-relative path rather than the basename: `apps/demo-app/.env.example` is required,
 * `apps/demo-app/.env.local` is a finding, and an example file anywhere else is a finding too,
 * because a third example file is a copy nobody maintains.
 *
 * @param {string} filePath Repository-relative path; a leading `/` or `./` is tolerated.
 * @returns {boolean}
 */
export function isEnvFileViolation(filePath) {
  const relPath = normalizeRepoPath(filePath);
  if (relPath === '') {
    return false;
  }
  const base = baseName(relPath);
  if (base !== '.env' && !base.startsWith('.env.')) {
    return false;
  }
  return !ALLOWED_ENV_FILES.includes(relPath);
}

/**
 * Whether a name denotes a credential. camelCase is split first so that `clientSecret` is read as
 * `client_secret`, which is what makes the rule work on JavaScript identifiers as well as on
 * environment variables and HTTP headers.
 *
 * @param {string} name
 * @returns {boolean}
 */
export function isKeyLikeName(name) {
  const text = typeof name === 'string' ? name : String(name ?? '');
  if (text === '') {
    return false;
  }
  return KEY_LIKE_NAME_PATTERN.test(text.replace(/([a-z0-9])([A-Z])/g, '$1_$2'));
}

/**
 * The name a value is assigned to, read leftwards from the value's position.
 *
 * Handles the syntaxes credentials actually appear in: `NAME=value`, `name: value`,
 * `name = "value"`, `"name": "value"` and `--name value`. Brackets and parentheses are not
 * traversed, so `hash('<long value>')` yields no name and a long literal passed to a function is
 * not attributed to that function - deliberately conservative, because the `entropy` rule only
 * fires when a name is found.
 *
 * @param {string} before The part of the line that precedes the value.
 * @returns {string} The name, or `''` when the value is not an assigned one.
 */
function nearestAssignedName(before) {
  let index = before.length;
  while (index > 0 && NAME_PADDING.has(before.charAt(index - 1))) {
    index -= 1;
  }
  const operator = before.charAt(index - 1);
  if (index > 0 && (operator === '=' || operator === ':')) {
    index -= 1;
    // `=>` is an arrow, not an assignment; treating it as one would attribute a value to whatever
    // identifier happened to precede the arrow.
    if (before.charAt(index - 1) === '>' || before.charAt(index - 1) === '=') {
      return '';
    }
    while (index > 0 && NAME_PADDING.has(before.charAt(index - 1))) {
      index -= 1;
    }
  }
  const match = NAME_PATTERN.exec(before.slice(0, index));
  return match === null ? '' : match[0];
}

/**
 * A raw rule match on one line, before it becomes a finding.
 *
 * @typedef {object} RuleMatch
 * @property {string} rule Rule id.
 * @property {string} pattern Sub-pattern label, or `''` for a rule with a single shape.
 * @property {number} start Inclusive index in the line.
 * @property {number} end Exclusive index in the line.
 * @property {string} text The matched text.
 * @property {string} detail Rule-specific explanation, already free of the matched value.
 */

/**
 * Drop matches that overlap one already accepted. Matches arrive in rule and pattern order, so the
 * survivor is always the more specific rule - `sk-ant-` over `sk-`, a provider key over the
 * entropy heuristic that would also see it.
 *
 * @param {readonly RuleMatch[]} matches
 * @returns {RuleMatch[]}
 */
function dedupeOverlaps(matches) {
  /** @type {RuleMatch[]} */
  const accepted = [];
  for (const match of matches) {
    const overlaps = accepted.some((other) => match.start < other.end && other.start < match.end);
    if (!overlaps) {
      accepted.push(match);
    }
  }
  return accepted;
}

/**
 * `provider-key`: a credential prefix with a plausible credential body after it.
 *
 * @param {string} line
 * @returns {RuleMatch[]}
 */
function matchProviderKeys(line) {
  /** @type {RuleMatch[]} */
  const matches = [];
  for (const shape of PROVIDER_KEY_PATTERNS) {
    for (const match of line.matchAll(shape.pattern)) {
      const text = match[0];
      matches.push({
        rule: 'provider-key',
        pattern: shape.label,
        start: match.index,
        end: match.index + text.length,
        text,
        detail: `${shape.description} \`${shape.label}\``,
      });
    }
  }
  return matches;
}

/**
 * `jwt`: a three-segment JSON Web Token.
 *
 * @param {string} line
 * @returns {RuleMatch[]}
 */
function matchJwts(line) {
  /** @type {RuleMatch[]} */
  const matches = [];
  for (const match of line.matchAll(JWT_PATTERN)) {
    const text = match[0];
    matches.push({
      rule: 'jwt',
      pattern: '',
      start: match.index,
      end: match.index + text.length,
      text,
      detail: 'JSON Web Token shaped string',
    });
  }
  return matches;
}

/**
 * `private-key`: a PEM private-key header.
 *
 * @param {string} line
 * @returns {RuleMatch[]}
 */
function matchPrivateKeys(line) {
  /** @type {RuleMatch[]} */
  const matches = [];
  for (const match of line.matchAll(PRIVATE_KEY_PATTERN)) {
    const text = match[0];
    matches.push({
      rule: 'private-key',
      pattern: text.replace(PEM_PREFIX_PATTERN, ''),
      start: match.index,
      end: match.index + text.length,
      text,
      detail: `PEM private-key header (${text.replace(PEM_PREFIX_PATTERN, '')})`,
    });
  }
  return matches;
}

/**
 * `connection-string`: a URI with an embedded user and password.
 *
 * @param {string} line
 * @returns {RuleMatch[]}
 */
function matchConnectionStrings(line) {
  /** @type {RuleMatch[]} */
  const matches = [];
  for (const match of line.matchAll(CONNECTION_STRING_PATTERN)) {
    const text = match[0];
    const scheme = text.slice(0, text.indexOf(':'));
    matches.push({
      rule: 'connection-string',
      pattern: scheme,
      start: match.index,
      end: match.index + text.length,
      text,
      detail: `${scheme} URI with an embedded user and password`,
    });
  }
  return matches;
}

/**
 * `entropy`: a long, dense value bound to a key-like name.
 *
 * Three exclusions keep the rule quiet on content this repository legitimately commits:
 *
 *   * `pnpm-lock.yaml` is exempt from this rule alone (see {@link ENTROPY_EXEMPT_FILES}).
 *   * A value that continues a URI (`scheme://<here>`) is a host and path, not a credential; a
 *     credentialed URI is `connection-string`'s business.
 *   * A git object name in a workflow is how actions are pinned (AAP 0.3.2). Hexadecimal cannot
 *     exceed 4 bits per character anyway, so this is belt and braces rather than the load-bearing
 *     guard.
 *
 * @param {string} relPath Repository-relative POSIX path.
 * @param {string} line
 * @returns {RuleMatch[]}
 */
function matchEntropy(relPath, line) {
  /** @type {RuleMatch[]} */
  const matches = [];
  if (ENTROPY_EXEMPT_FILES.includes(relPath)) {
    return matches;
  }
  const inWorkflow = relPath.startsWith(WORKFLOW_PATH_PREFIX);
  for (const match of line.matchAll(ENTROPY_CANDIDATE_PATTERN)) {
    const text = match[0];
    const before = line.slice(0, match.index);
    if (before.endsWith('://')) {
      continue;
    }
    if (inWorkflow && GIT_SHA_PATTERN.test(text)) {
      continue;
    }
    const name = nearestAssignedName(before);
    if (!isKeyLikeName(name)) {
      continue;
    }
    const bits = shannonEntropy(text);
    if (bits <= ENTROPY_MIN_BITS_PER_CHAR) {
      continue;
    }
    matches.push({
      rule: 'entropy',
      pattern: name,
      start: match.index,
      end: match.index + text.length,
      text,
      detail:
        `value of ${text.length} characters at ${bits.toFixed(2)} bits/char assigned to ` +
        `the key-like name \`${name}\``,
    });
  }
  return matches;
}

/* ---------------------------------------------------------------------------
 * Findings
 * ------------------------------------------------------------------------ */

/**
 * How a developer clears each rule. Every finding carries one, because a gate that says only "no"
 * gets worked around instead of fixed.
 *
 * @type {Readonly<Record<string, string>>}
 */
const HINTS = Object.freeze({
  'env-file':
    'untrack it with `git rm --cached <file>` and keep its values in a local .env; /.gitignore ' +
    'ignores .env* and re-includes only the two required example files',
  'provider-key':
    'revoke the credential at the provider, then read it from the environment (for example ' +
    'ANTHROPIC_API_KEY in an untracked .env) instead of committing it',
  jwt:
    'revoke the token and keep tokens out of tracked files; the local service stores its own ' +
    'credentials in $DEBUGGEN_HOME/auth.json, outside every checkout',
  'private-key':
    'remove the key from the index with `git rm --cached <file>` and keep key material outside ' +
    'the repository',
  entropy:
    'move the value into an untracked .env file or $DEBUGGEN_HOME/auth.json; if it is a ' +
    `non-secret placeholder the repository must commit, add it to ${ALLOWLIST_HINT_PATH} with a ` +
    'written justification and the exact paths where it is allowed',
  'connection-string':
    'commit a credential-free URL and take the password from the environment; if it is a required ' +
    `development placeholder, add it to ${ALLOWLIST_HINT_PATH} with a written justification and ` +
    'the exact paths where it is allowed',
});

/**
 * One rule violation.
 *
 * @typedef {object} Finding
 * @property {string} file Repository-relative POSIX path.
 * @property {number} line 1-based line number.
 * @property {number} column 1-based column of the match (1 for `env-file`).
 * @property {string} rule Rule id, one of {@link RULE_IDS}.
 * @property {string} pattern Sub-pattern label: the credential prefix, PEM label, URI scheme or
 *   key-like name that identified the match. `''` when the rule has a single shape.
 * @property {string} message What was found. Never contains the matched value in full.
 * @property {string} hint How to clear the finding.
 * @property {string} preview First few characters of the matched value plus its length; `''` when
 *   the rule matched on a path rather than on content.
 */

/**
 * A finding an allowlist entry exempted.
 *
 * @typedef {Finding & { allowlistValue: string }} AllowlistedFinding
 */

/**
 * Build the finding for a content match.
 *
 * @param {string} relPath
 * @param {number} lineNumber 1-based.
 * @param {RuleMatch} match
 * @returns {Finding}
 */
function contentFinding(relPath, lineNumber, match) {
  return {
    file: relPath,
    line: lineNumber,
    column: match.start + 1,
    rule: match.rule,
    pattern: match.pattern,
    message: `${match.detail} (${preview(match.text)})`,
    hint: HINTS[match.rule] ?? '',
    preview: preview(match.text),
  };
}

/**
 * Apply the rules that depend on the path alone, which is `env-file`.
 *
 * Kept separate from {@link scanContent} so the gate still reports a tracked `.env` file whose
 * content it deliberately did not read - a binary, oversized or deleted-but-tracked file.
 *
 * @param {string} filePath Repository-relative path.
 * @returns {Finding[]}
 */
export function scanPath(filePath) {
  const relPath = normalizeRepoPath(filePath);
  if (!isEnvFileViolation(relPath)) {
    return [];
  }
  return [
    {
      file: relPath,
      line: 1,
      column: 1,
      rule: 'env-file',
      pattern: baseName(relPath),
      message:
        'tracked environment file; environment files hold credentials and only ' +
        `${ALLOWED_ENV_FILES.join(' and ')} may be committed`,
      hint: HINTS['env-file'],
      preview: '',
    },
  ];
}

/**
 * Scan one file's path and content against every rule, separating the findings the allowlist
 * exempted so a caller can report how many exemptions were used.
 *
 * @param {string} filePath Repository-relative path, used in every finding.
 * @param {string} content File content as text.
 * @param {unknown} [allowlist] Validated allowlist, the parsed allowlist file, or nothing (in
 *   which case no literal is exempt).
 * @returns {{ findings: Finding[], allowlisted: AllowlistedFinding[] }}
 * @throws {CheckSecretsError} With code `allowlist-invalid` when `allowlist` is malformed.
 */
export function scanContentWithSuppressions(filePath, content, allowlist) {
  const relPath = normalizeRepoPath(filePath);
  const list = resolveAllowlist(allowlist);
  /** @type {Finding[]} */
  const findings = scanPath(relPath);
  /** @type {AllowlistedFinding[]} */
  const allowlisted = [];
  const text = typeof content === 'string' ? content : String(content ?? '');
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (line === '') {
      continue;
    }
    // Rule order is precedence order: the structural rules run before the entropy heuristic, so a
    // credential inside a URI is reported once, as the connection string a reviewer can act on.
    const matches = dedupeOverlaps([
      ...matchProviderKeys(line),
      ...matchJwts(line),
      ...matchPrivateKeys(line),
      ...matchConnectionStrings(line),
      ...matchEntropy(relPath, line),
    ]).sort((left, right) => left.start - right.start);
    if (matches.length === 0) {
      continue;
    }
    const occurrences = allowlistOccurrences(list, relPath, line);
    for (const match of matches) {
      const finding = contentFinding(relPath, index + 1, match);
      const allowlistValue = occurrences.length === 0 ? null : suppressionFor(occurrences, match);
      if (allowlistValue === null) {
        findings.push(finding);
      } else {
        allowlisted.push({ ...finding, allowlistValue });
      }
    }
  }
  return { findings, allowlisted };
}

/**
 * Every finding in one file, with allowlisted matches already removed.
 *
 * This is the seam the script's own tests drive: it needs neither git nor a checkout, and the
 * allowlist is an argument rather than a hidden dependency.
 *
 * @param {string} filePath Repository-relative path, used in every finding.
 * @param {string} content File content as text.
 * @param {unknown} [allowlist] Validated allowlist, the parsed allowlist file, or nothing.
 * @returns {Finding[]} Findings in line then column order.
 * @throws {CheckSecretsError} With code `allowlist-invalid` when `allowlist` is malformed.
 */
export function scanContent(filePath, content, allowlist) {
  return scanContentWithSuppressions(filePath, content, allowlist).findings;
}

/* ---------------------------------------------------------------------------
 * Repository enumeration
 * ------------------------------------------------------------------------ */

/**
 * Run git synchronously and return its stdout. Spawning the binary is deliberate: the check must
 * never read the contents of `.git/`, which on this repository holds an access token in its
 * `origin` URL (AAP 0.2.1).
 *
 * @param {string} cwd Directory to run git in.
 * @param {readonly string[]} args Arguments, already split.
 * @returns {string} Captured stdout, decoded as UTF-8.
 * @throws {CheckSecretsError} With code `git-missing` or `git-failed`.
 */
function git(cwd, args) {
  try {
    return execFileSync('git', [...args], {
      cwd,
      encoding: 'utf8',
      maxBuffer: GIT_MAX_BUFFER,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    if (/** @type {{ code?: string }} */ (error).code === 'ENOENT') {
      throw new CheckSecretsError(
        'git-missing',
        'the `git` executable was not found on PATH; this check enumerates tracked files with git',
        { cause: error instanceof Error ? error : undefined },
      );
    }
    const raw = /** @type {{ stderr?: unknown }} */ (error).stderr;
    const stderr = typeof raw === 'string' ? raw.trim() : '';
    throw new CheckSecretsError(
      'git-failed',
      `\`git ${args.join(' ')}\` failed in ${cwd}${stderr === '' ? '' : `: ${stderr}`}`,
      { cause: error instanceof Error ? error : undefined },
    );
  }
}

/**
 * Resolve the git work-tree root that contains `hint`. A subdirectory is fine: git reports the top
 * level either way, which is what lets the check run from any current directory and still anchor
 * every reported path to the repository root.
 *
 * @param {string} hint Absolute or cwd-relative path inside a checkout.
 * @returns {string} Absolute path of the work-tree root.
 * @throws {CheckSecretsError} With code `root-missing`, `not-a-repository` or `git-missing`.
 */
function resolveRepoRoot(hint) {
  const start = path.resolve(typeof hint === 'string' && hint.trim() !== '' ? hint : '.');
  let stats;
  try {
    stats = lstatSync(start);
  } catch (error) {
    throw new CheckSecretsError('root-missing', `path does not exist: ${start}`, {
      cause: error instanceof Error ? error : undefined,
    });
  }
  const directory = stats.isDirectory() ? start : path.dirname(start);
  const notARepository =
    `${directory} is not inside a git work tree; ` +
    'run this check from a checkout of the repository';
  let topLevel;
  try {
    topLevel = git(directory, ['rev-parse', '--show-toplevel']).trim();
  } catch (error) {
    if (error instanceof CheckSecretsError && error.code === 'git-missing') {
      throw error;
    }
    throw new CheckSecretsError('not-a-repository', notARepository, {
      cause: error instanceof Error ? error : undefined,
    });
  }
  if (topLevel === '') {
    throw new CheckSecretsError('not-a-repository', notARepository);
  }
  return path.resolve(topLevel);
}

/**
 * Every file git tracks, repository-relative.
 *
 * Tracked-only enumeration is the contract (AAP 0.3.4: the check "scans `git ls-files` content").
 * It keeps the gate deterministic - an untracked scratch file in one developer's tree cannot fail
 * the build - and it is the reason nothing under `.git/` is ever opened, because `git ls-files`
 * does not list it. Do not add a filesystem-walk fallback.
 *
 * @param {string} repoRoot Absolute work-tree root.
 * @returns {string[]} Tracked paths, repository-relative POSIX.
 */
function listTrackedFiles(repoRoot) {
  return git(repoRoot, ['ls-files', '-z'])
    .split('\0')
    .filter((entry) => entry !== '')
    .map((entry) => normalizeRepoPath(entry));
}

/**
 * Whether a path names a file type that never holds text.
 *
 * @param {string} relPath
 * @returns {boolean}
 */
function hasBinaryExtension(relPath) {
  const lower = relPath.toLowerCase();
  return BINARY_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

/**
 * Treat a file as binary when its first bytes contain a NUL, which is how tracked assets without a
 * known extension are skipped.
 *
 * @param {Buffer} buffer
 * @returns {boolean}
 */
function isBinary(buffer) {
  return buffer.subarray(0, BINARY_SNIFF_BYTES).includes(0);
}

/**
 * A tracked file the scan deliberately did not read.
 *
 * @typedef {object} SkippedFile
 * @property {string} file Repository-relative POSIX path.
 * @property {'binary'|'symlink'|'not-a-regular-file'|'too-large'|'missing'|'unreadable'} reason
 * @property {number} [bytes] Size, when it was known.
 */

/**
 * The report the command line prints and `--json` serializes.
 *
 * @typedef {object} CheckReport
 * @property {boolean} ok No findings.
 * @property {number} exitCode {@link EXIT_OK} or {@link EXIT_FINDINGS}.
 * @property {string} repoRoot Absolute work-tree root that was scanned.
 * @property {string} allowlistPath Absolute path of the allowlist that was applied.
 * @property {readonly string[]} rules Rule ids that were enforced.
 * @property {number} filesTracked Files git tracks.
 * @property {number} filesScanned Files whose content was read and scanned.
 * @property {Finding[]} findings Violations, in file then line then column order.
 * @property {AllowlistedFinding[]} allowlisted Matches an allowlist entry exempted.
 * @property {SkippedFile[]} skipped Files whose content was deliberately not read.
 */

/**
 * Scan a checkout: enumerate tracked files, apply every rule, and return the report.
 *
 * @param {{ cwd?: string, root?: string, allowlist?: unknown, allowlistPath?: string }} [options]
 *   `cwd` (or its alias `root`) is any path inside the checkout to scan; it defaults to this
 *   script's own directory, so the command line behaves identically from any current directory.
 *   In-process callers pass a throwaway repository here. `allowlist` supplies a validated or parsed
 *   allowlist instead of reading one; `allowlistPath` reads a different file.
 * @returns {CheckReport}
 * @throws {CheckSecretsError} When the scan cannot be performed.
 */
export function scanRepository(options = {}) {
  const repoRoot = resolveRepoRoot(options.cwd ?? options.root ?? SCRIPT_DIRECTORY);
  const allowlistPath = path.resolve(options.allowlistPath ?? DEFAULT_ALLOWLIST_PATH);
  const allowlist =
    options.allowlist === undefined || options.allowlist === null
      ? loadAllowlist(allowlistPath)
      : resolveAllowlist(options.allowlist);

  const files = listTrackedFiles(repoRoot);
  /** @type {Finding[]} */
  const findings = [];
  /** @type {AllowlistedFinding[]} */
  const allowlisted = [];
  /** @type {SkippedFile[]} */
  const skipped = [];
  let filesScanned = 0;

  for (const relPath of files) {
    const absolute = path.join(repoRoot, relPath);
    // The path rules apply to every tracked file, including the ones whose content is skipped
    // below: a tracked `.env` is a finding whether or not it is readable text.
    const pathFindings = scanPath(relPath);

    /** @type {SkippedFile | null} */
    let skip = null;
    /** @type {Buffer | null} */
    let buffer = null;
    let stats;
    try {
      stats = lstatSync(absolute);
    } catch {
      // Tracked but absent from the work tree: staged deletion, or a sparse checkout.
      skip = { file: relPath, reason: 'missing' };
      stats = null;
    }
    if (stats !== null) {
      if (stats.isSymbolicLink()) {
        skip = { file: relPath, reason: 'symlink' };
      } else if (!stats.isFile()) {
        // A gitlink (submodule) or another non-regular entry: there is no content here to read.
        skip = { file: relPath, reason: 'not-a-regular-file' };
      } else if (hasBinaryExtension(relPath)) {
        skip = { file: relPath, reason: 'binary', bytes: stats.size };
      } else if (stats.size > MAX_SCAN_BYTES) {
        // Reported rather than fatal: an oversized tracked file is a repository-hygiene problem of
        // its own, and failing the secrets gate for it would only obscure that.
        skip = { file: relPath, reason: 'too-large', bytes: stats.size };
      } else {
        try {
          buffer = readFileSync(absolute);
        } catch {
          skip = { file: relPath, reason: 'unreadable', bytes: stats.size };
        }
      }
    }
    if (buffer !== null && isBinary(buffer)) {
      skip = { file: relPath, reason: 'binary', bytes: buffer.length };
      buffer = null;
    }

    if (buffer === null) {
      findings.push(...pathFindings);
      if (skip !== null) {
        skipped.push(skip);
      }
      continue;
    }

    filesScanned += 1;
    const result = scanContentWithSuppressions(relPath, buffer.toString('utf8'), allowlist);
    findings.push(...result.findings);
    allowlisted.push(...result.allowlisted);
  }

  const ok = findings.length === 0;
  return {
    ok,
    exitCode: ok ? EXIT_OK : EXIT_FINDINGS,
    repoRoot,
    allowlistPath,
    rules: RULE_IDS,
    filesTracked: files.length,
    filesScanned,
    findings,
    allowlisted,
    skipped,
  };
}

/* ---------------------------------------------------------------------------
 * Reporting
 * ------------------------------------------------------------------------ */

/**
 * @param {number} count
 * @param {string} singular
 * @returns {string}
 */
function plural(count, singular) {
  return count === 1 ? singular : `${singular}s`;
}

/**
 * Why the findings matter and what to do about them, printed once after the list.
 *
 * @returns {string[]}
 */
function findingsExplanation() {
  return [
    'A tracked file must not contain a credential. Revoke anything real that appears above:',
    'deleting it from the working tree does not delete it from the history that has it.',
    'Keep secrets in an untracked .env file or under $DEBUGGEN_HOME, and reserve',
    `${ALLOWLIST_HINT_PATH} - with a written justification and an exact path list - for the`,
    'few non-secret placeholders this repository has to commit.',
  ];
}

/**
 * Render the human-readable report: findings first, summary last.
 *
 * @param {CheckReport} report
 * @returns {string} Text ending in a newline.
 */
function renderReport(report) {
  /** @type {string[]} */
  const lines = [];

  for (const finding of report.findings) {
    lines.push(`${finding.file}:${finding.line}: ${finding.rule}: ${finding.message}`);
    if (finding.hint !== '') {
      lines.push(`    hint: ${finding.hint}`);
    }
  }
  if (report.findings.length > 0) {
    lines.push('', ...findingsExplanation(), '');
  }

  if (report.filesTracked === 0) {
    lines.push(
      'check-secrets: warning: git tracks no files here, so the scan had nothing to check.',
    );
  }

  const parts = [
    `${report.filesScanned} ${plural(report.filesScanned, 'file')} scanned`,
    `${report.findings.length} ${plural(report.findings.length, 'finding')}`,
    `${report.allowlisted.length} allowlisted`,
  ];
  if (report.skipped.length > 0) {
    parts.push(`${report.skipped.length} skipped (binary, symlink, oversized or absent)`);
  }
  lines.push(`check-secrets: ${parts.join(', ')}`);

  return `${lines.join('\n')}\n`;
}

/**
 * @returns {string} The `--help` text, without a trailing newline.
 */
function helpText() {
  return [
    'Usage: node scripts/check-secrets.mjs [options]',
    '',
    'Fails when a file git tracks carries a credential. Every tracked file is read (binary,',
    'oversized and non-regular files are skipped and reported) and checked against these rules:',
    '',
    ...RULES.map((rule) => `  ${rule.id.padEnd(18)} ${rule.summary}`),
    '',
    `The two example files ${ALLOWED_ENV_FILES.join(' and ')} are the only`,
    'environment files that may be tracked. The non-secret placeholders this repository has to',
    `commit are exempted by the reviewed allowlist ${ALLOWLIST_HINT_PATH},`,
    'which grants each literal only at the exact paths it lists. There is no inline suppression',
    'comment.',
    '',
    'Options:',
    '  --json      print a machine-readable report on stdout instead of text.',
    '  -h, --help  print this help and exit 0.',
    '',
    'Exit codes:',
    '  0  no findings',
    '  1  at least one finding',
    '  2  the check could not run: unknown option, git unavailable, not a git repository, or a',
    '     missing or malformed allowlist',
    '',
    'The check only reads: it writes nothing to disk and never opens anything inside .git/, whose',
    'config holds this repository\u2019s remote access token. Findings name the file and line, and',
    `print at most the first ${String(PREVIEW_PREFIX_LENGTH)} characters of a matched value plus ` +
      'its length, because CI logs are public.',
    '',
    'It scans the checkout this script belongs to, whatever the current directory. In-process',
    'callers (scripts/check-secrets.test.mjs) import scanContent, isEnvFileViolation and',
    'shannonEntropy for rule coverage, and pass { cwd } to main() or scanRepository() to scan a',
    'different checkout.',
  ].join('\n');
}

/* ---------------------------------------------------------------------------
 * Command line
 * ------------------------------------------------------------------------ */

/**
 * @typedef {object} CliOptions
 * @property {boolean} help
 * @property {boolean} json
 */

/**
 * @param {readonly string[]} argv Arguments after the script path.
 * @returns {CliOptions}
 * @throws {CheckSecretsError} With code `usage` for anything but `--json`, `--help` and `-h`.
 */
function parseArgs(argv) {
  /** @type {CliOptions} */
  const options = { help: false, json: false };
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg.startsWith('-')) {
      throw usageError(`unknown option: ${arg}`);
    } else {
      throw usageError(
        `unexpected argument: ${arg}. This check takes no paths; it scans every tracked file.`,
      );
    }
  }
  return options;
}

/**
 * Run the check and return the process exit code.
 *
 * Nothing here calls `process.exit`, so in-process callers can assert on the returned code, and
 * output is written through `process.stdout` / `process.stderr` so a test can capture it.
 *
 * @param {readonly string[]} [argv] Arguments after the script path, as in `process.argv.slice(2)`.
 * @param {{ cwd?: string, root?: string, allowlist?: unknown, allowlistPath?: string }} [options]
 *   Scan a different checkout or supply a different allowlist; see {@link scanRepository}.
 * @returns {Promise<number>} 0 no findings, 1 findings, 2 usage or environment error.
 */
export async function main(argv = [], options = {}) {
  /** @type {CliOptions} */
  let cli;
  try {
    cli = parseArgs(Array.isArray(argv) ? argv : []);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`check-secrets: ${message}\n\n${helpText()}\n`);
    return EXIT_ERROR;
  }

  if (cli.help) {
    process.stdout.write(`${helpText()}\n`);
    return EXIT_OK;
  }

  try {
    const report = scanRepository(options);
    process.stdout.write(cli.json ? `${JSON.stringify(report, null, 2)}\n` : renderReport(report));
    return report.exitCode;
  } catch (error) {
    const code = error instanceof CheckSecretsError ? error.code : 'internal-error';
    const message = error instanceof Error ? error.message : String(error);
    if (cli.json) {
      process.stdout.write(
        `${JSON.stringify({ ok: false, exitCode: EXIT_ERROR, error: { code, message } }, null, 2)}\n`,
      );
    }
    process.stderr.write(`check-secrets: ${code}: ${message}\n`);
    return EXIT_ERROR;
  }
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(invokedPath)).href
) {
  process.exitCode = await main(process.argv.slice(2));
}
