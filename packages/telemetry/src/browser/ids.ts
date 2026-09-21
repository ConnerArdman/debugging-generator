/**
 * Every identifier the page-side telemetry agent mints, and the `traceparent`
 * header it writes by hand.
 *
 * This is the identifier leaf of `src/browser/**` — the lowest module in this
 * subtree's dependency graph, and the only one with no dependencies at all. It
 * produces the five shapes the agent needs:
 *
 * 1. **Trace ids** — one per correlated interaction. A click opens a trace, and
 *    every span the interaction causes across the browser, the Next.js server
 *    process and the database carries that one value, which is what lets one
 *    click resolve to one ordered tree.
 * 2. **Span ids** — one per recorded operation. A child names its parent by
 *    span id, and that `(traceId, parentSpanId)` edge is what the correlator
 *    walks.
 * 3. **Event ids** (`evt_…`) — one per emitted telemetry event; the stable
 *    secondary sort key of a paged panel-data response and the value an
 *    analysis cites when it claims a fact is evidenced.
 * 4. **A producer id** (`prd_…`) — one per page document, from
 *    {@link getProducerId}.
 * 5. **A document id** (`doc_…`) — one per page document, from
 *    {@link getDocumentId}, reported alongside the producer id in the agent's
 *    `agent.ready` message.
 *
 * ## W3C Trace Context
 *
 * Trace and span ids are not this product's invention: they are serialised into
 * the `traceparent` request header that {@link formatTraceparent} builds and
 * that the agent injects on same-origin `fetch` and `XHR` while an interaction
 * is in flight. Next.js's own tracer extracts that header on the way in, which
 * is the single seam joining browser evidence to server and database evidence.
 * So the specification dictates the shape, and this module obeys it exactly:
 *
 * ```text
 * traceparent: 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01
 *              ├┘ └──────────── 32 hex ───────────┘ └──── 16 hex ──┘ └┘
 *              version          trace id            span id       flags
 * ```
 *
 * Lowercase hex only, fixed lengths, and **never all-zero** — the
 * specification defines the all-zero trace id and the all-zero span id as
 * invalid, and a receiver is required to ignore a header built from one. An
 * ignored header is not a cosmetic problem: it is a click that never joins its
 * own route handler and database queries, which is the whole point of the
 * capture. {@link newTraceId} and {@link newSpanId} therefore exclude the value
 * rather than hoping about it, and {@link formatTraceparent} refuses to emit a
 * header it knows a receiver would drop.
 *
 * ## Why this file exists when `packages/shared/src/ids.ts` already does
 *
 * `@debuggen/shared` exports `newTraceId`, `newSpanId`, `newEventId` and
 * `newProducerId` already, and importing them here would be the obvious move.
 * It is also impossible. `esbuild.agent.mjs` bundles `src/browser/agent.ts`
 * into the IIFE that runs in the developer's page at `document_start`, and it
 * hard-fails the build — through a resolver plugin and a metafile audit — if any
 * input resolves to a Node builtin, to `@debuggen/protocol`, to
 * `@debuggen/shared/node` or to **`zod`**. Shared's `"."` barrel value-imports
 * `zod` by way of `source-location.ts`, and the resolver fires while the import
 * graph is being walked, long before tree-shaking could prove the import
 * unused. So an import statement naming `newTraceId` out of the
 * `@debuggen/shared` barrel does not produce a slightly larger bundle; it
 * produces no bundle and a failed build. (Written in prose rather than as a
 * code sample on purpose: the mechanical audit for this file greps for import
 * syntax, and a sample would be a false positive.)
 *
 * **This module therefore has zero import statements, and that is deliberate.**
 * Not shared, not a sibling in this folder, not `../schema/*`. Please do not
 * "fix" the duplication by adding one.
 *
 * ## The parity contract with `packages/shared/src/ids.ts`
 *
 * Duplicated code that drifts is worse than no duplication, and the drift here
 * would be silent and total. Ids minted in the page cross a process boundary:
 * the agent posts event batches to the isolated-world bridge, the Chrome
 * service worker wraps them in protocol envelopes, and the local service
 * validates every one against the strict `telemetryEventIngressSchema` in
 * `../schema/event.ts` — which reuses *shared's* `TRACE_ID_PATTERN` and
 * `SPAN_ID_PATTERN` for its `traceId`, `spanId` and `parentSpanId` fields. A
 * shape mismatch here does not degrade gracefully; it rejects every event the
 * page produces, and the panel stays empty for a reason no log line explains.
 *
 * The shapes mirrored from `packages/shared/src/ids.ts`, which remains the
 * authority for all of them:
 *
 * | Shape | Rule |
 * | --- | --- |
 * | trace id | 32 lowercase hex characters, never all-zero |
 * | span id | 16 lowercase hex characters, never all-zero |
 * | opaque id | `/^[a-z]{3}_[0-9a-z]{16}$/` — three-letter kind prefix, `_`, 16 characters of digits and lowercase letters |
 * | `evt_` | shared's `ID_PREFIXES.event` |
 * | `prd_` | shared's `ID_PREFIXES.producer` |
 *
 * `doc_` is the one prefix with no counterpart in shared's `ID_PREFIXES`,
 * because a document id never leaves the page bundle's own message payloads and
 * is never a store key. It keeps the opaque-id *shape* regardless, so the
 * repository-wide `/^[a-z]{3}_[0-9a-z]{16}$/` assertion holds for it too.
 *
 * ## What lives here, and what deliberately does not
 *
 * Time conversion is **not** here. `./transport.ts` owns `nowEpochMs()` and
 * `toEpochMs()`, and it also owns the per-producer monotonic `seq` counter that
 * every event carries: `seq` is scoped to `(producerId, captureId)`, so the
 * producer id this module memoizes is exactly what makes that counter
 * meaningful. Canonical ordering inside a trace is parent-before-child, then
 * `startTime`, then `(producerId, seq)`, then the store-assigned ingest
 * sequence — so two producers that stamp the same millisecond still order
 * deterministically, and a reload (a new document, hence a new producer id)
 * cannot make a fresh counter interleave with the previous document's events.
 * `packages/telemetry/src/node/config.ts` mints one producer id per process
 * with shared's generator for the same reason; keeping both shapes identical is
 * what lets the service treat browser and server producers uniformly.
 *
 * ## Guarantees this module makes to the page
 *
 * The agent runs inside somebody else's application. Breaking that application
 * is the one unforgivable failure, so:
 *
 * - **Nothing here throws.** Not on a host without Web Crypto, not on a
 *   `getRandomValues` that raises, not on a nonsensical argument. Every
 *   function returns a correctly shaped value or, for
 *   {@link formatTraceparent}, the empty string that tells the caller not to
 *   inject a header.
 * - **No side effects at import time** beyond pure constant initialisation.
 *   This module does not touch `crypto`, `document` or `window` while it is
 *   being evaluated, because at `document_start` the host may not have finished
 *   installing its globals. The memoized ids are minted lazily, on the first
 *   call to their accessor.
 * - **No reliance on runtime names.** The bundle is minified with no name
 *   banners, so nothing here reads `Function.prototype.name` or a class name.
 * - **Every ambient global is reached behind a `typeof` check**, because this
 *   TypeScript project also compiles the Node preload and the runtime-neutral
 *   library.
 */

