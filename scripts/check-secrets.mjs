#!/usr/bin/env node
/**
 * check-secrets.mjs
 *
 * Repository gate behind `pnpm check:secrets`, which `pnpm verify` runs. It reads the content git
 * tracks and fails the build when a tracked path or its content matches one of the credential
 * shapes below. What a pass establishes is exactly that: none of those shapes occurs in the content
 * the check read. Which content that is - and what it cannot see inside a binary - is set out
 * under WHAT IS SCANNED, AND WHAT IS NOT.
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
 * `.git/` IS NEVER READ. The repository's `origin` URL embeds an access token, which lives in
 * `.git/config`. Enumeration goes through `git ls-files`, which never lists anything under
 * `.git/`, and there is no filesystem-walk fallback that could reach it. Do not add one.
 *
 * IT FAILS CLOSED. Every condition that leaves the check unable to inspect the repository is an
 * error (exit 2), never a quiet pass: git missing, the directory not being a checkout, a missing
 * or malformed allowlist, and - the one that looks like success - git tracking no files at all. A
 * gate that returns 0 having read nothing proves nothing, so an empty tracked subject is a
 * precondition failure raised where enumeration happens, which makes it fail for in-process
 * callers and for the command line alike.
 *
 * WHAT IS SCANNED, AND WHAT IS NOT. Each entry git tracks is handled in exactly one of these
 * ways, and the report accounts for every one:
 *
 *   - A text file is scanned against every rule. One larger than 2 MiB is streamed in chunks,
 *     with the same line and column semantics as a file read whole.
 *   - A text file whose leading bytes mark it as UTF-16 - a UTF-16LE (`FF FE`) or UTF-16BE
 *     (`FE FF`) byte-order mark, or, without one, NUL bytes concentrated at the odd
 *     (little-endian) or even (big-endian) offsets of its first {@link UTF16_SAMPLE_BYTES} (see
 *     {@link detectUtf16}) - is scanned twice, streamed when large: as UTF-8 like every other
 *     text file, so a mis-detection never narrows coverage, and again as the text its UTF-16
 *     decoding yields, whose findings name the encoding and count columns in UTF-16 code units.
 *     Windows PowerShell 5.1 writes UTF-16LE by default, which is how such a file reaches a
 *     commit. Each is counted as scanned and listed under `utf16`. What stays uncovered is read
 *     as UTF-8 only: BOM-less UTF-16 text too sparse in ASCII to meet the NUL threshold, UTF-32,
 *     and every other legacy encoding.
 *   - A tracked symbolic link is scanned as its target text - the string git stores for it - and
 *     is never followed.
 *   - A positively identified binary (its extension and its leading bytes agree on a format in
 *     {@link BINARY_FORMATS}) is scanned against every content rule twice over: byte for byte,
 *     streamed when large, and field by field, each plaintext field its format stores - PNG text
 *     chunks, standalone or in an ICO image; JPEG comment and application segments; GIF extension
 *     blocks; ZIP (VSIX) entry names, comments and stored entries and the archive comment; the
 *     WOFF and WOFF2 private data block - read from its own first byte, so a length prefix or a
 *     name before a value cannot pass for part of it, and GIF sub-blocks joined back into the text
 *     they split. PDF delimits its values itself, so the byte pass reads each from its start.
 *     Nothing is decompressed or decoded: a credential one of those fields holds as plain ASCII is
 *     found, as is one that stands between non-token bytes anywhere else in the file, while one
 *     inside compressed data - a PNG `zTXt` chunk, compressed `iTXt` or image data, a PDF Flate
 *     stream, a deflated ZIP or VSIX entry, a compressed WOFF or WOFF2 table - is not, nor is one
 *     stored as UTF-16 or hexadecimal (see {@link BinaryFile}): the UTF-16 pass above is a
 *     text-mode pass, and an identified binary is not text. Each such file counts as scanned and
 *     is listed under `binaries`.
 *   - A submodule (gitlink) is skipped, because its content is another repository's, and is
 *     listed under `skipped`.
 *   - A tracked file the check cannot examine - absent from the work tree, replaced by an entry of
 *     another type than the index records (a directory, a symbolic link where git tracks a regular
 *     file, or a symbolic link in place of one of its directories), or unreadable - is reported as
 *     `unscanned` with the command that fixes it, and the run exits 2: a gate that passed over it
 *     would be certifying content it never saw.
 *
 * `env-file` judges the path alone, so it applies to every tracked entry, skipped and unscanned
 * ones included.
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
 * The only environment files that may be tracked. These are repository-relative POSIX paths, not
 * basenames: `/.gitignore` re-includes exactly these two paths after ignoring `.env*`, and an
 * example file anywhere else is still a finding.
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

/**
 * Leading bytes of a file that UTF-16 detection counts NUL bytes over when the file carries no
 * byte-order mark (see {@link detectUtf16}). It must not exceed {@link STREAM_CHUNK_BYTES}: a
 * streamed file is classified from its first chunk, and the in-memory and streamed paths classify
 * a file identically only because both sample the same bytes.
 */
export const UTF16_SAMPLE_BYTES = 64 * 1024;

/**
 * Least share of the sampled bytes that must be NUL at the parity a UTF-16 byte order puts them,
 * as a divisor: at least one sampled byte in {@link UTF16_NUL_SHARE_DIVISOR}. ASCII text in
 * UTF-16 has a NUL beside every character, one sampled byte in two; four allows half the text to
 * be non-ASCII while staying far above the handful of NUL bytes a textual file with some binary
 * residue holds.
 */
const UTF16_NUL_SHARE_DIVISOR = 4;

/**
 * How many times the NUL bytes at the other parity the qualifying parity must outnumber. Binary
 * data that is merely NUL-rich - zero padding, a PNG header, the `\0\0` runs of a text file with
 * binary residue - holds NUL bytes at both parities alike, and must not be decoded as UTF-16.
 */
const UTF16_NUL_DOMINANCE = 8;

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

/** The eight bytes every PNG file begins with, whether it stands alone or inside an ICO file. */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * The binary formats a tracked file may be identified as: each format's extensions and the magic
 * signatures its files begin with. An identified file is scanned in binary mode (see
 * {@link ContentMode}): decoded byte for byte and, for the formats
 * {@link METADATA_FIELD_READERS} parses, field by field as well, against every content rule.
 *
 * Binary mode requires positive identification - the extension names the format AND the leading
 * bytes match one of its signatures - because it changes how the bytes are decoded, and either
 * signal alone says nothing about the content: renaming `credentials.txt` to `credentials.png`
 * leaves it text, and a stray NUL byte in an otherwise textual file does not make the rest of it
 * anything but text. So a file with a binary extension but no matching signature, or with NUL
 * bytes but no known binary extension, is decoded as UTF-8 text like every other file.
 *
 * @type {readonly { readonly format: string, readonly extensions: readonly string[],
 *   readonly signatures: readonly Buffer[] }[]}
 */
