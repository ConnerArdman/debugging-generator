/**
 * Every identifier shape in the product, constructed in exactly one place.
 *
 * Four processes cooperate here — the local service, the VS Code extension
 * host, the DevTools panel and the page agent — and all four mint identifiers:
 * the browser agent creates a trace id per interaction and a producer id per
 * document, the Node preload creates span ids and a producer id per process,
 * the service creates session, capture, panel and analysis ids and uses them as
 * store primary keys, and the protocol stamps a message id on every envelope.
 * If any two of them disagreed about a shape, correlation would silently stop
 * joining and a stored row would stop matching its live counterpart. So the
 * rules live here and nowhere else, and every layer above imports them:
 *
 * - `@debuggen/telemetry` — event ids, the producer id, trace and span creation
 *   in the browser agent and in the Node span converter, and the two patterns
 *   below, which `schema/event.ts` uses to validate its `traceId`/`spanId`
 *   fields rather than restating the regex.
 * - `@debuggen/protocol` — the `id` of the message envelope.
 * - `@debuggen/instrumentation` — action and modification ids.
 * - `apps/local-service` — session, capture, panel and analysis ids, which are
 *   also the primary keys of the session store.
 *
 * Two distinct id families live here, because they answer to different
 * authorities and must not be conflated:
 *
 * 1. **W3C trace and span identifiers** — lowercase hex of a fixed length,
 *    never all-zero, because they are serialised into the `traceparent` request
 *    header that the browser agent injects on same-origin fetch and XHR and
 *    that the server tracer extracts. Their shape is dictated by the W3C Trace
 *    Context specification, not by this product.
 * 2. **Opaque entity identifiers** — a three-letter kind prefix, an
 *    underscore, and sixteen characters of lowercase-alphanumeric randomness.
 *    Their shape is this product's own decision, recorded in
 *    {@link ID_PREFIXES} and {@link newId}, and it is a contract: a session id
 *    is interpolated into a filesystem path, a SQLite key and a URL path.
 *
 * ## Randomness
 *
 * This module belongs to the browser-safe `"."` entry of `@debuggen/shared`,
 * which the page agent, the DevTools panel and the VS Code webview all bundle
 * alongside the service and the preload. It therefore takes its randomness from
 * the `globalThis.crypto.getRandomValues` Web Crypto global **only** — never
 * from `node:crypto`. Node.js 24 (the pinned runtime) and every Chromium page
 * context provide that global, so one code path serves all five surfaces, and
 * Node-only helpers stay behind the separate `"./node"` entry.
 */

import { customAlphabet } from 'nanoid';

import { DebuggenError } from './errors.js';

// ---------------------------------------------------------------------------
// Id types
//
// Every alias below is a plain `string`, deliberately: not a zod brand, not an
// intersection brand, not a nominal wrapper.
//
// Branding would buy compile-time protection against passing a capture id
// where a session id belongs, and it would cost that protection everywhere the
// ids actually travel. The protocol and telemetry schemas are built on
// `z.string()`, so a branded type would force a `.brand()` call (and a cast on
// every `z.infer` consumer) into schemas that four processes share; a row read
// back out of the `node:sqlite` store arrives as `string` and would need a cast
// at every repository boundary; and a value that arrived through `postMessage`
// or a JSON round-trip has no brand to begin with. The aliases are therefore
// documentation with a type-checked name — they make a signature say what it
// means — while the *shape* is enforced where shape can actually be checked: by
// the patterns in this file and by schema validation at each process boundary.
// ---------------------------------------------------------------------------

/**
 * A W3C Trace Context trace id: 32 lowercase hex characters, never all-zero.
 *
 * Identifies one correlated interaction end to end — browser handler, React
 * work, fetch, server request, route handler, service functions, SQL and
 * external calls all share it — which is what lets one click resolve to one
 * ordered tree. Created by {@link newTraceId} and validated by
 * {@link isTraceId} or {@link TRACE_ID_PATTERN}.
 */
export type TraceId = string;

/**
 * A W3C Trace Context span id: 16 lowercase hex characters, never all-zero.
 *
 * Identifies one operation within a trace. A child span names its parent by
 * span id, and that edge — `(traceId, parentSpanId)` — is what the correlator
 * walks to build the tree. Created by {@link newSpanId} and validated by
 * {@link isSpanId} or {@link SPAN_ID_PATTERN}.
 */
