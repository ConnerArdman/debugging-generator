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
 *   entropy            a long, dense value bound to a key-like name. The value is measured over
 *                      its complete contents - a quoted string in full, an unquoted assignment up
 *                      to its delimiter - so punctuation in a password does not hide it, and a
 *                      dense run with no assignment operator is measured too. This rule is
 *                      deliberately *bound*: a high-entropy string on its own (a hash, a build id,
 *                      a base64 asset) is not a finding, because a bare entropy scan produces so
 *                      much noise that the gate stops being trusted.
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
 * THE ALLOWLIST IS EXACT. A match is exempt only when its whole span lies inside an occurrence of
 * an allowlisted literal at a path that literal lists, and the allowlist is consulted before
 * overlapping matches are deduplicated. A longer value that merely contains the literal - the
 * database URL with `?password=...`, `;password=...`, a path suffix, a fragment or a scheme prefix
 * appended - is a different, longer match, and it is reported. The literal must also be the whole
 * value on its line: an occurrence followed by anything other than closing punctuation before
 * whitespace, a quote, a backtick or the end of the line (`<url>)password=...`) exempts nothing.
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
 * IT FAILS CLOSED. Every condition that leaves the check unable to inspect the repository is an
 * error (exit 2), never a quiet pass: git missing, the directory not being a checkout, a missing
 * or malformed allowlist, and - the one that looks like success - git tracking no files at all. A
 * gate that returns 0 having read nothing proves nothing, so an empty tracked subject is a
 * precondition failure raised where enumeration happens, which makes it fail for in-process
 * callers and for the command line alike.
 *
 * The same holds file by file. Every tracked file is scanned: one larger than 2 MiB is streamed
 * in chunks rather than skipped, and a tracked symbolic link is scanned as its target text - the
 * string git stores for it - without ever being followed. Only two kinds of entry are skipped,
 * both because there is no text here to read: a positively identified binary (its extension and
 * its leading bytes agree on a known format) and a submodule (gitlink). A tracked file the check
 * cannot examine - absent from the work tree, replaced by an entry of another type than the index
 * records (a directory, a symbolic link where git tracks a regular file, or a symbolic link in
 * place of one of its directories), or unreadable - is reported as `unscanned` with the command
 * that fixes it, and the run exits 2: a gate that passed over it would be certifying content it
 * never saw.
 *
 * Usage:  node scripts/check-secrets.mjs [--json] [--help]
 * Exits:  0 clean | 1 findings | 2 usage or environment error (unknown option, git unavailable,
 *         not a git repository, no tracked files, missing or malformed allowlist) or a tracked
 *         file that could not be examined.
 *
 * The check only reads: it writes nothing to disk, and it prints at most the first four characters
 * of a matched value plus its length, because CI logs are public.
 *
 * In-process callers (`scripts/check-secrets.test.mjs`) use the exported helpers -
 * {@link scanContent}, {@link isEnvFileViolation}, {@link shannonEntropy} - which need neither git
 * nor a checkout. {@link main} and {@link scanRepository} accept `{ cwd }` to scan a different
 * checkout, which is how the end-to-end cases drive a throwaway repository.
 */

import { Buffer } from 'node:buffer';
import { execFileSync } from 'node:child_process';
import {
  closeSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  readlinkSync,
  realpathSync,
} from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';

/* ---------------------------------------------------------------------------
 * Contract constants
 * ------------------------------------------------------------------------ */

/** Exit code: no findings. */
export const EXIT_OK = 0;
/** Exit code: at least one finding. */
export const EXIT_FINDINGS = 1;
/** Exit code: the check could not be performed (usage, git, an empty subject, the allowlist). */
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

/**
 * Files larger than this are streamed in {@link STREAM_CHUNK_BYTES} chunks rather than read into
 * memory at once. Size decides how a file is read, never whether it is scanned.
 */
export const MAX_SCAN_BYTES = 2 * 1024 * 1024;

/**
 * Bytes read per chunk when a file larger than {@link MAX_SCAN_BYTES} is streamed. Exported so the
 * tests can place a multi-byte character across a chunk boundary.
 */
export const STREAM_CHUNK_BYTES = 1024 * 1024;

/** Index mode of a gitlink: a submodule commit, whose content lives in another repository. */
const GITLINK_MODE = '160000';

/** Index mode of a symbolic link, whose tracked content is the link's target text. */
const SYMLINK_MODE = '120000';

/** `git ls-files` on a large tree produces a lot of output; give it room. */
const GIT_MAX_BUFFER = 64 * 1024 * 1024;

/** Characters of a matched value that may be printed, before its length. */
const PREVIEW_PREFIX_LENGTH = 4;

/** Suffix marking a truncated preview (U+2026 HORIZONTAL ELLIPSIS). */
const PREVIEW_SUFFIX = '\u2026';

/**
 * The binary formats a tracked file may be skipped as: each format's extensions and the magic
 * signatures its files begin with.
 *
 * Skipping requires positive identification - the extension names the format AND the leading
 * bytes match one of its signatures. Either signal alone is what a committed credential could hide
 * behind: renaming `credentials.txt` to `credentials.png` changes nothing about its content, and a
 * stray NUL byte in an otherwise textual file does not make the rest of it unreadable. So a file
 * with a binary extension but no matching signature, or with NUL bytes but no known binary
 * extension, is scanned as text like every other file.
 *
 * @type {readonly { readonly format: string, readonly extensions: readonly string[],
 *   readonly signatures: readonly Buffer[] }[]}
 */
const BINARY_FORMATS = Object.freeze([
  binaryFormat('png', ['.png'], [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])]),
  binaryFormat('ico', ['.ico'], [Buffer.from([0x00, 0x00, 0x01, 0x00])]),
  binaryFormat('jpeg', ['.jpg', '.jpeg'], [Buffer.from([0xff, 0xd8, 0xff])]),
  binaryFormat('gif', ['.gif'], [Buffer.from('GIF87a', 'latin1'), Buffer.from('GIF89a', 'latin1')]),
  binaryFormat('pdf', ['.pdf'], [Buffer.from('%PDF-', 'latin1')]),
  binaryFormat('woff', ['.woff'], [Buffer.from('wOFF', 'latin1')]),
  binaryFormat('woff2', ['.woff2'], [Buffer.from('wOF2', 'latin1')]),
  binaryFormat('vsix', ['.vsix'], [Buffer.from([0x50, 0x4b, 0x03, 0x04])]),
]);

/**
 * One frozen entry of {@link BINARY_FORMATS}.
 *
 * @param {string} format Short format name, reported with the skipped file.
 * @param {readonly string[]} extensions Lower-case extensions, leading dot included.
 * @param {readonly Buffer[]} signatures Byte sequences a file of this format starts with.
 * @returns {{ readonly format: string, readonly extensions: readonly string[],
 *   readonly signatures: readonly Buffer[] }}
 */
function binaryFormat(format, extensions, signatures) {
  return Object.freeze({
    format,
    extensions: Object.freeze([...extensions]),
    signatures: Object.freeze([...signatures]),
  });
}

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
 * Characters that end a value outright where they follow an allowlisted literal: whitespace, a
 * double quote, a backtick and an angle bracket. None of them can appear unencoded inside a URI or
 * inside the unquoted value of an assignment, so whatever comes after one is a separate token, and
 * that token is judged by the rules on its own merits.
 */
