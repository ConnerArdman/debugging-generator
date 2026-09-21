/**
 * The keyed request identity that makes duplicate-request detection survive
 * redaction.
 *
 * The privacy model replaces every query-parameter value before a captured
 * event is persisted or broadcast, which is the right thing to do and also
 * destroys the only difference between two requests that differ solely in a
 * parameter: `productId=A` and `productId=B` are both stored as
 * `productId=?`. Grouping requests by their redacted URL would therefore
 * report those two as one duplicated request, and the duplicate-request
 * investigation the product exists to support would return a confident,
 * wrong answer.
 *
 * This module supplies the value that grouping actually uses:
 *
 * ```text
 * request_key = HMAC-SHA-256(sessionKey, version + method + path + sorted query pairs)
 * ```
 *
 * Two properties follow, and both are load-bearing. Byte-identical requests
 * produce the same key, so a genuine duplicate is detected; requests differing
 * only in a parameter value produce different keys, so two distinct requests
 * are never merged. The key is opaque — the material it was computed over
 * cannot be recovered from it — because the session key is 32 random bytes
 * held only in the session store and never sent anywhere.
 *
 * ## Its input is the *unredacted* URL
 *
 * The ingest path is *validate ingress → compute `request_key` → redact →
 * attribute → persist*, and this module runs at the second step, before
 * `./url.ts`'s `redactUrl` has touched anything. That order is not incidental:
 * computing the digest after masking would feed `productId=?` to the HMAC for
 * every request, collapsing every parameter value into a single group and
 * silently removing the feature while every panel still looked plausible. If
 * you are moving this call, it moves *before* redaction or not at all.
 *
 * Nothing here logs, persists or returns its inputs. The session key is a
 * secret and the URL is pre-redaction material, so no error message, hint or
 * `details` object below carries either one — lengths and shapes only.
 *
 * ## Where the result goes
 *
 * `apps/local-service/src/telemetry/ingest.ts` writes the digest onto the
 * event under the `request_key` attribute — the one key declared in
 * `../schema/attributes.ts`'s `SERVICE_ASSIGNED_ATTRIBUTE_KEYS`, whose name is
 * not repeated here so that the attribute vocabulary keeps exactly one
 * spelling of it — and `../aggregate/requests.ts` groups by it for the
 * `request_count` and `duplicate_request_count` metrics and the
 * `requestTable` node's duplicate badges. `./redactor.ts` exempts the
 * service-assigned keys from its name-driven rules on purpose: the attribute
 * name ends in "key" and its value is 64 characters of high-entropy hex, which
 * is exactly what the generic scrubber is built to mask, and masking it would
 * leave the aggregates grouping every request under one placeholder.
 *
 * ## WebCrypto, resolved lazily
 *
 * `@debuggen/telemetry`'s library bundle is built with esbuild's
 * `platform: "neutral"` and the page agent's bundle hard-fails on any Node
 * builtin, so the HMAC here is computed with `globalThis.crypto.subtle` —
 * never with `node:crypto`, and never through `@debuggen/shared/node`'s
 * same-named `hmacSha256Hex`, whose entry point is Node-only. The two
 * implementations are deliberately unshared for that reason alone and must
 * agree bit for bit: given the same key bytes and the same message,
 * {@link hmacSha256Hex} here and the Node helper there produce the identical
 * 64 lowercase hex characters (this module hex-decodes its `keyHex` argument,
 * so the Node counterpart must be handed those same bytes rather than the hex
 * text). {@link hmacSha256Hex} is exported so a known-answer vector can hold
 * that agreement in place.
 *
 * The global is read inside each function rather than captured at module
 * scope, matching `@debuggen/shared`'s identifier generator: a module-level
 * read runs at import time, which in a page bundle can precede the host
 * finishing its globals, and it would make the absent-WebCrypto path
 * untestable — a stub installed after import would have no effect and the
 * assertion would be vacuous.
 *
 * ## Failure contract
 *
 * Every asynchronous function returns a {@link Result} and **never rejects**.
 * One malformed URL in a batch of five thousand events must cost that one
 * event its group, not the batch its ingestion. The single exception is the
 * synchronous generator {@link createRequestKeySessionKey}, which throws when
 * the host has no Web Crypto: it is called once while a session is being
 * created, has no partial answer to give, and follows the precedent of
 * `newTraceId()` / `newSpanId()`.
 */

import { DebuggenError, err, isErr, ok } from '@debuggen/shared';
import type { Result } from '@debuggen/shared';