const BINARY_FORMATS = Object.freeze([
  binaryFormat('png', ['.png'], [PNG_SIGNATURE]),
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
 * @param {string} format Short format name, reported with the binary file.
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
 * the allowlist exempts the exact placeholder only.
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
 * A match that merely *contains* the literal is deliberately not exempt. That direction would let
 * an allowlisted prefix launder whatever followed it, and the allowlist exempts the exact
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
 * Exclusion (g), second half: a git object name on a `.github/workflows/` line is how the workflow
 * pins its actions. Hexadecimal cannot exceed the threshold anyway, so this is belt and braces
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
 * `entropy`: a value of at least {@link ENTROPY_MIN_LENGTH} characters, denser than
 * {@link ENTROPY_MIN_BITS_PER_CHAR} bits per character, bound to a key-like name.
 *
 * TWO CANDIDATE SOURCES, IN THIS ORDER.
 *
 *   1. The complete assigned or quoted value ({@link assignedValues}), measured over its full
 *      contents whatever characters it contains. Punctuation is what makes this pass necessary: a
 *      password of `!@#$%^&*()` and alphanumerics is dense key material, and the dense-run
 *      alphabet below splits it into sub-runs too short to measure.
 *   2. The contiguous dense run ({@link ENTROPY_CANDIDATE_PATTERN}), which is the only pass that
 *      covers a value with no assignment operator at all - the `--auth-token <run>` form - and
 *      dense runs embedded in a larger value.
 *
 * Complete values are reported first so that when both passes see the same credential,
 * {@link dedupeOverlaps} keeps the fullest extent and the finding's column, preview and
 * `N characters` describe the whole value. The structural rules still win over this one, because
 * {@link CONTENT_MATCHERS} lists them before it.
 *
 * EXCLUSIONS. Each has a name, because each is a false positive this repository's own tracked
 * content produces, and each is pinned by a test:
 *
 *   (a) too short, or not dense enough - see {@link entropyMatch}. There is no upper bound: the
 *       rule sets a minimum of 32 characters and no maximum, so a long value is measured, and
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

/**
 * How a file's bytes are read. Both modes apply every content rule; they differ in decoding and
 * in what is scanned besides the lines of the file.
 *
 *   text    UTF-8. A regular file is read this way unless it is a positively identified binary,
 *           and a symbolic link's target text always is. A regular file {@link detectUtf16}
 *           classifies as UTF-16 is read this way too, and then a second time as the text its
 *           UTF-16 decoding yields, with the byte-order mark kept as U+FEFF exactly as the UTF-8
 *           reading keeps it, so a column counts UTF-16 code units from the start of the decoded
 *           line in both readings. Findings of the second reading name the encoding in their
 *           message (see {@link scanTextBytesInto}). A symbolic link's target is a path, never
 *           UTF-16.
 *   binary  latin1 - one byte to one character, lossless, so a column is a byte offset within its
 *           line and a chunk boundary never splits a character. Lines end at the same `\n` and
 *           `\r\n` bytes as in text mode. The plaintext metadata fields of the file's format are
 *           then scanned as well, each from its own first byte (see
 *           {@link scanMetadataFieldsInto}).
 *
 * @typedef {'text' | 'binary'} ContentMode
 */

/**
 * One content rule's per-line matcher.
 *
 * @typedef {object} ContentMatcher
 * @property {string} rule Rule id.
 * @property {(line: string, relPath: string) => RuleMatch[]} match
 */

/**
 * Every content rule's matcher, in precedence order: the structural rules before the `entropy`
 * heuristic, which is the order {@link scanLineInto} relies on when it resolves overlaps.
 *
 * @type {readonly ContentMatcher[]}
 */
const CONTENT_MATCHERS = Object.freeze([
  Object.freeze({ rule: 'provider-key', match: matchProviderKeys }),
  Object.freeze({ rule: 'jwt', match: matchJwts }),
  Object.freeze({ rule: 'private-key', match: matchPrivateKeys }),
  Object.freeze({ rule: 'connection-string', match: matchConnectionStrings }),
  Object.freeze({
    rule: 'entropy',
    match: (/** @type {string} */ line, /** @type {string} */ relPath) =>
      matchEntropy(relPath, line),
  }),
]);

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
 * content it did not read - a submodule, or a file it could not examine.
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
 * This is the only per-line pass. The in-memory path ({@link scanTextInto}), the streamed path for
 * oversized files ({@link streamScanFile}) and the metadata-field pass for binaries
 * ({@link scanMetadataFieldsInto}) all call it, so content is judged identically whatever its
 * size, its mode or where in a file it was found.
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
  /** @type {RuleMatch[]} */
  const matches = [];
  for (const matcher of CONTENT_MATCHERS) {
    matches.push(...matcher.match(line, relPath));
  }
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
 * @param {string} text File content, decoded as its {@link ContentMode} prescribes.
 * @param {ContentSink} sink
 */
function scanTextInto(relPath, allowlist, text, sink) {
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    scanLineInto(relPath, allowlist, index + 1, lines[index] ?? '', sink);
  }
}

/**
 * A UTF-16 byte order a text file was classified as, in the label `TextDecoder` accepts.
 *
 * @typedef {'utf-16le' | 'utf-16be'} Utf16Encoding
 */

/**
 * What {@link detectUtf16} established about a file.
 *
 * @typedef {object} Utf16Detection
 * @property {Utf16Encoding} encoding The byte order the file's UTF-16 reading decodes.
 * @property {boolean} bom Whether a byte-order mark announced it; `false` when the NUL-parity
 *   heuristic inferred it.
 */

/** How each UTF-16 byte order is named in the message of a finding its reading produced. */
const UTF16_LABELS = Object.freeze({ 'utf-16le': 'UTF-16LE', 'utf-16be': 'UTF-16BE' });

/**
 * Whether a text-mode file is UTF-16, and in which byte order, judged from its leading bytes.
 *
 * A byte-order mark decides first: `FF FE` is UTF-16LE and `FE FF` is UTF-16BE. The one exception
 * is `FF FE 00 00`, which is also the UTF-32LE mark; this check does not decode UTF-32, so that
 * prefix is left to the heuristic below, which UTF-32 text does not satisfy and a UTF-16LE file
 * whose first character is U+0000 still does.
 *
 * Without a mark, the NUL bytes of the first {@link UTF16_SAMPLE_BYTES} are counted by offset
 * parity. An ASCII character in UTF-16LE is its own byte followed by a NUL, so the NULs fall at
 * odd offsets; UTF-16BE puts them at even ones. A byte order is inferred when the NULs at its
 * parity are at least one sampled byte in {@link UTF16_NUL_SHARE_DIVISOR} AND outnumber the NULs
 * at the other parity {@link UTF16_NUL_DOMINANCE} times over. Each condition excludes what the
 * other lets through: the share keeps out a textual file with a few stray NUL bytes, and the
 * dominance keeps out data that is merely NUL-rich - zero padding, a PNG header, a `\0\0` run -
 * whose NULs fall at both parities alike. Text too sparse in ASCII to reach the share, such as
 * BOM-less CJK prose, is not recognised; it is still read as UTF-8, like every text file.
 *
 * Only text-mode content is classified: a positively identified binary is never read as UTF-16.
 *
 * @example
 *   detectUtf16(Buffer.from('key = 1', 'utf16le')); // { encoding: 'utf-16le', bom: false }
 *   detectUtf16(Buffer.from('head\0\0\n'));          // null - balanced, sparse NUL bytes
 *
 * @param {Buffer} leading The file's first bytes: the whole file or its first chunk.
 * @returns {Utf16Detection | null} `null` when the bytes are not recognisably UTF-16.
 */
function detectUtf16(leading) {
  if (leading.length >= 2) {
    const utf32LittleEndianMark = leading[2] === 0 && leading[3] === 0;
    if (leading[0] === 0xff && leading[1] === 0xfe && !utf32LittleEndianMark) {
      return { encoding: 'utf-16le', bom: true };
    }
    if (leading[0] === 0xfe && leading[1] === 0xff) {
      return { encoding: 'utf-16be', bom: true };
    }
  }
  const sample = leading.subarray(0, UTF16_SAMPLE_BYTES);
  if (sample.length < 2) {
    return null;
  }
  // Jumping from NUL to NUL keeps the common case - a text file with no NUL at all - one scan.
  let even = 0;
  let odd = 0;
  for (let index = sample.indexOf(0); index !== -1; index = sample.indexOf(0, index + 1)) {
    if (index % 2 === 0) {
      even += 1;
    } else {
      odd += 1;
    }
  }
  if (odd * UTF16_NUL_SHARE_DIVISOR >= sample.length && even * UTF16_NUL_DOMINANCE <= odd) {
    return { encoding: 'utf-16le', bom: false };
  }
  if (even * UTF16_NUL_SHARE_DIVISOR >= sample.length && odd * UTF16_NUL_DOMINANCE <= even) {
    return { encoding: 'utf-16be', bom: false };
  }
  return null;
}

/**
 * A fresh decoder for one file's UTF-16 reading.
 *
 * `ignoreBOM: true` keeps a byte-order mark in the decoded text as U+FEFF - the WHATWG option
 * means "do not strip it" - exactly as the UTF-8 reading keeps a UTF-8 mark, so on the first line
 * both readings count the mark as a column. The decoder is not fatal: a lone surrogate or a
 * trailing odd byte decodes to U+FFFD rather than aborting the scan of everything after it. One
 * decoder serves one file, because a streaming decoder carries state from chunk to chunk.
 *
 * @param {Utf16Encoding} encoding
 * @returns {TextDecoder}
 */
function utf16Decoder(encoding) {
  return new TextDecoder(encoding, { ignoreBOM: true });
}

/**
 * Line then column order, which every file's findings end in.
 *
 * @param {Finding} left
 * @param {Finding} right
 * @returns {number}
 */
function comparePositions(left, right) {
  return left.line - right.line || left.column - right.column;
}

/**
 * Merge the findings of a file's UTF-16 reading into `sink`, which holds the same file's UTF-8
 * findings and nothing else, leaving one line-then-column ordered list.
 *
 * Each merged finding's message ends by naming the encoding: its line and column are positions in
 * the decoded text, and a reviewer needs to know the file was read that way to find them. The
 * preview is untouched, so the disclosure budget is the same as for any other finding. Array sort
 * is stable, so at an equal position the UTF-8 finding stays first.
 *
 * @param {ContentSink} sink One file's UTF-8 findings.
 * @param {ContentSink} decoded The same file's UTF-16 findings.
 * @param {Utf16Encoding} encoding
 */
function mergeDecodedInto(sink, decoded, encoding) {
  if (decoded.findings.length === 0 && decoded.allowlisted.length === 0) {
    return;
  }
  const suffix = `, decoded as ${UTF16_LABELS[encoding]}`;
  /**
   * @template {Finding} T
   * @param {T} finding
   * @returns {T}
   */
  const labelled = (finding) => ({ ...finding, message: `${finding.message}${suffix}` });
  sink.findings.push(...decoded.findings.map(labelled));
  sink.allowlisted.push(...decoded.allowlisted.map(labelled));
  sink.findings.sort(comparePositions);
  sink.allowlisted.sort(comparePositions);
}

/**
 * Scan the whole content of a text-mode file from its bytes (see {@link ContentMode}): as UTF-8,
 * and, when {@link detectUtf16} classifies the bytes, a second time as UTF-16.
 *
 * The UTF-8 reading is unconditional, so a file the heuristic misclassifies loses nothing: UTF-8
 * content that happens to be NUL-heavy is still judged exactly as before, and its UTF-16 reading
 * merely adds text no rule is likely to match. A classified file's two readings are gathered on
 * their own and merged, so they reach `sink` as one line-then-column ordered list.
 *
 * @param {string} relPath Repository-relative POSIX path.
 * @param {Allowlist} allowlist Validated allowlist.
 * @param {Buffer} bytes The file's complete content.
 * @param {ContentSink} sink
 * @returns {Utf16Detection | null} The UTF-16 classification, for the report; `null` for a file
 *   read as UTF-8 alone.
 */
function scanTextBytesInto(relPath, allowlist, bytes, sink) {
  const utf16 = detectUtf16(bytes);
  if (utf16 === null) {
    scanTextInto(relPath, allowlist, bytes.toString('utf8'), sink);
    return null;
  }
  /** @type {ContentSink} */
  const local = { findings: [], allowlisted: [] };
  scanTextInto(relPath, allowlist, bytes.toString('utf8'), local);
  /** @type {ContentSink} */
  const decoded = { findings: [], allowlisted: [] };
  scanTextInto(relPath, allowlist, utf16Decoder(utf16.encoding).decode(bytes), decoded);
  mergeDecodedInto(local, decoded, utf16.encoding);
  appendSink(sink, local);
  return utf16;
}

/**
 * Scan one file's path and content against every rule, separating the findings the allowlist
 * exempted so a caller can report how many exemptions were used.
 *
 * `content` is judged as text (see {@link ContentMode}); binary mode, and its metadata-field pass,
 * is chosen only by {@link scanRepository}, from a tracked file's own extension and leading bytes.
 * A string is scanned as it stands. Bytes are read the way {@link scanRepository} reads a text
 * file: as UTF-8, and again as UTF-16 when {@link detectUtf16} classifies them, whose findings
 * name the encoding in their message.
 *
 * @example
 *   scanContent('deploy.ps1', Buffer.from(script, 'utf16le'), allowlist);
 *
 * @param {string} filePath Repository-relative path, used in every finding.
 * @param {string | Uint8Array} content File content as text, or its raw bytes (a `Buffer` or any
 *   other `Uint8Array`). Anything else is converted with `String()`.
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
  if (content instanceof Uint8Array) {
    // A view, not a copy: `Buffer` gives the detector `indexOf` and the UTF-8 reading `toString`.
    const bytes = Buffer.from(content.buffer, content.byteOffset, content.byteLength);
    scanTextBytesInto(relPath, list, bytes, sink);
    return sink;
  }
  const text = typeof content === 'string' ? content : String(content ?? '');
  scanTextInto(relPath, list, text, sink);
  return sink;
}

/**
 * Every finding in one file, with allowlisted matches already removed.
 *
 * This is the seam the script's own tests drive: it needs neither git nor a checkout, and the
 * allowlist is an argument rather than a hidden dependency.
 *
 * @param {string} filePath Repository-relative path, used in every finding.
 * @param {string | Uint8Array} content File content as text, or its raw bytes, read as
 *   {@link scanContentWithSuppressions} describes.
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
 * `origin` URL.
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
 * Tracked-only enumeration is the contract: the check scans what `git ls-files` lists, and nothing
 * else. It keeps the gate deterministic - an untracked scratch file in one developer's tree cannot
 * fail the build - and it is the reason nothing under `.git/` is ever opened, because
 * `git ls-files` does not list it. Do not add a filesystem-walk fallback.
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
 * The binary format a tracked file positively is, which selects binary mode (see
 * {@link ContentMode}), or `null` when it is scanned as text.
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
 * How {@link scanRegularFile} read a file: as text (`scanned`), as text read both as UTF-8 and as
 * the UTF-16 byte order it names (`utf16`), or in binary mode as the format it names (`binary`).
 *
 * @typedef {{ kind: 'scanned' } | { kind: 'utf16', encoding: Utf16Encoding, bom: boolean } |
 *   { kind: 'binary', format: string }} RegularFileOutcome
 */

/**
 * The outcome for a file read in the mode `format` selects, with the UTF-16 classification of a
 * text-mode file.
 *
 * @param {string | null} format What {@link identifyBinary} returned.
 * @param {Utf16Detection | null} utf16 What {@link detectUtf16} returned for a text-mode file;
 *   `null` for a binary, which is never classified.
 * @returns {RegularFileOutcome}
 */
function regularFileOutcome(format, utf16) {
  if (format !== null) {
    return { kind: 'binary', format };
  }
  return utf16 === null
    ? { kind: 'scanned' }
    : { kind: 'utf16', encoding: utf16.encoding, bom: utf16.bom };
}

/* ---------------------------------------------------------------------------
 * Metadata fields of binary formats
 * ------------------------------------------------------------------------ */

/**
 * Longest stretch of one metadata field that is scanned as a field. A field's bytes are read into
 * memory together, so this bounds that read; bytes past it are still scanned by the byte-for-byte
 * pass, which reads every byte of the file.
 */
export const MAX_FIELD_BYTES = MAX_SCAN_BYTES;

/** Bytes a descriptor-backed {@link ByteSource} reads at once when it walks a file's structure. */
const SOURCE_WINDOW_BYTES = 64 * 1024;

/**
 * Random access to one file's bytes, in memory or through an open descriptor.
 *
 * @typedef {object} ByteSource
 * @property {number} size Bytes in the file.
 * @property {(position: number, length: number) => Buffer} read Up to `length` bytes starting at
 *   `position`: fewer at the end of the file, none past it.
 */

/**
 * A {@link ByteSource} over a file read whole.
 *
 * @param {Buffer} buffer
 * @returns {ByteSource}
 */
function bufferSource(buffer) {
  return {
    size: buffer.length,
    read: (position, length) =>
      buffer.subarray(position, Math.min(buffer.length, position + Math.max(0, length))),
  };
}

/**
 * A {@link ByteSource} over an open descriptor. Walking a format's structure reads a few bytes at
 * a time - a GIF's sub-block lengths one byte each - so reads are served from a
 * {@link SOURCE_WINDOW_BYTES} window, replaced (never overwritten) when a read falls outside it,
 * which keeps every buffer already returned valid.
 *
 * @param {number} fd Open descriptor of the file.
 * @param {number} size Size the work-tree entry reported.
 * @returns {ByteSource}
 * @throws {TrackedFileReadError} From `read`, when the operating system refuses the read.
 */
function descriptorSource(fd, size) {
  let windowStart = 0;
  let window = Buffer.alloc(0);
  /**
   * @param {number} position
   * @param {number} length
   * @returns {Buffer}
   */
  const readAt = (position, length) => {
    const buffer = Buffer.allocUnsafe(length);
    const bytesRead = fileRead(() => readSync(fd, buffer, 0, length, position));
    return buffer.subarray(0, bytesRead);
  };
  return {
    size,
    read(position, length) {
      if (length <= 0 || position >= size) {
        return Buffer.alloc(0);
      }
      const wanted = Math.min(length, size - position);
      if (position >= windowStart && position + wanted <= windowStart + window.length) {
        return window.subarray(position - windowStart, position - windowStart + wanted);
      }
      if (wanted > SOURCE_WINDOW_BYTES) {
        return readAt(position, wanted);
      }
      window = readAt(position, Math.min(SOURCE_WINDOW_BYTES, size - position));
      windowStart = position;
      return window.subarray(0, Math.min(wanted, window.length));
    },
  };
}

/**
 * One contiguous run of a file's bytes.
 *
 * @typedef {object} ByteRange
 * @property {number} offset Position of the first byte in the file.
 * @property {number} length Bytes in the run.
 */

/**
 * One plaintext value a binary format stores: its bytes, in order, as one or more runs of the
 * file. A GIF sub-block structure splits a value into runs of at most 255 bytes, each after a
 * length byte; every other field here is a single run.
 *
 * @typedef {object} MetadataField
 * @property {readonly ByteRange[]} segments
 */

/**
 * `ranges` as a field, without the empty runs, or `null` when nothing is left.
 *
 * @param {readonly ByteRange[]} ranges
 * @returns {MetadataField | null}
 */
function metadataField(ranges) {
  const segments = ranges.filter((range) => range.length > 0);
  return segments.length === 0 ? null : { segments };
}

/**
 * The `length` bytes of `source` from `base` on, as a source of their own: an image embedded in
 * another file, read as the file it would be if it stood alone.
 *
 * @param {ByteSource} source
 * @param {number} base Position of the embedded file's first byte in `source`.
 * @param {number} length Bytes it holds; clamped to what `source` has after `base`.
 * @returns {ByteSource}
 */
function embeddedSource(source, base, length) {
  const size = Math.max(0, Math.min(length, source.size - base));
  return {
    size,
    read: (position, wanted) =>
      source.read(base + position, Math.max(0, Math.min(wanted, size - position))),
  };
}

/**
 * `fields`, read from a source embedded at `base`, positioned in the enclosing file instead.
 *
 * @param {readonly MetadataField[]} fields
 * @param {number} base
 * @returns {MetadataField[]}
 */
function shiftFields(fields, base) {
  return fields.map((field) => ({
    segments: field.segments.map((segment) => ({ ...segment, offset: base + segment.offset })),
  }));
}

/**
 * The PNG text chunks and the plaintext fields of each, from its data (`base` is the data's
 * position in the file). Fields are separated by NUL bytes: `tEXt` holds a keyword and its text;
 * `zTXt` a keyword and compressed text, of which only the keyword is plaintext; `iTXt` a keyword,
 * a compression flag and method, a language tag, a translated keyword and its text, which is
 * plaintext when the flag is 0.
 *
 * @param {string} type Chunk type.
 * @param {Buffer} data Chunk data, at most {@link MAX_FIELD_BYTES} of it.
 * @param {number} base Position of `data` in the file.
 * @returns {MetadataField[]}
 */
function pngTextFields(type, data, base) {
  /**
   * @param {number} start
   * @param {number} end
   * @returns {ByteRange}
   */
  const range = (start, end) => ({ offset: base + start, length: Math.max(0, end - start) });
  /**
   * @param {number} from
   * @returns {number} The next NUL at or after `from`, or the end of the data.
   */
  const nulFrom = (from) => {
    const index = data.indexOf(0, from);
    return index === -1 ? data.length : index;
  };
  const keywordEnd = nulFrom(0);
  const ranges = [range(0, keywordEnd)];
  if (type === 'tEXt') {
    ranges.push(range(keywordEnd + 1, data.length));
  } else if (type === 'iTXt') {
    const compressed = data[keywordEnd + 1] !== 0;
    const languageStart = keywordEnd + 3;
    const languageEnd = nulFrom(languageStart);
    const translatedEnd = nulFrom(languageEnd + 1);
    ranges.push(range(languageStart, languageEnd), range(languageEnd + 1, translatedEnd));
    if (!compressed) {
      ranges.push(range(translatedEnd + 1, data.length));
    }
  }
  return ranges.map((one) => metadataField([one])).filter((field) => field !== null);
}

/** PNG chunk types whose data holds plaintext fields. */
const PNG_TEXT_CHUNKS = new Set(['tEXt', 'zTXt', 'iTXt']);

/**
 * The plaintext fields of a PNG: every field of every text chunk, wherever in the chunk sequence
 * it stands. A chunk is a four-byte big-endian data length, a four-byte type, the data and a
 * four-byte CRC; the walk stops at `IEND` or at a chunk that runs past the end of the file.
 *
 * @param {ByteSource} source
 * @returns {MetadataField[]}
 */
function pngFields(source) {
  /** @type {MetadataField[]} */
  const fields = [];
  let position = PNG_SIGNATURE.length;
  while (position + 8 <= source.size) {
    const header = source.read(position, 8);
    if (header.length < 8) {
      break;
    }
    const length = header.readUInt32BE(0);
    const type = header.toString('latin1', 4, 8);
    const dataStart = position + 8;
    if (PNG_TEXT_CHUNKS.has(type)) {
      const data = source.read(dataStart, Math.min(length, MAX_FIELD_BYTES));
      fields.push(...pngTextFields(type, data, dataStart));
    }
    if (type === 'IEND') {
      break;
    }
    position = dataStart + length + 4;
  }
  return fields;
}

/** JPEG marker of a comment segment. */
const JPEG_COMMENT = 0xfe;
/** JPEG markers of the application segments APP0 to APP15 (JFIF, EXIF, XMP, ICC, ...). */
const JPEG_APP_FIRST = 0xe0;
const JPEG_APP_LAST = 0xef;
/** JPEG markers that end the header segments: start of scan and end of image. */
const JPEG_HEADER_END = new Set([0xda, 0xd9]);

/**
 * Whether a JPEG marker stands alone, with no length or payload after it: TEM, RST0 to RST7 and
 * SOI.
 *
 * @param {number} marker
 * @returns {boolean}
 */
function isStandaloneJpegMarker(marker) {
  return marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8);
}

