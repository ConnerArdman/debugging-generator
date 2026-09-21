/**
 * Tests for `./hash.ts`: the five digest constructions the whole product
 * depends on.
 *
 * These are not coverage tests. Each suite below pins one property that
 * something far away from this file relies on, and that nothing closer to the
 * consumer can re-check once it is wrong.
 *
 * 1. **The digests are the real, standard ones.** A recorded hash outlives the
 *    revision that recorded it: a credential is stored only as its digest, a
 *    reversible source edit records the file's digest before it writes, and the
 *    backup holding the original bytes is *named* after that digest. So a
 *    change in hashing behaviour does not merely fail a comparison — it
 *    orphans backups whose names can no longer be recomputed. The known-answer
 *    cases (SHA-256 of the empty input and of `abc`, HMAC-SHA256 of RFC 4231
 *    test case 2) are the guard: they fail on any change to the construction,
 *    including one that still looks like a hex digest.
 *
 * 2. **Nothing normalises bytes.** The reversibility guarantee is a statement
 *    about bytes: cleanup restores a backup only while the file's current
 *    digest still matches the digest recorded for the edited content. If a hash
 *    function folded `\r\n` into `\n`, then on a checkout that uses CRLF line
 *    endings two genuinely different files would hash alike — an edit would
 *    report itself reversible and would not be, and a file that could have been
 *    restored would be reported as a conflict instead. The file suite proves
 *    CRLF and LF content hash *differently*, through both the streaming and the
 *    synchronous reader, and that a file which is not valid UTF-8 is hashed
 *    without being decoded.
 *
 * 3. **A composed key cannot collide.** `stableHash` builds the cache key of
 *    the static-analysis index from a project identity and the modification
 *    time of every indexed file. A plain concatenation would make `['a', 'bc']`
 *    and `['ab', 'c']` one key, and a cache that treats them alike serves one
 *    entry's data for another's question — a wrong answer delivered from a hit,
 *    which is the hardest kind to notice. The `stableHash` suite asserts the
 *    separations the length-prefixed framing exists to create: between part
 *    boundaries, between part types, and between orderings.
 *
 * Two habits in here are deliberate.
 *
 * - **Known answers are literals, verified against the runtime before they
 *   were committed, and never recomputed inside the test.** A test that hashes
 *   with `node:crypto` and compares against `./hash.ts` proves only that two
 *   call sites agree; it would pass unchanged if both moved to a different
 *   algorithm. Where a test does compare two of this module's own results, it
 *   is asserting an *agreement contract* — bytes against text, streaming
 *   against synchronous — not a digest value.
 * - **Every filesystem test writes inside one temporary sandbox**, created in
 *   `beforeAll` and removed in `afterAll`, with exact bytes rather than text,
 *   so no case depends on the checkout's line endings, on the ambient umask, or
 *   on any path outside the sandbox.
 *
 * Nothing here logs a key or the material a MAC is computed over: the keyed
 * request identity is built from pre-redaction request material, so the digest
 * is the only value of that computation which is safe to keep, and the keys
 * below are short, obviously synthetic literals for that reason.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DebuggenError } from '../errors.js';
import { hmacSha256Hex, sha256Hex, sha256OfFile, sha256OfFileSync, stableHash } from './hash.js';

/*
 * ---------------------------------------------------------------------------
 * Known answers
 * ---------------------------------------------------------------------------
 */

/**
 * The shape every function in the module promises: 64 lowercase hexadecimal
 * characters, and nothing else.
 *
 * Asserted separately from the digest values because the values are what the
 * comparisons depend on and the shape is what the *uses* depend on — a digest
 * becomes a path segment and a database key, so an upper-cased or truncated
 * result would be a different filename for the same bytes.
 */
const HEX_64 = /^[0-9a-f]{64}$/;

/**
 * SHA-256 of the empty input.
 *
 * Verified against the runtime before it was committed. If this literal ever
 * disagrees with `node:crypto`, the runtime is right and the literal is the
 * thing to fix — never the implementation.
 */
const SHA256_OF_EMPTY = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

/** SHA-256 of `abc`, the published one-block vector. Verified as above. */
const SHA256_OF_ABC = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';

/**
 * RFC 4231 test case 2 for HMAC-SHA256: a short ASCII key and a short ASCII
 * message, chosen by the standard precisely because the key is shorter than the
 * block size and so exercises the padding path.
 *
 * Kept as three separate constants so the assertion reads as the vector it is.
 * The key is a four-character literal from a public standard — it is not a
 * credential, and nothing in this file constructs anything that resembles one.
 */