import { decodeQueryComponent, parseQueryPairs, parseUrlParts } from './url.js';

/**
 * Version tag of the canonical message, and its first line.
 *
 * Stored `request_key` values are opaque digests: nothing can tell from one
 * which message layout produced it. Carrying the version *inside* the message
 * is what makes a future layout change safe — every key computed under a new
 * tag differs from every key computed under this one, so old and new values
 * cannot be compared by accident, and a capture keyed under one layout stays
 * internally consistent. Bump this only together with a layout change, and
 * treat the two as one edit.
 *
 * `v2` tags the layout {@link buildRequestKeyMessage} documents: four
 * newline-separated parts whose every variable member is JSON-encoded, so no
 * member can contain the delimiter that frames it. `v1` joined those members
 * with bare `\n`, `&` and `=`, which its own components could contain, and so
 * gave two structurally different requests one digest — the condition this
 * module exists to prevent. Nothing keyed under `v1` can be compared with a
 * `v2` key, which is the point of the tag.
 */
export const REQUEST_KEY_MESSAGE_VERSION = 'v2';

/**
 * Length in bytes of a per-session key: 32, rendered as 64 hex characters.
 *
 * 32 bytes is the natural key length for HMAC-SHA-256 (the block-sized key
 * neither padded up nor hashed down by the construction) and matches the
 * credential sizing used elsewhere in the product.
 */
export const REQUEST_KEY_SESSION_KEY_BYTES = 32;

/**
 * The exact shape of a session key: 64 lowercase hex characters, anchored.
 *
 * Non-global on purpose, so `.test()` carries no `lastIndex` state between
 * calls — a global pattern reused across events would accept and reject the
 * same key alternately.
 *
 * Lowercase only. {@link createRequestKeySessionKey} is the only thing that
 * mints these values and it emits lowercase, so accepting an uppercase
 * spelling would admit a key this product did not generate while adding a
 * second spelling of one secret. The low-level {@link hmacSha256Hex} is
 * deliberately more permissive about its own `keyHex` argument, because it
 * must be able to reproduce published test vectors whose keys are neither 32
 * bytes nor lowercase.
 */
export const REQUEST_KEY_SESSION_KEY_PATTERN = /^[0-9a-f]{64}$/;

/** Hex characters a session key occupies: two per byte. */
const SESSION_KEY_HEX_LENGTH = REQUEST_KEY_SESSION_KEY_BYTES * 2;

/** Hex characters per byte, which is also the `padStart` width in {@link toHex}. */
const HEX_DIGITS_PER_BYTE = 2;

/** Radix for reading and writing hex. */
const HEX_RADIX = 16;

/**
 * Hex digits in either case, anchored and unbounded in length.
 *
 * A single character class with `+` rather than `(?:..)+` over pairs: both
 * accept the same strings, but this one cannot backtrack, so a megabyte of
 * near-hex costs one linear scan. The even-length requirement is checked
 * separately in {@link hexToBytes}, where the arithmetic that needs it lives.
 */
const HEX_PATTERN = /^[0-9a-fA-F]+$/;

/**
 * The HMAC parameters, stated once.
 *
 * `SHA-256` is the digest the stored column and every consumer expect; the
 * object is frozen because it is shared by both the key import and, by
 * reference, every diagnostic that names the algorithm.
 */
const HMAC_ALGORITHM = Object.freeze({ name: 'HMAC', hash: 'SHA-256' } as const);

/**
 * A canonicalised query parameter: decoded key, decoded value.
 *
 * A bare flag (`?reload`) arrives from `parseQueryPairs` with an `undefined`
 * value and becomes the empty string here, so the tuple is always complete and
 * the message layout is fixed-arity. `?reload` and `?reload=` consequently
 * canonicalise identically, which is correct for request identity: a server
 * reading either one sees the parameter present with no value.
 */
type CanonicalPair = readonly [key: string, value: string];

/**
 * Orders two canonicalised pairs by key, then by value, in UTF-16 code-unit
 * order.
 *
 * Plain `<` comparison, never `String.prototype.localeCompare`. A locale-aware
 * comparison depends on the host's locale and on its ICU version — it orders
 * `Z` before `a` in one collation and after it in another — so two machines, or
 * one machine before and after a runtime upgrade, would canonicalise the same
 * query differently and compute different keys for one request. Code-unit
 * order is not the order a human would choose for a listing, and that is fine:
 * nothing displays this string, and the only property required of the ordering
 * is that every host agrees on it.
 *
 * Comparing the value as well as the key makes repeated parameters
 * order-insensitive too: `?tag=b&tag=a` and `?tag=a&tag=b` canonicalise to one
 * message. `Array.prototype.sort` has been stable since ES2019, so pairs that
 * compare equal — which here means they are character-for-character identical —
 * keep their arrival order and cannot perturb the result either way.
 */