export type SpanId = string;

/**
 * Identifies one telemetry producer: one page document, or one server process.
 *
 * Created by {@link newProducerId}. It scopes the per-producer monotonic `seq`
 * counter carried on every event, and `(producerId, seq)` is the tie-breaker in
 * the canonical ordering of a trace, so two producers that stamp the same
 * `startTime` still order deterministically.
 */
export type ProducerId = string;

/**
 * Identifies one debugging session: a question, its plan, its captures, its
 * analyses and its panels.
 *
 * Created by {@link newSessionId}. It is a store primary key **and** a path
 * segment — the patcher's backup directory is
 * `$DEBUGGEN_HOME/backups/<sessionId>/<originalHash>` — which is why the
 * alphabet in {@link newId} is restricted the way it is.
 */
export type SessionId = string;

/**
 * Identifies one capture window within a session: the span between a capture
 * starting and stopping, to which every ingested event is attributed.
 *
 * Created by {@link newCaptureId}. A session may run several captures — a
 * follow-up that needs new evidence starts another one — so telemetry, panels
 * and analyses all carry the capture they came from.
 */
export type CaptureId = string;

/**
 * Identifies one generated panel specification.
 *
 * Created by {@link newPanelId}. Panels are versioned rather than replaced: a
 * regenerated panel is a new id whose `supersedes` names the previous one, so a
 * reopened session can still render what the developer originally saw.
 */
export type PanelId = string;

/**
 * Identifies one analysis result — the observed facts and likely causes drawn
 * from a capture.
 *
 * Created by {@link newAnalysisId}. Like panels, analyses accumulate across
 * follow-ups instead of overwriting, so the evidence a panel cites stays
 * reachable.
 */
export type AnalysisId = string;

/**
 * Identifies one recorded modification to a file in the developer's project.
 *
 * Created by {@link newModificationId}. The record it keys carries the original
 * hash, the instrumented hash, the backup path and the diff, and cleanup
 * restores strictly by following those records — so this id is how a temporary
 * edit stays reversible.
 */
export type ModificationId = string;

/**
 * Identifies one action within an instrumentation plan.
 *
 * Created by {@link newActionId}. A follow-up plan is additive — the next plan
 * version is the previous one plus new actions — so the installer compares
 * action ids to apply only the delta and never reinstalls what is already in
 * place.
 */
export type ActionId = string;

/**
 * Identifies one telemetry event, unique across every producer in a session.
 *
 * Created by {@link newEventId}. It is the stable secondary sort key that keeps
 * paged panel-data responses deterministic, and the value an analysis cites
 * when it claims a fact is evidenced.
 */
export type EventId = string;

/**
 * Identifies one protocol message.
 *
 * Created by {@link newMessageId}, which fills the `id` field of the envelope
 * `{ id, type, sessionId?, ts, payload }` that every WebSocket frame carries.
 */
export type MessageId = string;

// ---------------------------------------------------------------------------
// W3C trace and span identifiers
// ---------------------------------------------------------------------------

/**
 * The exact shape of a {@link TraceId}: 32 lowercase hex characters, anchored
 * at both ends.
 *
 * Exported because it is the *single* definition of the rule:
 * `packages/telemetry/src/schema/event.ts` validates its `traceId` field with
 * this pattern instead of writing its own, so a producer, the store and the
 * schema cannot drift apart.
 *
 * Uppercase hex is rejected on purpose. The `traceparent` header format is
 * defined over lowercase hex, and two spellings of one id would split a trace
 * into two when the correlator groups by string equality.
 *
 * Deliberately **no** `g` flag: a global regex carries a mutable `lastIndex`
 * that `RegExp.prototype.test` advances, which would make the result of the
 * next call depend on the previous one. A shared, exported, stateful matcher is
 * exactly the kind of order-dependent bug that appears only under load.
 */
export const TRACE_ID_PATTERN = /^[0-9a-f]{32}$/;

/**
 * The exact shape of a {@link SpanId}: 16 lowercase hex characters, anchored at
 * both ends.
 *
 * The span-id counterpart of {@link TRACE_ID_PATTERN}, with the same
 * lowercase-only rule and the same deliberate absence of the `g` flag, and used
 * by the telemetry event schema for the `spanId` and `parentSpanId` fields.
 */
export const SPAN_ID_PATTERN = /^[0-9a-f]{16}$/;