const RFC4231_CASE_2_KEY = 'Jefe';

/** The message of RFC 4231 test case 2. */
const RFC4231_CASE_2_DATA = 'what do ya want for nothing?';

/** The expected MAC of RFC 4231 test case 2. Verified against the runtime. */
const RFC4231_CASE_2_MAC = '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843';

/**
 * The key every non-vector MAC case uses: short, readable and obviously
 * synthetic.
 *
 * Deliberately not a random 32-byte value bound to a credential-shaped name —
 * the repository's secret scanner treats a long, dense value bound to a
 * key-like name as a finding, and it is right to, so a test key stays a word.
 */
const SYNTHETIC_KEY = 'test-key';

/** Text whose UTF-8 encoding is longer than its character count. */
const MULTI_BYTE_TEXT = 'héllo — ünïcøde ✓';

/** Encodes text the way `sha256Hex` and `hmacSha256Hex` do internally. */
const encoder = new TextEncoder();

/*
 * ---------------------------------------------------------------------------
 * Sandbox
 * ---------------------------------------------------------------------------
 */

/**
 * The one directory this suite is allowed to write in, created fresh per run.
 *
 * `mkdtemp` gives a unique name, so the suite is safe beside the other `shared`
 * suites and beside another checkout of this repository running the same tests
 * on the same machine. Initialised to the empty string rather than left
 * `undefined` so no case has to narrow it.
 */
let sandbox = '';

beforeAll(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'debuggen-hash-'));
});

afterAll(() => {
  // `force` so a case that never created its file cannot fail the teardown, and
  // `recursive` because every file of the run lives in here.
  rmSync(sandbox, { recursive: true, force: true });
});

/*
 * ---------------------------------------------------------------------------
 * Helpers
 * ---------------------------------------------------------------------------
 */

/**
 * Writes `bytes` to `name` inside the sandbox and returns the path.
 *
 * Takes bytes rather than text on purpose: the whole point of the file suite is
 * that the digest describes the bytes on disk, so the test states those bytes
 * explicitly instead of letting an encoding step decide them.
 *
 * @param name File name within the sandbox; unique per case.
 * @param bytes Exact contents to write.
 * @returns The absolute path written.
 */
function writeBytes(name: string, bytes: Uint8Array): string {
  const path = join(sandbox, name);
  writeFileSync(path, bytes);
  return path;
}

/**
 * `length` bytes of a deterministic, non-repeating-by-block pattern.
 *
 * Used for the large-file case, where the point is to cross the read stream's
 * chunk boundary several times with content whose every chunk differs — a
 * streaming loop that dropped or reordered a chunk would still produce the
 * right digest for a file of one repeated byte.
 *
 * @param length How many bytes to produce.
 * @returns The bytes, identical on every call for the same length.
 */
function deterministicBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let index = 0; index < length; index += 1) {
    bytes[index] = (index * 31 + 7) % 256;
  }
  return bytes;
}

/**
 * The value `run` threw.
 *
 * @param run The call under test.
 * @returns Whatever it threw.
 * @throws When the call returned normally, which is itself the failure.
 */
function captureThrow(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error('Expected the call to throw, but it returned normally.');
}

/**
 * The `DebuggenError` that `run` threw, with the brand asserted through the
 * public guard before the value is handed back.
 *
 * The guard is the supported way to ask — a copy of the error class from
 * another bundle fails `instanceof` — so the assertion is made here, once, and
 * every caller then inspects a value that has already satisfied it.
 *
 * @param run The call under test.
 * @returns The thrown error, narrowed.
 */
function thrownDebuggenError(run: () => unknown): DebuggenError {
  const thrown = captureThrow(run);
  expect(DebuggenError.is(thrown)).toBe(true);
  if (!DebuggenError.is(thrown)) {
    // Unreachable: the assertion above has already failed the test. Present so
    // the narrowing is done by the guard rather than by a cast.
    throw new Error('Expected a DebuggenError.');
  }
  return thrown;
}

/**
 * The value a rejected promise rejected with.
 *
 * @param promise The call under test.
 * @returns Whatever it rejected with.
 * @throws When the promise resolved, which is itself the failure.
 */
async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('Expected the promise to reject, but it resolved.');
}