function compareCanonicalPairs(left: CanonicalPair, right: CanonicalPair): number {
  if (left[0] !== right[0]) {
    return left[0] < right[0] ? -1 : 1;
  }
  if (left[1] !== right[1]) {
    return left[1] < right[1] ? -1 : 1;
  }
  return 0;
}

/**
 * The single delimiter between the canonical message's four parts.
 *
 * Newline rather than a printable character so that a message read in a test
 * failure or a local trace is legible line by line. It is safe as a delimiter
 * only because every variable part is written by
 * {@link encodeCanonicalPart}, whose output cannot contain it.
 */
const MESSAGE_PART_DELIMITER = '\n';

/**
 * Writes one variable part of the canonical message so that it cannot be
 * confused with another part, or with a different value in the same part.
 *
 * `JSON.stringify` is the encoder, and the choice carries three properties the
 * message depends on:
 *
 * - **Injective.** `JSON.parse` inverts it, so two distinct inputs can never
 *   share an encoding. That is the whole requirement: a digest identifies a
 *   request only if the string behind it does. Canonical percent-encoding
 *   would also be injective but cannot be used here — `encodeURIComponent`
 *   throws `URIError` on a lone surrogate, and this function runs on every
 *   captured request while the module's contract is that no input throws.
 *   Well-formed `JSON.stringify` escapes such a code unit instead (ES2019),
 *   so it is total where the alternative is not.
 * - **Deterministic.** ECMA-262 fixes the escaping completely: `"` and `\`,
 *   the C0 controls as `\n`, `\t` and the rest, anything else below `0x20` as
 *   a four-digit lowercase `\uXXXX`. Two machines, or one machine before and
 *   after a runtime upgrade, therefore encode a value identically — the same
 *   reason {@link compareCanonicalPairs} compares code units rather than
 *   consulting a locale. A stored key stays comparable with a freshly computed
 *   one.
 * - **Newline-free.** An encoded part cannot contain the delimiter that frames
 *   it, which is what makes the message's four-part arity an invariant rather
 *   than a hope.
 *
 * @param part - A method, a path, or the sorted pair list. Never logged: this
 * is pre-redaction material.
 * @returns The part as a JSON value, ready to be joined into the message.
 */
function encodeCanonicalPart(part: string | readonly CanonicalPair[]): string {
  return JSON.stringify(part);
}