/**
 * Whether `value` is a well-formed {@link TraceId}.
 *
 * A type guard for boundaries that receive unvalidated input — an event batch
 * relayed from a page, a `traceparent` header field, a row read back from the
 * store — where the compiler knows only `unknown`. It checks the string type
 * before the pattern, so a number, `null` or an object is rejected rather than
 * coerced to text and matched.
 *
 * Note that a syntactically valid id is not necessarily a *useful* one: this
 * function accepts the all-zero trace id, which {@link newTraceId} never
 * produces but which the W3C specification defines as invalid. Callers that
 * need that distinction should reject the all-zero value explicitly.
 *
 * @param value Any value, typically from outside this process.
 * @returns `true` when `value` is a string of 32 lowercase hex characters.
 */
export function isTraceId(value: unknown): value is TraceId {
  return typeof value === 'string' && TRACE_ID_PATTERN.test(value);
}

/**
 * Whether `value` is a well-formed {@link SpanId}.
 *
 * The span-id counterpart of {@link isTraceId}, with the same string-first
 * check and the same caveat about the all-zero value.
 *
 * @param value Any value, typically from outside this process.
 * @returns `true` when `value` is a string of 16 lowercase hex characters.
 */
export function isSpanId(value: unknown): value is SpanId {
  return typeof value === 'string' && SPAN_ID_PATTERN.test(value);
}

/** Byte count of a {@link TraceId}: 16 bytes rendered as 32 hex characters. */
const TRACE_ID_BYTES = 16;

/** Byte count of a {@link SpanId}: 8 bytes rendered as 16 hex characters. */
const SPAN_ID_BYTES = 8;

/** Hex characters per byte, which is also the `padStart` width in {@link toHex}. */
const HEX_DIGITS_PER_BYTE = 2;

/**
 * How many times {@link newHexId} may redraw before giving up on a non-zero id.
 *
 * Eight is far more than generosity requires. Drawing all-zero bytes has
 * probability 2^-64 for a span id and 2^-128 for a trace id, so eight
 * consecutive failures is not an unlucky run — it is proof that the host's
 * randomness is not random, which is a condition to report rather than to
 * retry forever.
 */
const MAX_NON_ZERO_ATTEMPTS = 8;

/**
 * The part of the Web Crypto global this module actually uses.
 *
 * Narrowed to the single method on purpose: it documents that identifier
 * generation needs nothing else from `crypto` (no `subtle`, no `randomUUID`),
 * and it keeps the type honest across hosts, since `Pick` follows whatever the
 * ambient `Crypto` type is in the surface being compiled.
 */
type RandomSource = Pick<typeof globalThis.crypto, 'getRandomValues'>;

/**
 * Fill a fresh `Uint8Array` with cryptographically strong random bytes.
 *
 * The global is resolved **at call time**, on every call, and never captured in
 * a module-level constant. Two reasons, both load-bearing:
 *
 * - A module-level read runs at import time, which in a page bundle can be
 *   before the host has finished setting up its globals.
 * - The failure path below is testable only while access stays lazy. The sibling
 *   `ids.test.ts` stubs `globalThis.crypto` away to assert that a
 *   {@link DebuggenError} is thrown; against a captured reference that stub
 *   would have no effect and the assertion would be vacuous.
 *
 * The absent-global branch exists for exotic hosts only. Node.js 24 — the
 * pinned runtime for the service, the preload and every test — and every
 * Chromium page context, where the agent and the DevTools panel run, all
 * provide `crypto.getRandomValues`. Reaching for `node:crypto` as a fallback is
 * not an option here: this module is bundled into three browser surfaces, and a
 * Node builtin specifier would break all three.
 *
 * @param length How many random bytes to produce.
 * @returns A new `Uint8Array` of exactly `length` random bytes.
 * @throws DebuggenError `INTERNAL` when the host provides no
 * `globalThis.crypto.getRandomValues`.
 */
function randomBytes(length: number): Uint8Array {
  const source: RandomSource | undefined = globalThis.crypto;

  if (source === undefined || typeof source.getRandomValues !== 'function') {
    throw new DebuggenError(
      'INTERNAL',
      'Cannot generate an identifier: this host provides no globalThis.crypto.getRandomValues.',
      {
        hint: 'Run on a host with the Web Crypto global — Node.js 24 or a Chromium page context both provide it — or install a globalThis.crypto exposing getRandomValues(Uint8Array) before any identifier is generated.',
        details: { requestedBytes: length },
      },
    );
  }

  return source.getRandomValues(new Uint8Array(length));
}