// ---------------------------------------------------------------------------
// Byte and hex primitives
// ---------------------------------------------------------------------------

/**
 * How many distinct values a byte holds, which is also the size of
 * {@link HEX_BYTE_TABLE} and the divisor of the `Math.random` fallback.
 */
const BYTE_VALUES = 256;

/**
 * Hex characters per byte, which is the `padStart` width used to build
 * {@link HEX_BYTE_TABLE}.
 *
 * Padding is not decoration: without it a byte below `0x10` would contribute
 * one character instead of two, every id after it would be short by one, and
 * the length-anchored patterns below would reject the result.
 */
const HEX_DIGITS_PER_BYTE = 2;

/**
 * `0x00` … `0xff` rendered as two lowercase hex characters each, computed once.
 *
 * {@link toHex} runs on every trace id, span id and any other hex the agent
 * produces, so the per-byte `toString(16).padStart(2, '0')` that
 * `packages/shared/src/ids.ts` performs inline is hoisted into a table here: a
 * table lookup and a string concatenation per byte, with no intermediate
 * allocation per byte.
 *
 * Building it is pure computation over a literal length — no globals, no I/O,
 * no clock — which is the only kind of work this module permits at import time.
 */
const HEX_BYTE_TABLE: readonly string[] = Array.from({ length: BYTE_VALUES }, (_unused, byte) =>
  byte.toString(16).padStart(HEX_DIGITS_PER_BYTE, '0'),
);

