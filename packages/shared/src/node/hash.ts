/**
 * Cryptographic digests for the whole product — the Node-only half of
 * `@debuggen/shared`.
 *
 * Every hash this product persists, compares or uses as a filename is
 * constructed here and nowhere else: the recorded hashes of a file before and
 * after a reversible edit, the name of the backup that holds the original
 * bytes, the stored form of a credential or a one-time code, the cache key of
 * the static-analysis index, and the keyed identity that lets two
 * byte-identical requests be recognised as the same request. Concentrating
 * them in one module is what makes a hash written by one version of the
 * product verifiable by the next: there is exactly one construction to keep
 * stable, and it is this one.
 *
 * ## Why this file is behind the `./node` entry
 *
 * The package publishes two disjoint entries. The root entry (`.`) is bundled
 * into a page — the MAIN-world telemetry agent that runs at `document_start`,
 * the design-system renderer, the DevTools panel and the editor webview — and
 * none of those can resolve a `node:` specifier. So `node:crypto` and
 * `node:fs` live here, behind `@debuggen/shared/node`, and the root entry
 * never imports this module. A consumer that needs both sides imports both
 * entries; the boundary is asserted by the sibling entry-boundary test, which
 * scans the non-test modules directly under `src` for `node:` specifiers and
 * asserts that the root barrel exports none of the five functions below.
 *
 * ## The byte-fidelity invariant
 *
 * **These functions hash raw bytes. Nothing here decodes, re-encodes, trims,
 * strips a byte-order mark or normalises a line ending.**
 *
 * That is not a stylistic preference, it is the mechanism behind the product's
 * reversibility guarantee. A reversible source edit records the file's digest
 * before it is written, stores the original bytes in a backup named after that
 * digest, and at cleanup restores the backup only when the file's current
 * digest still matches the digest recorded for the edited content. If a hash
 * function folded `\r\n` into `\n`, then on a checkout that uses CRLF line
 * endings two different files would hash alike: an edit would report itself
 * reversible and would not be, and a file that could have been restored would
 * instead be reported as a conflict. So a digest is a statement about bytes,
 * and the only safe statement is the literal one.
 *
 * ## Shape of every result
 *
 * Every function returns lowercase hexadecimal — 64 characters for SHA-256 and
 * HMAC-SHA256 — because that is what Node's `digest('hex')` produces, and
 * because the values are compared as strings and used as path segments. No
 * result is upper-cased, truncated or re-encoded on the way out.
 *
 * The module has no default export, adds nothing to the surface beyond the
 * five functions below, and performs no work at load time: importing it opens
 * no file, reads no environment variable and touches no global.
 */
import { createHash, createHmac, type Hash } from 'node:crypto';
import { createReadStream, readFileSync } from 'node:fs';

import { DebuggenError } from '../errors.js';

/**
 * What a digest can be computed over: text, which is encoded as UTF-8, or
 * bytes, which are used exactly as given.
 *
 * Deliberately not exported. The `./node` surface is the five functions of
 * this module plus the filesystem helpers of its sibling, so a name that only
 * describes a parameter stays internal.
 */
type HashInput = string | Uint8Array;

/**
 * One element of a {@link stableHash} part list.
 *
 * `number` is accepted because the composed keys this product builds are
 * mostly text and timestamps, and requiring the caller to stringify a
 * timestamp would put the canonical form of a number in the caller's hands
 * instead of here.
 */
type HashPart = string | number | Uint8Array;

/**
 * The tag byte that precedes a part's length in the {@link stableHash} frame,
 * one per accepted part type. Its only job is to keep a part of one type from
 * ever producing the same frame as a part of another.
 */
const PART_TAG = {
  string: 's',
  number: 'n',
  bytes: 'b',
} as const;

/**
 * Separates a {@link stableHash} frame's decimal length from the part bytes
 * that follow it. Any non-digit byte would do; a colon is chosen because it
 * makes a hex dump of the hashed stream readable during debugging.
 */