/**
 * One canonical request string of the shape the ingest layer builds before it
 * computes the keyed request identity: the method, the path, then the query
 * pairs in a canonical order.
 *
 * The pairs are sorted here for the same reason they are sorted there — two
 * spellings of one request must produce the same bytes, so that two
 * byte-identical requests produce the same MAC and can be grouped. The values
 * are intentionally generic; this helper mirrors the *shape* of the input, not
 * any particular application's routes.
 *
 * @param method Request method.
 * @param path Request path, without a query string.
 * @param query Query pairs in any order.
 * @returns The canonical string.
 */
function canonicalRequest(
  method: string,
  path: string,
  query: ReadonlyArray<readonly [string, string]>,
): string {
  const pairs = query.map(([name, value]) => `${name}=${value}`).sort();
  return pairs.length === 0 ? `${method} ${path}` : `${method} ${path}?${pairs.join('&')}`;
}

/*
 * ---------------------------------------------------------------------------
 * sha256Hex
 * ---------------------------------------------------------------------------
 */

describe('sha256Hex', () => {
  it('matches the published digest of the empty input', () => {
    expect(sha256Hex('')).toBe(SHA256_OF_EMPTY);
  });

  it('matches the published digest of a one-block input', () => {
    expect(sha256Hex('abc')).toBe(SHA256_OF_ABC);
  });

  it('returns 64 lowercase hexadecimal characters for text', () => {
    expect(sha256Hex('abc')).toMatch(HEX_64);
  });

  it('returns 64 lowercase hexadecimal characters for bytes', () => {
    expect(sha256Hex(Uint8Array.of(0x00, 0x7f, 0x80, 0xff))).toMatch(HEX_64);
  });

  it('hashes text as its UTF-8 bytes', () => {
    // The agreement is the contract: a caller may hand over either form of the
    // same value and must get the same digest, which is what lets one layer
    // hash text and another hash the bytes it read.
    expect(sha256Hex('abc')).toBe(sha256Hex(encoder.encode('abc')));
  });

  it('hashes multi-byte text as its UTF-8 bytes rather than its characters', () => {
    expect(sha256Hex(MULTI_BYTE_TEXT)).toBe(sha256Hex(encoder.encode(MULTI_BYTE_TEXT)));
  });

  it('gives the empty byte array the empty-input digest', () => {
    expect(sha256Hex(new Uint8Array(0))).toBe(SHA256_OF_EMPTY);
  });

  it('distinguishes inputs that differ in one byte', () => {
    expect(sha256Hex('abc')).not.toBe(sha256Hex('abd'));
  });
});

/*
 * ---------------------------------------------------------------------------
 * sha256OfFile and sha256OfFileSync
 * ---------------------------------------------------------------------------
 */