/**
 * Upper bound on a single {@link randomHex} or {@link randomBytes} request.
 *
 * Two jobs. It keeps a mistaken caller — a length computed from a parsed header,
 * say — from asking the page to allocate megabytes, and it stays comfortably
 * under the 65 536-byte quota that `crypto.getRandomValues` rejects with a
 * `QuotaExceededError`, so the primary randomness path cannot be pushed into
 * the fallback by an oversized request. Every real caller asks for 16 bytes or
 * fewer.
 */
const MAX_RANDOM_BYTES = 1024;

/**
 * The part of the Web Crypto global this module uses, and nothing else.
 *
 * Declared locally rather than reusing the ambient `Crypto` type, for two
 * reasons. This program compiles with both `lib.dom.d.ts` and `@types/node` in
 * scope, and the two spell `getRandomValues` with different generic
 * constraints; and the method is declared **optional** here on purpose, so the
 * capability check in {@link fillFromWebCrypto} is a check the compiler agrees
 * is necessary rather than one a future stricter lint rule would call
 * redundant. The return type is `unknown` because the return value is ignored:
 * `getRandomValues` fills the array it is given in place.
 */
interface RandomSource {
  getRandomValues?: (bytes: Uint8Array) => unknown;
}

/**
 * Coerce a requested byte length into something `new Uint8Array(n)` accepts.
 *
 * `new Uint8Array(-1)` and `new Uint8Array(1.5)` both throw a `RangeError`, and
 * `new Uint8Array(NaN)` silently yields an empty array — so a caller that
 * computed a length from untrusted input could otherwise throw inside the
 * developer's page. Anything unusable becomes `0` (which yields an empty
 * string, a value the caller can test) and anything oversized is clamped to
 * {@link MAX_RANDOM_BYTES}.
 *
 * @param byteLength Requested number of bytes, possibly fractional, negative,
 * `NaN` or absurd.
 * @returns An integer in `0 … MAX_RANDOM_BYTES`.
 */
function normalizeByteLength(byteLength: number): number {
  if (!Number.isFinite(byteLength)) {
    return 0;
  }

  const floored = Math.floor(byteLength);
  if (floored <= 0) {
    return 0;
  }

  return floored > MAX_RANDOM_BYTES ? MAX_RANDOM_BYTES : floored;
}

/**
 * Fill `bytes` from `globalThis.crypto.getRandomValues`, reporting whether it
 * worked.
 *
 * The global is resolved **at call time**, never captured in a module-level
 * constant: this module is evaluated at `document_start`, before the page's own
 * scripts run and potentially before the host has finished installing its
 * globals, and a captured reference would freeze whatever was there at that
 * instant.
 *
 * Every step is defensive because the page is not ours. `crypto` may be absent
 * (an exotic or non-secure context), it may be present but shadowed by
 * application code with something that is not a function, and
 * `getRandomValues` itself may raise — a `QuotaExceededError` for an oversized
 * request, or a `TypeError` when called with the wrong receiver. The method is
 * therefore invoked with `.call(source, …)` so it keeps its `Crypto` receiver
 * (a detached reference raises an illegal-invocation `TypeError` in Chromium),
 * and the whole attempt sits inside a `try` that converts any failure into
 * `false` for {@link randomBytes} to handle.
 *
 * @param bytes Array to fill in place.
 * @returns `true` when `bytes` now holds cryptographically strong random
 * values, `false` when the caller must fall back.
 */
function fillFromWebCrypto(bytes: Uint8Array): boolean {
  if (typeof globalThis === 'undefined') {
    return false;
  }

  try {
    const scope = globalThis as unknown as { crypto?: RandomSource | null };
    const source = scope.crypto;
    if (source === undefined || source === null) {
      return false;
    }

    const getRandomValues = source.getRandomValues;
    if (typeof getRandomValues !== 'function') {
      return false;
    }

    getRandomValues.call(source, bytes);
    return true;
  } catch {
    return false;
  }
}