const PART_LENGTH_TERMINATOR = ':';

/**
 * The SHA-256 digest of `input`, as 64 lowercase hexadecimal characters.
 *
 * A `string` is encoded as UTF-8 — the encoding is passed to the digest
 * explicitly rather than inferred — and a `Uint8Array` is hashed exactly as
 * given, so `sha256Hex(text)` and `sha256Hex(new TextEncoder().encode(text))`
 * always agree. The caller owns the encoding decision: text that must be
 * hashed as something other than UTF-8 is encoded by the caller and passed as
 * bytes.
 *
 * Callers include the access boundary of the local service, which stores a
 * credential or a one-time pairing code only as its digest
 * (`apps/local-service/src/server/auth.ts`), and the reversible-edit writer,
 * which hashes the edited content it holds in memory before writing it
 * (`packages/instrumentation/src/patch/patcher.ts`).
 *
 * @param input Text to hash as UTF-8, or bytes to hash verbatim.
 * @returns The digest as lowercase hex, 64 characters, matching
 * `/^[0-9a-f]{64}$/`.
 *
 * @example
 * ```ts
 * sha256Hex('');
 * // 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
 * ```
 */
export function sha256Hex(input: HashInput): string {
  const hash = createHash('sha256');
  if (typeof input === 'string') {
    hash.update(input, 'utf8');
  } else {
    hash.update(input);
  }
  return hash.digest('hex');
}

/**
 * The SHA-256 digest of the bytes stored at `path`, as 64 lowercase
 * hexadecimal characters.
 *
 * **Byte-fidelity.** The file is read as bytes and hashed as bytes. It is
 * never decoded as text, so content that differs only in its line endings
 * produces different digests, content that is not valid UTF-8 is hashed
 * without loss, and a leading byte-order mark is part of the file rather than
 * something to strip. That literalness is what keeps a recorded digest a
 * usable proof that a file is unchanged — and therefore what keeps a
 * reversible source edit reversible on any checkout.
 *
 * The file is streamed and hashed chunk by chunk, so a large file is never
 * held in memory whole, and the result is identical to
 * {@link sha256OfFileSync} for the same bytes.
 *
 * **Errors propagate unchanged.** A missing path, a permission failure or a
 * directory rejects with the runtime's own error, carrying its original `code`
 * (`ENOENT`, `EACCES`, `EISDIR`). Nothing is caught and re-thrown, because a
 * caller deciding what to do next — and a test asserting on that decision —
 * needs the errno, not a wrapper's paraphrase of it.
 *
 * **Symlinks are followed**, which is ordinary read behaviour and the right
 * behaviour here: the digest has to describe the bytes a reader of that path
 * actually gets. A read that must refuse to follow a symlink — because the
 * path came from outside and the final component is not trusted — belongs to
 * `readFileNoFollow` in the sibling `./safe-fs.js`, which exists for exactly
 * that case.
 *
 * @param path Filesystem path to read. Absolute or relative to the process's
 * working directory, resolved by the runtime as any other read would be.
 * @returns A promise for the digest as lowercase hex, 64 characters.
 * @throws The runtime's own filesystem error, with its `code` intact, when the
 * path cannot be read.
 */
export async function sha256OfFile(path: string): Promise<string> {
  const hash = createHash('sha256');

  // Annotated as an async iterable of bytes so the loop variable below has a
  // real type: the stream's own declaration yields `any`, which would make
  // every `update` call an unchecked one.
  const stream: AsyncIterable<Uint8Array> = createReadStream(path);

  // `for await` destroys the stream when the loop ends — including when it
  // ends by throwing — so a failed read leaks no file descriptor.
  for await (const chunk of stream) {
    hash.update(chunk);
  }

  return hash.digest('hex');
}