const LITERAL_VALUE_BOUNDARY = /[\s"`<>]/;

/**
 * Closing punctuation that may stand between an allowlisted literal and the end of its value: the
 * brackets and single quote that wrap a value (`('<url>')`, `(<url>)`, `[<url>]`), the separators
 * that end a statement or list element (`;`, `,`) and the marks that end a sentence (`.`, `:`,
 * `!`, `?`).
 */
const LITERAL_CLOSING_PUNCTUATION = new Set([')', ']', '}', "'", ';', ',', '.', ':', '!', '?']);

/**
 * Whether the literal ending at `end` is the whole of its value on `line`: nothing but closing
 * punctuation lies between it and the end of the line or the next {@link LITERAL_VALUE_BOUNDARY}.
 *
 * This is the second half of the exact-value rule, and it exists because the connection-string
 * match ends where a URI embedded in prose or code conventionally ends - at `)`, `'` or `]` - while
 * RFC 3986 lets `)` and `'` continue a URI path. The extent of a match therefore cannot tell
 * `See [the database](<url>).` from `DATABASE_URL=<url>)password=<secret>`: in both the match stops
 * at the literal's last character. What follows the literal can. In the first, only closing
 * punctuation runs to the end of the line; in the second, `password=<secret>` continues the value
 * past the `)`, so the literal is a prefix of a longer value rather than the value itself, and
 * AAP 0.3.4 exempts the exact placeholder only.
 *
 * @param {string} line
 * @param {number} end Exclusive index of the literal's end in `line`.
 * @returns {boolean}
 */
function literalStandsAlone(line, end) {
  for (let index = end; index < line.length; index += 1) {
    const character = line.charAt(index);
    if (LITERAL_VALUE_BOUNDARY.test(character)) {
      return true;
    }
    if (!LITERAL_CLOSING_PUNCTUATION.has(character)) {
      return false;
    }
  }
  return true;
}

/**
 * Every occurrence, on `line`, of an allowlisted literal that is permitted at `relPath` and stands
 * alone as a whole value (see {@link literalStandsAlone}).
 *
 * An occurrence that continues into a longer value is left out rather than recorded: it exempts
 * nothing, so every match inside it is reported like any other credential.
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
      const end = index + literal.value.length;
      if (literalStandsAlone(line, end)) {
        occurrences.push({ value: literal.value, start: index, end });
      }
      index = line.indexOf(literal.value, index + 1);
    }
  }
  return occurrences;
}

/**
 * The allowlisted literal that exempts this match, or `null`.
 *
 * A match is exempt only when its whole span lies inside one occurrence of an allowlisted literal
 * on the same line: `occurrence.start <= match.start` and `match.end <= occurrence.end`. The
 * literal must therefore cover the entire matched value. The connection-string rule matches up to
 * the URI's terminator, so the development database URL is exempt only where it stands alone:
 * the same literal with anything appended or prepended - a `?password=` query, a `_prod` path
 * suffix, a `#` fragment carrying a second credentialed authority, an `evil+` scheme prefix - is a
 * longer match that extends past the literal and is reported like any other credential. Where the
 * match cannot extend - the literal followed by `)`, `'` or `]` and then more of the value, as in
 * `<url>)password=<secret>` - the occurrence itself is withheld by {@link allowlistOccurrences},
 * because the literal is not the whole value there either.
 *
 * A match that merely *contains* the literal is deliberately not exempt. That direction is what
 * let an allowlisted prefix launder whatever followed it, and AAP 0.3.4 exempts the exact
 * placeholder, not every value it is a substring of. A match that shares a line with an
 * allowlisted literal without lying inside it is a finding too.
 *
 * @param {readonly AllowlistOccurrence[]} occurrences
 * @param {{ start: number, end: number }} match
 * @returns {string | null}
 */
function suppressionFor(occurrences, match) {
  for (const occurrence of occurrences) {
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
 * Characters that always terminate a URI embedded in code, prose, JSON or YAML: whitespace, a
 * quote or backtick, a closing bracket and an angle bracket.
 *
 * `)` stays here although RFC 3986 lets it appear in a path, because in Markdown and prose a URI
 * is wrapped in parentheses far more often than it contains one, and the character after the `)`
 * is then ordinary text: `[database](<url>).` or `(see <url>)and`. Treated like `;` and `,`, that
 * `.` or letter would continue the match past the literal and report the exact placeholder in the
 * documentation that is required to carry it. `]` and `}` close the arrays and objects a URI is an
 * element of, for the same reason. The price is that a match cannot see a value continuing past
 * one of them (`<url>)password=<secret>`); the allowlist closes that gap separately, by exempting a
 * literal only where it is the whole value on its line (see {@link literalStandsAlone}).
 */
const URI_HARD_TERMINATORS = '\\s\'"`)\\]}<>';

/**
 * RFC 3986 sub-delimiters that end a URI only where nothing that can continue one follows them.
 *
 * `;` and `,` are legal inside a URI path - `<url>;password=<secret>` and
 * `<url>,<user>:<secret>@<host>` are each one URI, and not the allowlisted one - so treating them
 * as hard terminators would cut the match at the allowlisted literal's last character and exempt
 * everything after it. They are also how a statement, a list element or a clause ends:
 * `connect(<url>);`, `[<url>, <url>]`, `<url>, then`. The character after the run tells the two
 * readings apart: a run of them followed by whitespace, a quote, a hard terminator or the end of
 * the line ends the URI before the run, and a run followed by any other character continues it,
 * run included - so `;;password=` cannot hide behind a doubled delimiter either.
 */
const URI_SOFT_TERMINATORS = ';,';

/** Every character that can end a URI, hard or soft. */
const URI_TERMINATORS = URI_HARD_TERMINATORS + URI_SOFT_TERMINATORS;

/** One character that continues a URI unconditionally: anything that is not a terminator. */
const URI_BODY_CHAR = '[^' + URI_TERMINATORS + ']';

/**
 * The part of a connection string after its `@`: host, port, path, query and fragment, up to the
 * URI's terminator. The match deliberately runs past the `@` to the end of the URI: the
 * allowlisted development database URL includes its host, port and database name, so a match that
 * stopped at the credential could never be compared against it.
 *
 * Backtracking stays linear. The two alternatives start with disjoint characters (a body character
 * is never a sub-delimiter), so each position is consumed one way only; a sub-delimiter run gives
 * back at most its own length when the lookahead rejects it; and nothing follows the repetition,
 * so a shorter tail is never retried against a later token.
 */
const URI_TAIL =
  '(?:' + URI_BODY_CHAR + '|[' + URI_SOFT_TERMINATORS + ']+(?=' + URI_BODY_CHAR + '))*';

/** A URI carrying `user:password@`, with its authority and path captured for comparison. */
const CONNECTION_STRING_PATTERN = new RegExp(
  '\\b[a-z][a-z0-9+.-]*' + ':\\/\\/' + '[^/\\s:@]+' + ':' + '[^/\\s:@]+' + '@' + URI_TAIL,
  'gi',
);

/**
 * A contiguous dense run long enough for the `entropy` rule to measure. This is the second of the
 * rule's two candidate sources: the first is the complete assigned value (see
 * {@link assignedValues}), and this one is what still covers the syntaxes that have no assignment
 * operator at all - `--auth-token <run>`, `Authorization: Bearer <run>` - and dense runs embedded
 * in a larger value.
 *
 * The alphabet is deliberately narrow, which is exactly why it cannot be the only source: a
 * punctuated value is split into sub-runs shorter than {@link ENTROPY_MIN_LENGTH} and would never
 * be measured. The complete-value pass exists for that case and measures the value whatever
 * characters it contains.
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

/** Quote characters that make an assigned value a complete string literal. */
const VALUE_QUOTES = new Set(['"', "'", '`']);

/**
 * What ends an unquoted assigned value: whitespace, a quote, a list separator, or an angle bracket.
 *
 * Notably *not* `=` or `:`. The name is read leftwards from the value's first character, so by the
 * time a value begins its operator has already been consumed, and a further `=` or `:` inside the
 * run belongs to the value: `API_KEY=YWJjZGVm==` keeps its base64 padding, `TOKEN=v1:abc:def`
 * keeps its segments, and `SECRET=a=b` keeps both halves. Terminating on them, as the dense-run
 * alphabet must, is what truncates such a value to something shorter than the rule can measure.
 *
 * `<` and `>` do terminate it, because no value spans one: in TypeScript they delimit a type
 * argument, so `const token: ReadonlyArray<CredentialDescriptor> = …` would otherwise offer the
 * type `ReadonlyArray<CredentialDescriptor>` as a 35-character dense value bound to `token`, and in
 * shell syntax they are redirections. A *quoted* value keeps them, so a password containing an
 * angle bracket is still measured in full.
 */
const UNQUOTED_VALUE_TERMINATOR = /[\s"'`,;<>]/;

/**
 * Characters that, immediately before a `=` or `:`, mark it as something other than an assignment:
 * a compound assignment (`+=`), a comparison (`!=`, `<=`), a ternary (`?:`) or a namespace
 * separator (`::`). The `=>` / `==` / `===` / `::` forms are rejected by looking at the *next*
 * character as well, so both halves of a two-character operator are covered.
 */
const NON_ASSIGNMENT_PREFIXES = new Set([...'=!<>+-*/%&|^?~:']);

/**
 * An interpolated (`${...}`) or command-substituted (`$(...)`) string. What such a value holds is
 * computed when the file runs, so the committed text is a template and not key material.
 */
const INTERPOLATED_VALUE_PATTERN = /\$[{(]/;

/**
 * A value that is a URI: a location rather than key material. A URI that does carry a credential
 * is `connection-string`'s business, which reports it with the scheme a reviewer needs.
 */
const URI_VALUE_PATTERN = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;

/**
 * An *unquoted* value that begins with `/`: a regular-expression literal or a filesystem path,
 * neither of which is key material. The pattern case is why this is needed at all, because such a
 * literal need not be closed by the time the extraction stops:
 * `/-{5}BEGIN\s?(DSA|RSA)?\s?PRIVATE KEY/gm` bound to a key-like name is cut at the space before
 * `KEY`, leaving a 48-character fragment at 4.47 bits per character whose brackets balance and
 * which no anchored literal test recognises.
 *
 * Quoting is the line this exclusion stops at, and deliberately so: quotes delimit a literal, so
 * `password = "/Ab!9cD@…"` is a credential that happens to start with a slash and is measured in
 * full, while a quoted pattern is still recognised by {@link REGEX_LITERAL_VALUE_PATTERN}.
 */
const PATH_OR_PATTERN_VALUE_PATTERN = /^\//;

/** A regular-expression literal with optional flags, which is a pattern and not a credential. */
const REGEX_LITERAL_VALUE_PATTERN = /^\/.+\/[a-z]*$/;

/**
 * A value containing whitespace, which a quoted value can and an unquoted value cannot: prose. A
 * credential is issued as one unbroken token, whereas a quoted string with spaces is a sentence -
 * a documented example such as ``API_TOKEN=`This has 'single' and "double" quotes inside` ``, a
 * message, or a description. Such sentences sit right at the threshold (English prose measures
 * about 4 bits per character), so admitting them would put the gate's noise floor in documentation
 * while adding no credential class the dense-run pass, which never admitted whitespace either,
 * could see.
 */
const PROSE_VALUE_PATTERN = /\s/;

/**
 * An identifier followed by one or more member, call or index groups, anchored to the whole value:
 * `process.env.DEBUGGEN_SERVER_AGENT_TOKEN`, `normalizeSqlStatement(fixture.sql)`,
 * `credentials[activeProfile]`, `credential.tokenType?.toLowerCase()`. These are expressions that
 * *read* a value, not the value itself. Nested groups are collapsed before the test (see
 * {@link collapseGroups}), so a call whose argument is itself a call -
 * `this.generateAccountKey(AccountEntityUtils.getAccountInfo(account))` - is recognised too.
 *
 * The separators admit optional chaining (`?.`) and the non-null assertion (`!`), because
 * TypeScript writes a nullable credential lookup that way and the whole point of the pattern is to
 * recognise a lookup: `const tokenType = credential.tokenType?.toLowerCase();` is 35 characters at
 * over 4 bits per character bound to a key-like name, so without them it reads as key material.
 *
 * At least one group is required, so a bare identifier is *not* excluded: an unquoted
 * `API_KEY=AbCdEfGh…` value has exactly the shape of an identifier, and that is the commonest
 * credential form there is.
 */
const MEMBER_EXPRESSION_PATTERN =
  /^[A-Za-z_$][A-Za-z0-9_$]*(?:(?:\?\.|!\.|\.)[A-Za-z_$][A-Za-z0-9_$]*|(?:\?\.)?\([^()]*\)|(?:\?\.)?\[[^[\]]*\]|!)+$/;

/** How many levels of nesting {@link collapseGroups} flattens before it gives up. */
const MAX_GROUP_COLLAPSE_PASSES = 8;

/**
 * Bracket pairs whose balance decides whether an unquoted run is a complete value or a fragment
 * cut out of a larger expression.
 *
 * @type {readonly (readonly [string, string])[]}
 */
const BRACKET_PAIRS = Object.freeze([
  Object.freeze(/** @type {[string, string]} */ (['(', ')'])),
  Object.freeze(/** @type {[string, string]} */ (['[', ']'])),
  Object.freeze(/** @type {[string, string]} */ (['{', '}'])),
]);

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

/**
 * How much of the text before a value the name lookup reads.
 *
 * {@link nearestAssignedName} only ever inspects the tail of what it is given - quoting and
 * whitespace, then one identifier - so handing it the whole prefix of the line is wasted work, and
 * on a long line it is quadratic work: one copy of the prefix per assignment site. Measured on a
 * 50 000-character line of `NAME=value` pairs, the unbounded lookup cost 693 ms against 11 ms
 * through this window, and that gap widens with the square of the length, which is how a gate
 * inside `pnpm verify` would come to stall on a committed minified bundle. 256 characters is far
 * more than any name plus its padding, and a name longer than that is reported truncated rather
 * than missed.
 */
const NAME_LOOKBEHIND = 256;

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
 * The text immediately before `index` on `line`, bounded to {@link NAME_LOOKBEHIND} characters:
 * what the name lookup and the URI-authority guard read. Both look only at the tail, so the bound
 * changes nothing they decide and keeps the entropy rule linear on a long line.
 *
 * @param {string} line
 * @param {number} index Exclusive end of the window.
 * @returns {string}
 */
function lookbehind(line, index) {
  return line.slice(index > NAME_LOOKBEHIND ? index - NAME_LOOKBEHIND : 0, index);
}

/**
 * Index of the quote that closes a literal opened at `from`, or `-1` when the line does not close
 * it.
 *
 * A backslash escapes the character after it, so `\"` inside a double-quoted literal is part of
 * the value rather than its end. Scanning for the delimiter without that rule cuts
 * `password = "Ab!\"cD@…"` at the escaped quote and measures a fragment - which is the whole
 * failure this rule exists to avoid, in a different disguise.
 *
 * @param {string} line
 * @param {string} quote The opening delimiter: `"`, `'` or a backtick.
 * @param {number} from Index of the literal's first content character.
 * @returns {number} Index of the closing delimiter, or `-1`.
 */
function closingQuote(line, quote, from) {
  for (let index = from; index < line.length; index += 1) {
    const character = line.charAt(index);
    if (character === '\\') {
      index += 1;
      continue;
    }
    if (character === quote) {
      return index;
    }
  }
  return -1;
}

/**
 * One complete value an assignment on the line binds to a name.
 *
 * @typedef {object} AssignedValue
 * @property {string} name The name the value is bound to, or `''` when there is none.
 * @property {string} value The value in full, quotes stripped, punctuation and all.
 * @property {number} start Inclusive index of the value's first character in the line.
 * @property {number} end Exclusive index just past the value's last character in the line.
 * @property {boolean} quoted Whether the value was delimited by quotes, and therefore complete by
 *   construction rather than cut at the first delimiter.
 */

/**
 * Whether every bracket in `value` is closed, and none closes before it opens.
 *
 * An unquoted value stops at the first delimiter, so `readCredential(configuration` is all that is
 * left of `readCredential(configuration, fallbackProfile)` once the run is cut at the comma:
 * unbalanced brackets are the signal that the run is a fragment of a larger expression rather than
 * a value in its own right.
 *
 * @param {string} value
 * @returns {boolean}
 */
function hasBalancedBrackets(value) {
  for (const [open, close] of BRACKET_PAIRS) {
    let depth = 0;
    for (let index = 0; index < value.length; index += 1) {
      const character = value.charAt(index);
      if (character === open) {
        depth += 1;
      } else if (character === close) {
        depth -= 1;
        if (depth < 0) {
          return false;
        }
      }
    }
    if (depth !== 0) {
      return false;
    }
  }
  return true;
}

/**
 * Every complete assigned or quoted value on `line`, with the name each is bound to.
 *
 * This is the `entropy` rule's first candidate source, and the reason a punctuated credential is
 * measurable at all: the dense-run pattern ({@link ENTROPY_CANDIDATE_PATTERN}) splits
 * `password=Xq!7@vB#...` into sub-runs of a handful of characters each, none of which reaches
 * {@link ENTROPY_MIN_LENGTH}, whereas the value read here is the whole 35 characters.
 *
 * An assignment site is a `=` or `:` that assigns rather than operates: `==`, `===`, `=>`, `::`,
 * `+=`, `!=` and the rest are skipped by inspecting the character on either side of it. After the
 * operator, a quoted value runs to its matching *unescaped* quote (see {@link closingQuote}), or to
 * the end of the line when the literal is unterminated, which is what an unbalanced editor state or
 * a wrapped line looks like; an unquoted value runs to the first
 * {@link UNQUOTED_VALUE_TERMINATOR}, which is neither `=` nor `:`.
 *
 * Scanning continues *after* each value, never inside it: an `=` within a quoted string is part of
 * the string, not a second assignment.
 *
 * @param {string} line
 * @returns {AssignedValue[]} In left-to-right order; empty values are omitted.
 */
function assignedValues(line) {
  /** @type {AssignedValue[]} */
  const values = [];
  let index = 0;
  while (index < line.length) {
    const operator = line.charAt(index);
    if (operator !== '=' && operator !== ':') {
      index += 1;
      continue;
    }
    const next = line.charAt(index + 1);
    if (next === '=' || next === '>' || (operator === ':' && next === ':')) {
      // `==`, `===`, `=>` and `::`: two-character operators, and neither half assigns.
      index += 2;
      continue;
    }
    if (index > 0 && NON_ASSIGNMENT_PREFIXES.has(line.charAt(index - 1))) {
      // The trailing half of a compound assignment, a comparison or a namespace separator.
      index += 1;
      continue;
    }

    let cursor = index + 1;
    while (cursor < line.length && (line.charAt(cursor) === ' ' || line.charAt(cursor) === '\t')) {
      cursor += 1;
    }

    const quote = line.charAt(cursor);
    const quoted = VALUE_QUOTES.has(quote);
    let valueStart;
    let valueEnd;
    let resumeAt;
    if (quoted) {
      valueStart = cursor + 1;
      const closing = closingQuote(line, quote, valueStart);
      valueEnd = closing === -1 ? line.length : closing;
      resumeAt = closing === -1 ? line.length : closing + 1;
    } else {
      valueStart = cursor;
      let end = valueStart;
      while (end < line.length && !UNQUOTED_VALUE_TERMINATOR.test(line.charAt(end))) {
        end += 1;
      }
      valueEnd = end;
      resumeAt = valueEnd;
    }

    const value = line.slice(valueStart, valueEnd);
    if (value !== '') {
      values.push({
        // The name is read with the same helper, through the same bounded window, as the
        // dense-run pass uses, so its rejection of arrows and comparisons applies identically to
        // both candidate sources.
        name: nearestAssignedName(lookbehind(line, valueStart)),
        value,
        start: valueStart,
        end: valueEnd,
        quoted,
      });
    }
    index = Math.max(resumeAt, index + 1);
  }
  return values;
}

/**
 * `value` with every balanced bracket group emptied, innermost first, so that an arbitrarily nested
 * call or index reads as a flat one: `Arr.fromIterable(map.keys()).map(unmake)` collapses to
 * `Arr.fromIterable().map()`, which {@link MEMBER_EXPRESSION_PATTERN} recognises as the expression
 * it is. Without this, a regular expression would have to match nested parentheses, which it
 * cannot, and every nested call in a codebase would read as a dense value.
 *
 * Each pass rewrites the innermost groups to a sentinel rather than to `()`, because `()` matches
 * the same sub-pattern again and the collapse would stall one level in. The sentinels become empty
 * groups once the text stops changing. Collapsing runs at most
 * {@link MAX_GROUP_COLLAPSE_PASSES} times; stopping early only means a value nested deeper than
 * that is measured rather than skipped.
 *
 * @param {string} value
 * @returns {string}
 */
function collapseGroups(value) {
  const CALL = '\u0001';
  const INDEX = '\u0002';
  let text = value;
  for (let pass = 0; pass < MAX_GROUP_COLLAPSE_PASSES; pass += 1) {
    const collapsed = text.replace(/\([^()]*\)/g, CALL).replace(/\[[^[\]]*\]/g, INDEX);
    if (collapsed === text) {
      break;
    }
    text = collapsed;
  }
  return text.split(CALL).join('()').split(INDEX).join('[]');
}

/**
 * Whether an assigned value is code that reads or matches a credential rather than a credential.
 *
 * Two shapes. An expression - `normalizeSqlStatement(fixture.sql)`, which is a tracked line of
 * `packages/telemetry/src/redaction/sql.test.ts` and the exact false positive a complete-value
 * pass produces there, or a member chain such as `credentials[activeProfile].secretValue`. And -
 * for unquoted values only - a run with unbalanced brackets, which means the run was cut out of a
 * larger expression at the delimiter the extraction stopped on. A quoted value is complete by
 * construction, so the balance rule does not apply to it: a real credential may legitimately
 * contain a lone bracket.
 *
 * A closed regular-expression literal is code too, quoted or not, so it is tested here rather than
 * left to {@link PATH_OR_PATTERN_VALUE_PATTERN}, which refuses unquoted `/`-leading values only.
 *
 * @param {string} value
 * @param {boolean} quoted
 * @returns {boolean}
 */
function isExpressionValue(value, quoted) {
  if (MEMBER_EXPRESSION_PATTERN.test(collapseGroups(value))) {
    return true;
  }
  if (REGEX_LITERAL_VALUE_PATTERN.test(value)) {
    return true;
  }
  return !quoted && !hasBalancedBrackets(value);
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
 * It runs only after the allowlist has partitioned a line's matches (see {@link scanLineInto}),
 * once over the live matches and once over the exempt ones, never across the two: an exempt match
 * must not absorb an overlapping live one that extends past the allowlisted literal.
 *
 * @template {{ start: number, end: number }} T
 * @param {readonly T[]} matches
 * @returns {T[]}
 */
function dedupeOverlaps(matches) {
  /** @type {T[]} */
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
 * The `entropy` match for one candidate, or `null` when a threshold or the name binding rejects
 * it. Shared by both candidate passes of {@link matchEntropy} so the two cannot drift apart in
 * what they consider dense, and so a finding reads the same however the candidate was found.
 *
 * Exclusion (a): a value shorter than {@link ENTROPY_MIN_LENGTH}, or one whose density does not
 * strictly exceed {@link ENTROPY_MIN_BITS_PER_CHAR}, is not measurable key material - an entropy
 * estimate over a handful of characters means nothing, and hexadecimal (16 symbols, at most 4
 * bits/char) is a hash rather than a credential.
 *
 * Exclusion (b): the rule is *bound*. A dense value under a neutral name is a hash, a build id or
 * a base64 asset, and reporting those would make the gate too noisy to be trusted.
 *
 * Exclusion (g), second half: a git object name on a `.github/workflows/` line is how actions are
 * pinned (AAP 0.3.2). Hexadecimal cannot exceed the threshold anyway, so this is belt and braces
 * rather than the load-bearing guard.
 *
 * @param {string} name Name the value is bound to.
 * @param {string} value Complete candidate value.
 * @param {number} start Inclusive index of `value` in the line.
 * @param {boolean} inWorkflow Whether the file is a GitHub Actions workflow.
 * @returns {RuleMatch | null}
 */
function entropyMatch(name, value, start, inWorkflow) {
  if (value.length < ENTROPY_MIN_LENGTH) {
    return null;
  }
  if (inWorkflow && GIT_SHA_PATTERN.test(value)) {
    return null;
  }
  if (!isKeyLikeName(name)) {
    return null;
  }
  const bits = shannonEntropy(value);
  if (bits <= ENTROPY_MIN_BITS_PER_CHAR) {
    return null;
  }
  return {
    rule: 'entropy',
    pattern: name,
    start,
    end: start + value.length,
    text: value,
    detail:
      `value of ${value.length} characters at ${bits.toFixed(2)} bits/char assigned to ` +
      `the key-like name \`${name}\``,
  };
}

/**
 * `entropy`: a long, dense value bound to a key-like name (AAP 0.3.4).
 *
 * TWO CANDIDATE SOURCES, IN THIS ORDER.
 *
 *   1. The complete assigned or quoted value ({@link assignedValues}), measured over its full
 *      contents whatever characters it contains. Punctuation is what makes this pass necessary: a
 *      password of `!@#$%^&*()` and alphanumerics is dense key material, and the dense-run
 *      alphabet below splits it into sub-runs too short to measure.
 *   2. The contiguous dense run ({@link ENTROPY_CANDIDATE_PATTERN}), which is the only pass that
 *      covers a value with no assignment operator at all - the `--auth-token <run>` form this
 *      file's specification requires - and dense runs embedded in a larger value.
 *
 * Complete values are reported first so that when both passes see the same credential,
 * {@link dedupeOverlaps} keeps the fullest extent and the finding's column, preview and
 * `N characters` describe the whole value. The structural rules still win over this one, because
 * {@link scanContentWithSuppressions} lists them before it.
 *
 * EXCLUSIONS. Each has a name, because each is a false positive this repository's own tracked
 * content produces, and each is pinned by a test:
 *
 *   (a) too short, or not dense enough - see {@link entropyMatch}. There is no upper bound: AAP
 *       0.3.4 states a minimum of 32 characters and no maximum, so a long value is measured, and
 *       what keeps a long *line* affordable is {@link NAME_LOOKBEHIND} rather than a size cap.
 *   (b) the name is not key-like - see {@link entropyMatch}.
 *   (c) the value interpolates (`${...}`) or substitutes a command (`$(...)`): what it holds is
 *       computed at runtime, so the committed text is a template, not a literal.
 *   (d) the value is a URI, or is unquoted and begins with `/` (see
 *       {@link PATH_OR_PATTERN_VALUE_PATTERN}): a location or a pattern, not key material. A
 *       credentialed URI is `connection-string`'s business, and `API_KEY=https://host/<dense path>`
 *       is an asset URL. A *quoted* value beginning with `/` is a literal and is measured.
 *   (e) the value contains whitespace - see {@link PROSE_VALUE_PATTERN}. Only a quoted value can:
 *       prose in documentation, not a credential, which is always one unbroken token.
 *   (f) the value is code rather than a literal - see {@link isExpressionValue}.
 *   (g) `pnpm-lock.yaml` is exempt from this rule alone (see {@link ENTROPY_EXEMPT_FILES}), and a
 *       git object name in a workflow is a pin rather than a credential.
 *
 * Exclusions (c) to (f) apply to the complete-value pass only, and the dense-run pass keeps
 * exactly the guard it always had: a run that continues a URI authority (`scheme://<here>`). That
 * is deliberate rather than an oversight. Those four exclusions are properties of a *complete*
 * value, and a dense run is by definition a fragment bounded by the narrow alphabet, so what keeps
 * such a fragment quiet is the name binding (b) - the character before it is a `(`, a `.` or a `/`
 * rather than an assignment operator. Leaving the run pass untouched also means this rule detects
 * everything it detected before, since a dotted dense run that happens to look like a member chain
 * is still measured there.
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

  for (const assigned of assignedValues(line)) {
    if (INTERPOLATED_VALUE_PATTERN.test(assigned.value)) {
      continue;
    }
    if (URI_VALUE_PATTERN.test(assigned.value)) {
      continue;
    }
    if (!assigned.quoted && PATH_OR_PATTERN_VALUE_PATTERN.test(assigned.value)) {
      continue;
    }
    if (PROSE_VALUE_PATTERN.test(assigned.value)) {
      continue;
    }
    if (isExpressionValue(assigned.value, assigned.quoted)) {
      continue;
    }
    const match = entropyMatch(assigned.name, assigned.value, assigned.start, inWorkflow);
    if (match !== null) {
      matches.push(match);
    }
  }

  for (const run of line.matchAll(ENTROPY_CANDIDATE_PATTERN)) {
    const text = run[0];
    const before = lookbehind(line, run.index);
    if (before.endsWith('://')) {
      continue;
    }
    const match = entropyMatch(nearestAssignedName(before), text, run.index, inWorkflow);
    if (match !== null) {
      matches.push(match);
    }
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
 * content it did not read - a binary, a submodule, or a file it could not examine.
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
 * Where one file's content findings accumulate while its lines are scanned.
 *
 * @typedef {object} ContentSink
 * @property {Finding[]} findings Live findings, in line then column order.
 * @property {AllowlistedFinding[]} allowlisted Matches an allowlist entry exempted.
 */

/**
 * Apply every content rule to one line and append the results to `sink`.
 *
 * This is the only per-line pass. The in-memory path ({@link scanTextInto}) and the streamed path
 * for oversized files ({@link streamScanFile}) both call it, so a file is judged identically
 * whatever its size.
 *
 * SUPPRESS FIRST, THEN DEDUPE. Every rule's matches are collected in precedence order - the
 * structural rules before the entropy heuristic, so a credential inside a URI is reported once, as
 * the connection string a reviewer can act on - and each is classified against the allowlist
 * before any overlap is resolved. Live and exempt matches are then deduplicated separately. The
 * other order lets an exempt match absorb a live one: a higher-precedence match that lies inside
 * the allowlisted literal would win the overlap, drop a lower-precedence match that extends past
 * the literal, and then be exempted, so the credential beyond the literal would vanish from the
 * report without ever having been compared against the allowlist.
 *
 * @param {string} relPath Repository-relative POSIX path.
 * @param {Allowlist} allowlist Validated allowlist.
 * @param {number} lineNumber 1-based.
 * @param {string} line The line without its terminator.
 * @param {ContentSink} sink
 */
function scanLineInto(relPath, allowlist, lineNumber, line, sink) {
  if (line === '') {
    return;
  }
  const matches = [
    ...matchProviderKeys(line),
    ...matchJwts(line),
    ...matchPrivateKeys(line),
    ...matchConnectionStrings(line),
    ...matchEntropy(relPath, line),
  ];
  if (matches.length === 0) {
    return;
  }
  const occurrences = allowlistOccurrences(allowlist, relPath, line);
  /** @type {RuleMatch[]} */
  const live = [];
  /** @type {(RuleMatch & { allowlistValue: string })[]} */
  const exempt = [];
  for (const match of matches) {
    const allowlistValue = occurrences.length === 0 ? null : suppressionFor(occurrences, match);
    if (allowlistValue === null) {
      live.push(match);
    } else {
      exempt.push({ ...match, allowlistValue });
    }
  }
  const byStart = (/** @type {RuleMatch} */ left, /** @type {RuleMatch} */ right) =>
    left.start - right.start;
  for (const match of dedupeOverlaps(live).sort(byStart)) {
    sink.findings.push(contentFinding(relPath, lineNumber, match));
  }
  for (const match of dedupeOverlaps(exempt).sort(byStart)) {
    sink.allowlisted.push({
      ...contentFinding(relPath, lineNumber, match),
      allowlistValue: match.allowlistValue,
    });
  }
}

/**
 * Apply every content rule to `text`, line by line, appending the results to `sink`.
 *
 * Lines are what `text.split(/\r?\n/)` yields - a `\r\n` pair and a bare `\n` both end a line, a
 * lone `\r` does not - and are numbered from 1. {@link streamScanFile} reproduces exactly these
 * semantics over a file too large to hold in memory.
 *
 * @param {string} relPath Repository-relative POSIX path.
 * @param {Allowlist} allowlist Validated allowlist.
 * @param {string} text File content as text.
 * @param {ContentSink} sink
 */
function scanTextInto(relPath, allowlist, text, sink) {
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    scanLineInto(relPath, allowlist, index + 1, lines[index] ?? '', sink);
  }
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
  /** @type {ContentSink} */
  const sink = { findings: scanPath(relPath), allowlisted: [] };
  scanTextInto(relPath, list, typeof content === 'string' ? content : String(content ?? ''), sink);
  return sink;
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
 * One path in the index.
 *
 * @typedef {object} TrackedEntry
 * @property {string} file Repository-relative POSIX path.
 * @property {string} mode Octal index mode: `100644` or `100755` for a regular file,
 *   {@link SYMLINK_MODE} for a symbolic link, {@link GITLINK_MODE} for a submodule.
 */

/**
 * Every path git tracks, repository-relative, with its index mode.
 *
 * Tracked-only enumeration is the contract (AAP 0.3.4: the check "scans `git ls-files` content").
 * It keeps the gate deterministic - an untracked scratch file in one developer's tree cannot fail
 * the build - and it is the reason nothing under `.git/` is ever opened, because `git ls-files`
 * does not list it. Do not add a filesystem-walk fallback.
 *
 * `--stage` is what carries the mode, which is the only way to tell a submodule (whose content is
 * another repository's) from a directory that has replaced a tracked file (which is a work tree
 * the check cannot vouch for). Each record is `<mode> <object> <stage>\t<path>`, and `-z` leaves
 * the path unquoted. A path in an unresolved merge has one record per stage; it is listed once,
 * as a gitlink only when every stage is one, so a conflict never turns a file into a skip.
 *
 * @param {string} repoRoot Absolute work-tree root.
 * @returns {TrackedEntry[]} In `git ls-files` order, one entry per path.
 * @throws {CheckSecretsError} With code `git-failed` when a record cannot be parsed, because a
 *   path the check cannot read from the listing is a path it would silently not scan.
 */
function listTrackedFiles(repoRoot) {
  /** @type {Map<string, TrackedEntry>} */
  const entries = new Map();
  for (const record of git(repoRoot, ['ls-files', '-z', '--stage']).split('\0')) {
    if (record === '') {
      continue;
    }
    const tab = record.indexOf('\t');
    const fields = tab === -1 ? [] : record.slice(0, tab).split(' ');
    const mode = fields[0] ?? '';
    if (fields.length !== 3 || !/^[0-7]{6}$/.test(mode)) {
      throw new CheckSecretsError(
        'git-failed',
        `\`git ls-files -z --stage\` in ${repoRoot} produced a record this check cannot parse ` +
          `(${JSON.stringify(record.slice(0, 120))}), so it cannot tell which files to scan`,
      );
    }
    const file = normalizeRepoPath(record.slice(tab + 1));
    const known = entries.get(file);
    if (known === undefined || (known.mode === GITLINK_MODE && mode !== GITLINK_MODE)) {
      entries.set(file, { file, mode });
    }
  }
  return [...entries.values()];
}

/**
 * The binary format a tracked file positively is, or `null` when it must be scanned as text.
 *
 * Both signals have to agree (see {@link BINARY_FORMATS}): the extension selects the format, and
 * the leading bytes must match one of its signatures.
 *
 * @param {string} relPath Repository-relative POSIX path.
 * @param {Buffer} leading The file's first bytes; the whole file or its first chunk.
 * @returns {string | null} The format name, for example `png`.
 */
function identifyBinary(relPath, leading) {
  const extension = path.posix.extname(relPath).toLowerCase();
  const entry = BINARY_FORMATS.find((candidate) => candidate.extensions.includes(extension));
  if (entry === undefined) {
    return null;
  }
  const matches = entry.signatures.some(
    (signature) =>
      leading.length >= signature.length && leading.subarray(0, signature.length).equals(signature),
  );
  return matches ? entry.format : null;
}

/**
 * Raised by {@link fileRead} when the operating system refuses a read of a tracked file, so the
 * scan can record that file as unscanned without also swallowing a defect in the scanner itself,
 * which propagates as the internal error it is.
 */
class TrackedFileReadError extends Error {
  /**
   * @param {unknown} cause The error the filesystem call raised.
   */
  constructor(cause) {
    super(cause instanceof Error ? cause.message : String(cause), {
      cause: cause instanceof Error ? cause : undefined,
    });
    this.name = 'TrackedFileReadError';
  }
}

/**
 * Run one filesystem read of a tracked file, converting its failure into a
 * {@link TrackedFileReadError}.
 *
 * @template T
 * @param {() => T} operation
 * @returns {T}
 * @throws {TrackedFileReadError}
 */
function fileRead(operation) {
  try {
    return operation();
  } catch (error) {
    throw new TrackedFileReadError(error);
  }
}

/**
 * Stream a file larger than {@link MAX_SCAN_BYTES} through the per-line rule pass in
 * {@link STREAM_CHUNK_BYTES} chunks, or identify it from its first chunk as a binary format.
 *
 * Line semantics are exactly those of `content.split(/\r?\n/)` in {@link scanTextInto}, so a file
 * reports the same findings at the same lines and columns whichever path reads it:
 *
 *   - `\n` ends a line, and a `\r` immediately before it belongs to the terminator - including a
 *     `\r` that ended the previous chunk while its `\n` opened this one, because the pieces of a
 *     line are joined before the `\r` is stripped;
 *   - a lone `\r`, and a `\r` at the very end of the file, stay in the line;
 *   - lines are numbered from 1, and the text after the last `\n` is the final line.
 *
 * Bytes are decoded by one `StringDecoder` for the whole file, which holds back a multi-byte UTF-8
 * sequence split across two chunks until its remaining bytes arrive, so a character straddling a
 * chunk boundary decodes once, correctly, instead of as two replacement characters that would
 * shift every later column on its line. Newlines are searched for in each decoded chunk only, and
 * the pieces of a line are joined once when it ends, so a long line costs linear time.
 *
 * @param {number} fd Open descriptor of the file.
 * @param {string} relPath Repository-relative POSIX path.
 * @param {Allowlist} allowlist Validated allowlist.
 * @param {ContentSink} sink
 * @returns {{ kind: 'scanned' } | { kind: 'binary', format: string }}
 * @throws {TrackedFileReadError} When a read fails; findings from the part already read stay in
 *   `sink`, because they are real.
 */
function streamScanFile(fd, relPath, allowlist, sink) {
  const chunk = Buffer.allocUnsafe(STREAM_CHUNK_BYTES);
  const decoder = new StringDecoder('utf8');
  /** @type {string[]} */
  let pieces = [];
  let lineNumber = 1;

  /** @param {string} text Newly decoded text. */
  const consume = (text) => {
    let start = 0;
    let newline = text.indexOf('\n');
    while (newline !== -1) {
      pieces.push(text.slice(start, newline));
      let line = pieces.length === 1 ? (pieces[0] ?? '') : pieces.join('');
      if (line.endsWith('\r')) {
        line = line.slice(0, -1);
      }
      scanLineInto(relPath, allowlist, lineNumber, line, sink);
      lineNumber += 1;
      pieces = [];
      start = newline + 1;
      newline = text.indexOf('\n', start);
    }
    if (start < text.length) {
      pieces.push(text.slice(start));
    }
  };

  let position = 0;
  for (;;) {
    const offset = position;
    const bytesRead = fileRead(() => readSync(fd, chunk, 0, chunk.length, offset));
    if (offset === 0) {
      const format = identifyBinary(relPath, chunk.subarray(0, bytesRead));
      if (format !== null) {
        return { kind: 'binary', format };
      }
    }
    if (bytesRead === 0) {
      break;
    }
    position += bytesRead;
    consume(decoder.write(chunk.subarray(0, bytesRead)));
  }
  consume(decoder.end());
  scanLineInto(relPath, allowlist, lineNumber, pieces.join(''), sink);
  return { kind: 'scanned' };
}

/**
 * Read and scan one regular file, or identify it as a binary format and skip it.
 *
 * A file up to {@link MAX_SCAN_BYTES} is read whole; a larger one is streamed by
 * {@link streamScanFile}. Either way the leading bytes decide binary identification and every line
 * goes through {@link scanLineInto}.
 *
 * @param {string} absolute Absolute path of the file.
 * @param {string} relPath Repository-relative POSIX path.
 * @param {number} size Size the work-tree entry reported.
 * @param {Allowlist} allowlist Validated allowlist.
 * @param {ContentSink} sink
 * @returns {{ kind: 'scanned' } | { kind: 'binary', format: string }}
 * @throws {TrackedFileReadError} When the file cannot be opened or read.
 */
function scanRegularFile(absolute, relPath, size, allowlist, sink) {
  if (size <= MAX_SCAN_BYTES) {
    const buffer = fileRead(() => readFileSync(absolute));
    const format = identifyBinary(relPath, buffer);
    if (format !== null) {
      return { kind: 'binary', format };
    }
    scanTextInto(relPath, allowlist, buffer.toString('utf8'), sink);
    return { kind: 'scanned' };
  }
  const fd = fileRead(() => openSync(absolute, 'r'));
  try {
    return streamScanFile(fd, relPath, allowlist, sink);
  } finally {
    fileRead(() => closeSync(fd));
  }
}

/**
 * `value` quoted for a POSIX shell when it needs quoting, so a remedy can be pasted as printed.
 *
 * @param {string} value
 * @returns {string}
 */
function shellQuote(value) {
  return /^[A-Za-z0-9_./@%+=:,-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * What kind of work-tree entry `stats` describes, for a message.
 *
 * @param {import('node:fs').Stats} stats
 * @returns {string}
 */
function describeEntry(stats) {
  if (stats.isSymbolicLink()) {
    return 'symbolic link';
  }
  if (stats.isDirectory()) {
    return 'directory';
  }
  if (stats.isFIFO()) {
    return 'named pipe';
  }
  if (stats.isSocket()) {
    return 'socket';
  }
  if (stats.isBlockDevice() || stats.isCharacterDevice()) {
    return 'device node';
  }
  return 'non-regular entry';
}

/**
 * What kind of entry git tracks under index `mode`, for a message. A gitlink never reaches a
 * message (it is skipped before the work tree is consulted), so any mode other than
 * {@link SYMLINK_MODE} is a regular file: `100644`, `100755`, or a legacy mode an old index may
 * still record.
 *
 * @param {string} mode Octal index mode from {@link listTrackedFiles}.
 * @returns {string}
 */
function describeTrackedMode(mode) {
  const kind = mode === SYMLINK_MODE ? 'a symbolic link' : 'a regular file';
  return `${kind} (index mode ${mode})`;
}

/**
 * The nearest directory above `file`, repository-relative, that the work tree holds as a symbolic
 * link, or `null` when every directory between the root and `file` is a real one.
 *
 * Git never tracks a path beneath a symbolic link (`git add` refuses one as "beyond a symbolic
 * link"), so a link standing where the index records a directory is a local replacement of that
 * directory. `lstat` leaves only the last component of a path unfollowed, so without this walk
 * every tracked file under such a link would be read from wherever it points - content outside
 * the checkout, or a benign stand-in - and reported as scanned in the tracked file's name.
 *
 * Many tracked files share each directory, so every answer is cached for the rest of the run and
 * each directory is examined once, top-down: the walk costs one `lstat` per tracked directory.
 *
 * @param {string} repoRoot Absolute, canonical work-tree root.
 * @param {string} file Repository-relative POSIX path of a tracked entry.
 * @param {Map<string, string | null>} cache Answers so far, keyed by repository-relative directory.
 * @returns {string | null} The linked directory, repository-relative.
 * @throws {TrackedFileReadError} When a directory on the way cannot be stat-ed.
 */
function symlinkedAncestor(repoRoot, file, cache) {
  const directory = path.posix.dirname(file);
  if (directory === '.') {
    return null;
  }
  const known = cache.get(directory);
  if (known !== undefined) {
    return known;
  }
  let found = symlinkedAncestor(repoRoot, directory, cache);
  if (found === null) {
    const stats = fileRead(() => lstatSync(path.join(repoRoot, directory)));
    found = stats.isSymbolicLink() ? directory : null;
  }
  cache.set(directory, found);
  return found;
}

/**
 * How to make each kind of unscanned file examinable.
 *
 * @type {Readonly<Record<UnscannedFile['reason'], (file: string) => string>>}
 */
const UNSCANNED_REMEDIES = Object.freeze({
  missing: (file) =>
    `stage the deletion with \`git rm -- ${shellQuote(file)}\`, restore the file with ` +
    `\`git checkout -- ${shellQuote(file)}\`, or, in a sparse checkout, run ` +
    '`git sparse-checkout disable`',
  'wrong-type': (file) =>
    `move the entry aside and restore the tracked file with \`git checkout -- ${shellQuote(file)}\`, ` +
    `or stage the replacement with \`git rm --cached -- ${shellQuote(file)}\` followed by ` +
    '`git add`',
  unreadable: (file) =>
    'make the file and its parent directories readable to the account running this check ' +
    `(for example \`chmod u+r -- ${shellQuote(file)}\`), then run the check again`,
});

/**
 * @param {string} file
 * @param {UnscannedFile['reason']} reason
 * @param {string} detail
 * @returns {{ kind: 'unscanned', entry: UnscannedFile }}
 */
function unscanned(file, reason, detail) {
  return {
    kind: 'unscanned',
    entry: { file, reason, detail, remedy: UNSCANNED_REMEDIES[reason](file) },
  };
}

/**
 * Examine one tracked entry: scan its content into `sink`, or say why it was skipped or could not
 * be examined.
 *
 * The index mode says what git tracks at the path, the work-tree entry says what stands there
 * now, and the two are compared before anything is read, because a work-tree entry of another
 * type is not the tracked content and reading it would certify something git does not store:
 *
 *   - A gitlink is skipped as `submodule` without touching the work tree: its content is another
 *     repository's.
 *   - A symbolic link where git tracks one (mode {@link SYMLINK_MODE}) is scanned as its target
 *     text, which is the blob git stores for it. It is never followed: the target may lie outside
 *     the checkout, and it is the link that is tracked.
 *   - A regular file is read (streamed when large) and skipped only as a positively identified
 *     binary. A regular file standing where git tracks a symbolic link is scanned too: that is how
 *     a checkout with `core.symlinks=false` stores the link, as a file holding its target.
 *   - Anything else is `unscanned`: `missing` when the path is absent from the work tree,
 *     `unreadable` when the operating system refuses to stat or read it, and `wrong-type` when the
 *     entry is not what git tracks - a directory or another non-regular entry, a symbolic link
 *     where git tracks a regular file (its target text is not the file's content, and following it
 *     would read a stand-in), or a path reached through a directory the work tree has replaced
 *     with a symbolic link (see {@link symlinkedAncestor}). The detail names both types.
 *
 * @param {string} repoRoot Absolute, canonical work-tree root.
 * @param {TrackedEntry} tracked
 * @param {Allowlist} allowlist Validated allowlist.
 * @param {ContentSink} sink
 * @param {Map<string, string | null>} ancestry The run's {@link symlinkedAncestor} cache.
 * @returns {{ kind: 'scanned' } | { kind: 'skipped', entry: SkippedFile } |
 *   { kind: 'unscanned', entry: UnscannedFile }}
 */
function examineTrackedFile(repoRoot, tracked, allowlist, sink, ancestry) {
  const { file, mode } = tracked;
  if (mode === GITLINK_MODE) {
    return { kind: 'skipped', entry: { file, reason: 'submodule' } };
  }
  const absolute = path.join(repoRoot, file);
  let stats;
  try {
    stats = lstatSync(absolute);
  } catch (error) {
    const code = /** @type {{ code?: string }} */ (error).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return unscanned(file, 'missing', 'git tracks this path but the work tree has nothing there');
    }
    return unscanned(file, 'unreadable', error instanceof Error ? error.message : String(error));
  }

  try {
    // The path's own `lstat` above has already classified a missing or unreadable entry, so every
    // directory on the way exists; only a race can make one fail here, reported as unreadable.
    const linkedDirectory = symlinkedAncestor(repoRoot, file, ancestry);
    if (linkedDirectory !== null) {
      return unscanned(
        file,
        'wrong-type',
        `the work tree holds a symbolic link at ${linkedDirectory} where git tracks a directory, ` +
          `so this path, tracked as ${describeTrackedMode(mode)}, resolves through the link`,
      );
    }
    if (stats.isSymbolicLink() && mode === SYMLINK_MODE) {
      const target = fileRead(() => readlinkSync(absolute, 'utf8'));
      scanTextInto(file, allowlist, target, sink);
      return { kind: 'scanned' };
    }
    // A symbolic link where git tracks a regular file lands here too: `lstat` reports it as a
    // link, never as a file.
    if (!stats.isFile()) {
      return unscanned(
        file,
        'wrong-type',
        `the work tree holds a ${describeEntry(stats)} where git tracks ${describeTrackedMode(mode)}`,
      );
    }
    const outcome = scanRegularFile(absolute, file, stats.size, allowlist, sink);
    return outcome.kind === 'binary'
      ? {
          kind: 'skipped',
          entry: { file, reason: 'binary', format: outcome.format, bytes: stats.size },
        }
      : outcome;
  } catch (error) {
    if (error instanceof TrackedFileReadError) {
      return unscanned(file, 'unreadable', error.message);
    }
    throw error;
  }
}

/**
 * A tracked entry the scan did not read because it holds no text to read here.
 *
 * @typedef {object} SkippedFile
 * @property {string} file Repository-relative POSIX path.
 * @property {'binary'|'submodule'} reason `binary`: the extension and the leading bytes agree on a
 *   format in {@link BINARY_FORMATS}. `submodule`: a gitlink, whose content is another
 *   repository's.
 * @property {string} [format] The identified format, for `binary`.
 * @property {number} [bytes] Size in bytes, for `binary`.
 */

/**
 * A tracked file the scan could not examine. Any one of these makes the run exit
 * {@link EXIT_ERROR}, because a pass over it would certify content nobody read.
 *
 * @typedef {object} UnscannedFile
 * @property {string} file Repository-relative POSIX path.
 * @property {'missing'|'wrong-type'|'unreadable'} reason `missing`: absent from the work tree
 *   (a deletion not yet staged, or a sparse checkout). `wrong-type`: the work-tree entry is not
 *   the type git tracks there - a directory or another non-regular entry, a symbolic link where
 *   git tracks a regular file, or a path beneath a directory replaced by a symbolic link.
 *   `unreadable`: the operating system refused to stat or read it.
 * @property {string} detail What happened, including the operating-system error when there was
 *   one.
 * @property {string} remedy The command or change that makes the file examinable.
 */

/**
 * The report the command line prints and `--json` serializes.
 *
 * @typedef {object} CheckReport
 * @property {boolean} ok No findings and no unscanned files.
 * @property {number} exitCode {@link EXIT_ERROR} when any file is unscanned, otherwise
 *   {@link EXIT_FINDINGS} when there are findings, otherwise {@link EXIT_OK}.
 * @property {string} repoRoot Absolute work-tree root that was scanned.
 * @property {string} allowlistPath Absolute path of the allowlist that was applied.
 * @property {readonly string[]} rules Rule ids that were enforced.
 * @property {number} filesTracked Paths git tracks; never zero, because an empty tracked subject
 *   is a precondition failure rather than a report (see {@link scanRepository}).
 * @property {number} filesScanned Files whose content - or, for a symbolic link, whose target
 *   text - was read and scanned.
 * @property {Finding[]} findings Violations, in file then line then column order.
 * @property {AllowlistedFinding[]} allowlisted Matches an allowlist entry exempted.
 * @property {SkippedFile[]} skipped Binaries and submodules, which hold no text to read here.
 * @property {UnscannedFile[]} unscanned Files that could not be examined; non-empty means the run
 *   proves nothing and exits {@link EXIT_ERROR}.
 */

/**
 * Scan a checkout: enumerate tracked files, apply every rule, and return the report.
 *
 * Every tracked entry ends up in exactly one of three places: scanned (counted in
 * `filesScanned`), `skipped` (a positively identified binary or a submodule), or `unscanned` (see
 * {@link examineTrackedFile}). An unscanned file does not throw - the rest of the tree is still
 * scanned and reported, so one missing file does not hide a credential elsewhere - but it makes
 * the report's `exitCode` {@link EXIT_ERROR} and `ok` false.
 *
 * @param {{ cwd?: string, root?: string, allowlist?: unknown, allowlistPath?: string }} [options]
 *   `cwd` (or its alias `root`) is any path inside the checkout to scan; it defaults to this
 *   script's own directory, so the command line behaves identically from any current directory.
 *   In-process callers pass a throwaway repository here. `allowlist` supplies a validated or parsed
 *   allowlist instead of reading one; `allowlistPath` reads a different file.
 * @returns {CheckReport}
 * @throws {CheckSecretsError} When the scan cannot be performed: `root-missing`,
 *   `not-a-repository`, `git-missing`, `git-failed`, an `allowlist-*` code, or
 *   `no-tracked-files` when git tracks nothing in the checkout.
 */
export function scanRepository(options = {}) {
  const repoRoot = resolveRepoRoot(options.cwd ?? options.root ?? SCRIPT_DIRECTORY);
  const allowlistPath = path.resolve(options.allowlistPath ?? DEFAULT_ALLOWLIST_PATH);
  const allowlist =
    options.allowlist === undefined || options.allowlist === null
      ? loadAllowlist(allowlistPath)
      : resolveAllowlist(options.allowlist);

  const files = listTrackedFiles(repoRoot);
  if (files.length === 0) {
    // A gate that passes because it had nothing to look at is worse than no gate at all: the
    // build goes green having proved nothing about the repository. This is raised here rather
    // than in the command line so that an in-process caller cannot get a clean report over an
    // unscanned tree either.
    throw new CheckSecretsError(
      'no-tracked-files',
      `git tracks no files in ${repoRoot}, so there is nothing to scan and this check cannot be ` +
        'performed. Nothing has been staged or committed yet, the checkout is sparse or partial, ' +
        'or the scan was pointed at the wrong directory: stage the files with `git add`, restore ' +
        'the full checkout with `git sparse-checkout disable`, or run the check from a complete ' +
        'checkout of the repository.',
    );
  }
  /** @type {ContentSink} */
  const sink = { findings: [], allowlisted: [] };
  /** @type {SkippedFile[]} */
  const skipped = [];
  /** @type {UnscannedFile[]} */
  const unscannedFiles = [];
  let filesScanned = 0;
  /** @type {Map<string, string | null>} */
  const ancestry = new Map();

  for (const tracked of files) {
    // The path rules apply to every tracked entry, including one whose content is skipped or
    // cannot be examined: a tracked `.env` is a finding whatever it holds.
    sink.findings.push(...scanPath(tracked.file));
    const outcome = examineTrackedFile(repoRoot, tracked, allowlist, sink, ancestry);
    if (outcome.kind === 'scanned') {
      filesScanned += 1;
    } else if (outcome.kind === 'skipped') {
      skipped.push(outcome.entry);
    } else {
      unscannedFiles.push(outcome.entry);
    }
  }

  const { findings, allowlisted } = sink;
  let exitCode = EXIT_OK;
  if (unscannedFiles.length > 0) {
    exitCode = EXIT_ERROR;
  } else if (findings.length > 0) {
    exitCode = EXIT_FINDINGS;
  }
  return {
    ok: exitCode === EXIT_OK,
    exitCode,
    repoRoot,
    allowlistPath,
    rules: RULE_IDS,
    filesTracked: files.length,
    filesScanned,
    findings,
    allowlisted,
    skipped,
    unscanned: unscannedFiles,
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
 * Render the human-readable report: files that could not be examined first, because they void the
 * run, then findings, then the summary.
 *
 * @param {CheckReport} report
 * @returns {string} Text ending in a newline.
 */
function renderReport(report) {
  /** @type {string[]} */
  const lines = [];

  if (report.unscanned.length > 0) {
    const count = report.unscanned.length;
    lines.push(
      `check-secrets: could not examine ${count} tracked ${plural(count, 'file')}, so this run ` +
        'proves nothing about the repository:',
    );
    for (const entry of report.unscanned) {
      lines.push(`${entry.file}: ${entry.reason}: ${entry.detail}`);
      lines.push(`    fix: ${entry.remedy}`);
    }
    lines.push('');
  }

  for (const finding of report.findings) {
    lines.push(`${finding.file}:${finding.line}: ${finding.rule}: ${finding.message}`);
    if (finding.hint !== '') {
      lines.push(`    hint: ${finding.hint}`);
    }
  }
  if (report.findings.length > 0) {
    lines.push('', ...findingsExplanation(), '');
  }

  const parts = [
    `${report.filesScanned} ${plural(report.filesScanned, 'file')} scanned`,
    `${report.findings.length} ${plural(report.findings.length, 'finding')}`,
    `${report.allowlisted.length} allowlisted`,
  ];
  if (report.skipped.length > 0) {
    parts.push(`${report.skipped.length} skipped (binary or submodule)`);
  }
  if (report.unscanned.length > 0) {
    parts.push(`${report.unscanned.length} unscanned`);
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
    'Fails when a file git tracks carries a credential. Every tracked file is read - a file over',
    '2 MiB is streamed, a symbolic link is read as its target text and never followed - and only',
    'a positively identified binary (extension and leading bytes agree) or a submodule is skipped.',
    'Each scanned file is checked against these rules:',
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
    '  2  the check could not run: unknown option, git unavailable, not a git repository, no',
    '     tracked files to scan, or a missing or malformed allowlist; or a tracked file could not',
    '     be examined (absent from the work tree, replaced by a directory or another non-regular',
    '     entry, or unreadable), which the report lists as unscanned with the command that fixes',
    '     it',
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
 * @returns {Promise<number>} 0 no findings, 1 findings, 2 usage or environment error or a tracked
 *   file that could not be examined.
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
    if (report.unscanned.length > 0) {
      // Exit 2 always explains itself on stderr, so a caller watching only that stream - or
      // parsing --json from stdout - still learns why the gate refused to pass.
      const count = report.unscanned.length;
      process.stderr.write(
        `check-secrets: unscanned: could not examine ${count} tracked ` +
          `${plural(count, 'file')} (${report.unscanned.map((entry) => entry.file).join(', ')}); ` +
          'the report lists each with the command that fixes it\n',
      );
    }
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
 * Whether this module is the process entry point, so importing it (the tests) never runs the
 * command line.
 *
 * Both sides are canonicalized. Node reports `import.meta.url` as a real path but leaves
 * `process.argv[1]` as typed, so comparing the two as they come makes a run through any symbolic
 * link - a symlinked checkout, a linked workspace, macOS's `/tmp` - skip `main` entirely and exit 0
 * without printing a word: a secrets gate that passes without looking, which is the one outcome it
 * exists to rule out.
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