/**
 * The plaintext fields of a JPEG: the payload of every comment and application segment before
 * the image data. A segment is `FF`, a marker byte and a two-byte big-endian length that counts
 * itself - which is why its low byte can be a letter or a digit standing right before the text,
 * and why the payload has to be read from its own first byte. The walk stops at the start of scan,
 * the end of the image, or anything that is not a marker; the entropy-coded image data after the
 * scan header holds no segments.
 *
 * @param {ByteSource} source
 * @returns {MetadataField[]}
 */
function jpegFields(source) {
  /** @type {MetadataField[]} */
  const fields = [];
  let position = 2;
  while (position + 2 <= source.size) {
    const head = source.read(position, 4);
    const marker = head[1];
    if (head[0] !== 0xff || marker === undefined || marker === 0x00) {
      break;
    }
    if (marker === 0xff) {
      position += 1;
      continue;
    }
    if (isStandaloneJpegMarker(marker)) {
      position += 2;
      continue;
    }
    if (JPEG_HEADER_END.has(marker) || head.length < 4) {
      break;
    }
    const length = head.readUInt16BE(2);
    if (length < 2) {
      break;
    }
    const payload = position + 4;
    if (marker === JPEG_COMMENT || (marker >= JPEG_APP_FIRST && marker <= JPEG_APP_LAST)) {
      const field = metadataField([
        {
          offset: payload,
          length: Math.min(length - 2, MAX_FIELD_BYTES, Math.max(0, source.size - payload)),
        },
      ]);
      if (field !== null) {
        fields.push(field);
      }
    }
    position = payload + length - 2;
  }
  return fields;
}