/**
 * The SHA-256 digest of the bytes stored at `path`, computed synchronously, as
 * 64 lowercase hexadecimal characters.
 *
 * **Agrees with {@link sha256OfFile} byte for byte.** The two functions are
 * interchangeable by contract, differing only in how they read: this one reads
 * the file in a single call, the other streams it. The same byte-fidelity
 * rules apply — bytes in, bytes hashed, no decoding, no line-ending
 * normalisation, no byte-order-mark stripping — and filesystem errors
 * propagate unchanged with their original `code`.
 *
 * **Why a synchronous variant exists.** The local service reconciles the
 * record of every outstanding file edit at start-up, *before* it begins
 * serving: for each record it hashes the file as it stands and compares that
 * digest with the two recorded ones to decide whether the edit was never
 * written, should be restored from its backup, or has been overtaken by a
 * developer's own change. That decision table is only sound if no other work
 * interleaves with it, so the reconciliation pass reads synchronously and this
 * is the function it calls. Ordinary request-path code hashes with
 * {@link sha256OfFile} instead.
 *
 * Because the read is not streamed, the whole file is held in memory for the
 * duration of the call. That is the right trade for the source files and
 * backups this is used on, and the reason the asynchronous variant is the
 * default everywhere else.
 *
 * @param path Filesystem path to read, with the same resolution and
 * symlink-following behaviour as {@link sha256OfFile}.
 * @returns The digest as lowercase hex, 64 characters.
 * @throws The runtime's own filesystem error, with its `code` intact, when the
 * path cannot be read.
 */
export function sha256OfFileSync(path: string): string {
  return sha256Hex(readFileSync(path));
}

/**
 * One digest over an ordered list of parts, framed so that no two different
 * lists can produce the same digest.
 *
 * Concatenating parts before hashing them is the classic way to build a key
 * that quietly collides: `['a', 'bc']` and `['ab', 'c']` are different lists
 * with the same concatenation, and a cache that treats them alike serves one
 * entry's data for the other's question. Each part is therefore written into
 * the digest as a self-delimiting frame:
 *
 * ```text
 * <tag><byte length in decimal><':'><the part's bytes>
 * ```
 *
 * The tag records the part's type (`s` text, `n` number, `b` bytes), the
 * length is the exact number of bytes that follow, and the terminator can
 * never appear inside the decimal length. A reader could therefore recover the
 * original list from the hashed stream unambiguously, which is precisely why
 * two different lists cannot share one. Two consequences worth stating:
 * `['a', 'bc']` and `['ab', 'c']` differ, and so do `['1']` and `[1]` — the
 * same text under a different tag is a different key.
 *
 * **Numbers** are canonicalised with the language's own number-to-string
 * conversion, which is fully specified and stable, so the same value always
 * contributes the same bytes. Only finite values are accepted: a non-finite
 * one would otherwise contribute the bytes of `NaN` or `Infinity` and two
 * genuinely different keys would silently agree, which in a cache is not a
 * cosmetic defect but a wrong answer served from a hit. Note that `-0` and `0`
 * canonicalise alike, as the two are numerically equal; a caller that must
 * distinguish them passes text instead.
 *
 * **An empty list is legal** and returns the digest of the empty byte stream —
 * the same value as `sha256Hex('')` — which gives a caller with nothing to say
 * a stable key rather than an error.
 *
 * The composed key this exists for is the static-analysis index cache key in
 * `packages/code-analysis`, which combines a project identity with the
 * modification time of every indexed file so that a cached index is reused
 * only for a tree that has not changed.
 *
 * @param parts The ordered parts of the key. Order is significant:
 * `['a', 'b']` and `['b', 'a']` are different keys.
 * @returns The digest as lowercase hex, 64 characters.
 * @throws {DebuggenError} With code `INTERNAL` when a numeric part is not
 * finite. No part's value appears in the error — parts routinely carry paths
 * and other content that does not belong in a log — only the position of the
 * offending one.
 *
 * @example
 * ```ts
 * const key = stableHash(['index-v1', 'a/b.ts', 1_700_000_000_000]);
 * ```
 */