/**
 * A new `Uint8Array` of `byteLength` random bytes, from Web Crypto when the
 * page provides it and from `Math.random` when it does not.
 *
 * ## The deliberate divergence from `packages/shared/src/ids.ts`
 *
 * Shared's `randomBytes` throws a `DebuggenError` when no Web Crypto global is
 * available. This one must not, and cannot: it has no `DebuggenError` to throw
 * (importing one is banned — see the module header), and more importantly an
 * exception raised here would surface inside the developer's application, in a
 * capture-phase event listener or a patched `fetch`, which is exactly the
 * damage the agent exists to avoid. **A page that has lost `crypto` must still
 * load.**
 *
 * Degrading to `Math.random` is safe here in a way it would not be in the
 * service, because of what these bytes are for. Trace ids, span ids and event
 * ids are **correlation keys, not secrets**: they are not credentials, they
 * authorise nothing, they live for the length of one debugging capture on one
 * developer's machine, and the only property that matters is that two
 * concurrently live ids differ. `Math.random` is a poor cryptographic source
 * and an entirely adequate source of 128 bits of distinctness for that. The
 * alternative — refusing to capture at all on a host whose `crypto` an
 * application has shadowed — trades a real capability for no security benefit.
 *
 * @param byteLength How many bytes to produce; normalised by
 * {@link normalizeByteLength}.
 * @returns A fresh array of exactly `normalizeByteLength(byteLength)` bytes.
 */
function randomBytes(byteLength: number): Uint8Array {
  const length = normalizeByteLength(byteLength);
  const bytes = new Uint8Array(length);

  if (length === 0 || fillFromWebCrypto(bytes)) {
    return bytes;
  }

  for (let index = 0; index < length; index += 1) {
    bytes[index] = Math.floor(Math.random() * BYTE_VALUES);
  }

  return bytes;
}

/**
 * Render bytes as lowercase hex, two characters per byte.
 *
 * Iterated with `for…of` rather than by index: `noUncheckedIndexedAccess` is
 * on, so `bytes[i]` would be `number | undefined` and would need an assertion
 * the iterator form makes unnecessary.
 *
 * The `?? '00'` on the table lookup is unreachable — a `Uint8Array` element is
 * an integer in `0 … 255` and the table has exactly 256 entries — and is
 * written that way so the same `noUncheckedIndexedAccess` rule is satisfied
 * without a non-null assertion. Should it ever fire, it contributes two
 * characters like every other byte, so the result keeps its length and its
 * shape instead of failing validation at ingest.
 *
 * @param bytes The bytes to render.
 * @returns `bytes.length * 2` lowercase hex characters.
 */
function toHex(bytes: Uint8Array): string {
  let hex = '';
  for (const byte of bytes) {
    hex += HEX_BYTE_TABLE[byte] ?? '00';
  }
  return hex;
}

/**
 * `byteLength` random bytes as lowercase hex.
 *
 * The primitive the id generators in this module are built from, exported so a
 * test can exercise the randomness and encoding paths directly rather than
 * inferring them from a trace id. Callers that need a W3C identifier should use
 * {@link newTraceId} or {@link newSpanId} instead: those additionally guarantee
 * the value is not all-zero.
 *
 * @param byteLength How many random bytes to render; normalised by
 * {@link normalizeByteLength}, so a negative, fractional or absurd argument
 * yields `''` or a clamped result rather than an exception.
 * @returns `2 * normalizeByteLength(byteLength)` lowercase hex characters.
 */
export function randomHex(byteLength: number): string {
  return toHex(randomBytes(byteLength));
}

// ---------------------------------------------------------------------------
// W3C trace and span identifiers
// ---------------------------------------------------------------------------

/**
 * The exact shape of a trace id: 32 lowercase hex characters, anchored at both
 * ends.
 *
 * Mirrors `TRACE_ID_PATTERN` in `packages/shared/src/ids.ts`, which is the
 * pattern `../schema/event.ts` validates ingested events with. Uppercase hex is
 * rejected deliberately: the `traceparent` format is defined over lowercase
 * hex, and two spellings of one id would split a single trace in two when the
 * correlator groups by string equality.
 *
 * Deliberately **no** `g` flag. A global regex carries a mutable `lastIndex`
 * that `RegExp.prototype.test` advances, so a shared, exported, stateful
 * matcher would make each call's result depend on the previous one — an
 * order-dependent bug that only appears once the agent is busy.
 */
export const TRACE_ID_PATTERN = /^[0-9a-f]{32}$/;

/**
 * The exact shape of a span id: 16 lowercase hex characters, anchored at both
 * ends.
 *
 * The span-id counterpart of {@link TRACE_ID_PATTERN}, mirroring shared's
 * `SPAN_ID_PATTERN`, with the same lowercase-only rule and the same deliberate
 * absence of the `g` flag.
 */
export const SPAN_ID_PATTERN = /^[0-9a-f]{16}$/;

/**
 * Matches a hex string that is entirely zeroes, of any length.
 *
 * Used by {@link formatTraceparent} to refuse the two values W3C Trace Context
 * declares invalid. It is anchored and has no `g` flag for the same reasons as
 * the patterns above.
 */