/**
 * Builds the exact string {@link computeRequestKey} authenticates.
 *
 * Pure, synchronous and free of crypto, so a test can assert the canonical
 * form directly instead of inferring it from a digest — which is the only way
 * a format this persisted values depend on can be pinned at all.
 *
 * ## The layout
 *
 * Four parts joined by newlines. Every part after the version tag is written
 * by {@link encodeCanonicalPart}, so no part can contain the delimiter that
 * frames it and no part can be mistaken for another:
 *
 * ```text
 * <version>\n<"METHOD">\n<"path">\n[["key","value"],…]
 * ```
 *
 * For `GET https://shop.test:3000/api/items?limit=20&q=hex%20bolt#top`:
 *
 * ```text
 * v2
 * "GET"
 * "/api/items"
 * [["limit","20"],["q","hex bolt"]]
 * ```
 *
 * Part by part:
 *
 * - **Version** — {@link REQUEST_KEY_MESSAGE_VERSION}, so a layout change
 *   cannot silently re-key existing data. It is the one part left bare,
 *   because its value comes from a closed set of short literals that contain
 *   no newline and so cannot absorb the delimiter after it.
 * - **Method** — trimmed and upper-cased with `toUpperCase`, never
 *   `toLocaleUpperCase`, whose Turkish mapping would turn a dotless `i` into
 *   something no HTTP method contains. `get` and `GET` therefore collide, which
 *   is what the wire means by them. Encoded, because nothing upstream
 *   guarantees a producer's method contains no delimiter.
 * - **Path** — `parseUrlParts(url).path`, byte-faithful: trailing slashes are
 *   not folded, case is not folded, and `%2F` is not decoded, because two paths
 *   spelled differently are two different requests to the server that answers
 *   them. **The origin is deliberately absent**, exactly as the product's
 *   formula states. The consequence is that two origins serving the same path
 *   and query collide — acceptable, because a capture is scoped to one bound
 *   tab and one application, and the alternative (keying on the origin) would
 *   stop a `fetch` written as `/api/items` from grouping with the same request
 *   written absolutely. Do not "fix" this without changing the formula, the
 *   version tag and the aggregates together. Encoded, because a path is
 *   reproduced verbatim and a producer can report one containing anything.
 * - **Query pairs** — every pair from `parseQueryPairs`, each half run through
 *   `decodeQueryComponent` so that `a%20b`, `a+b` and `a b` canonicalise
 *   identically, then sorted by {@link compareCanonicalPairs} and encoded as
 *   one array of two-element tuples. Decoding before sorting is what keeps
 *   those encoding variants equivalent; encoding after sorting is what keeps
 *   the result unambiguous. An absent or empty query yields `[]`, still
 *   preceded by its newline: the layout has fixed arity, so `?` and no query
 *   at all canonicalise the same way and a message can never be mistaken for
 *   one with fewer parts.
 * - **Excluded** — the fragment, which no browser sends to a server, and any
 *   userinfo, which is a credential rather than part of a request's identity.
 *
 * ## Why the parts are encoded rather than merely delimited
 *
 * A canonical message is worth only as much as its framing. Duplicate
 * detection groups by the digest of this string, so if two structurally
 * different requests can produce one message, the product reports them as one
 * repeated request — a confident, wrong answer of exactly the kind the privacy
 * model's `productId=A` versus `productId=B` sentence forbids. A framing built
 * from delimiters its own components may contain admits precisely that, and
 * four concrete cases followed from the earlier `\n`/`&`/`=` join:
 *
 * - `?a=b%26c=d` (one parameter whose value is `b&c=d`) and `?a=b&c=d` (two
 *   parameters) both rendered `a=b&c=d`.
 * - `?a%3Db=c` (the key `a=b`) and `?a=b=c` (the value `b=c`) both rendered
 *   `a=b=c`.
 * - A method of `GET\n/b` with the path `/a` rendered the same three lines as
 *   the method `GET` with a path of `/B\n/a` — the part delimiter itself was
 *   forgeable, and `parseUrlParts` reproduces a path verbatim.
 * - `?q=a%0Ab` decoded to a value containing a newline and produced a
 *   *five*-part message, breaking the fixed arity the layout claims.
 *
 * Encoding each part removes the class, not the four instances:
 * {@link encodeCanonicalPart} is injective, so distinct inputs cannot share an
 * encoding, and its output contains no literal newline, so the arity holds for
 * every input. The two equivalences that must survive — parameter order and
 * percent/plus/space spelling — are unaffected, because both are settled by
 * decoding and sorting before anything is encoded.
 *
 * ## One bounded ambiguity, stated rather than discovered
 *
 * `parseQueryPairs` caps a query at 512 pairs, and this function canonicalises
 * that capped prefix. The cap is deterministic — the same URL always yields the
 * same prefix and so the same key — but beyond it order insensitivity no longer
 * holds, because reordering changes which pairs survive the cut. It needs a
 * query no ordinary application produces, and it errs toward reporting two
 * requests as one group rather than splitting one.
 *
 * Total: every string decomposes, `decodeQueryComponent` returns its input
 * rather than throwing on malformed escapes, {@link encodeCanonicalPart}
 * accepts every string, and nothing here allocates more than the capped pair
 * list. No input throws.
 *
 * @param input - The request's method and its **unredacted** URL, absolute or
 * origin-relative. Ingress validation upstream guarantees both are strings.
 * @returns The canonical message, ready to be authenticated.
 */
export function buildRequestKeyMessage(input: { method: string; url: string }): string {
  const method = input.method.trim().toUpperCase();
  const { path, query } = parseUrlParts(input.url);

  const pairs: CanonicalPair[] =
    query === undefined || query.length === 0
      ? []
      : parseQueryPairs(query).map(([key, value]): CanonicalPair => [
          decodeQueryComponent(key),
          decodeQueryComponent(value ?? ''),
        ]);

  pairs.sort(compareCanonicalPairs);

  return [
    REQUEST_KEY_MESSAGE_VERSION,
    encodeCanonicalPart(method),
    encodeCanonicalPart(path),
    encodeCanonicalPart(pairs),
  ].join(MESSAGE_PART_DELIMITER);
}

/*
 * ---------------------------------------------------------------------------
 * Web Crypto plumbing
 * ---------------------------------------------------------------------------
 */