/** GIF block introducers: an extension, an image descriptor. */
const GIF_EXTENSION = 0x21;
const GIF_IMAGE = 0x2c;
/** GIF extension labels whose sub-blocks hold text: plain text, application, comment. */
const GIF_PLAIN_TEXT = 0x01;
const GIF_APPLICATION = 0xff;
const GIF_COMMENT = 0xfe;

/**
 * Bytes of a GIF colour table announced by a packed field, or 0 when the field has no table.
 *
 * @param {number} packed The logical screen's or image descriptor's packed byte.
 * @returns {number}
 */
function gifColorTableBytes(packed) {
  return (packed & 0x80) === 0 ? 0 : 3 * 2 ** ((packed & 0x07) + 1);
}

/**
 * Walk a GIF sub-block sequence starting at `start`: runs of up to 255 bytes, each after its length
 * byte, ended by a zero length. The data runs are collected, up to {@link MAX_FIELD_BYTES} in
 * total, when `collect` is set.
 *
 * @param {ByteSource} source
 * @param {number} start Position of the first length byte.
 * @param {boolean} collect
 * @returns {{ blocks: ByteRange[], end: number }} `end` is the position after the terminator, or
 *   the end of the file when the sequence is truncated.
 */
function gifSubBlocks(source, start, collect) {
  /** @type {ByteRange[]} */
  const blocks = [];
  let collected = 0;
  let position = start;
  for (;;) {
    const length = source.read(position, 1)[0];
    if (length === undefined) {
      return { blocks, end: source.size };
    }
    position += 1;
    if (length === 0) {
      return { blocks, end: position };
    }
    if (collect && collected < MAX_FIELD_BYTES) {
      const taken = Math.max(
        0,
        Math.min(length, MAX_FIELD_BYTES - collected, source.size - position),
      );
      blocks.push({ offset: position, length: taken });
      collected += taken;
    }
    position += length;
  }
}