const ALL_ZERO_HEX_PATTERN = /^0+$/;

/**
 * Whether `value` is a well-formed trace id.
 *
 * A type guard for boundaries that receive unvalidated input — a `traceparent`
 * header read back from a request, a value relayed through `postMessage`, an
 * id stored in the page by a previous document — where the compiler knows only
 * `unknown`. The string check comes first, so a number, `null` or an object is
 * rejected rather than coerced to text and matched.
 *
 * Note that a syntactically valid id is not necessarily a *usable* one: this
 * function accepts the all-zero trace id, which {@link newTraceId} never
 * produces and which the specification defines as invalid.
 * {@link formatTraceparent} rejects it explicitly; callers that build a header
 * themselves must do the same.
 *
 * @param value Any value, typically from outside this module.
 * @returns `true` when `value` is a string of 32 lowercase hex characters.
 */
export function isTraceId(value: unknown): value is string {
  return typeof value === 'string' && TRACE_ID_PATTERN.test(value);
}

/**
 * Whether `value` is a well-formed span id.
 *
 * The span-id counterpart of {@link isTraceId}, with the same string-first
 * check and the same caveat about the all-zero value.
 *
 * @param value Any value, typically from outside this module.
 * @returns `true` when `value` is a string of 16 lowercase hex characters.
 */
export function isSpanId(value: unknown): value is string {
  return typeof value === 'string' && SPAN_ID_PATTERN.test(value);
}

/** Byte count of a trace id: 16 bytes rendered as 32 hex characters. */
const TRACE_ID_BYTES = 16;

/** Byte count of a span id: 8 bytes rendered as 16 hex characters. */
const SPAN_ID_BYTES = 8;

/**
 * Whether every byte is zero.
 *
 * Iterated with `for…of` for the same `noUncheckedIndexedAccess` reason as
 * {@link toHex}, and returning on the first non-zero byte, which is the
 * overwhelmingly common case: one comparison for all but a vanishing fraction
 * of calls.
 *
 * @param bytes The bytes to inspect.
 * @returns `true` when `bytes` contains no non-zero byte.
 */
function isAllZeroBytes(bytes: Uint8Array): boolean {
  for (const byte of bytes) {
    if (byte !== 0) {
      return false;
    }
  }
  return true;
}

/**
 * `byteLength` random bytes as lowercase hex, guaranteed not to be all-zero.
 *
 * W3C Trace Context defines the all-zero trace id and the all-zero span id as
 * invalid, and a `traceparent` header built from either is an invalid header a
 * receiver must ignore. That would break correlation exactly where it matters,
 * since the injected header is the only thing tying a browser interaction to
 * the server spans it causes.
 *
 * The correction is a single bounded step rather than a retry loop. Shared's
 * generator redraws up to eight times and then throws, on the reasoning that
 * eight consecutive all-zero draws prove the randomness source is broken — but
 * throwing is not available here, and neither is looping until a broken source
 * cooperates, because a source that returns zeroes would loop forever. So one
 * draw is taken, and if it is all-zero the last byte is overwritten with a
 * value in `1 … 255`: the result is then non-zero by construction, in constant
 * time, whatever the source is doing. On a working source this branch runs with
 * probability 2⁻⁶⁴ for a span id and 2⁻¹²⁸ for a trace id; on a stubbed source
 * it is what keeps the capture alive.
 *
 * @param byteLength How many random bytes the id is made of.
 * @returns `byteLength * 2` lowercase hex characters, not all zero.
 */
function newNonZeroHex(byteLength: number): string {
  const bytes = randomBytes(byteLength);

  if (bytes.length > 0 && isAllZeroBytes(bytes)) {
    // `(seed % 255) + 1` lands in 1 … 255 for every possible byte, so the last
    // byte is non-zero no matter what the extra draw returned — including
    // another zero.
    const extra = randomBytes(1);
    const seed = extra[0] ?? 0;
    bytes[bytes.length - 1] = (seed % (BYTE_VALUES - 1)) + 1;
  }

  return toHex(bytes);
}

/**
 * Create a trace id: 16 random bytes as 32 lowercase hex characters.
 *
 * Called once per correlated interaction. The agent opens a trace when a user
 * interaction begins and every span the interaction causes — React renders and
 * commits, the `fetch` it triggers, the Next.js request and route handler that
 * answers, the service functions and SQL beneath them — carries this same
 * value. The result always satisfies {@link TRACE_ID_PATTERN} and is never
 * all-zero, so it is safe to hand straight to {@link formatTraceparent}.
 *
 * @returns A fresh trace id.
 */