/**
 * The part of the Web Crypto global {@link createRequestKeySessionKey} uses.
 *
 * Narrowed to one method, as `@debuggen/shared`'s identifier generator does:
 * it records that minting a key needs nothing else from `crypto`, and it keeps
 * the type honest across hosts, since `Pick` follows whatever the ambient
 * `Crypto` type is in the surface being compiled.
 */
type RandomSource = Pick<typeof globalThis.crypto, 'getRandomValues'>;

/** The part of `crypto.subtle` the HMAC needs: import a raw key, sign bytes. */
type HmacProvider = Pick<typeof globalThis.crypto.subtle, 'importKey' | 'sign'>;

/**
 * Resolves `crypto.subtle` at call time, or refuses.
 *
 * The capability checks are not ceremony. A host can present a `crypto` object
 * with no `subtle` (an older embedder, or a page served over plain HTTP in a
 * browser that gates Web Crypto on a secure context), and a test stubs the
 * global away entirely to prove this path; the declared types say none of that
 * can happen, so the checks are written against the runtime rather than
 * against the compiler's belief.
 *
 * Throws rather than returning a {@link Result} because every caller already
 * runs inside the `try` that converts a failure into an `Err` — which is what
 * keeps the promise that no asynchronous function here rejects — and a second
 * error channel would only give each of them a branch to forget.
 *
 * @throws DebuggenError `INTERNAL` when the host provides no usable
 * `globalThis.crypto.subtle`.
 */
function resolveHmacProvider(): HmacProvider {
  const source: Pick<typeof globalThis.crypto, 'subtle'> | undefined = globalThis.crypto;
  const subtle: HmacProvider | undefined = source?.subtle;

  if (
    subtle === undefined ||
    typeof subtle.importKey !== 'function' ||
    typeof subtle.sign !== 'function'
  ) {
    throw new DebuggenError(
      'INTERNAL',
      'Cannot compute a request key: this host provides no globalThis.crypto.subtle able to import a key and sign.',
      {
        // The hint deliberately names no builtin module specifier: this string
        // survives into the bundled `dist/index.js`, which the package's build
        // is verified against by grepping for such a specifier.
        hint: "Run on a host with Web Crypto — Node.js 24 and every Chromium page context provide it. Do not substitute the platform's own crypto module: this module is bundled for the inspected page as well as for the service.",
        details: { algorithm: HMAC_ALGORITHM.name, hash: HMAC_ALGORITHM.hash },
      },
    );
  }

  return subtle;
}

/**
 * Renders bytes as lowercase hex, two characters per byte.
 *
 * Iterated with `for...of` rather than by index because
 * `noUncheckedIndexedAccess` types `bytes[i]` as `number | undefined`, which
 * the iterator form avoids without a non-null assertion. `toString(16)` is
 * already lowercase, and `padStart` keeps the leading zero of a byte below
 * `0x10` — without it a digest containing `0x0a` would be 63 characters and
 * would no longer be a fixed-width column value.
 */
function toHex(bytes: Uint8Array): string {
  let hex = '';
  for (const byte of bytes) {
    hex += byte.toString(HEX_RADIX).padStart(HEX_DIGITS_PER_BYTE, '0');
  }
  return hex;
}

/**
 * Decodes validated hex into bytes.
 *
 * Private, and it trusts its input: both call sites check the shape first
 * ({@link validateSessionKeyHex}, {@link validateHmacKeyHex}) so that the
 * rejection can name what was expected. Called with unvalidated text it would
 * produce `NaN` bytes, which is why it is not exported.
 *
 * The `Uint8Array<ArrayBuffer>` return type is not decoration. Web Crypto's
 * `BufferSource` admits only views over a plain `ArrayBuffer`, so the default
 * `Uint8Array<ArrayBufferLike>` — which a `SharedArrayBuffer` also satisfies —
 * is rejected by `importKey` and `sign`. Pinning the buffer type here and in
 * {@link encodeUtf8} is what lets both calls pass the bytes straight through
 * with no cast.
 */
function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(hex.length / HEX_DIGITS_PER_BYTE);
  for (let index = 0; index < bytes.length; index += 1) {
    const start = index * HEX_DIGITS_PER_BYTE;
    bytes[index] = Number.parseInt(hex.slice(start, start + HEX_DIGITS_PER_BYTE), HEX_RADIX);
  }
  return bytes;
}

/**
 * The UTF-8 encoder, built on first use and then reused.
 *
 * Lazy so that importing this module has no side effect and touches no global,
 * and cached because an ingest batch encodes thousands of messages and a fresh
 * encoder per event is pure garbage. `TextEncoder` is standard in both
 * runtimes this package targets; on a host without it the constructor throws,
 * and every call site is inside the `try` that turns that into an `Err`.
 */