describe('sha256OfFile and sha256OfFileSync', () => {
  it('hashes the bytes a file holds', async () => {
    const bytes = encoder.encode('abc');
    const path = writeBytes('one-block.bin', bytes);

    await expect(sha256OfFile(path)).resolves.toBe(SHA256_OF_ABC);
    expect(sha256OfFileSync(path)).toBe(SHA256_OF_ABC);
  });

  it('returns 64 lowercase hexadecimal characters for a file', async () => {
    const path = writeBytes('shape.bin', encoder.encode('content of no significance'));

    expect(await sha256OfFile(path)).toMatch(HEX_64);
    expect(sha256OfFileSync(path)).toMatch(HEX_64);
  });

  it('agrees with the in-memory digest of the same bytes', async () => {
    const bytes = Uint8Array.of(0x01, 0x02, 0x03, 0x04, 0x05);
    const path = writeBytes('bytes.bin', bytes);

    expect(await sha256OfFile(path)).toBe(sha256Hex(bytes));
  });

  it('gives the two readers one answer for one file', async () => {
    // The synchronous reader exists for the start-up reconciliation pass, which
    // compares a file's current digest against two recorded ones before the
    // service begins serving. Its decision table is only sound while the two
    // readers are interchangeable, so their agreement is a contract, not an
    // implementation detail.
    const path = writeBytes('agreement.bin', deterministicBytes(4_096));

    expect(sha256OfFileSync(path)).toBe(await sha256OfFile(path));
  });

  it('gives an empty file the empty-input digest', async () => {
    const path = writeBytes('empty.bin', new Uint8Array(0));

    await expect(sha256OfFile(path)).resolves.toBe(SHA256_OF_EMPTY);
    expect(sha256OfFileSync(path)).toBe(SHA256_OF_EMPTY);
  });

  it('hashes a file that spans several read chunks identically through both readers', async () => {
    // Comfortably past the read stream's default chunk size, so the streaming
    // loop runs several times: a loop that dropped the final chunk, or hashed
    // the first one twice, fails here and nowhere else.
    const bytes = deterministicBytes(300 * 1024);
    const path = writeBytes('large.bin', bytes);

    const streamed = await sha256OfFile(path);

    expect(streamed).toBe(sha256Hex(bytes));
    expect(sha256OfFileSync(path)).toBe(streamed);
  });

  it('never normalises a line ending: CRLF and LF content hash differently', async () => {
    // THE reversibility case. A reversible source edit records the file's digest
    // before writing and restores the original bytes only while the current
    // digest still matches the digest recorded for the edited content. Folding
    // CRLF into LF anywhere in this module would make those two files one
    // digest, and on a checkout that uses CRLF line endings an edit would then
    // report itself reversible while being unable to restore the file — or
    // report a conflict for a file it could have restored. Both readers are
    // asserted because the reconciliation pass uses one and the request path
    // uses the other.
    const crlfBytes = encoder.encode('a\r\nb');
    const lfBytes = encoder.encode('a\nb');
    const crlfPath = writeBytes('crlf.txt', crlfBytes);
    const lfPath = writeBytes('lf.txt', lfBytes);

    const crlfStreamed = await sha256OfFile(crlfPath);
    const lfStreamed = await sha256OfFile(lfPath);

    expect(crlfStreamed).not.toBe(lfStreamed);
    expect(sha256OfFileSync(crlfPath)).not.toBe(sha256OfFileSync(lfPath));

    // Each digest is exactly the digest of that file's own bytes, so the
    // difference above is byte fidelity rather than two ways of being wrong.
    expect(crlfStreamed).toBe(sha256Hex(crlfBytes));
    expect(lfStreamed).toBe(sha256Hex(lfBytes));
    expect(sha256OfFileSync(crlfPath)).toBe(sha256Hex(crlfBytes));
    expect(sha256OfFileSync(lfPath)).toBe(sha256Hex(lfBytes));
  });

  it('hashes bytes that are not valid UTF-8 without decoding them', async () => {
    // A lone 0xff cannot begin a UTF-8 sequence, so any decode step would
    // replace it and change the digest. Source trees legitimately contain such
    // files (a compiled asset beside the code), and a digest that silently
    // described a replacement character would make them unrestorable.
    const bytes = Uint8Array.of(0xff, 0xfe, 0x00, 0x01);
    const path = writeBytes('not-utf8.bin', bytes);

    await expect(sha256OfFile(path)).resolves.toBe(sha256Hex(bytes));
    expect(sha256OfFileSync(path)).toBe(sha256Hex(bytes));
  });

  it('keeps a byte-order mark as part of the content', async () => {
    const withMark = Uint8Array.of(0xef, 0xbb, 0xbf, 0x61);
    const withoutMark = Uint8Array.of(0x61);
    const markedPath = writeBytes('with-mark.txt', withMark);
    const plainPath = writeBytes('without-mark.txt', withoutMark);

    expect(await sha256OfFile(markedPath)).toBe(sha256Hex(withMark));
    expect(await sha256OfFile(markedPath)).not.toBe(await sha256OfFile(plainPath));
  });

  it('propagates ENOENT from the synchronous reader unchanged', () => {
    const thrown = captureThrow(() => sha256OfFileSync(join(sandbox, 'absent.bin')));

    expect(thrown).toMatchObject({ code: 'ENOENT' });
    // The raw errno error, not a wrapper: the caller decides what a missing
    // file means — a record that was never written, or a file the developer
    // deleted — and that decision needs the code, not a paraphrase of it.
    expect(DebuggenError.is(thrown)).toBe(false);
  });

  it('rejects with ENOENT from the streaming reader unchanged', async () => {
    const missing = join(sandbox, 'absent-async.bin');

    await expect(sha256OfFile(missing)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(DebuggenError.is(await rejectionOf(sha256OfFile(missing)))).toBe(false);
  });
});

/*
 * ---------------------------------------------------------------------------
 * stableHash
 * ---------------------------------------------------------------------------
 */

describe('stableHash', () => {
  it('returns the same digest for the same part list', () => {
    const parts = ['index-v1', 'a/b.ts', 1_700_000_000_000];

    expect(stableHash(parts)).toBe(stableHash(parts));
    expect(stableHash(parts)).toMatch(HEX_64);
  });

  it('cannot be collided by moving a character across a part boundary', () => {
    // The collision a plain concatenation would produce, and the reason each
    // part is written into the digest behind its own byte length. Two different
    // lists sharing one cache key means one entry's data answering another's
    // question.
    expect(stableHash(['a', 'bc'])).not.toBe(stableHash(['ab', 'c']));
  });

  it('separates a part list from the single part that concatenates it', () => {
    expect(stableHash(['a', 'b'])).not.toBe(stableHash(['ab']));
  });

  it('separates text from a number that renders the same way', () => {
    expect(stableHash(['1'])).not.toBe(stableHash([1]));
  });

  it('separates bytes from the text they decode to', () => {
    expect(stableHash([encoder.encode('a')])).not.toBe(stableHash(['a']));
  });

  it('depends on the order of the parts', () => {
    expect(stableHash(['a', 'b'])).not.toBe(stableHash(['b', 'a']));
  });

  it('gives an empty list the empty-input digest, stably', () => {
    // An empty list is legal: a caller with nothing to say gets a key rather
    // than an error, and the key is the digest of the empty byte stream.
    expect(stableHash([])).toBe(stableHash([]));
    expect(stableHash([])).toMatch(HEX_64);
    expect(stableHash([])).toBe(SHA256_OF_EMPTY);
  });

  it('hashes a mixed list of text, numbers and bytes deterministically', () => {
    const parts = ['index-v1', 0, 42, -17.5, encoder.encode('trailer'), MULTI_BYTE_TEXT];

    expect(stableHash(parts)).toBe(stableHash([...parts]));
    expect(stableHash(parts)).toMatch(HEX_64);
  });

  it('canonicalises a number the same way on every call', () => {
    // Numbers are canonicalised with the language's own number-to-string
    // conversion, so a value contributes the same bytes however it was
    // computed. Negative zero and zero are numerically equal and therefore
    // canonicalise alike; a caller that must distinguish them passes text.
    expect(stableHash([1_700_000_000_000])).toBe(stableHash([1.7e12]));
    expect(stableHash([-0])).toBe(stableHash([0]));
  });

  it('distinguishes two composed keys that differ in a single timestamp', () => {
    // The shape of the static-analysis index cache key: an identity for the
    // indexed tree, then one modification time per indexed file. Written
    // generically — the property is the framing, not the paths.
    const identity = 'index-v1';
    const first = [identity, 'a/one.ts', 1_700_000_000_000, 'a/two.ts', 1_700_000_000_500];
    const second = [identity, 'a/one.ts', 1_700_000_000_000, 'a/two.ts', 1_700_000_000_501];

    expect(stableHash(first)).not.toBe(stableHash(second));
  });

  it('reuses one digest for an identical composed key', () => {
    const identity = 'index-v1';
    const key = (): ReadonlyArray<string | number> => [
      identity,
      'a/one.ts',
      1_700_000_000_000,
      'a/two.ts',
      1_700_000_000_500,
    ];

    expect(stableHash(key())).toBe(stableHash(key()));
  });

  it('refuses a number that is not finite', () => {
    // Accepting one would let two genuinely different keys agree on the bytes
    // of `NaN` or `Infinity` — in a cache, a wrong answer served from a hit.
    const fromNaN = thrownDebuggenError(() => stableHash([Number.NaN]));
    const fromInfinity = thrownDebuggenError(() => stableHash([Number.POSITIVE_INFINITY]));
    const fromNegativeInfinity = thrownDebuggenError(() => stableHash([Number.NEGATIVE_INFINITY]));

    expect(fromNaN.code).toBe('INTERNAL');
    expect(fromInfinity.code).toBe('INTERNAL');
    expect(fromNegativeInfinity.code).toBe('INTERNAL');
  });

  it('names the position of the offending part without disclosing its value', () => {
    // Parts routinely carry paths and other content that does not belong in a
    // log, so the error reports where the bad part was, never what it held.
    const thrown = thrownDebuggenError(() => stableHash(['index-v1', Number.POSITIVE_INFINITY]));

    // The position is reported as structured detail, which is what a caller can
    // act on, rather than only inside the prose of the message.
    expect(thrown.details).toMatchObject({ partIndex: 1 });

    // Neither the offending value nor the parts around it appear anywhere a log
    // or a user interface would show.
    expect(thrown.message).not.toContain('Infinity');
    expect(thrown.message).not.toContain('index-v1');
    expect(Object.values(thrown.details ?? {})).not.toContain('Infinity');

    // A refusal carries the developer's next step, not just the diagnosis.
    expect(thrown.hint).toBeTypeOf('string');
    expect(thrown.hint).not.toBe('');
  });

  it('accepts a finite number at the position a non-finite one was refused', () => {
    expect(stableHash(['index-v1', Number.MAX_SAFE_INTEGER])).toMatch(HEX_64);
  });
});

/*
 * ---------------------------------------------------------------------------
 * hmacSha256Hex
 * ---------------------------------------------------------------------------
 */

describe('hmacSha256Hex', () => {
  it('matches the published MAC of the standard test vector', () => {
    expect(hmacSha256Hex(RFC4231_CASE_2_KEY, RFC4231_CASE_2_DATA)).toBe(RFC4231_CASE_2_MAC);
  });

  it('returns 64 lowercase hexadecimal characters', () => {
    expect(hmacSha256Hex(RFC4231_CASE_2_KEY, RFC4231_CASE_2_DATA)).toMatch(HEX_64);
  });

  it('returns the same value for the same key and message', () => {
    expect(hmacSha256Hex(SYNTHETIC_KEY, 'message')).toBe(hmacSha256Hex(SYNTHETIC_KEY, 'message'));
  });

  it('depends on the key', () => {
    // Why the stored value is opaque: without the key it cannot be recomputed,
    // so the material it was built from cannot be recovered from it.
    expect(hmacSha256Hex(SYNTHETIC_KEY, 'message')).not.toBe(
      hmacSha256Hex('other-test-key', 'message'),
    );
  });

  it('depends on the message', () => {
    expect(hmacSha256Hex(SYNTHETIC_KEY, 'message')).not.toBe(
      hmacSha256Hex(SYNTHETIC_KEY, 'messagf'),
    );
  });

  it('treats a byte key as its UTF-8 text equivalent', () => {
    expect(hmacSha256Hex(encoder.encode(SYNTHETIC_KEY), 'message')).toBe(
      hmacSha256Hex(SYNTHETIC_KEY, 'message'),
    );
  });

  it('treats a byte message as its UTF-8 text equivalent', () => {
    expect(hmacSha256Hex(SYNTHETIC_KEY, encoder.encode(MULTI_BYTE_TEXT))).toBe(
      hmacSha256Hex(SYNTHETIC_KEY, MULTI_BYTE_TEXT),
    );
  });

  it('gives two byte-identical requests one identity', () => {
    // Duplicate detection rests on this half: the canonical form of a request —
    // method, path and query pairs in a fixed order — is what is authenticated,
    // so two spellings of the same request produce the same value and the
    // capture aggregates can group them. Note that the identity is computed
    // over unredacted material, because redaction replaces parameter values and
    // would erase the difference the next case depends on.
    const first = canonicalRequest('GET', '/alpha/beta', [
      ['p', '1'],
      ['q', '2'],
    ]);
    const second = canonicalRequest('GET', '/alpha/beta', [
      ['q', '2'],
      ['p', '1'],
    ]);

    expect(first).toBe(second);
    expect(hmacSha256Hex(SYNTHETIC_KEY, first)).toBe(hmacSha256Hex(SYNTHETIC_KEY, second));
  });

  it('keeps two requests apart when a query parameter value differs', () => {
    // The other half: two requests that differ only in a parameter value are
    // different requests and must not be grouped, however alike their redacted
    // forms look.
    const first = canonicalRequest('GET', '/alpha/beta', [['p', '1']]);
    const second = canonicalRequest('GET', '/alpha/beta', [['p', '2']]);

    expect(hmacSha256Hex(SYNTHETIC_KEY, first)).not.toBe(hmacSha256Hex(SYNTHETIC_KEY, second));
  });

  it('keeps two requests apart when only the path differs', () => {
    const first = canonicalRequest('GET', '/alpha/beta', []);
    const second = canonicalRequest('GET', '/alpha/gamma', []);

    expect(hmacSha256Hex(SYNTHETIC_KEY, first)).not.toBe(hmacSha256Hex(SYNTHETIC_KEY, second));
  });

  it('keeps two requests apart when only the method differs', () => {
    const first = canonicalRequest('GET', '/alpha/beta', []);
    const second = canonicalRequest('POST', '/alpha/beta', []);

    expect(hmacSha256Hex(SYNTHETIC_KEY, first)).not.toBe(hmacSha256Hex(SYNTHETIC_KEY, second));
  });
});