/**
 * Render bytes as lowercase hex, two characters per byte.
 *
 * Iterated with `for...of` rather than by index: `noUncheckedIndexedAccess` is
 * on, so `bytes[i]` is `number | undefined` and would need a non-null assertion
 * that the iterator form makes unnecessary.
 *
 * `toString(16)` already yields lowercase, and `padStart` keeps the leading zero
 * of a byte below 0x10 — without it a byte of 0x0a would contribute one
 * character instead of two and every id after it would be short by one, which
 * the length-anchored patterns would then reject.
 *
 * @param bytes The bytes to render.
 * @returns `bytes.length * 2` lowercase hex characters.
 */
function toHex(bytes: Uint8Array): string {
  let hex = '';
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(HEX_DIGITS_PER_BYTE, '0');
  }
  return hex;
}

/**
 * Whether every byte is zero.
 *
 * Iterated with `for...of` for the same reason as {@link toHex}, and returning
 * early on the first non-zero byte, which is the overwhelmingly common case.
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
 * Draw random bytes until they are not all-zero, then render them as hex.
 *
 * W3C Trace Context defines an all-zero trace id and an all-zero span id as
 * **invalid**, and a `traceparent` header built from one is an invalid header:
 * a receiver is required to ignore it. That would break correlation precisely
 * where it matters — the header the browser agent injects on same-origin fetch
 * and XHR is the only thing that ties a browser interaction to the server
 * spans it causes, so an ignored header means a click that never joins its own
 * route handler and database queries. The value is astronomically unlikely, and
 * excluding it costs one comparison, so it is excluded rather than hoped about.
 *
 * @param byteLength How many random bytes the id is made of.
 * @param kind Which id family is being generated, for the error message.
 * @returns `byteLength * 2` lowercase hex characters, not all zero.
 * @throws DebuggenError `INTERNAL` after {@link MAX_NON_ZERO_ATTEMPTS}
 * consecutive all-zero draws, which indicates a broken randomness source
 * rather than bad luck.
 */
function newHexId(byteLength: number, kind: 'trace' | 'span'): string {
  for (let attempt = 0; attempt < MAX_NON_ZERO_ATTEMPTS; attempt += 1) {
    const bytes = randomBytes(byteLength);
    if (!isAllZeroBytes(bytes)) {
      return toHex(bytes);
    }
  }

  throw new DebuggenError(
    'INTERNAL',
    `Could not generate a valid ${kind} id: the randomness source returned all-zero bytes ${String(MAX_NON_ZERO_ATTEMPTS)} times in a row.`,
    {
      hint: 'This host provides a globalThis.crypto.getRandomValues that is not producing random bytes. Check for a stubbed or patched Web Crypto global in this process.',
      details: { kind, byteLength, attempts: MAX_NON_ZERO_ATTEMPTS },
    },
  );
}

/**
 * Create a new {@link TraceId}: 16 random bytes as 32 lowercase hex characters.
 *
 * Called once per correlated interaction — the browser agent opens a trace when
 * a user interaction begins, and every span the interaction causes across the
 * browser, the Next.js server process and the database carries this same value.
 * The result always satisfies {@link TRACE_ID_PATTERN} and is never all-zero,
 * so it is safe to serialise straight into a `traceparent` header.
 *
 * @returns A fresh trace id.
 * @throws DebuggenError `INTERNAL` when no Web Crypto global is available, or
 * when the randomness source is demonstrably broken.
 */
export function newTraceId(): TraceId {
  return newHexId(TRACE_ID_BYTES, 'trace');
}

/**
 * Create a new {@link SpanId}: 8 random bytes as 16 lowercase hex characters.
 *
 * Called once per operation the agent or the preload records. The result always
 * satisfies {@link SPAN_ID_PATTERN} and is never all-zero.
 *
 * @returns A fresh span id.
 * @throws DebuggenError `INTERNAL` when no Web Crypto global is available, or
 * when the randomness source is demonstrably broken.
 */
export function newSpanId(): SpanId {
  return newHexId(SPAN_ID_BYTES, 'span');
}

// ---------------------------------------------------------------------------
// Opaque prefixed entity identifiers
// ---------------------------------------------------------------------------