let utf8Encoder: TextEncoder | undefined;

/** Encodes `text` as UTF-8, which is the byte sequence the HMAC authenticates. */
function encodeUtf8(text: string): Uint8Array<ArrayBuffer> {
  utf8Encoder ??= new TextEncoder();
  return utf8Encoder.encode(text);
}

/**
 * Imports raw key bytes as a non-extractable signing key.
 *
 * `extractable = false` means the key material cannot be read back out of the
 * `CryptoKey`, so a handle that leaks into a log or a debugger reveals nothing;
 * `["sign"]` is the only usage granted, so the same handle cannot verify,
 * derive or wrap anything either. Both are the least privilege the computation
 * needs.
 */
function importHmacKey(
  provider: HmacProvider,
  keyBytes: Uint8Array<ArrayBuffer>,
): Promise<CryptoKey> {
  return provider.importKey('raw', keyBytes, HMAC_ALGORITHM, false, ['sign']);
}

/** Signs one canonical message with an imported key and renders the digest. */
async function signMessage(
  provider: HmacProvider,
  key: CryptoKey,
  message: string,
): Promise<string> {
  const signature = await provider.sign(HMAC_ALGORITHM.name, key, encodeUtf8(message));
  return toHex(new Uint8Array(signature));
}

/**
 * Normalises anything thrown on the signing path into a `DebuggenError`,
 * without disclosing what was being signed.
 *
 * A `DebuggenError` raised by {@link resolveHmacProvider} passes through
 * unchanged, because it already says precisely what is wrong. Anything else —
 * a Web Crypto `OperationError`, a `TypeError` from a host without
 * `TextEncoder`, a stub that threw — becomes one generic failure whose message
 * mentions neither the key nor the URL. The original is attached as `cause`,
 * which `toPayload` excludes, so it reaches a local stack trace and not a
 * user interface or the wire.
 */
function asComputeError(caught: unknown): DebuggenError {
  if (DebuggenError.is(caught)) {
    return caught;
  }
  return new DebuggenError(
    'INTERNAL',
    'Computing a request key failed: the Web Crypto HMAC-SHA-256 operation did not complete.',
    {
      hint: 'Check that globalThis.crypto.subtle supports HMAC with SHA-256. Without it this event cannot be grouped with its duplicates, though the rest of the capture is unaffected.',
      cause: caught,
    },
  );
}

/*
 * ---------------------------------------------------------------------------
 * Key material
 * ---------------------------------------------------------------------------
 */

/**
 * Mints a per-session key: {@link REQUEST_KEY_SESSION_KEY_BYTES} random bytes
 * as {@link SESSION_KEY_HEX_LENGTH} lowercase hex characters.
 *
 * Call this once when a session is created and keep the result in the session
 * store, never in an event, a message, a log line or an outbound prompt. Its
 * only purpose is to make the stored digests opaque and unlinkable across
 * sessions: because each session keys under different bytes, the same request
 * in two sessions produces two unrelated values, so nothing about one capture
 * can be correlated with another — or with a dictionary of guessed URLs — from
 * the stored column alone.
 *
 * Randomness comes from `globalThis.crypto.getRandomValues` only, resolved at
 * call time, for the reasons in the module documentation. Unlike a trace id
 * this value is never redrawn for being all-zero: no specification forbids
 * that key, and at probability 2⁻²⁵⁶ a redraw loop would be decoration.
 *
 * **Throws** rather than returning a `Result`, which is the one exception to
 * this module's failure contract and matches `newTraceId()` / `newSpanId()`.
 * There is no partial answer to give: a session without a key cannot group
 * requests at all, the condition is a host defect rather than bad data, and it
 * is discovered once at session creation rather than per event.
 *
 * @returns 64 lowercase hex characters matching
 * {@link REQUEST_KEY_SESSION_KEY_PATTERN}.
 * @throws DebuggenError `INTERNAL` when the host provides no
 * `globalThis.crypto.getRandomValues`.
 */
export function createRequestKeySessionKey(): string {
  const source: RandomSource | undefined = globalThis.crypto;

  if (source === undefined || typeof source.getRandomValues !== 'function') {
    throw new DebuggenError(
      'INTERNAL',
      'Cannot mint a request-key session key: this host provides no globalThis.crypto.getRandomValues.',
      {
        hint: 'Run on a host with the Web Crypto global — Node.js 24 or a Chromium page context both provide it — or install a globalThis.crypto exposing getRandomValues(Uint8Array) before a session is created.',
        details: { requestedBytes: REQUEST_KEY_SESSION_KEY_BYTES },
      },
    );
  }

  return toHex(source.getRandomValues(new Uint8Array(REQUEST_KEY_SESSION_KEY_BYTES)));
}