export function newTraceId(): string {
  return newNonZeroHex(TRACE_ID_BYTES);
}

/**
 * Create a span id: 8 random bytes as 16 lowercase hex characters.
 *
 * Called once per operation the agent records. The result always satisfies
 * {@link SPAN_ID_PATTERN} and is never all-zero.
 *
 * @returns A fresh span id.
 */
export function newSpanId(): string {
  return newNonZeroHex(SPAN_ID_BYTES);
}

// ---------------------------------------------------------------------------
// Opaque prefixed identifiers
// ---------------------------------------------------------------------------

/**
 * The alphabet every opaque id is drawn from: digits and lowercase letters, and
 * nothing else.
 *
 * Identical to `ID_ALPHABET` in `packages/shared/src/ids.ts` — see the parity
 * note in the module header — and exported because the same restriction is what
 * makes `/^[a-z]{3}_[0-9a-z]{16}$/` a valid assertion for every id in the
 * product. The exclusions matter: `_` is the prefix delimiter, so it cannot
 * also appear in the random part; and one case means no id that differs from
 * another only by case, and so no pair of distinct ids that a
 * case-insensitive comparison would collide.
 *
 * Thirty-six symbols over {@link OPAQUE_ID_LENGTH} positions is about 82.7 bits
 * of entropy per id (`16 × log₂36`), which is ample for identifiers scoped to
 * one capture on one developer's machine.
 */
export const OPAQUE_ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

/**
 * How many {@link OPAQUE_ID_ALPHABET} characters follow the prefix and
 * underscore in every opaque id, matching shared's `ID_RANDOM_LENGTH`.
 */
export const OPAQUE_ID_LENGTH = 16;

/** Size of {@link OPAQUE_ID_ALPHABET}: 36 symbols. */
const OPAQUE_ID_ALPHABET_SIZE = OPAQUE_ID_ALPHABET.length;

/**
 * Highest byte value, exclusive, that maps onto the alphabet without bias:
 * `⌊256 / 36⌋ × 36 = 252`.
 *
 * A plain `byte % 36` would make the seven symbols at indices 0 … 3 appear
 * eight times per 256 draws while the remaining thirty-two appear seven — about
 * 14 % more often — because 36 does not divide 256. Bytes at or above this
 * limit are discarded instead, which is the rejection sampling nanoid performs
 * internally and that shared therefore inherits. The bias would not be a
 * security flaw at this size, but a skewed id distribution is the kind of
 * detail that makes collision reasoning wrong later, and discarding 4 bytes in
 * 256 costs nothing.
 */
const UNBIASED_BYTE_LIMIT =
  Math.floor(BYTE_VALUES / OPAQUE_ID_ALPHABET_SIZE) * OPAQUE_ID_ALPHABET_SIZE;

/**
 * How many times {@link randomAlphabetChars} may draw before it stops
 * rejecting.
 *
 * Each round over-draws (see {@link SAMPLING_SLACK_DIVISOR}), so one round
 * fills the string with probability well above 0.999 and four rounds leave a
 * residual probability far below anything that will ever be observed. The bound
 * exists for the case the probabilities do not describe: a randomness source
 * that keeps returning bytes at or above {@link UNBIASED_BYTE_LIMIT}, against
 * which an unbounded loop would hang the page's event handler forever. A hung
 * page is a worse failure than a very slightly biased id.
 */
const MAX_SAMPLING_ROUNDS = 4;

/**
 * Over-draw factor for rejection sampling: each round asks for the characters
 * still missing plus an eighth of that again (`⌈missing / 8⌉` spare bytes).
 *
 * Rejection costs 4/256 ≈ 1.56 % of bytes, so the two spare bytes on a
 * 16-character draw cover the expected loss (0.25 bytes) many times over —
 * eight or more rejections in eighteen bytes has probability well under 10⁻¹⁰ —
 * which turns the usual case into exactly one call to the randomness source per
 * id.
 */
const SAMPLING_SLACK_DIVISOR = 8;

/**
 * `length` characters drawn uniformly from {@link OPAQUE_ID_ALPHABET}.
 *
 * Allocation-light on purpose: this runs on every emitted telemetry event, in
 * the page, during a capture. The common path is one `Uint8Array` and one
 * accumulating string; `charAt` is used rather than an index expression because
 * it returns `string` rather than `string | undefined` under
 * `noUncheckedIndexedAccess`, which keeps the hot loop free of a fallback
 * branch.
 *
 * @param length How many characters to produce.
 * @returns Exactly `length` characters of {@link OPAQUE_ID_ALPHABET}, or `''`
 * when `length` is not positive.
 */