/**
 * The alphabet every opaque id is drawn from: digits and lowercase letters, and
 * nothing else.
 *
 * nanoid's default alphabet is URL-safe base64, which includes `-` and `_`, and
 * both are wrong here — not merely inelegant:
 *
 * - **Filesystem paths.** A session id is a path segment: the patcher stores a
 *   file's original bytes at `$DEBUGGEN_HOME/backups/<sessionId>/<originalHash>`
 *   before it writes anything, and that backup is how a temporary edit stays
 *   reversible. Restricting the alphabet keeps every id a safe path component
 *   with no quoting rules to remember and nothing a shell would reinterpret.
 * - **The underscore is the delimiter.** {@link newId} joins the prefix to the
 *   random part with `_`, so an underscore inside the random part would make
 *   the boundary ambiguous and defeat a split on it.
 * - **Unambiguous transcription.** Ids appear in logs, in store keys, in URL
 *   paths and in error messages a developer retypes. One case means no
 *   confusion between `l` and `L`, and no id that differs from another only by
 *   case — which also means a case-insensitive comparison cannot collide two
 *   distinct ids.
 * - **One regex in tests.** Every id in the product matches
 *   `/^[a-z]{3}_[0-9a-z]{16}$/`, so a test asserting an id's shape needs no
 *   per-kind pattern.
 *
 * Thirty-six symbols over sixteen positions is about 82.7 bits of entropy per
 * id (`16 * log2(36)`), which is ample for identifiers scoped to one
 * developer's machine, and nanoid draws them with rejection sampling so the
 * distribution stays uniform rather than biased by a modulo.
 */
const ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

/** How many alphabet characters follow the prefix and underscore in every id. */
const ID_RANDOM_LENGTH = 16;

/**
 * The one random-suffix generator, built once at module scope.
 *
 * `customAlphabet` returns a closure that reuses its precomputed sampling
 * parameters, so building it once per module rather than once per call is both
 * cheaper and the shape nanoid documents. It draws from
 * `globalThis.crypto.getRandomValues` internally, matching the randomness
 * policy the rest of this module follows.
 */
const nextIdSuffix = customAlphabet(ID_ALPHABET, ID_RANDOM_LENGTH);

/**
 * The three-letter prefix for each kind of entity id.
 *
 * Every prefix is exactly three lowercase letters, which is what makes the
 * single shape regex possible and lets a developer reading a log or a store row
 * tell at a glance what an id refers to. These values are a **contract**, not
 * an implementation detail: store keys, protocol payloads and tests all assume
 * them, so changing one is a breaking change across the monorepo rather than a
 * local edit.
 *
 * Declared `as const` so each value is its own literal type, which keeps the
 * typed wrappers below honest and makes the object impossible to mutate by
 * accident.
 *
 * @example
 * ```ts
 * const id = newId(ID_PREFIXES.capture);
 * // → 'cap_7f3q0m2zk1x8ab9c'
 * ```
 */
export const ID_PREFIXES = {
  /** A debugging session — see {@link SessionId}. */
  session: 'ses',
  /** A capture window — see {@link CaptureId}. */
  capture: 'cap',
  /** A generated panel specification — see {@link PanelId}. */
  panel: 'pnl',
  /** An analysis result — see {@link AnalysisId}. */
  analysis: 'ana',
  /** A recorded file modification — see {@link ModificationId}. */
  modification: 'mod',
  /** An instrumentation plan action — see {@link ActionId}. */
  action: 'act',
  /** A telemetry event — see {@link EventId}. */
  event: 'evt',
  /** A protocol message — see {@link MessageId}. */
  message: 'msg',
  /** A telemetry producer — see {@link ProducerId}. */
  producer: 'prd',
} as const;

/**
 * Create an opaque id: the given prefix, one underscore, then
 * {@link ID_RANDOM_LENGTH} characters of {@link ID_ALPHABET}.
 *
 * The result is always 3 + 1 + 16 = 20 characters and always matches
 * `/^[a-z]{3}_[0-9a-z]{16}$/` when `prefix` comes from {@link ID_PREFIXES} —
 * which store schemas and tests rely on. Prefer one of the typed wrappers below
 * over calling this directly; reach for it only where the kind is chosen at
 * runtime, and pass a value from {@link ID_PREFIXES} rather than a literal so
 * the prefix vocabulary stays in one place.
 *
 * @param prefix The kind prefix, conventionally three lowercase letters from
 * {@link ID_PREFIXES}.
 * @returns A fresh opaque id, for example `ses_4k2p9dq7m1zx0c3v`.
 * @throws DebuggenError `INTERNAL` — propagated from nanoid's use of the Web
 * Crypto global on a host that provides none.
 */