/**
 * The plaintext fields of one GIF extension, from its data sub-blocks. A comment is its
 * sub-blocks joined back together, so text a sub-block boundary split is whole again; a plain-text
 * extension's first sub-block is twelve bytes of grid geometry and its text follows; an
 * application extension's first sub-block is its identifier and authentication code, a field of
 * its own, and its data follows.
 *
 * @param {number} label
 * @param {readonly ByteRange[]} blocks
 * @returns {MetadataField[]}
 */
function gifExtensionFields(label, blocks) {
  /** @type {(MetadataField | null)[]} */
  let fields = [];
  if (label === GIF_COMMENT) {
    fields = [metadataField(blocks)];
  } else if (label === GIF_PLAIN_TEXT) {
    fields = [metadataField(blocks.slice(1))];
  } else if (label === GIF_APPLICATION) {
    fields = [metadataField(blocks.slice(0, 1)), metadataField(blocks.slice(1))];
  }
  return fields.filter((field) => field !== null);
}

/**
 * The plaintext fields of a GIF: every comment, plain-text and application extension. The walk
 * follows the block structure - header, logical screen descriptor and global colour table, then
 * extensions and images, each image's colour table and data sub-blocks skipped - and stops at the
 * trailer or at a byte that introduces no block.
 *
 * @param {ByteSource} source
 * @returns {MetadataField[]}
 */
function gifFields(source) {
  /** @type {MetadataField[]} */
  const fields = [];
  const screen = source.read(6, 7);
  const screenPacked = screen[4];
  if (screen.length < 7 || screenPacked === undefined) {
    return fields;
  }
  let position = 13 + gifColorTableBytes(screenPacked);
  while (position < source.size) {
    const introducer = source.read(position, 1)[0];
    if (introducer === GIF_EXTENSION) {
      const label = source.read(position + 1, 1)[0];
      const collect =
        label === GIF_COMMENT || label === GIF_PLAIN_TEXT || label === GIF_APPLICATION;
      const { blocks, end } = gifSubBlocks(source, position + 2, collect);
      if (label !== undefined && collect) {
        fields.push(...gifExtensionFields(label, blocks));
      }
      position = end;
    } else if (introducer === GIF_IMAGE) {
      const descriptorPacked = source.read(position + 9, 1)[0];
      if (descriptorPacked === undefined) {
        break;
      }
      // Ten descriptor bytes, the local colour table, then the LZW minimum code size.
      const data = position + 10 + gifColorTableBytes(descriptorPacked) + 1;
      position = gifSubBlocks(source, data, false).end;
    } else {
      break;
    }
  }
  return fields;
}

/**
 * The run of `length` bytes at `offset` as a field, cut to {@link MAX_FIELD_BYTES} and to the end
 * of the file, or `null` when nothing of it is in the file.
 *
 * @param {ByteSource} source
 * @param {number} offset
 * @param {number} length
 * @returns {MetadataField | null}
 */
function fileRun(source, offset, length) {
  return metadataField([
    { offset, length: Math.max(0, Math.min(length, MAX_FIELD_BYTES, source.size - offset)) },
  ]);
}

/** Bytes of an ICO file's header and of each entry of its image directory. */
const ICO_HEADER_BYTES = 6;
const ICO_ENTRY_BYTES = 16;

/**
 * The plaintext fields of an ICO file: those of every PNG image it embeds. The file is a six-byte
 * header whose last two bytes count the images, a sixteen-byte directory entry per image - its
 * size and offset in the last eight, little-endian - and the images, each a bitmap, which holds no
 * text, or a complete PNG file, whose text chunks are read as {@link pngFields} reads those of a
 * PNG standing alone. The images of a real icon are disjoint, so one that starts inside an image
 * already read is passed over, which keeps the walk linear in the file however its directory is
 * written.
 *
 * @param {ByteSource} source
 * @returns {MetadataField[]}
 */