function randomAlphabetChars(length: number): string {
  if (length <= 0) {
    return '';
  }

  let out = '';

  for (let round = 0; round < MAX_SAMPLING_ROUNDS && out.length < length; round += 1) {
    const missing = length - out.length;
    const draw = randomBytes(missing + Math.ceil(missing / SAMPLING_SLACK_DIVISOR));

    for (const byte of draw) {
      if (out.length === length) {
        break;
      }
      if (byte < UNBIASED_BYTE_LIMIT) {
        out += OPAQUE_ID_ALPHABET.charAt(byte % OPAQUE_ID_ALPHABET_SIZE);
      }
    }
  }

  if (out.length < length) {
    // Bounded fallback, reached only when the source spent four whole rounds
    // returning bytes ≥ UNBIASED_BYTE_LIMIT. A marginally biased id keeps the
    // capture running; an unbounded retry would not.
    for (const byte of randomBytes(length - out.length)) {
      out += OPAQUE_ID_ALPHABET.charAt(byte % OPAQUE_ID_ALPHABET_SIZE);
    }
  }

  return out;
}

/** Kind prefix of an event id, matching shared's `ID_PREFIXES.event`. */
const EVENT_ID_PREFIX = 'evt';

/** Kind prefix of a producer id, matching shared's `ID_PREFIXES.producer`. */
const PRODUCER_ID_PREFIX = 'prd';

/**
 * Kind prefix of a document id.
 *
 * The one prefix without a counterpart in shared's `ID_PREFIXES`: a document id
 * identifies one page document to the agent's own `agent.ready` message and is
 * never a store key, so it needs no entry in the product-wide vocabulary. It
 * keeps the opaque-id shape regardless — see the module header.
 */
const DOCUMENT_ID_PREFIX = 'doc';

/**
 * Assemble an opaque id: the prefix, one underscore, then
 * {@link OPAQUE_ID_LENGTH} characters of {@link OPAQUE_ID_ALPHABET}.
 *
 * @param prefix Three lowercase letters naming the kind.
 * @returns A 20-character id matching `/^[a-z]{3}_[0-9a-z]{16}$/`.
 */
function newOpaqueId(prefix: string): string {
  return `${prefix}_${randomAlphabetChars(OPAQUE_ID_LENGTH)}`;
}

/**
 * Create an event id (`evt_…`).
 *
 * Called for every event the agent emits — interactions, renders, commits,
 * state transitions, requests, performance entries and errors alike. It is the
 * value an analysis cites as evidence and the stable secondary sort key that
 * keeps a paged panel-data response deterministic, so it is minted once per
 * event and never rewritten.
 *
 * @returns A fresh event id, for example `evt_7f3q0m2zk1x8ab9c`.
 */
export function newEventId(): string {
  return newOpaqueId(EVENT_ID_PREFIX);
}

/**
 * Create a producer id (`prd_…`).
 *
 * Prefer {@link getProducerId}, which memoizes one value for this document;
 * this function exists for the accessor to build on and for tests that need two
 * independent values.
 *
 * @returns A fresh producer id.
 */
export function newProducerId(): string {
  return newOpaqueId(PRODUCER_ID_PREFIX);
}

/**
 * Create a document id (`doc_…`).
 *
 * Prefer {@link getDocumentId}, for the same reason as {@link newProducerId}.
 *
 * @returns A fresh document id.
 */
export function newDocumentId(): string {
  return newOpaqueId(DOCUMENT_ID_PREFIX);
}

// ---------------------------------------------------------------------------
// Per-document memoized identities
// ---------------------------------------------------------------------------

/**
 * This document's producer id, minted on the first {@link getProducerId} call.
 *
 * Module state, which is per JS context: the agent bundle is evaluated once per
 * page document, so one document means one producer, and a reload means a new
 * one. That is the behaviour `seq` scoping depends on — see the module header.
 */
let memoizedProducerId: string | undefined;

/**
 * This document's document id, minted on the first {@link getDocumentId} call.
 */
let memoizedDocumentId: string | undefined;