export function newId(prefix: string): string {
  return `${prefix}_${nextIdSuffix()}`;
}

/**
 * Create a new {@link SessionId} (`ses_…`).
 *
 * Called by the service when a developer submits a question. The value becomes
 * the session's store primary key and a backup path segment, so it is minted
 * once and never rewritten.
 *
 * @returns A fresh session id.
 */
export function newSessionId(): SessionId {
  return newId(ID_PREFIXES.session);
}

/**
 * Create a new {@link CaptureId} (`cap_…`).
 *
 * Called by the service when a capture starts. Every event ingested until that
 * capture stops is attributed to this id, which is how a follow-up can be
 * answered from stored evidence instead of asking the developer to reproduce
 * the issue again.
 *
 * @returns A fresh capture id.
 */
export function newCaptureId(): CaptureId {
  return newId(ID_PREFIXES.capture);
}

/**
 * Create a new {@link PanelId} (`pnl_…`).
 *
 * Called when a panel specification is generated, including a regenerated one —
 * the new panel gets its own id and names the previous id in `supersedes`,
 * because panels are versioned rather than overwritten.
 *
 * @returns A fresh panel id.
 */
export function newPanelId(): PanelId {
  return newId(ID_PREFIXES.panel);
}

/**
 * Create a new {@link AnalysisId} (`ana_…`).
 *
 * Called when an analysis result is stored. Analyses accumulate across
 * follow-ups so the evidence a panel cites stays reachable for as long as the
 * panel does.
 *
 * @returns A fresh analysis id.
 */
export function newAnalysisId(): AnalysisId {
  return newId(ID_PREFIXES.analysis);
}

/**
 * Create a new {@link ModificationId} (`mod_…`).
 *
 * Called by the patcher **before** it writes anything, because the journal
 * entry this id keys — original hash, instrumented hash, backup path, diff — is
 * what makes the edit reversible even if the process dies mid-write.
 *
 * @returns A fresh modification id.
 */
export function newModificationId(): ModificationId {
  return newId(ID_PREFIXES.modification);
}

/**
 * Create a new {@link ActionId} (`act_…`).
 *
 * Called when an instrumentation plan is normalised, giving every action a
 * stable identity. A follow-up plan version reuses the ids of actions already
 * installed, so the installer can apply only the delta.
 *
 * @returns A fresh action id.
 */
export function newActionId(): ActionId {
  return newId(ID_PREFIXES.action);
}

/**
 * Create a new {@link EventId} (`evt_…`).
 *
 * Called by each telemetry producer for every event it emits — the browser
 * agent for interactions, renders, requests and errors, the Node preload for
 * server and database spans.
 *
 * @returns A fresh event id.
 */
export function newEventId(): EventId {
  return newId(ID_PREFIXES.event);
}

/**
 * Create a new {@link MessageId} (`msg_…`).
 *
 * Fills the `id` field of the protocol envelope `{ id, type, sessionId?, ts,
 * payload }` that every WebSocket frame carries, so a frame can be traced
 * through a log and correlated with the reply it provoked.
 *
 * @returns A fresh message id.
 */
export function newMessageId(): MessageId {
  return newId(ID_PREFIXES.message);
}

/**
 * Create a new {@link ProducerId} (`prd_…`).
 *
 * Generated **once per page document** by the browser agent — so a reload
 * yields a new producer — and **once per process** by the Node preload. It
 * scopes the per-producer monotonic `seq` counter that every event carries, and
 * `(producerId, seq)` is the tie-breaker in the canonical ordering of a trace:
 * parent before child, then `startTime`, then `(producerId, seq)`, then the
 * store-assigned ingest sequence. Without a producer scope, two independent
 * counters starting at the same number would interleave arbitrarily whenever
 * their timestamps tied.
 *
 * The `prd_` prefix is this module's decision and is therefore the contract
 * other packages and tests match, exactly like the rest of
 * {@link ID_PREFIXES}.
 *
 * @returns A fresh producer id.
 */
export function newProducerId(): ProducerId {
  return newId(ID_PREFIXES.producer);
}