/**
 * Checks a session key's shape and decodes it, disclosing nothing about the
 * value it rejected.
 *
 * The rejection names the expected shape and records two lengths — never the
 * supplied text, not even a prefix of it. A session key is a secret, and the
 * one place a secret most often ends up in a log is the error raised for
 * getting it wrong; the event schema's validation errors keep the same
 * discipline.
 */
function validateSessionKeyHex(sessionKey: string): Result<Uint8Array<ArrayBuffer>, DebuggenError> {
  if (!REQUEST_KEY_SESSION_KEY_PATTERN.test(sessionKey)) {
    return err(
      new DebuggenError(
        'INTERNAL',
        `A request-key session key must be exactly ${String(SESSION_KEY_HEX_LENGTH)} lowercase hexadecimal characters (${String(REQUEST_KEY_SESSION_KEY_BYTES)} random bytes).`,
        {
          hint: 'Mint it with createRequestKeySessionKey() and read it back from the session store; never derive it from session data and never accept it from a client.',
          details: {
            expectedCharacters: SESSION_KEY_HEX_LENGTH,
            receivedCharacters: sessionKey.length,
          },
        },
      ),
    );
  }
  return ok(hexToBytes(sessionKey));
}

/**
 * Checks the low-level {@link hmacSha256Hex} key argument and decodes it.
 *
 * Deliberately looser than {@link validateSessionKeyHex}: any non-empty,
 * even-length hex string in either case is accepted, because this is the
 * primitive a published test vector is measured against and such vectors use
 * keys of 4, 20 or 131 bytes. HMAC itself imposes no key length — shorter keys
 * are zero-padded to the block size and longer ones are hashed down — so
 * nothing here needs to. Case is accepted in both spellings because two
 * spellings of one hex string decode to the same bytes and therefore to the
 * same digest; only the *session* key is pinned to lowercase, where a second
 * spelling would mean a second copy of a secret.
 */
function validateHmacKeyHex(keyHex: string): Result<Uint8Array<ArrayBuffer>, DebuggenError> {
  if (
    keyHex.length === 0 ||
    keyHex.length % HEX_DIGITS_PER_BYTE !== 0 ||
    !HEX_PATTERN.test(keyHex)
  ) {
    return err(
      new DebuggenError(
        'INTERNAL',
        'An HMAC-SHA-256 key must be a non-empty hexadecimal string of even length (two characters per byte).',
        {
          hint: 'Pass key material as hex, for example the value createRequestKeySessionKey() returned.',
          details: { receivedCharacters: keyHex.length },
        },
      ),
    );
  }
  return ok(hexToBytes(keyHex));
}

/*
 * ---------------------------------------------------------------------------
 * Hashing
 * ---------------------------------------------------------------------------
 */

/**
 * HMAC-SHA-256 of `message` under the key given as hex, as 64 lowercase hex
 * characters.
 *
 * The low-level primitive of this module, exported for one reason: a keyed
 * digest is untestable from the outside — every wrong implementation produces
 * 64 plausible hex characters too — so the colocated test pins this function
 * against published HMAC-SHA-256 known-answer vectors. That is what proves the
 * hex encoding, the UTF-8 encoding of the message and the key decoding are
 * each right, rather than merely self-consistent.
 *
 * It is the WebCrypto counterpart of the same-named helper behind
 * `@debuggen/shared/node`, which computes the identical digest with
 * `node:crypto`. The duplication is deliberate and must stay: this package's
 * library bundle is built `platform: "neutral"` and its page agent bundle
 * rejects Node builtins, so the Node helper is unreachable from here, while
 * the service-side callers of that helper cannot depend on a browser global
 * being the one that computed a stored value. The two must agree bit for bit
 * for the same key bytes and message — note that `keyHex` here is *hex-decoded*
 * before use, so the Node helper has to be handed those decoded bytes (a
 * `Uint8Array`), not the hex text, which it would encode as UTF-8 instead.
 *
 * @param keyHex - Key material as hex, either case, even length, non-empty.
 * Never logged.
 * @param message - The text to authenticate, encoded as UTF-8. Never logged.
 * @returns `Ok` with 64 lowercase hex characters, or `Err` when the key is
 * malformed or the host has no usable Web Crypto. Never rejects.
 */