export function stableHash(parts: ReadonlyArray<HashPart>): string {
  const hash = createHash('sha256');

  // Created per call rather than once per module, so importing this module
  // constructs nothing. The cost is one small object for a whole key.
  const encoder = new TextEncoder();

  for (const [index, part] of parts.entries()) {
    if (typeof part === 'string') {
      writeFrame(hash, PART_TAG.string, encoder.encode(part));
      continue;
    }

    if (typeof part === 'number') {
      if (!Number.isFinite(part)) {
        throw new DebuggenError(
          'INTERNAL',
          `stableHash received a non-finite number at part ${index}.`,
          {
            hint: 'Pass a finite number, or convert the value to text before composing the key.',
            details: { partIndex: index, partType: 'number' },
          },
        );
      }
      writeFrame(hash, PART_TAG.number, encoder.encode(String(part)));
      continue;
    }

    writeFrame(hash, PART_TAG.bytes, part);
  }

  return hash.digest('hex');
}

/**
 * The HMAC-SHA256 of `data` under `key`, as 64 lowercase hexadecimal
 * characters.
 *
 * A `string` — key or data — is encoded as UTF-8 with the encoding passed
 * explicitly, and a `Uint8Array` is used exactly as given, so a value and its
 * UTF-8 encoding always produce the same result.
 *
 * **This is the single construction site for the keyed request identity** that
 * makes duplicate-request detection possible. At ingest, the redaction layer
 * (`packages/telemetry/src/redaction/request-key.ts`) computes an HMAC over
 * the *unredacted* request material — method, path and query pairs in a
 * canonical order — under a random key held only in the session store, and the
 * capture aggregates (`packages/telemetry/src/aggregate/requests.ts`) group
 * requests by the resulting value. Two properties follow, and both are needed:
 * byte-identical requests produce the same value and so group together, while
 * requests differing only in a query-parameter value produce different values
 * and stay apart. The redacted form of a request cannot do this — redaction
 * replaces parameter values, so it erases exactly the difference the second
 * property depends on — and the key makes the stored value opaque, so the
 * material it was computed over cannot be recovered from it.
 *
 * **Neither argument may be logged, persisted or put in an error message.**
 * The key is a secret and the data is pre-redaction material; the privacy
 * model forbids either leaving the machine. Nothing in this function records
 * them, and a caller must be as careful — the digest is the only value of this
 * computation that is safe to keep.
 *
 * @param key The secret key. Text is encoded as UTF-8; bytes are used as
 * given. Never log it.
 * @param data The material to authenticate. Never log it.
 * @returns The digest as lowercase hex, 64 characters.
 *
 * @example
 * ```ts
 * // Two spellings of one request agree; a different parameter value does not.
 * const a = hmacSha256Hex('test-key', 'GET /a/b?p=1');
 * const b = hmacSha256Hex('test-key', 'GET /a/b?p=1');
 * const c = hmacSha256Hex('test-key', 'GET /a/b?p=2');
 * // a === b, and c differs from both.
 * ```
 */
export function hmacSha256Hex(key: HashInput, data: HashInput): string {
  const mac = createHmac('sha256', key);
  if (typeof data === 'string') {
    mac.update(data, 'utf8');
  } else {
    mac.update(data);
  }
  return mac.digest('hex');
}

/**
 * Writes one self-delimiting {@link stableHash} frame into `hash`: the type
 * tag, the payload's byte length in decimal, the terminator, then the payload.
 *
 * The length is taken from the very bytes that are written next, so the frame
 * header and its payload cannot disagree. Internal to this module; the framing
 * is an implementation detail of the digest, not part of the surface.
 *
 * @param hash The digest under construction.
 * @param tag The part's type tag, from {@link PART_TAG}.
 * @param payload The part's bytes, written verbatim.
 */
function writeFrame(
  hash: Hash,
  tag: (typeof PART_TAG)[keyof typeof PART_TAG],
  payload: Uint8Array,
): void {
  hash.update(`${tag}${payload.byteLength}${PART_LENGTH_TERMINATOR}`, 'utf8');
  hash.update(payload);
}