function icoFields(source) {
  /** @type {MetadataField[]} */
  const fields = [];
  const header = source.read(0, ICO_HEADER_BYTES);
  if (header.length < ICO_HEADER_BYTES) {
    return fields;
  }
  const directory = source.read(ICO_HEADER_BYTES, header.readUInt16LE(4) * ICO_ENTRY_BYTES);
  /** @type {ByteRange[]} */
  const images = [];
  for (let entry = 0; entry + ICO_ENTRY_BYTES <= directory.length; entry += ICO_ENTRY_BYTES) {
    images.push({
      offset: directory.readUInt32LE(entry + 12),
      length: directory.readUInt32LE(entry + 8),
    });
  }
  images.sort((left, right) => left.offset - right.offset);
  let free = ICO_HEADER_BYTES + directory.length;
  for (const image of images) {
    if (image.offset < free || image.offset >= source.size) {
      continue;
    }
    const embedded = embeddedSource(source, image.offset, image.length);
    if (embedded.read(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
      fields.push(...shiftFields(pngFields(embedded), image.offset));
    }
    free = image.offset + embedded.size;
  }
  return fields;
}

/** ZIP record signatures, read as little-endian 32-bit values. */
const ZIP_END_SIGNATURE = 0x06054b50;
const ZIP_ENTRY_SIGNATURE = 0x02014b50;
const ZIP_LOCAL_SIGNATURE = 0x04034b50;
/** Fixed bytes of the end record, a central directory entry and a local header. */
const ZIP_END_BYTES = 22;
const ZIP_ENTRY_BYTES = 46;
const ZIP_LOCAL_BYTES = 30;
/** Longest archive comment, so the farthest the end record can stand from the end of the file. */
const ZIP_MAX_COMMENT_BYTES = 0xffff;
/** Values of a 16-bit and a 32-bit field whose real value is in a ZIP64 record instead. */
const ZIP64_COUNT = 0xffff;
const ZIP64_SIZE = 0xffffffff;
/** Compression method of a stored (uncompressed) entry, and the flag bit of an encrypted one. */
const ZIP_STORED = 0;
const ZIP_ENCRYPTED = 0x0001;

/**
 * The plaintext fields of a ZIP archive, which a VSIX package is: the archive comment; each
 * entry's name and comment as the central directory records them; each entry's name again in its
 * local header; and the data of every stored entry that is not encrypted - a file kept
 * uncompressed, as a writer does when deflating would not shrink it. Each follows a binary length
 * or offset field, or the name before it, with no separator: the content of a stored file starts
 * right after the last letter of its name.
 *
 * The directory is found from the end record - the last signature whose comment length fits the
 * bytes after it - and gives every entry's sizes, including those a local header leaves to a
 * trailing data descriptor. The local records of a real archive are disjoint, so one that starts
 * inside a record already read is passed over, which keeps the reads linear in the file however
 * the directory is written. A ZIP64 directory is not walked; that archive is read byte for byte
 * only, and so is everything a deflated entry holds.
 *
 * @param {ByteSource} source
 * @returns {MetadataField[]}
 */
function zipFields(source) {
  /** @type {(MetadataField | null)[]} */
  const fields = [];
  const tailStart = Math.max(0, source.size - ZIP_END_BYTES - ZIP_MAX_COMMENT_BYTES);
  const tail = source.read(tailStart, source.size - tailStart);
  let end = tail.length - ZIP_END_BYTES;
  while (
    end >= 0 &&
    (tail.readUInt32LE(end) !== ZIP_END_SIGNATURE ||
      end + ZIP_END_BYTES + tail.readUInt16LE(end + 20) > tail.length)
  ) {
    end -= 1;
  }
  if (end < 0) {
    return [];
  }
  const endRecord = tailStart + end;
  fields.push(fileRun(source, endRecord + ZIP_END_BYTES, tail.readUInt16LE(end + 20)));
  const entries = tail.readUInt16LE(end + 10);
  const directorySize = tail.readUInt32LE(end + 12);
  const directoryStart = tail.readUInt32LE(end + 16);
  /** @type {{ local: number, size: number, stored: boolean }[]} */
  const records = [];
  if (entries !== ZIP64_COUNT && directorySize !== ZIP64_SIZE && directoryStart !== ZIP64_SIZE) {
    const directoryEnd = Math.min(directoryStart + directorySize, endRecord);
    let position = directoryStart;
    for (let count = 0; count < entries && position + ZIP_ENTRY_BYTES <= directoryEnd; count += 1) {
      const entry = source.read(position, ZIP_ENTRY_BYTES);
      if (entry.length < ZIP_ENTRY_BYTES || entry.readUInt32LE(0) !== ZIP_ENTRY_SIGNATURE) {
        break;
      }
      const name = position + ZIP_ENTRY_BYTES;
      const nameLength = entry.readUInt16LE(28);
      const extraLength = entry.readUInt16LE(30);
      const commentLength = entry.readUInt16LE(32);
      fields.push(
        fileRun(source, name, nameLength),
        fileRun(source, name + nameLength + extraLength, commentLength),
      );
      records.push({
        local: entry.readUInt32LE(42),
        size: entry.readUInt32LE(20),
        stored:
          entry.readUInt16LE(10) === ZIP_STORED && (entry.readUInt16LE(8) & ZIP_ENCRYPTED) === 0,
      });
      position = name + nameLength + extraLength + commentLength;
    }
  }
  records.sort((left, right) => left.local - right.local);
  let free = 0;
  for (const record of records) {
    const header = record.local < free ? null : source.read(record.local, ZIP_LOCAL_BYTES);
    if (
      header === null ||
      header.length < ZIP_LOCAL_BYTES ||
      header.readUInt32LE(0) !== ZIP_LOCAL_SIGNATURE
    ) {
      continue;
    }
    const name = record.local + ZIP_LOCAL_BYTES;
    const nameLength = header.readUInt16LE(26);
    const data = name + nameLength + header.readUInt16LE(28);
    const size = record.size === ZIP64_SIZE ? 0 : record.size;
    fields.push(fileRun(source, name, nameLength));
    if (record.stored) {
      fields.push(fileRun(source, data, size));
    }
    free = data + size;
  }
  return fields.filter((field) => field !== null);
}

/** Position, in a WOFF and in a WOFF2 header, of the private data block's offset field. */
const WOFF_PRIVATE_FIELD = 36;
const WOFF2_PRIVATE_FIELD = 40;

/**
 * A reader of the plaintext field of a WOFF or WOFF2 font: its private data block, which a font
 * tool may fill with anything and which is never compressed. The header records its big-endian
 * offset and, after that, its length; the block follows the table data or the compressed metadata
 * on a four-byte boundary with no separator of its own. The font tables are compressed - WOFF2's
 * always, WOFF's when that shrinks them - or, left uncompressed, binary structures whose strings
 * sit back to back, and are read byte for byte only.
 *
 * @param {number} privateField Position of the private block's offset field in the header.
 * @returns {(source: ByteSource) => MetadataField[]}
 */
function fontPrivateDataFields(privateField) {
  return (source) => {
    const header = source.read(privateField, 8);
    if (header.length < 8 || header.readUInt32BE(0) === 0) {
      return [];
    }
    const field = fileRun(source, header.readUInt32BE(0), header.readUInt32BE(4));
    return field === null ? [] : [field];
  };
}

/**
 * The field reader of each binary format, by format name. PDF has none: its syntax delimits every
 * value with bytes that end a token - a string between parentheses, a name after a solidus,
 * stream data after the line break that follows `stream` - so the byte-for-byte pass already
 * reads each value from its first byte, and a compressed stream is read by neither pass.
 *
 * @type {Readonly<Record<string, (source: ByteSource) => MetadataField[]>>}
 */
const METADATA_FIELD_READERS = Object.freeze({
  png: pngFields,
  ico: icoFields,
  jpeg: jpegFields,
  gif: gifFields,
  woff: fontPrivateDataFields(WOFF_PRIVATE_FIELD),
  woff2: fontPrivateDataFields(WOFF2_PRIVATE_FIELD),
  vsix: zipFields,
});

/**
 * Line and column of every position in a file, as the byte-for-byte pass numbers them: a line
 * ends at each 0x0A byte, and a column counts bytes from the line's first. The line-feed positions
 * are collected once, on first use, which is only ever for a file with a field finding.
 *
 * @param {ByteSource} source
 * @returns {(offset: number) => { line: number, column: number }}
 */
function positionLocator(source) {
  /** @type {number[] | null} */
  let lineFeeds = null;
  const collect = () => {
    /** @type {number[]} */
    const found = [];
    for (let start = 0; start < source.size; start += STREAM_CHUNK_BYTES) {
      const chunk = source.read(start, STREAM_CHUNK_BYTES);
      let index = chunk.indexOf(0x0a);
      while (index !== -1) {
        found.push(start + index);
        index = chunk.indexOf(0x0a, index + 1);
      }
    }
    return found;
  };
  return (offset) => {
    lineFeeds ??= collect();
    let low = 0;
    let high = lineFeeds.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if ((lineFeeds[middle] ?? 0) < offset) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    const lineStart = low === 0 ? 0 : (lineFeeds[low - 1] ?? -1) + 1;
    return { line: low + 1, column: offset - lineStart + 1 };
  };
}

/**
 * Position in the file of byte `index` of a field's joined text.
 *
 * @param {readonly ByteRange[]} segments
 * @param {number} index
 * @returns {number}
 */
function fieldOffset(segments, index) {
  let remaining = index;
  for (const segment of segments) {
    if (remaining < segment.length) {
      return segment.offset + remaining;
    }
    remaining -= segment.length;
  }
  const last = segments.at(-1);
  return last === undefined ? 0 : last.offset + last.length;
}

/**
 * Where each line of `text` starts, by `text.split(/\r?\n/)` numbering: line `n` starts at index
 * `n - 1` of the result.
 *
 * @param {string} text
 * @returns {number[]}
 */
function lineStartsOf(text) {
  const starts = [0];
  let index = text.indexOf('\n');
  while (index !== -1) {
    starts.push(index + 1);
    index = text.indexOf('\n', index + 1);
  }
  return starts;
}

/**
 * The identity of a finding for merging the two binary passes: rule, line and column.
 *
 * @param {Finding} finding
 * @returns {string}
 */
function findingKey(finding) {
  return `${finding.rule}:${String(finding.line)}:${String(finding.column)}`;
}

/**
 * Scan the plaintext metadata fields of a positively identified binary, each as text of its own,
 * and merge what they add into `sink`, which holds the same file's byte-for-byte findings.
 *
 * WHY A SECOND PASS. The byte-for-byte pass reads a value where it stands, so whatever byte comes
 * before it is its left context - and in a binary that byte is often a length field. A JPEG
 * comment of 67 bytes follows the length `00 45`, and `E` is a token character: the credential
 * prefix at the start of the comment does not start a token there, and the rules' left boundary,
 * which keeps prose like `task-...` from reading as a key, rejects it. The content of a file a ZIP
 * archive stores uncompressed begins right after the last letter of its name, in the same way. A
 * GIF value longer than 255 bytes is split by length bytes into sub-blocks, so no single run holds
 * it whole. Reading each field from its own first byte, and a GIF field's sub-blocks joined,
 * restores the boundaries and the continuity the value has in the format, and every content rule,
 * `entropy` included, then judges it exactly as it judges a line of text.
 *
 * A finding is reported at its position in the file - the line and column the byte-for-byte pass
 * uses - and once. Where both passes report a rule at the same position, which is the common case,
 * the field pass's report stands: its boundaries are the format's, so it names the key without a
 * length byte glued to it and judges the allowlist on the value alone. The file's findings end in
 * line then column order.
 *
 * @param {string} relPath Repository-relative POSIX path.
 * @param {Allowlist} allowlist Validated allowlist.
 * @param {string} format The format {@link identifyBinary} named.
 * @param {ByteSource} source The file's bytes.
 * @param {ContentSink} sink This file's findings so far, and only this file's.
 */
function scanMetadataFieldsInto(relPath, allowlist, format, source, sink) {
  const readFields = METADATA_FIELD_READERS[format];
  if (readFields === undefined) {
    return;
  }
  const locate = positionLocator(source);
  /** @type {Map<string, Finding>} */
  const fieldFindings = new Map();
  /** @type {Map<string, AllowlistedFinding>} */
  const fieldAllowlisted = new Map();
  for (const field of readFields(source)) {
    const bytes = Buffer.concat(
      field.segments.map((segment) => source.read(segment.offset, segment.length)),
    );
    const text = bytes.toString('latin1');
    /** @type {ContentSink} */
    const fieldSink = { findings: [], allowlisted: [] };
    scanTextInto(relPath, allowlist, text, fieldSink);
    if (fieldSink.findings.length === 0 && fieldSink.allowlisted.length === 0) {
      continue;
    }
    const starts = lineStartsOf(text);
    /**
     * @template {Finding} T
     * @param {T} finding A finding positioned in the field's text.
     * @returns {T} The same finding positioned in the file.
     */
    const place = (finding) => {
      const index = (starts[finding.line - 1] ?? 0) + finding.column - 1;
      return { ...finding, ...locate(fieldOffset(field.segments, index)) };
    };
    for (const finding of fieldSink.findings.map(place)) {
      fieldFindings.set(findingKey(finding), finding);
    }
    for (const finding of fieldSink.allowlisted.map(place)) {
      fieldAllowlisted.set(findingKey(finding), finding);
    }
  }
  if (fieldFindings.size === 0 && fieldAllowlisted.size === 0) {
    return;
  }
  /** @param {Finding} finding */
  const notReplaced = (finding) =>
    !fieldFindings.has(findingKey(finding)) && !fieldAllowlisted.has(findingKey(finding));
  const byPosition = (/** @type {Finding} */ left, /** @type {Finding} */ right) =>
    left.line - right.line || left.column - right.column;
  const findings = [...sink.findings.filter(notReplaced), ...fieldFindings.values()];
  const allowlisted = [...sink.allowlisted.filter(notReplaced), ...fieldAllowlisted.values()];
  sink.findings.splice(0, sink.findings.length, ...findings.sort(byPosition));
  sink.allowlisted.splice(0, sink.allowlisted.length, ...allowlisted.sort(byPosition));
}

/**
 * Move the findings of one file's `local` sink into `sink`.
 *
 * @param {ContentSink} sink
 * @param {ContentSink} local
 */
function appendSink(sink, local) {
  sink.findings.push(...local.findings);
  sink.allowlisted.push(...local.allowlisted);
}

/**
 * Incremental line splitting for text that arrives in decoded pieces.
 *
 * @typedef {object} LineAssembler
 * @property {(text: string) => void} push Consume newly decoded text, scanning every line it
 *   completes.
 * @property {() => void} end Scan the final line - the text after the last `\n`, which may be
 *   empty - once the input is exhausted.
 */

/**
 * A {@link LineAssembler} that scans each line through {@link scanLineInto} into `sink` as soon as
 * its terminator arrives.
 *
 * Line semantics are exactly those of `content.split(/\r?\n/)` in {@link scanTextInto}, so text
 * fed in pieces reports the same findings at the same lines and columns as the same text split
 * whole:
 *
 *   - `\n` ends a line, and a `\r` immediately before it belongs to the terminator - including a
 *     `\r` that ended the previous piece while its `\n` opened this one, because the pieces of a
 *     line are joined before the `\r` is stripped;
 *   - a lone `\r`, and a `\r` at the very end of the input, stay in the line;
 *   - lines are numbered from 1, and the text after the last `\n` is the final line.
 *
 * Newlines are searched for in each piece only, and the pieces of a line are joined once when it
 * ends, so a long line costs linear time and a credential that straddles two pieces is matched on
 * the joined line.
 *
 * @param {string} relPath Repository-relative POSIX path.
 * @param {Allowlist} allowlist Validated allowlist.
 * @param {ContentSink} sink
 * @returns {LineAssembler}
 */
function lineAssembler(relPath, allowlist, sink) {
  /** @type {string[]} */
  let pieces = [];
  let lineNumber = 1;
  return {
    push(text) {
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
    },
    end() {
      scanLineInto(relPath, allowlist, lineNumber, pieces.join(''), sink);
      // An empty line is never scanned, so a second call cannot report the last line twice.
      pieces = [];
    },
  };
}

/**
 * Stream a file larger than {@link MAX_SCAN_BYTES} through the per-line rule pass in
 * {@link STREAM_CHUNK_BYTES} chunks. The first chunk decides the mode: a file it identifies as a
 * binary format is streamed in binary mode, and every other file as text - and, when
 * {@link detectUtf16} classifies that same chunk as UTF-16, as UTF-16 too. The detector samples
 * {@link UTF16_SAMPLE_BYTES}, which is no larger than a chunk, so a file is classified exactly as
 * the in-memory path would classify it.
 *
 * Each reading has its own decoder and its own {@link lineAssembler}, so each keeps exactly the
 * line and column semantics of {@link scanTextInto} over the text it decodes. The UTF-8 (or
 * latin1) reading is decoded by one `StringDecoder` for the whole file. In text mode it holds back
 * a multi-byte UTF-8 sequence split across two chunks until its remaining bytes arrive, so a
 * character straddling a chunk boundary decodes once, correctly, instead of as two replacement
 * characters that would shift every later column on its line; in binary mode it decodes latin1,
 * where every byte is a character of its own. The UTF-16 reading is decoded by one streaming
 * `TextDecoder` (see {@link utf16Decoder}), which likewise carries an odd trailing byte or the
 * leading half of a surrogate pair over to the next chunk inside its own state - never as a view
 * of the chunk buffer, which the next read overwrites.
 *
 * The UTF-16 reading's findings are merged into `sink` when the stream ends, or when a read fails:
 * both readings' findings from the part already read are real and are kept.
 *
 * @param {number} fd Open descriptor of the file.
 * @param {string} relPath Repository-relative POSIX path.
 * @param {Allowlist} allowlist Validated allowlist.
 * @param {ContentSink} sink This file's findings, and only this file's: the UTF-16 reading is
 *   merged into it in line then column order.
 * @returns {RegularFileOutcome}
 * @throws {TrackedFileReadError} When a read fails; findings from the part already read stay in
 *   `sink`, because they are real.
 */
function streamScanFile(fd, relPath, allowlist, sink) {
  const chunk = Buffer.allocUnsafe(STREAM_CHUNK_BYTES);
  let bytesRead = fileRead(() => readSync(fd, chunk, 0, chunk.length, 0));
  const leading = chunk.subarray(0, bytesRead);
  const format = identifyBinary(relPath, leading);
  // A positively identified binary is never read as UTF-16; a text file is classified here, from
  // the first chunk, before the buffer is reused.
  const utf16 = format === null ? detectUtf16(leading) : null;
  // Binary mode decodes latin1; its metadata-field pass is the caller's (see scanRegularFile),
  // because it needs random access to the file rather than the stream.
  const decoder = new StringDecoder(format === null ? 'utf8' : 'latin1');
  const lines = lineAssembler(relPath, allowlist, sink);
  /** @type {ContentSink} */
  const decodedSink = { findings: [], allowlisted: [] };
  const wide =
    utf16 === null
      ? null
      : {
          decoder: utf16Decoder(utf16.encoding),
          lines: lineAssembler(relPath, allowlist, decodedSink),
        };

  try {
    let position = 0;
    while (bytesRead > 0) {
      position += bytesRead;
      const bytes = chunk.subarray(0, bytesRead);
      lines.push(decoder.write(bytes));
      if (wide !== null) {
        wide.lines.push(wide.decoder.decode(bytes, { stream: true }));
      }
      const offset = position;
      bytesRead = fileRead(() => readSync(fd, chunk, 0, chunk.length, offset));
    }
    lines.push(decoder.end());
    lines.end();
    if (wide !== null) {
      wide.lines.push(wide.decoder.decode());
      wide.lines.end();
    }
  } finally {
    if (utf16 !== null) {
      mergeDecodedInto(sink, decodedSink, utf16.encoding);
    }
  }
  return regularFileOutcome(format, utf16);
}

/**
 * Read and scan one regular file: as text, or - when its extension and leading bytes identify a
 * binary format - in binary mode (see {@link ContentMode}).
 *
 * A file up to {@link MAX_SCAN_BYTES} is read whole; a larger one is streamed by
 * {@link streamScanFile}. Either way the leading bytes decide binary identification and, for a
 * text file, UTF-16 classification (see {@link detectUtf16}), and every line goes through
 * {@link scanLineInto}; a binary's metadata fields then go through
 * {@link scanMetadataFieldsInto}, over the buffer or the open descriptor. A binary's findings, and
 * a UTF-16 file's, are gathered for the file on its own first, so its two passes merge into one
 * position-ordered list.
 *
 * @param {string} absolute Absolute path of the file.
 * @param {string} relPath Repository-relative POSIX path.
 * @param {number} size Size the work-tree entry reported.
 * @param {Allowlist} allowlist Validated allowlist.
 * @param {ContentSink} sink
 * @returns {RegularFileOutcome}
 * @throws {TrackedFileReadError} When the file cannot be opened or read; findings from the part
 *   already read are in `sink`, because they are real.
 */
function scanRegularFile(absolute, relPath, size, allowlist, sink) {
  if (size <= MAX_SCAN_BYTES) {
    const buffer = fileRead(() => readFileSync(absolute));
    const format = identifyBinary(relPath, buffer);
    if (format === null) {
      return regularFileOutcome(null, scanTextBytesInto(relPath, allowlist, buffer, sink));
    }
    /** @type {ContentSink} */
    const local = { findings: [], allowlisted: [] };
    scanTextInto(relPath, allowlist, buffer.toString('latin1'), local);
    scanMetadataFieldsInto(relPath, allowlist, format, bufferSource(buffer), local);
    appendSink(sink, local);
    return regularFileOutcome(format, null);
  }
  const fd = fileRead(() => openSync(absolute, 'r'));
  /** @type {ContentSink} */
  const local = { findings: [], allowlisted: [] };
  try {
    const outcome = streamScanFile(fd, relPath, allowlist, local);
    if (outcome.kind === 'binary') {
      scanMetadataFieldsInto(relPath, allowlist, outcome.format, descriptorSource(fd, size), local);
    }
    return outcome;
  } finally {
    appendSink(sink, local);
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
 *   - A regular file is read (streamed when large) and scanned: as text, or byte for byte in binary
 *     mode when it is a positively identified binary, which is reported as `binary` so the report
 *     lists it. A text file {@link detectUtf16} classifies as UTF-16 is read as UTF-8 and as
 *     UTF-16, and is reported as `utf16` so the report lists it too. A regular file standing where
 *     git tracks a symbolic link is scanned too: that is how a checkout with `core.symlinks=false`
 *     stores the link, as a file holding its target.
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
 * @returns {{ kind: 'scanned' } | { kind: 'binary', entry: BinaryFile } |
 *   { kind: 'utf16', entry: Utf16File } | { kind: 'skipped', entry: SkippedFile } |
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
    if (outcome.kind === 'binary') {
      return { kind: 'binary', entry: { file, format: outcome.format, bytes: stats.size } };
    }
    if (outcome.kind === 'utf16') {
      return { kind: 'utf16', entry: { file, encoding: outcome.encoding, bom: outcome.bom } };
    }
    return outcome;
  } catch (error) {
    if (error instanceof TrackedFileReadError) {
      return unscanned(file, 'unreadable', error.message);
    }
    throw error;
  }
}

/**
 * A tracked file scanned in binary mode: its extension and its leading bytes agree on a format in
 * {@link BINARY_FORMATS}, so it was scanned against every content rule byte for byte and, for
 * every format but PDF, field by field (see {@link scanMetadataFieldsInto}). It is counted in
 * `filesScanned` as well.
 *
 * What binary mode sees is what the format stores as plain ASCII bytes: PNG `tEXt` and
 * uncompressed `iTXt` fields and every chunk keyword, in a PNG file or in a PNG image of an ICO
 * file; JPEG comment and application segments (EXIF text, XMP packets); GIF comment, plain-text
 * and application extensions with their sub-blocks joined; ZIP (VSIX) entry names, entry comments,
 * the archive comment and stored entries; the WOFF and WOFF2 private data block; and uncompressed
 * PDF objects. Nothing is decompressed or decoded, so a credential inside a PNG `zTXt` or
 * compressed `iTXt` chunk or image data, a PDF Flate stream, a deflated ZIP or VSIX entry, or a
 * compressed WOFF or WOFF2 table is not seen, nor is one stored as UTF-16, as hexadecimal or as a
 * PDF octal escape. Where no field is parsed out - inside an EXIF structure, inside a file stored
 * in a ZIP archive, in an uncompressed font table, in a JPEG segment after the start of scan, in a
 * ZIP64 archive's directory, past the first {@link MAX_FIELD_BYTES} of a field - the bytes around a
 * value are its context, so a value glued to a preceding letter or digit does not start a token
 * there.
 *
 * @typedef {object} BinaryFile
 * @property {string} file Repository-relative POSIX path.
 * @property {string} format The identified format, for example `png`.
 * @property {number} bytes Size in bytes.
 */

/**
 * A tracked text file {@link detectUtf16} classified as UTF-16, so it was scanned against every
 * content rule twice: as UTF-8, like every text file, and as the text its UTF-16 decoding yields,
 * whose findings name the encoding in their message. It is counted in `filesScanned` as well.
 *
 * @typedef {object} Utf16File
 * @property {string} file Repository-relative POSIX path.
 * @property {Utf16Encoding} encoding The byte order it was decoded in.
 * @property {boolean} bom Whether a byte-order mark announced it; `false` when the NUL parity of
 *   its leading bytes did.
 */

/**
 * A tracked entry the scan did not read because its content is not stored in this repository.
 *
 * @typedef {object} SkippedFile
 * @property {string} file Repository-relative POSIX path.
 * @property {'submodule'} reason A gitlink, whose content is another repository's.
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
 *   text - was read and scanned, binaries and UTF-16 files included.
 * @property {Finding[]} findings Violations, in file then line then column order.
 * @property {AllowlistedFinding[]} allowlisted Matches an allowlist entry exempted.
 * @property {BinaryFile[]} binaries The scanned files that were positively identified binaries:
 *   scanned against every content rule byte for byte and by metadata field, compressed payloads
 *   not inflated.
 * @property {Utf16File[]} utf16 The scanned text files classified as UTF-16: scanned against
 *   every content rule as UTF-8 and as UTF-16. Always present; empty when there are none.
 * @property {SkippedFile[]} skipped Submodules, whose content is another repository's.
 * @property {UnscannedFile[]} unscanned Files that could not be examined; non-empty means the run
 *   proves nothing and exits {@link EXIT_ERROR}.
 */

/**
 * Scan a checkout: enumerate tracked files, apply every rule, and return the report.
 *
 * Every tracked entry ends up in exactly one of three places: scanned (counted in
 * `filesScanned`, and listed in `binaries` too when it was scanned in binary mode, or in `utf16`
 * when it was also read as UTF-16), `skipped` (a submodule), or `unscanned` (see
 * {@link examineTrackedFile}). An unscanned file does not throw -
 * the rest of the tree is still scanned and reported, so one missing file does not hide a
 * credential elsewhere - but it makes the report's `exitCode` {@link EXIT_ERROR} and `ok` false.
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
  /** @type {BinaryFile[]} */
  const binaries = [];
  /** @type {Utf16File[]} */
  const utf16 = [];
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
    } else if (outcome.kind === 'binary') {
      filesScanned += 1;
      binaries.push(outcome.entry);
    } else if (outcome.kind === 'utf16') {
      filesScanned += 1;
      utf16.push(outcome.entry);
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
    binaries,
    utf16,
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

  // Each kind of scan beyond plain text is counted only when it happened, so a repository with
  // neither binaries nor UTF-16 files prints the bare count.
  /** @type {string[]} */
  const scannedNotes = [];
  if (report.binaries.length > 0) {
    scannedNotes.push(`${report.binaries.length} binary`);
  }
  if (report.utf16.length > 0) {
    scannedNotes.push(`${report.utf16.length} UTF-16`);
  }
  const scannedNote = scannedNotes.length > 0 ? ` (${scannedNotes.join(', ')})` : '';
  const parts = [
    `${report.filesScanned} ${plural(report.filesScanned, 'file')} scanned${scannedNote}`,
    `${report.findings.length} ${plural(report.findings.length, 'finding')}`,
    `${report.allowlisted.length} allowlisted`,
  ];
  if (report.skipped.length > 0) {
    parts.push(`${report.skipped.length} skipped (submodule)`);
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
  const binaryFormats = BINARY_FORMATS.map(({ format }) => format.toUpperCase()).join(', ');
  return [
    'Usage: node scripts/check-secrets.mjs [options]',
    '',
    'Fails when a path git tracks, or the content it tracks, matches one of these credential',
    'shapes. A text file is checked against every rule - one over 2 MiB is streamed - and so is',
    'a symbolic link, read as its target text and never followed:',
    '',
    ...RULES.map((rule) => `  ${rule.id.padEnd(18)} ${rule.summary}`),
    '',
    'Text is read as UTF-8. A text file that is recognisably UTF-16 - a UTF-16LE or UTF-16BE',
    'byte-order mark, or NUL bytes concentrated at odd (little-endian) or even (big-endian)',
    `offsets of its first ${String(UTF16_SAMPLE_BYTES / 1024)} KiB - is checked a second time as ` +
      'its UTF-16 decoding, whose',
    'findings name the encoding; the report counts it as scanned and lists it under "utf16". Still',
    'read as UTF-8 only: BOM-less UTF-16 text too sparse in ASCII to meet that threshold, UTF-32,',
    'and every other legacy encoding.',
    '',
    'A positively identified binary - its extension and leading bytes agree on one of the',
    `formats ${binaryFormats} -`,
    'is checked against the same rules byte for byte, and its plaintext metadata fields are',
    'checked again each from its own first byte, so a length prefix or a name before a value',
    'cannot hide its start: PNG text chunks, also in ICO images; JPEG comment and application',
    'segments; GIF extension blocks with their sub-blocks joined; ZIP (VSIX) entry names, comments',
    'and stored entries and the archive comment; the WOFF and WOFF2 private data block. PDF',
    'delimits its values itself. Nothing is decompressed, so a credential inside compressed data -',
    'PNG zTXt, compressed iTXt and image data, PDF Flate streams, deflated ZIP and VSIX entries,',
    'compressed WOFF and WOFF2 tables - is not seen, nor is text a format encodes (UTF-16 inside',
    'a binary, hexadecimal). The report counts binaries as scanned and lists them under',
    '"binaries". A submodule is skipped, because its content is another repository\u2019s, and is',
    'listed under "skipped".',
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
        `unexpected argument: ${arg}. This check takes no paths; it scans what git tracks.`,
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