export async function hmacSha256Hex(
  keyHex: string,
  message: string,
): Promise<Result<string, DebuggenError>> {
  const keyBytes = validateHmacKeyHex(keyHex);
  if (isErr(keyBytes)) {
    return keyBytes;
  }

  try {
    const provider = resolveHmacProvider();
    const key = await importHmacKey(provider, keyBytes.value);
    return ok(await signMessage(provider, key, message));
  } catch (caught) {
    return err(asComputeError(caught));
  }
}

/**
 * A session-scoped request keyer: one validated key, many requests.
 *
 * Obtained from {@link createRequestKeyHasher} and held for the duration of an
 * ingest batch, which is what keeps the cost of the feature at one key import
 * per session rather than one per event.
 */
export interface RequestKeyHasher {
  /**
   * The `request_key` for one request, computed from its **unredacted** URL.
   *
   * @param method - HTTP method; trimmed and upper-cased, so `get` and `GET`
   * produce one key.
   * @param url - The request URL as the producer reported it, absolute or
   * origin-relative, before redaction.
   * @returns `Ok` with 64 lowercase hex characters, or `Err` when the host has
   * no usable Web Crypto. Never rejects: one unkeyable event must not cost a
   * batch its ingestion.
   */
  compute(method: string, url: string): Promise<Result<string, DebuggenError>>;
}

/**
 * Validates a session key and returns a hasher bound to it.
 *
 * The `CryptoKey` is imported **once**, on the first `compute` call, and the
 * in-flight promise is cached — so a batch of five thousand events performs one
 * import, and two concurrent calls share it rather than racing to import the
 * same bytes twice. The import is deferred to first use rather than done here
 * because it is asynchronous while this function is not, and because a session
 * that never sees a request should not pay for it.
 *
 * A failed `compute` clears the cache before returning its `Err`. A rejected
 * promise left in place would be permanent — every later event in the session
 * would replay one transient failure — and re-importing on the next call costs
 * a fraction of a millisecond against that.
 *
 * @param sessionKey - The session's key, 64 lowercase hex characters from
 * {@link createRequestKeySessionKey}. Never logged, and never echoed by the
 * rejection when it is malformed.
 * @returns `Ok` with the hasher, or `Err` when `sessionKey` does not match
 * {@link REQUEST_KEY_SESSION_KEY_PATTERN}.
 */
export function createRequestKeyHasher(
  sessionKey: string,
): Result<RequestKeyHasher, DebuggenError> {
  const validated = validateSessionKeyHex(sessionKey);
  if (isErr(validated)) {
    return validated;
  }

  const keyBytes = validated.value;
  let pendingKey: Promise<CryptoKey> | undefined;

  return ok({
    async compute(method: string, url: string): Promise<Result<string, DebuggenError>> {
      try {
        const provider = resolveHmacProvider();
        // Inside the `try` on purpose: the builder is total for every string,
        // but a value that reached ingest without being validated would throw
        // here, and that must become this event's `Err` rather than a rejected
        // promise nobody is waiting on.
        const message = buildRequestKeyMessage({ method, url });
        pendingKey ??= importHmacKey(provider, keyBytes);
        const key = await pendingKey;
        return ok(await signMessage(provider, key, message));
      } catch (caught) {
        pendingKey = undefined;
        return err(asComputeError(caught));
      }
    },
  });
}

/**
 * One request's key in one call: the convenience form of
 * {@link createRequestKeyHasher}.
 *
 * Use it for a single request — resolving one event, a test, a diagnostic.
 * Ingest uses the hasher instead, because this function validates the session
 * key and imports the `CryptoKey` on every call, which is exactly the
 * per-event cost the hasher exists to avoid.
 *
 * Not declared `async`: the only work it does before delegating is
 * synchronous, so the failure case is wrapped with `Promise.resolve` and the
 * success case returns the hasher's promise unchanged, adding no microtask tick
 * of its own.
 *
 * @param input - The session key, the HTTP method and the **unredacted** URL.
 * @returns `Ok` with 64 lowercase hex characters, or `Err` when the session key
 * is malformed or the host has no usable Web Crypto. Never rejects.
 */
export function computeRequestKey(input: {
  sessionKey: string;
  method: string;
  url: string;
}): Promise<Result<string, DebuggenError>> {
  const hasher = createRequestKeyHasher(input.sessionKey);
  if (isErr(hasher)) {
    return Promise.resolve(hasher);
  }
  return hasher.value.compute(input.method, input.url);
}