/**
 * This document's producer id, the same value for every call.
 *
 * Every event the agent emits carries it, and `./transport.ts` scopes its
 * monotonic `seq` counter to `(producerId, captureId)`, which makes
 * `(producerId, seq)` the tie-breaker when two producers stamp the same
 * `startTime`. Two distinct producer ids inside one document would therefore
 * split one counter's sequence into two incomparable halves, and a single id
 * shared across documents would let a reloaded page's counter — restarting at
 * zero — interleave with the previous document's events.
 *
 * Minted lazily rather than at import time, because this module is evaluated at
 * `document_start`, and deliberately **not** resettable: there is no
 * `resetProducerId` export, since resetting it mid-document is precisely the
 * state the ordering rules assume cannot happen.
 *
 * @returns This document's producer id, stable for the lifetime of the
 * document.
 */
export function getProducerId(): string {
  memoizedProducerId ??= newProducerId();
  return memoizedProducerId;
}

/**
 * This document's document id, the same value for every call.
 *
 * Reported next to the producer id in the agent's `agent.ready` message —
 * `{ tabId, documentId, producerId, url, installedBeforeReact, reactDetected }`
 * — which the Chrome service worker relays so the service can tell a fresh
 * document from a reconnecting one when it decides whether readiness still
 * holds.
 *
 * It is always a **different** value from {@link getProducerId}: the two are
 * drawn independently, and their prefixes (`doc_` and `prd_`) differ even in
 * the impossible case where the random parts collide.
 *
 * @returns This document's document id, stable for the lifetime of the
 * document.
 */
export function getDocumentId(): string {
  memoizedDocumentId ??= newDocumentId();
  return memoizedDocumentId;
}

// ---------------------------------------------------------------------------
// W3C traceparent header
// ---------------------------------------------------------------------------

/**
 * The only `traceparent` version this product writes or expects.
 *
 * Version `00` is the one defined by the W3C Trace Context Level 1
 * recommendation, and it is what Next.js's propagator parses on the way in.
 */
const TRACEPARENT_VERSION = '00';

/** Trace-flags byte with the `sampled` bit set. */
const TRACE_FLAG_SAMPLED = '01';

/** Trace-flags byte with the `sampled` bit clear. */
const TRACE_FLAG_NOT_SAMPLED = '00';

/**
 * Build a W3C `traceparent` header value, or `''` when the ids cannot make a
 * valid one.
 *
 * The agent calls this while an interaction is in flight and injects the result
 * on same-origin `fetch` and `XHR`; the header is extracted server-side by
 * Next.js's request tracer once the Node preload has registered a provider with
 * the W3C propagator. It is the entire mechanism by which a click joins its own
 * route handler, service functions and SQL — so what this function returns
 * decides whether an investigation sees one tree or two disconnected halves.
 *
 * ## Why it returns a string instead of throwing
 *
 * `./fetch.ts` treats `''` as "do not inject" and proceeds with the request
 * untouched. That contract is deliberate: this code runs inside the developer's
 * own request path, and a malformed id is a bug in the agent, not a reason to
 * break the application's network call. A missing header costs one uncorrelated
 * request in a debugging panel; a thrown exception costs the page.
 *
 * Both ids are validated against {@link TRACE_ID_PATTERN} and
 * {@link SPAN_ID_PATTERN}, and the all-zero forms are rejected on top of that:
 * they pass the length-and-alphabet check but the specification defines them as
 * invalid, so a receiver would ignore the whole header and the injection would
 * be worse than useless — it would look like correlation was attempted and had
 * simply failed. Ids from {@link newTraceId} and {@link newSpanId} always pass.
 *
 * @param traceId The 32-hex trace id of the interaction.
 * @param spanId The 16-hex span id of the request being made, which becomes the
 * parent of the server span.
 * @param sampled Whether to set the `sampled` flag; defaults to `true`, so the
 * ordinary call site yields `00-‹traceId›-‹spanId›-01`. Only an explicit
 * `false` clears the bit — `undefined` means "not specified", not "not
 * sampled".
 * @returns A `traceparent` value, or `''` when either id is malformed or
 * all-zero.
 */
export function formatTraceparent(traceId: string, spanId: string, sampled?: boolean): string {
  if (!isTraceId(traceId) || !isSpanId(spanId)) {
    return '';
  }

  if (ALL_ZERO_HEX_PATTERN.test(traceId) || ALL_ZERO_HEX_PATTERN.test(spanId)) {
    return '';
  }

  const flags = sampled === false ? TRACE_FLAG_NOT_SAMPLED : TRACE_FLAG_SAMPLED;
  return `${TRACEPARENT_VERSION}-${traceId}-${spanId}-${flags}`;
}
