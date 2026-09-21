/**
 * Chunk and source-map retrieval: the transport half of the product's third
 * source-resolution route.
 *
 * A runtime item that a debugging panel offers a click-to-source link for needs
 * a project-relative `SourceLocation`, and four routes produce one (AAP 0.4.2):
 * patch metadata, the code graph, the **source map of a generated chunk**, and
 * the React owner chain. This module owns the first step of that third route —
 * given the URL of a generated chunk the dev server served, find the source map
 * that belongs to it and hand back a parsed document. Turning a generated
 * position into an original one is `./resolver.ts` (it owns
 * `@jridgewell/trace-mapping`), and turning a map's `sources` entry into a
 * project-relative path is `./normalize.ts`. Neither concern appears here.
 *
 * ## Why the directive, and only the directive, decides the pairing
 *
 * The one thing this module exists to *not* do is guess `<chunk>.js.map` from a
 * chunk's own filename. Webpack usually names the map after the chunk;
 * Turbopack hashes map filenames independently, so a chunk named
 * `…-widget.js` can be paired with a map named `…-widget-<hash>.js.map` that no
 * name-derivation rule would ever find, and requesting the guessed name gets a
 * dev server's HTML 404 page — which parses as neither JavaScript nor JSON and,
 * worse, could be a *different* chunk's map if the server is permissive about
 * paths. So the pairing comes from the chunk's own `sourceMappingURL`
 * directive, resolved as a relative reference against the chunk's URL, and from
 * nothing else. A chunk with no directive is reported as
 * `{ kind: 'none', reason: 'no-directive' }` and **no second request is made**.
 *
 * ## `{ kind: 'none' }` is a success, not a failure
 *
 * "This chunk has no map" is an ordinary, expected outcome: plenty of runtime
 * frames point into a vendor chunk, a dev-server runtime or an inline script
 * that never had a map. The pipeline's answer to it is to fall back to the code
 * graph or the React owner chain and return the frame unresolved rather than
 * mis-resolved, so it arrives as an `Ok` carrying a discriminated `none`
 * outcome. Reporting it as an `Err` would make every mapless frame look like a
 * defect in a user interface, which is precisely the confusion the graceful-
 * failure contract (AAP 0.5.5) forbids.
 *
 * ## The security boundary, stated once
 *
 * **The chunk URL is untrusted input.** It reaches this module from a stack
 * string captured in the page (`new Error().stack` in the browser agent's
 * fetch/XHR patch), so its origin, scheme, credentials and path are all
 * attacker-influenceable by anything that can run script in the inspected tab.
 * This function runs inside the local service, on the developer's machine,
 * behind no network boundary at all — which makes an unguarded fetch here a
 * server-side request forgery (SSRF) primitive. Five bounds are therefore not
 * optional, and each is enforced below:
 *
 * 1. **A mandatory origin pin, matched exactly.** Every lookup names the
 *    session's authoritative dev-server origin
 *    ({@link FetchSourceMapOptions.devServerOrigin}, taken from the session
 *    record's `devServerUrl`), and **both** the chunk URL and the map URL a
 *    directive names must equal that origin exactly — same scheme, same host,
 *    same port. The option is required rather than optional because "loopback"
 *    is not a trust boundary on a developer's machine: a dozen services listen
 *    there, this product's own service among them, and a default that accepted
 *    any loopback host and port would let a page steer either request at any of
 *    them. The pin itself is screened before it is used — it must be a
 *    credential-free `http:`/`https:` loopback origin — so a caller cannot
 *    widen the policy by passing a public origin, and a caller that has lost
 *    the value fails closed instead of falling back to "anything local".
 *    Loopback remains an independent check on top of the pin (see
 *    {@link isLoopbackDevServerUrl}), and a URL carrying a `user:password@`
 *    userinfo component is refused outright rather than stripped, because a
 *    credential in a captured URL is a credential this product must not replay.
 *
 *    The pin cannot refuse a legitimate lookup: the service binds a tab to the
 *    session whose dev-server origin matches that tab's origin (AAP 0.4.2), so
 *    a stack frame captured in that tab names chunks on that one origin, and a
 *    chunk served from anywhere else is not this session's to read.
 * 2. **No ambient authority on the wire.** Every request is made with
 *    `credentials: 'omit'` and with no headers at all — no `Authorization`, no
 *    cookie, no custom header — so a request this module makes cannot carry the
 *    developer's session anywhere.
 * 3. **`redirect: 'error'`.** A dev server has no reason to redirect a chunk,
 *    and following a redirect would move the request to an origin the checks
 *    above already approved, defeating them.
 * 4. **A byte ceiling enforced in two places**: once against the declared
 *    `Content-Length`, and again while the body streams in, so a server that
 *    omits the header or lies about it cannot make this process buffer an
 *    unbounded body.
 * 5. **A composed timeout.** `AbortSignal.timeout(timeoutMs)` bounds each
 *    request, and it is combined with the caller's own `options.signal` through
 *    `AbortSignal.any` so a session teardown and the timeout can both cancel.
 *
 * The same screening runs a second time on the *resolved map URL*, because the
 * directive is page-authored content too: `//# sourceMappingURL=https://evil.example/x.map`
 * is a one-line exfiltration attempt, and resolving it produces a URL that must
 * pass the same gate the chunk URL did.
 *
 * ## Failure vocabulary
 *
 * Nothing here throws. Every outcome is a `Result` (AAP's shared failure
 * vocabulary), with three codes chosen from the closed `DEBUGGEN_ERROR_CODES`
 * tuple and never invented:
 *
 * | Outcome | Code | `details.reason` |
 * | --- | --- | --- |
 * | The supplied origin pin is unusable | `FORBIDDEN_ORIGIN` | `origin-pin-invalid` (with `problem`: `missing`, `unparseable`, `scheme`, `credentials`, `non-loopback`) |
 * | URL refused by policy | `FORBIDDEN_ORIGIN` | `unparseable`, `scheme`, `credentials`, `non-loopback`, `origin-mismatch` |
 * | Request failed, was refused, timed out, or the body was too large or unreadable | `DEV_SERVER_UNAVAILABLE` | `request-failed`, `http-status`, `too-large`, `unreadable` |
 * | A document was fetched but is not a source map | `CODE_INDEX_FAILED` | `invalid-json`, `invalid-shape` |
 *
 * ## Dependencies, deliberately none
 *
 * The only import is `@debuggen/shared`, the base layer of the acyclic package
 * graph (AAP 0.2.2) — `packages/code-analysis` may import no other
 * `@debuggen/*` package, and ESLint's `no-restricted-imports` layering block
 * enforces it. There is no third-party import: `@jridgewell/trace-mapping`
 * belongs to `./resolver.ts` and would drag a decoder into a module that only
 * moves bytes; `zod` is not a dependency of this package, so the document shape
 * check below is written structurally; the `source-map` package is rejected
 * repository-wide for its WASM initialisation (AAP 0.2.4). There is no `node:`
 * import either: `fetch`, `AbortSignal`, `URL` and `Buffer` are all globals in
 * Node 24, and reaching for `node:http` would mean re-implementing redirect
 * handling, decompression and abort semantics that `fetch` already has.
 *
 * ## State
 *
 * This module holds no mutable state. The document cache is *injected*
 * ({@link FetchSourceMapOptions.cache}), never a module-level singleton, so one
 * session's maps cannot leak into the next session — or into another test —
 * and a session that ends can drop its cache with the rest of its memory.
 */
import {
  DebuggenError,
  err,
  fromPromise,
  isErr,
  isOk,
  noopLogger,
  ok,
  tryCatch,
} from '@debuggen/shared';
import type { Logger, Result } from '@debuggen/shared';

/**
 * The largest response, in bytes, this module will read for a chunk or a map.
 *
 * Source maps are the largest artifacts a dev server serves: a development
 * chunk's map carries one entry per mapped position plus, frequently, the full
 * text of every original source in `sourcesContent`. 8 MiB is generous enough
 * for a real application page's map (a few hundred kilobytes is typical, a few
 * megabytes is possible for a large page with embedded sources) while still
 * bounding what a single lookup can allocate — which matters because the
 * request target is untrusted input and the service holds sessions, an index
 * cache and a store in the same process.
 *
 * Override per call with {@link FetchSourceMapOptions.maxBytes}.
 */
export const DEFAULT_MAX_MAP_BYTES = 8 * 1024 * 1024;

/**
 * The default per-request timeout, in milliseconds.
 *
 * The target is a dev server on loopback, so a request that has not answered in
 * five seconds is not slow, it is wedged — a webpack or Turbopack compilation
 * holding the request, a port that something else now owns, a server shutting
 * down mid-session. Five seconds is long enough to survive a cold compile of
 * the chunk being requested and short enough that a click-to-source resolution
 * fails visibly instead of hanging a panel interaction.
 *
 * The budget applies **per request**, not per call: a lookup that fetches a
 * chunk and then its map gives each request its own window, because sharing one
 * already half-spent timer would make the second request fail for reasons that
 * have nothing to do with it. Override with
 * {@link FetchSourceMapOptions.timeoutMs}.
 */
export const DEFAULT_FETCH_TIMEOUT_MS = 5_000;

/**
 * How much of a chunk's tail is scanned for the `sourceMappingURL` directive.
 *
 * By convention the directive is the last line of a chunk, so scanning the tail
 * rather than the whole body keeps the scan bounded no matter how large the
 * chunk is, and — just as importantly — keeps the literal string
 * `sourceMappingURL`, which appears in the *code* of bundler runtimes and
 * source-map libraries, from being mistaken for a directive.
 *
 * The window has to be wide enough to contain a complete directive line, and
 * the widest legitimate directive is an inline `data:` URI whose base64 payload
 * *is* the whole source map. 64 KiB admits an inline map of realistic size
 * (a few thousand mapped positions) while still being a rounding error against
 * {@link DEFAULT_MAX_MAP_BYTES}. The unit is UTF-16 code units, which equals
 * bytes for the ASCII tail of a JavaScript chunk and is a conservative bound
 * for anything else.
 */
export const SOURCE_MAPPING_URL_TAIL_BYTES = 64 * 1024;

/**
 * The number of parsed documents a cache from {@link createSourceMapCache}
 * holds before it evicts the oldest.
 *
 * One investigation touches a handful of chunks — the page bundle, a route
 * chunk, a vendor chunk — so a few dozen entries covers a session with room to
 * spare, and the bound is what keeps a long-lived service from accumulating
 * every map of every reload. Override with `createSourceMapCache({ maxEntries })`.
 */
const DEFAULT_CACHE_MAX_ENTRIES = 32;

/**
 * The only `version` a source map may declare. Version 3 has been the sole
 * living version of the format for over a decade; a document declaring anything
 * else is not a map this product can read, and accepting it would push the
 * failure into `@jridgewell/trace-mapping` where the diagnostic is worse.
 */
const SUPPORTED_SOURCE_MAP_VERSION = 3;

/** The URL schemes a chunk or a map may be fetched over. See the SSRF note. */
const ALLOWED_URL_PROTOCOLS: readonly string[] = ['http:', 'https:'];

/**
 * What `URL.origin` serialises an opaque origin to.
 *
 * Every opaque origin serialises to this same string, so comparing origins by
 * equality would make two unrelated ones equal. No `http:`/`https:` URL has an
 * opaque origin, which is why this only ever guards the pin — defence against a
 * future scheme being admitted, not a case reachable today.
 */
const OPAQUE_ORIGIN = 'null';

/** The scheme that marks a directive as an inline, embedded map. */
const DATA_URL_SCHEME = 'data:';

/** The only media type an inline source map is accepted under. */
const INLINE_MAP_MEDIA_TYPE = 'application/json';

/** The `data:` URI parameter that marks the payload as base64. */
const BASE64_PARAMETER = 'base64';

/**
 * Matches a line-leading `sourceMappingURL` directive in either comment form.
 *
 * Both spellings are accepted because both are in the wild: `//#` is current,
 * `//@` is the legacy form older tools still emit, and the block form
 * `/*# sourceMappingURL=… *\/` appears in CSS-adjacent and concatenated output.
 * Leading whitespace is tolerated (a formatted or indented chunk), the line
 * anchor is not (a directive-looking string in the middle of a line of code is
 * not a directive), and capture group 1 holds the line-comment value while
 * group 2 holds the block-comment value.
 *
 * The `g` flag is required by `String.prototype.matchAll`, which clones the
 * expression rather than advancing this one, so the shared instance carries no
 * `lastIndex` state between calls.
 */
const SOURCE_MAPPING_URL_DIRECTIVE =
  /^[\t ]*(?:\/\/[#@][\t ]*sourceMappingURL=([^\r\n]*)|\/\*[#@][\t ]*sourceMappingURL=([^\r\n]*?)[\t ]*\*\/[\t ]*)$/gm;

/**
 * Matches a dotted-quad IPv4 literal. WHATWG `URL` canonicalises every legal
 * IPv4 spelling — `127.1`, `0x7f.1`, `2130706433` — into this form before it
 * reaches {@link isLoopbackDevServerUrl}, so the loopback test can be a plain
 * comparison of the first octet instead of an address parser.
 */
const IPV4_LITERAL = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** The first octet of the IPv4 loopback range, `127.0.0.0/8`. */
const IPV4_LOOPBACK_FIRST_OCTET = 127;

/** The largest value an IPv4 octet may hold. */
const IPV4_MAX_OCTET = 255;

/** The canonical serialisation of the IPv6 loopback address, without brackets. */
const IPV6_LOOPBACK = '::1';

/** The reserved TLD that is loopback by specification (RFC 6761 §6.3). */
const LOOPBACK_TLD_SUFFIX = '.localhost';

/** The host that is loopback by specification (RFC 6761 §6.3). */
const LOOPBACK_HOST = 'localhost';

// ---------------------------------------------------------------------------
// Document types.
//
// These describe a source map as a *document* — what JSON.parse produced and
// what this module hands on — and they are deliberately declared here rather
// than imported from @jridgewell/trace-mapping. Two reasons: this module must
// not depend on the decoder (the import restriction of AAP 0.2.2 aside, a
// transport layer that types its output against a decoder cannot be tested
// without one), and a consumer of `@debuggen/code-analysis` should not have to
// resolve a transitive package's types to name the value it was handed.
//
// They are nevertheless *structurally compatible* with what trace-mapping 0.3.31
// accepts as input, which constrains three details that would otherwise be
// written differently in this repository's style:
//
//   * `version` is the literal `3`, not `number`, because trace-mapping's
//     `SourceMapV3.version` is `3`. The shape check below proves the literal
//     before the cast that produces one of these types, so the declaration is
//     honest rather than optimistic.
//   * The arrays are mutable, not `readonly`, because trace-mapping's own
//     fields are mutable and a `readonly` array is not assignable to a mutable
//     one. Callers must still treat a returned document as read-only: a cached
//     document is shared by every lookup that hits the same map URL, so
//     mutating one mutates every consumer's copy.
//   * `names` is optional, because maps in the wild omit it (a map whose every
//     segment has four fields needs no name table) even though trace-mapping
//     declares it required. A consumer handing a document to `TraceMap` or
//     `FlattenMap` therefore supplies `names ?? []`.
// ---------------------------------------------------------------------------

/**
 * A plain (non-sectioned) source-map document: Source Map Revision 3 with
 * VLQ-encoded `mappings`.
 *
 * Fields beyond those listed are preserved by `JSON.parse` and simply not
 * described here — the shape check that produces this type validates `version`
 * and `mappings` and nothing else on purpose, because deciding what a map
 * *means* is the decoder's job and every additional assumption made here is one
 * more way a legitimate map could be refused.
 */
export interface RawSourceMapDocument {
  /** Always `3`; proved by the shape check before this type is applied. */
  version: typeof SUPPORTED_SOURCE_MAP_VERSION;

  /** The generated file this map describes, when the producer recorded it. */
  file?: string;

  /** A prefix `sources` entries are resolved against, when present. */
  sourceRoot?: string;

  /**
   * The original sources, as the producer named them: `webpack://_N_E/./src/x.ts`,
   * `turbopack:///[project]/src/x.ts`, or a relative path. A `null` entry means
   * the producer withheld the name. Turning an entry into a project-relative
   * path is `./normalize.ts`.
   */
  sources: (string | null)[];

  /**
   * The text of each entry in {@link sources}, when the map carries it. A
   * `null` entry means "content withheld for this source", which is not the
   * same as "file missing" — the resolver reads that source from disk instead.
   */
  sourcesContent?: (string | null)[];

  /** The symbol names five-field segments index into. */
  names?: string[];

  /** The VLQ-encoded segment table. */
  mappings: string;

  /** Indices of `sources` the producer marked as third-party. */
  ignoreList?: number[];
}

/**
 * A sectioned source-map document: several maps, each offset to a region of one
 * generated file.
 *
 * Turbopack emits these for a chunk assembled from independently compiled
 * modules. They cannot be handed to `TraceMap` — it reads `sources` before it
 * checks for `sections` and throws — so the resolver dispatches on
 * {@link isSectionedSourceMap} and uses `FlattenMap` (exported also as
 * `AnyMap`) for this shape.
 */
export interface SectionedSourceMapDocument {
  /** Always `3`; proved by the shape check before this type is applied. */
  version: typeof SUPPORTED_SOURCE_MAP_VERSION;

  /** The generated file this map describes, when the producer recorded it. */
  file?: string;

  /**
   * The sections, in generated order. `offset` is **0-based** in both line and
   * column, so a section's first generated line is `offset.line + 1`, and a
   * section's `map` may itself be sectioned.
   */
  sections: {
    offset: { line: number; column: number };
    map: RawSourceMapDocument | SectionedSourceMapDocument;
  }[];
}

/** Either document form a `sourceMappingURL` can resolve to. */
export type SourceMapDocument = RawSourceMapDocument | SectionedSourceMapDocument;

/**
 * Whether `document` is a sectioned map, as a type guard.
 *
 * The test is structural — a present, array-valued `sections` — because that is
 * exactly the discriminator the format offers: a sectioned map has `sections`
 * and no `mappings`, a plain map the reverse, and neither carries a kind tag.
 *
 * This lives in this module rather than in the resolver because it is a
 * statement about the *document*, and the document is what this module
 * produces; the resolver imports it to choose between `FlattenMap` and
 * `TraceMap`, a choice that must never be made by trial and error because the
 * wrong branch throws.
 *
 * @param document A document returned by {@link fetchSourceMap}.
 * @returns `true` when `document` is a {@link SectionedSourceMapDocument},
 * narrowing it in the guarded branch and to {@link RawSourceMapDocument} in the
 * `else`.
 */
export function isSectionedSourceMap(
  document: SourceMapDocument,
): document is SectionedSourceMapDocument {
  return Array.isArray((document as { sections?: unknown }).sections);
}

/**
 * The outcome of a successful lookup: a map was found, or the chunk has none.
 *
 * A discriminated union rather than `SourceMapDocument | undefined`, because
 * the two "no map" cases are different facts a caller may want to log
 * differently — a chunk that never had a map versus a directive this module
 * declines to decode — and because a nullable return invites the `?.` that
 * silently treats "no map" as "no answer".
 */
export type SourceMapLookup =
  | {
      readonly kind: 'found';

      /** The parsed document. Treat as read-only; it may be cache-shared. */
      readonly map: SourceMapDocument;

      /**
       * The absolute URL the document came from, as resolved. For an inline
       * map this is the **chunk's** URL: the map has no URL of its own, the
       * chunk is where it was found, and a caller that resolves a map's
       * relative `sources` entries against `mapUrl` needs the document's
       * actual location, which for an embedded map is the chunk.
       */
      readonly mapUrl: string;

      /** `true` when the document was decoded from a `data:` directive. */
      readonly inline: boolean;
    }
  | {
      readonly kind: 'none';

      /**
       * `no-directive` — the chunk carries no `sourceMappingURL` at all, which
       * is ordinary. `unsupported-directive` — a directive is present but this
       * module declines to decode it (an inline payload in a media type or
       * transfer encoding it does not support, or one whose escapes are
       * malformed). Neither is a failure; both mean "fall back to another
       * resolution route".
       */
      readonly reason: 'no-directive' | 'unsupported-directive';
    };

/**
 * A bounded, invalidatable store of parsed source-map documents.
 *
 * Keyed by **resolved map URL** for a fetched map and by **chunk URL** for an
 * inline one, so two chunks that share a map share the entry and an inline map
 * is keyed by the only URL it has. Values are the parsed documents, because
 * parsing a multi-megabyte map is the expensive half of a lookup, not the
 * request.
 *
 * Implementations are injected through {@link FetchSourceMapOptions.cache};
 * there is no default and no module-level instance. A service therefore scopes
 * a cache to a session and drops it at `session.end`, and a test gets a fresh
 * one per case instead of inheriting the previous case's entries.
 */
export interface SourceMapCache {
  /** The document stored under `key`, or `undefined` for a miss. */
  get(key: string): SourceMapDocument | undefined;

  /** Stores `document` under `key`, evicting the oldest entry if bounded. */
  set(key: string, document: SourceMapDocument): void;

  /** Invalidates `key`. Returns `true` when an entry was removed. */
  delete(key: string): boolean;

  /** Invalidates every entry. */
  clear(): void;

  /** The number of entries currently held. */
  readonly size: number;
}

/**
 * Creates a {@link SourceMapCache} bounded by entry count.
 *
 * Eviction is insertion-ordered: a `Map` preserves insertion order, so the
 * oldest key is the first one its iterator yields, and `set` re-inserts an
 * existing key so that re-storing a document refreshes its position. That makes
 * the policy least-recently-*written* rather than least-recently-read, which is
 * the right bias here — a document is written once per fetch and read many
 * times, and a read that renewed an entry's lease would let one long-lived map
 * pin the cache while a session moved on to other chunks.
 *
 * Entry count rather than byte size: measuring a parsed document's retained
 * size is not something a JavaScript runtime offers honestly, and a count is a
 * bound a reader of this code can reason about.
 *
 * @param options.maxEntries Maximum entries to retain. Defaults to a few dozen;
 * a value below 1, or one that is not a finite number, is clamped to 1, because
 * a cache that stores nothing is a bug that presents as a performance mystery
 * rather than as an error.
 * @returns A fresh cache holding no entries and shared with nothing.
 */
export function createSourceMapCache(options: { maxEntries?: number } = {}): SourceMapCache {
  const maxEntries = Math.max(
    1,
    Math.floor(positiveNumberOr(options.maxEntries, DEFAULT_CACHE_MAX_ENTRIES)),
  );
  const entries = new Map<string, SourceMapDocument>();

  return {
    get(key: string): SourceMapDocument | undefined {
      return entries.get(key);
    },

    set(key: string, document: SourceMapDocument): void {
      // Delete before insert so an existing key moves to the end of the
      // iteration order; `Map.set` on a present key keeps its original
      // position, which would make the refresh a no-op.
      entries.delete(key);
      entries.set(key, document);

      while (entries.size > maxEntries) {
        const oldest = entries.keys().next();
        if (oldest.done === true) {
          break;
        }
        entries.delete(oldest.value);
      }
    },

    delete(key: string): boolean {
      return entries.delete(key);
    },

    clear(): void {
      entries.clear();
    },

    get size(): number {
      return entries.size;
    },
  };
}

/**
 * Options for {@link fetchSourceMap}.
 *
 * {@link devServerOrigin} is **required**; every other field is optional and
 * its default is the safe one. The one mandatory field is the security-relevant
 * one on purpose: a lookup that does not say which dev server it is reading
 * from has no origin policy at all, and making that omission a type error is
 * the only way to keep "any loopback service will do" from being the default
 * behaviour (see the SSRF note in the module overview).
 */
export interface FetchSourceMapOptions {
  /**
   * The authoritative origin of the session's dev server — the one origin a
   * chunk and its map may be read from. **Required.**
   *
   * Supply the session record's `devServerUrl` (AAP 0.2.3). A full URL is
   * accepted and only its origin is used, so `http://127.0.0.1:3000`,
   * `http://127.0.0.1:3000/` and `http://127.0.0.1:3000/products/1` are the
   * same pin; the comparison is against the WHATWG canonical origin, which
   * normalises case and drops a default port, so `http://localhost:80` and
   * `http://localhost` also agree.
   *
   * Matching is **exact**: a different port or a different loopback spelling is
   * a different origin and is refused, for the chunk URL and again for the URL
   * a `sourceMappingURL` directive names. The pin can only narrow what may be
   * requested — it is itself screened as a credential-free `http:`/`https:`
   * loopback origin — so passing a public origin refuses every lookup rather
   * than authorising one, and an empty or unparseable value refuses too rather
   * than degrading to "any loopback host".
   */
  readonly devServerOrigin: string;

  /**
   * A caller's cancellation signal — a session ending, a panel interaction
   * superseded. Composed with the per-request timeout through
   * `AbortSignal.any`, so either can cancel and neither has to know about the
   * other.
   */
  readonly signal?: AbortSignal | undefined;

  /**
   * The `fetch` implementation to use. Defaults to the global `fetch`.
   *
   * This seam exists for the assertion that matters most in this module's
   * tests: that a refused URL results in **no network call at all**, and that a
   * chunk without a directive results in **exactly one**. Neither can be
   * asserted against a global, so the injection point is part of the contract
   * rather than a testing convenience.
   */
  readonly fetchImpl?: typeof fetch | undefined;

  /** Byte ceiling per response. Defaults to {@link DEFAULT_MAX_MAP_BYTES}. */
  readonly maxBytes?: number | undefined;

  /**
   * Per-request timeout in milliseconds. Defaults to
   * {@link DEFAULT_FETCH_TIMEOUT_MS}.
   */
  readonly timeoutMs?: number | undefined;

  /**
   * A document cache from {@link createSourceMapCache}, or any implementation
   * of {@link SourceMapCache}. Omit it and every lookup fetches and parses
   * afresh.
   */
  readonly cache?: SourceMapCache | undefined;

  /** Where refusals, misses and failures are logged. Defaults to `noopLogger`. */
  readonly logger?: Logger | undefined;
}

/**
 * Fetches a generated chunk, reads its `sourceMappingURL` directive and returns
 * the source map that directive names.
 *
 * The sequence is fixed, and each step is a bound rather than a best effort:
 *
 * 0. Screen `options.devServerOrigin` — the mandatory pin. A missing,
 *    unparseable, credentialed, non-`http(s)` or non-loopback pin refuses the
 *    whole lookup **before `fetchImpl` is consulted at all**, because a lookup
 *    with no usable origin policy must not run rather than run unpinned.
 * 1. Screen `chunkUrl` against the URL policy, which includes exact equality
 *    with that pin. A refused URL returns an `Err` **before `fetchImpl` is
 *    consulted at all** — no request is made, not even a rejected one.
 * 2. Fetch the chunk, credential-free, redirect-refusing, size-capped and
 *    timeout-bounded. The chunk is always fetched: only the chunk can say where
 *    its map is, or that it has none, so no cache entry can spare this request.
 * 3. Scan the chunk's tail for the last line-leading directive. None found →
 *    `Ok({ kind: 'none', reason: 'no-directive' })`, and the lookup stops there.
 * 4. A `data:` directive is decoded in place — no second request — and yields
 *    `inline: true` with `mapUrl` set to the chunk's URL.
 * 5. Any other directive is resolved **as a relative reference against the
 *    chunk's own URL**, never derived from the chunk's filename, and the
 *    resolved URL is screened again by the same policy — pin included, so a
 *    directive naming a different port or host on this machine is refused with
 *    no second request. The cache is consulted before the request and populated
 *    after the parse.
 *
 * @param chunkUrl The absolute URL of the generated chunk. Untrusted input: it
 * arrives from a stack string captured in the inspected page.
 * @param options See {@link FetchSourceMapOptions}. Required, because
 * {@link FetchSourceMapOptions.devServerOrigin} is: every other field has a
 * safe default, and an origin policy does not.
 * @returns A promise that **always fulfils**. `Ok` carries a
 * {@link SourceMapLookup} — a found document or a clean "no map" outcome; `Err`
 * carries a `DebuggenError` whose `code` is one of `FORBIDDEN_ORIGIN`,
 * `DEV_SERVER_UNAVAILABLE` or `CODE_INDEX_FAILED` and whose `details.reason`
 * distinguishes the cases. It never rejects and never throws: the resolver's
 * degradation promise — an unresolvable frame is returned unresolved — depends
 * on it, so every `await`, every `JSON.parse`, every `new URL` and every stream
 * read below sits inside a guard.
 *
 * @example
 * ```ts
 * const cache = createSourceMapCache();
 * const lookup = await fetchSourceMap(frame.url, {
 *   devServerOrigin: session.devServerUrl,
 *   cache,
 *   logger,
 * });
 * if (isOk(lookup) && lookup.value.kind === 'found') {
 *   // hand lookup.value.map to ./resolver.ts
 * }
 * ```
 */
export async function fetchSourceMap(
  chunkUrl: string,
  options: FetchSourceMapOptions,
): Promise<Result<SourceMapLookup>> {
  // The options bag is validated before a single property of it is read. It is
  // typed and required, but this module sits behind a service boundary and the
  // published package is reachable from untyped JavaScript, so a caller that
  // forgot the argument must get the same fail-closed refusal a missing pin
  // gets — not a `TypeError` thrown past a caller that was promised a `Result`.
  // Read through `unknown`, as every other foreign value in this module is.
  const bag: unknown = options;
  if (typeof bag !== 'object' || bag === null) {
    return err(invalidOriginPin('missing'));
  }
  const settings = bag as FetchSourceMapOptions;

  const logger = settings.logger ?? noopLogger;
  const maxBytes = Math.floor(positiveNumberOr(settings.maxBytes, DEFAULT_MAX_MAP_BYTES));
  const timeoutMs = Math.floor(positiveNumberOr(settings.timeoutMs, DEFAULT_FETCH_TIMEOUT_MS));
  const fetchImpl = settings.fetchImpl ?? globalThis.fetch;

  // The origin policy is established before anything else, including before the
  // `fetch` availability check below: a lookup whose pin is missing or unusable
  // has no policy to enforce, and the only safe reading of that is to refuse it
  // rather than to fall back to "any loopback service".
  const pinnedOrigin = screenOriginPin(settings.devServerOrigin);
  if (isErr(pinnedOrigin)) {
    logger.debug('source map lookup refused an unusable dev-server origin pin', {
      problem: pinnedOrigin.error.details?.['problem'],
    });
    return pinnedOrigin;
  }

  // Guarded rather than assumed: `fetch` is global from Node 18, but this
  // module's contract is "returns a Result", and a bare call on a missing
  // global would throw a TypeError straight past every caller.
  if (typeof fetchImpl !== 'function') {
    return err(
      new DebuggenError('DEV_SERVER_UNAVAILABLE', 'No fetch implementation is available.', {
        hint: 'Run the local service on Node 24, or pass options.fetchImpl.',
        details: { reason: 'request-failed' },
      }),
    );
  }

  const chunkTarget = screenUrl(chunkUrl, 'chunk', pinnedOrigin.value);
  if (isErr(chunkTarget)) {
    logger.debug('source map lookup refused a chunk URL', {
      reason: chunkTarget.error.details?.['reason'],
      url: chunkTarget.error.details?.['url'],
    });
    return chunkTarget;
  }

  const chunkBody = await fetchTextWithinCeiling({
    target: chunkTarget.value,
    role: 'chunk',
    fetchImpl,
    maxBytes,
    timeoutMs,
    signal: settings.signal,
    logger,
  });
  if (isErr(chunkBody)) {
    return chunkBody;
  }

  const directive = readSourceMappingUrlDirective(chunkBody.value);
  if (directive === undefined) {
    logger.debug('chunk carries no sourceMappingURL directive', {
      url: describeUrl(chunkTarget.value),
    });
    return ok({ kind: 'none', reason: 'no-directive' });
  }

  if (isDataUrlDirective(directive)) {
    return resolveInlineDirective(directive, chunkTarget.value, settings.cache, logger);
  }

  // The pairing comes from the directive, resolved against the chunk's URL — a
  // relative value ("./x.js.map", "../maps/x.map"), an absolute path ("/_next/…")
  // and an absolute URL all behave as the format specifies, and none of them is
  // derived from the chunk's filename. Screening runs again, against the same
  // pin, because a directive is page-authored content: it can name a foreign
  // origin, a private network address, a `javascript:` URL — or another service
  // on this very machine, which is the case only the pin catches — and each of
  // those is refused here, before a second request exists.
  const mapTarget = screenUrl(directive, 'map', pinnedOrigin.value, chunkTarget.value);
  if (isErr(mapTarget)) {
    logger.debug('source map lookup refused a map URL named by a directive', {
      chunkUrl: describeUrl(chunkTarget.value),
      reason: mapTarget.error.details?.['reason'],
      url: mapTarget.error.details?.['url'],
    });
    return mapTarget;
  }

  const mapUrl = mapTarget.value.href;
  const cached = cacheGet(settings.cache, mapUrl, describeUrl(mapTarget.value), logger);
  if (cached !== undefined) {
    logger.debug('source map served from cache', { url: describeUrl(mapTarget.value) });
    return ok({ kind: 'found', map: cached, mapUrl, inline: false });
  }

  const mapBody = await fetchTextWithinCeiling({
    target: mapTarget.value,
    role: 'map',
    fetchImpl,
    maxBytes,
    timeoutMs,
    signal: settings.signal,
    logger,
  });
  if (isErr(mapBody)) {
    return mapBody;
  }

  const document = parseSourceMapDocument(mapBody.value, describeUrl(mapTarget.value));
  if (isErr(document)) {
    logger.warn('source map document could not be parsed', {
      url: describeUrl(mapTarget.value),
      reason: document.error.details?.['reason'],
    });
    return document;
  }

  cacheSet(settings.cache, mapUrl, document.value, describeUrl(mapTarget.value), logger);
  return ok({ kind: 'found', map: document.value, mapUrl, inline: false });
}

/**
 * Whether `url`'s **host** is a loopback address, and therefore a host a dev
 * server on this machine can legitimately be reached at.
 *
 * Accepted, and nothing else:
 *
 * - `localhost` and any `*.localhost` subdomain, both reserved to loopback by
 *   RFC 6761 §6.3 (`app.localhost` is what a multi-tenant dev server uses).
 * - The whole IPv4 loopback range `127.0.0.0/8` — not just `127.0.0.1`: a dev
 *   server bound to `127.0.0.2` is as local as one bound to `127.0.0.1`.
 *   WHATWG `URL` canonicalises `127.1`, `0177.1` and `2130706433` into dotted
 *   quads before they arrive here, so the shorthand spellings are covered by
 *   the same comparison rather than by a second parser.
 * - IPv6 `::1`, which a URL carries as the bracketed host `[::1]`. A raw,
 *   unbracketed `::1` is accepted too, for a caller passing a host-shaped
 *   string it built itself.
 *
 * Refused explicitly: `0.0.0.0` and `[::]` (the unspecified addresses — they
 * name "every interface", which is not the same as "this machine", and a
 * request to one leaves through a real interface), every private and
 * link-local range (`10/8`, `172.16/12`, `192.168/16`, `169.254/16`, IPv6
 * `fc00::/7`, `fe80::/10`), every public host, and any string that is not a
 * URL at all.
 *
 * ## What this predicate does *not* cover
 *
 * The host is one of four checks in {@link fetchSourceMap}'s URL policy; the
 * other three — an `http:`/`https:` scheme, no `user:password@` credentials,
 * and exact equality with the session's pinned dev-server origin
 * ({@link FetchSourceMapOptions.devServerOrigin}) — are applied there, because
 * they are properties of the *request* rather than of the host. A caller
 * reusing this predicate as a standalone guard before fetching something itself
 * must apply those three as well; loopback alone is **not** an authorisation on
 * a developer's machine, where this product's own service is one of the things
 * listening there.
 *
 * @param url An absolute URL, as a string or a parsed `URL`.
 * @returns `true` only for a loopback host. A string that does not parse as an
 * absolute URL returns `false` rather than throwing, because the inputs to this
 * predicate are captured strings and "not a URL" is a refusal, not an error.
 */
export function isLoopbackDevServerUrl(url: string | URL): boolean {
  const parsed = typeof url === 'string' ? tryCatch(() => new URL(url)) : ok(url);
  if (isErr(parsed)) {
    return false;
  }

  // `URL.hostname` is already lower-cased and IDNA-encoded by the parser; the
  // explicit lower-casing covers a caller-supplied `URL`-like value and a
  // bracketed IPv6 host, which keeps its case only in pathological inputs.
  const hostname = parsed.value.hostname.toLowerCase();
  if (hostname.length === 0) {
    return false;
  }

  if (hostname === LOOPBACK_HOST || hostname.endsWith(LOOPBACK_TLD_SUFFIX)) {
    return true;
  }

  // `URL.hostname` brackets an IPv6 literal; a raw host string does not.
  const unbracketed =
    hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
  if (unbracketed === IPV6_LOOPBACK) {
    return true;
  }

  const octets = IPV4_LITERAL.exec(unbracketed);
  if (octets === null) {
    return false;
  }

  // `noUncheckedIndexedAccess`: every capture is `string | undefined`, so the
  // first octet is read defensively even though the pattern guarantees four.
  const first = Number(octets[1] ?? '');
  const rest = [octets[2], octets[3], octets[4]];
  if (first !== IPV4_LOOPBACK_FIRST_OCTET) {
    return false;
  }

  // A dotted quad that reaches here came through the URL parser, which rejects
  // an out-of-range octet — but this predicate also accepts a host-shaped
  // string a caller built, so the range is checked rather than assumed.
  return rest.every((octet) => {
    const value = Number(octet ?? '');
    return Number.isInteger(value) && value >= 0 && value <= IPV4_MAX_OCTET;
  });
}

/**
 * Reads the value of the last `sourceMappingURL` directive in a chunk's tail.
 *
 * Only the last {@link SOURCE_MAPPING_URL_TAIL_BYTES} code units are scanned
 * (see that constant for why), and within that window:
 *
 * - the directive must be **line-leading**, with only tabs and spaces before
 *   it, so the string appearing inside a line of bundler runtime code is not
 *   mistaken for a directive;
 * - both comment spellings are accepted — the current `//#`, the legacy `//@`,
 *   and the block form `/*# … *\/` in either spelling;
 * - the **last** match wins, because a bundler that appends a directive to
 *   output that already carried one (tsup's tree-shaking pass does exactly
 *   that) leaves two, and the later one is the operative one;
 * - the value is trimmed, and a directive whose value is empty is treated as no
 *   directive at all rather than resolved against the chunk URL — which would
 *   otherwise request the chunk itself and parse it as JSON.
 *
 * @param chunkText The chunk's full text, as fetched.
 * @returns The trimmed directive value — a relative reference, an absolute URL
 * or a `data:` URI — or `undefined` when the tail carries no directive. Total:
 * no input throws, including an empty string or a megabyte of binary junk.
 */
export function readSourceMappingUrlDirective(chunkText: string): string | undefined {
  const tail =
    chunkText.length > SOURCE_MAPPING_URL_TAIL_BYTES
      ? chunkText.slice(chunkText.length - SOURCE_MAPPING_URL_TAIL_BYTES)
      : chunkText;

  let found: string | undefined;
  for (const match of tail.matchAll(SOURCE_MAPPING_URL_DIRECTIVE)) {
    // Group 1 is the line-comment form, group 2 the block form; exactly one
    // participates in any match, and both are `string | undefined` under
    // `noUncheckedIndexedAccess`.
    const value = (match[1] ?? match[2] ?? '').trim();
    if (value.length > 0) {
      found = value;
    }
  }

  return found;
}

// ---------------------------------------------------------------------------
// Internals. Nothing below is exported: the public surface is the four
// functions, the three constants and the types above, and every helper here is
// an implementation detail the tests reach through them.
// ---------------------------------------------------------------------------

/** Which artifact a request is for, used in log fields and error details. */
type RequestRole = 'chunk' | 'map';

/** Everything {@link fetchTextWithinCeiling} needs for one bounded request. */
interface BoundedTextRequest {
  /** The screened, absolute target. */
  readonly target: URL;

  /** Whether this is the chunk or its map; diagnostics only. */
  readonly role: RequestRole;

  /** The injected or global `fetch`. */
  readonly fetchImpl: typeof fetch;

  /** The byte ceiling, enforced against the header and against the stream. */
  readonly maxBytes: number;

  /** This request's own timeout window. */
  readonly timeoutMs: number;

  /** The caller's cancellation signal, composed with the timeout. */
  readonly signal: AbortSignal | undefined;

  /** Where failures are logged. */
  readonly logger: Logger;
}

/**
 * A byte-stream reader, described structurally.
 *
 * `@types/node` declares the global `ReadableStream` as `ReadableStream<R = any>`,
 * so `response.body.getReader().read()` resolves to a value containing `any` —
 * which this repository's type-aware lint rules reject, and rightly: an `any`
 * flowing out of a network read is exactly where a wrong assumption about a
 * chunk's type stops being caught. Describing the two methods this module
 * actually calls, and casting the body to that shape once, fences the `any` off
 * at the boundary and types every byte after it.
 */
interface ByteStreamReader {
  read(): Promise<{ readonly done: boolean; readonly value?: Uint8Array | undefined }>;
  cancel(reason?: unknown): Promise<void>;
}

/** The one method this module calls on a response body. */
interface ByteStreamSource {
  getReader(): ByteStreamReader;
}

/** What {@link decodeInlineDirective} produced. */
type InlineDecoding =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'unsupported'; readonly detail: string };

/**
 * A URL rendered for a log field or an error detail: scheme, host, port and
 * path, with **userinfo, query and fragment dropped**.
 *
 * Three reasons, all of them the privacy model's (AAP 0.5.2): a captured URL's
 * query values are application data and are redacted everywhere else in this
 * product; a `user:password@` component is a credential and must not be echoed
 * into a log line by the very function that refused it for carrying one; and
 * the path is what a developer needs to recognise which chunk failed.
 */
function describeUrl(url: URL): string {
  return `${url.protocol}//${url.host}${url.pathname}`;
}

/**
 * Applies the URL policy and returns the parsed target, or an `Err` naming the
 * rule that refused it.
 *
 * This is the SSRF gate described in the module overview, and it runs **before
 * any request** — for the chunk URL a caller supplied, and again for the map
 * URL a directive named. The five rules, in the order a reader should think
 * about them:
 *
 * 1. It must parse as an absolute URL (with `base`, as a relative reference
 *    against the chunk's URL).
 * 2. Its scheme must be `http:` or `https:`, which rejects `data:` reached by
 *    a path this function guards, `file:` (a local-file read), `javascript:`
 *    and everything else.
 * 3. It must carry no credentials. A `user:password@` userinfo component is
 *    refused rather than stripped: this product does not replay a credential
 *    it found in a captured string, and silently dropping it would turn an
 *    attempted credential leak into a successful anonymous fetch.
 * 4. Its host must be loopback ({@link isLoopbackDevServerUrl}).
 * 5. Its origin must **equal** `pinnedOrigin` — the session's authoritative
 *    dev-server origin, already screened by {@link screenOriginPin}. This is
 *    the rule that distinguishes the dev server under investigation from every
 *    other listener on this machine, and it is why rule 4 is a floor rather
 *    than the policy: `127.0.0.1:5432` and `127.0.0.1:43117` are as loopback as
 *    the dev server is, and neither is it.
 *
 * @param candidate The URL to screen: a caller-supplied chunk URL, or a
 * page-authored directive value resolved against `base`.
 * @param role Whether this is the chunk or its map; diagnostics only.
 * @param pinnedOrigin The canonical origin every request of this lookup is
 * confined to.
 * @param base The chunk's URL, when `candidate` may be a relative reference.
 * @returns `Ok(URL)` for a permitted target, or `Err` with code
 * `FORBIDDEN_ORIGIN` and `details.reason` naming the failed rule.
 */
function screenUrl(
  candidate: string,
  role: RequestRole,
  pinnedOrigin: string,
  base?: URL,
): Result<URL> {
  const parsed = tryCatch(() =>
    base === undefined ? new URL(candidate) : new URL(candidate, base),
  );
  if (isErr(parsed)) {
    return err(
      refusal('is not a valid URL', role, {
        reason: 'unparseable',
        // The candidate is not a URL, so `describeUrl` cannot render it and the
        // raw string is not safe to log in full (it may be page-authored). Its
        // length is the one diagnostic that is both useful and inert.
        candidateLength: candidate.length,
      }),
    );
  }

  const url = parsed.value;
  if (!ALLOWED_URL_PROTOCOLS.includes(url.protocol)) {
    return err(
      refusal('uses an unsupported scheme', role, {
        reason: 'scheme',
        scheme: url.protocol,
      }),
    );
  }

  if (url.username.length > 0 || url.password.length > 0) {
    return err(
      refusal('carries credentials', role, {
        reason: 'credentials',
        // Deliberately the host only: rendering the path or the userinfo of a
        // credentialed URL is how a credential reaches a log file.
        host: url.host,
      }),
    );
  }

  if (!isLoopbackDevServerUrl(url)) {
    return err(
      refusal('does not name a loopback dev server', role, {
        reason: 'non-loopback',
        host: url.host,
      }),
    );
  }

  if (url.origin !== pinnedOrigin) {
    return err(
      refusal("does not belong to the session's dev server", role, {
        reason: 'origin-mismatch',
        origin: url.origin,
        expectedOrigin: pinnedOrigin,
      }),
    );
  }

  return ok(url);
}

/**
 * Screens the mandatory origin pin and reduces it to a canonical origin string.
 *
 * The pin is the one thing a caller *must* supply, so it is also the one thing
 * that must not be trusted to be well formed: it travels from a session record
 * through the service, and a caller that lost it — an empty string from a
 * half-initialised session, a value that was never a URL — would otherwise
 * install a policy that matches nothing (harmless) or, if the comparison were
 * written laxly, one that matches everything (not). Screening it here makes
 * both cases the same visible refusal.
 *
 * The same four properties the candidates are held to apply to the pin, for one
 * reason each: it must **parse**, or there is no origin to compare against; it
 * must be `http:`/`https:`, because those are the only schemes this module
 * fetches over and a `file:` or `data:` pin would authorise a set of URLs it
 * could never legitimately name; it must carry **no credentials**, because a
 * pin is compared by origin and a userinfo component in it can only be a
 * mistake worth surfacing; and it must be **loopback**, which is what keeps the
 * option a narrowing of the loopback rule rather than an escape from it — a
 * caller cannot authorise `https://evil.example` by pinning to it.
 *
 * A full URL is accepted and reduced to its origin, because the value a session
 * carries is a dev-server *URL* (`http://127.0.0.1:3000/`), not a bare origin.
 * `URL.origin` performs the canonicalisation both sides of the later comparison
 * need — lower-cased scheme and host, IDNA- and IPv4-normalised host, default
 * port dropped — so the comparison itself is a string equality with no further
 * parsing per candidate.
 *
 * @param rawOrigin The value of {@link FetchSourceMapOptions.devServerOrigin},
 * taken as `unknown` rather than as `string`: the declared type is a promise
 * TypeScript keeps for its own callers, and this function is the one place that
 * must hold for the others too.
 * @returns `Ok` with the canonical origin (`http://127.0.0.1:3000`), or `Err`
 * with code `FORBIDDEN_ORIGIN`, `details.reason = 'origin-pin-invalid'` and
 * `details.problem` naming which property failed.
 */
function screenOriginPin(rawOrigin: unknown): Result<string> {
  // A type narrowing rather than a truthiness test: this is a public option on
  // a security boundary, and a JavaScript caller — or options deserialised from
  // JSON — can supply `undefined`, `null` or a number for it without TypeScript
  // ever seeing the call.
  if (typeof rawOrigin !== 'string' || rawOrigin.trim().length === 0) {
    return err(invalidOriginPin('missing'));
  }

  const parsed = tryCatch(() => new URL(rawOrigin.trim()));
  if (isErr(parsed)) {
    return err(invalidOriginPin('unparseable'));
  }

  const url = parsed.value;
  if (!ALLOWED_URL_PROTOCOLS.includes(url.protocol)) {
    return err(invalidOriginPin('scheme'));
  }

  if (url.username.length > 0 || url.password.length > 0) {
    return err(invalidOriginPin('credentials'));
  }

  if (!isLoopbackDevServerUrl(url)) {
    return err(invalidOriginPin('non-loopback'));
  }

  // `URL.origin` is `"null"` for an opaque origin. No `http:`/`https:` URL has
  // one, so this is unreachable for the schemes admitted above — and it is
  // checked anyway, because an origin of `"null"` compared by equality would
  // match every other opaque origin rather than none of them.
  if (url.origin === OPAQUE_ORIGIN) {
    return err(invalidOriginPin('unparseable'));
  }

  return ok(url.origin);
}

/** Whether a directive value is an inline `data:` URI. Schemes are case-insensitive. */
function isDataUrlDirective(directive: string): boolean {
  return directive.slice(0, DATA_URL_SCHEME.length).toLowerCase() === DATA_URL_SCHEME;
}

/**
 * Resolves an inline (`data:`) directive without making a second request.
 *
 * `mapUrl` is set to the **chunk's** URL, and `inline` to `true`: an embedded
 * map has no URL of its own, the chunk is where it lives, and a consumer
 * resolving the map's relative `sources` entries needs the location of the
 * document it is resolving — which, for an embedded map, is the chunk. The
 * cache is keyed by the same URL for the same reason.
 *
 * A payload this module declines to decode — a media type other than
 * `application/json`, a transfer encoding it does not implement, malformed
 * percent escapes — is an `Ok` carrying `{ kind: 'none', reason:
 * 'unsupported-directive' }`. It is not a failure: the frame is simply
 * unresolvable through this route, exactly as a chunk with no directive is, and
 * reporting it as a failure would surface a dev server's choice of encoding as
 * a defect in the product. A payload that *is* decoded but is not a source map
 * is a different matter and fails as a malformed document.
 */
function resolveInlineDirective(
  directive: string,
  chunkTarget: URL,
  cache: SourceMapCache | undefined,
  logger: Logger,
): Result<SourceMapLookup> {
  const chunkUrl = chunkTarget.href;

  const cached = cacheGet(cache, chunkUrl, describeUrl(chunkTarget), logger);
  if (cached !== undefined) {
    logger.debug('inline source map served from cache', { url: describeUrl(chunkTarget) });
    return ok({ kind: 'found', map: cached, mapUrl: chunkUrl, inline: true });
  }

  const decoded = decodeInlineDirective(directive);
  if (decoded.kind === 'unsupported') {
    logger.debug('inline sourceMappingURL directive is not decodable', {
      url: describeUrl(chunkTarget),
      detail: decoded.detail,
    });
    return ok({ kind: 'none', reason: 'unsupported-directive' });
  }

  const document = parseSourceMapDocument(decoded.text, describeUrl(chunkTarget));
  if (isErr(document)) {
    logger.warn('inline source map document could not be parsed', {
      url: describeUrl(chunkTarget),
      reason: document.error.details?.['reason'],
    });
    return document;
  }

  cacheSet(cache, chunkUrl, document.value, describeUrl(chunkTarget), logger);
  return ok({ kind: 'found', map: document.value, mapUrl: chunkUrl, inline: true });
}

/**
 * Decodes the payload of a `data:` directive into source-map text.
 *
 * The grammar (RFC 2397) is `data:[<media-type>][;base64],<payload>`, and the
 * media type may carry parameters. That last clause is the one a matcher
 * written against the common case gets wrong: real inline maps are emitted as
 * `data:application/json;charset=utf-8;base64,…`, so a prefix comparison
 * against `data:application/json;base64,` refuses a perfectly ordinary
 * directive. The media type is therefore parsed — first `;`-separated segment,
 * trimmed and lower-cased — and its parameters are scanned for `base64`
 * independently of where they appear.
 *
 * Two transfer encodings are implemented, which is all the format defines:
 * `;base64` (decoded through `Buffer`, whose base64 decoder accepts the URL-safe
 * alphabet too) and the default percent-encoded form (decoded through
 * `decodeURIComponent`). Anything else, and any malformed escape sequence, is
 * reported as unsupported rather than thrown.
 */
function decodeInlineDirective(directive: string): InlineDecoding {
  const separator = directive.indexOf(',');
  if (separator < 0) {
    return { kind: 'unsupported', detail: 'data URI has no payload separator' };
  }

  const header = directive.slice(DATA_URL_SCHEME.length, separator);
  const payload = directive.slice(separator + 1);
  const segments = header.split(';');
  const mediaType = (segments[0] ?? '').trim().toLowerCase();
  const parameters = segments.slice(1).map((segment) => segment.trim().toLowerCase());

  if (mediaType !== INLINE_MAP_MEDIA_TYPE) {
    return {
      kind: 'unsupported',
      // An empty media type is the RFC's `text/plain;charset=US-ASCII` default,
      // which is not a source map either; naming what was seen keeps the debug
      // line actionable without echoing the payload.
      detail: `unsupported media type: ${mediaType.length === 0 ? '(default)' : mediaType}`,
    };
  }

  if (parameters.includes(BASE64_PARAMETER)) {
    // `Buffer.from(…, 'base64')` is total: it ignores characters outside the
    // alphabet rather than throwing, so a truncated payload produces short text
    // and fails the JSON parse below with a precise diagnostic instead of an
    // exception here.
    return { kind: 'text', text: Buffer.from(payload, 'base64').toString('utf8') };
  }

  const percentDecoded = tryCatch(() => decodeURIComponent(payload));
  if (isErr(percentDecoded)) {
    return { kind: 'unsupported', detail: 'payload is not valid percent-encoded text' };
  }

  return { kind: 'text', text: percentDecoded.value };
}

/**
 * Parses source-map text into a document, validating only what this layer is
 * entitled to decide.
 *
 * `JSON.parse` runs inside `tryCatch`, so a truncated map, a dev server's HTML
 * error page served with a 200, or a chunk mistakenly fetched as a map all
 * degrade to an `Err` with `details.reason = 'invalid-json'` rather than
 * throwing out of {@link fetchSourceMap}.
 *
 * The shape check that follows is deliberately minimal — an object (not an
 * array, not `null`) whose `version` is `3` and which carries either a string
 * `mappings` or an array `sections`. That is the discriminator the *format*
 * offers and the least this module can assert while still being able to say
 * "this is a source map"; everything beyond it (segment counts, index ranges,
 * section offsets, `sources` arity) is the decoder's to validate, and a check
 * here would only be a second, weaker copy of it that refuses maps the decoder
 * would have read.
 */
function parseSourceMapDocument(text: string, describedUrl: string): Result<SourceMapDocument> {
  const parsed = tryCatch(() => JSON.parse(text) as unknown, 'CODE_INDEX_FAILED');
  if (isErr(parsed)) {
    return err(
      new DebuggenError('CODE_INDEX_FAILED', `Source map at ${describedUrl} is not valid JSON.`, {
        hint: 'The dev server may have served an error page or a partial response; reload the page and try again.',
        details: { reason: 'invalid-json', url: describedUrl, bytes: text.length },
        cause: parsed.error,
      }),
    );
  }

  const value = parsed.value;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return err(malformedDocument(describedUrl, 'document is not a JSON object'));
  }

  const record = value as Record<string, unknown>;
  if (record['version'] !== SUPPORTED_SOURCE_MAP_VERSION) {
    return err(
      malformedDocument(
        describedUrl,
        `unsupported source map version: ${String(record['version'])}`,
      ),
    );
  }

  if (typeof record['mappings'] === 'string') {
    return ok(value as RawSourceMapDocument);
  }

  if (Array.isArray(record['sections'])) {
    return ok(value as SectionedSourceMapDocument);
  }

  return err(malformedDocument(describedUrl, 'document has neither mappings nor sections'));
}

/**
 * Performs one bounded GET and returns the response body as text.
 *
 * Every safety bound of the module overview is applied here, and each is worth
 * naming at the point it is enforced:
 *
 * - **No ambient authority.** `credentials: 'omit'` and *no headers at all*.
 *   The absence of a `headers` field is the point: there is no
 *   `Authorization`, no cookie and no custom header to audit, so a request
 *   this module makes cannot carry the developer's session anywhere.
 * - **`redirect: 'error'`.** A 3xx makes `fetch` reject, which arrives here as
 *   a transport failure. A dev server has no reason to redirect a chunk, and
 *   following one would land on an origin the screening never approved.
 * - **A composed timeout.** `AbortSignal.timeout` for this request plus the
 *   caller's signal through `AbortSignal.any`, so a session teardown cancels an
 *   in-flight read and the timeout still applies when the caller supplied no
 *   signal.
 * - **The ceiling, twice.** Once against the declared `Content-Length`, which
 *   refuses an oversized response *before* a byte of it is read, and again
 *   while the body streams, which is what covers a server that omits the
 *   header or understates it. Neither check alone is sufficient: the header is
 *   a claim, and buffering first to measure second is the failure mode the
 *   ceiling exists to prevent.
 *
 * @returns `Ok(text)`, or `Err` with code `DEV_SERVER_UNAVAILABLE` and
 * `details.reason` of `request-failed`, `http-status`, `too-large` or
 * `unreadable`.
 */
async function fetchTextWithinCeiling(request: BoundedTextRequest): Promise<Result<string>> {
  const described = describeUrl(request.target);
  const signal = composeSignal(request.timeoutMs, request.signal);
  if (isErr(signal)) {
    return err(
      transportFailure(
        `Could not start the request for the ${request.role} at ${described}.`,
        { reason: 'request-failed', role: request.role, url: described },
        signal.error,
      ),
    );
  }

  // Two guards, not one: `fetchImpl` is injectable, so it may throw
  // synchronously (a misconfigured double, a global that is not a function
  // after all) as well as reject. `tryCatch` catches the former while producing
  // the promise, `fromPromise` the latter while awaiting it.
  const started = tryCatch(() =>
    request.fetchImpl(request.target, {
      method: 'GET',
      credentials: 'omit',
      redirect: 'error',
      signal: signal.value,
    }),
  );
  if (isErr(started)) {
    return err(
      transportFailure(
        `Could not fetch the ${request.role} at ${described}.`,
        { reason: 'request-failed', role: request.role, url: described },
        started.error,
      ),
    );
  }

  const response = await fromPromise(started.value);
  if (isErr(response)) {
    request.logger.debug('source map lookup request failed', {
      role: request.role,
      url: described,
      timeoutMs: request.timeoutMs,
    });
    return err(
      transportFailure(
        `Could not fetch the ${request.role} at ${described}.`,
        { reason: 'request-failed', role: request.role, url: described },
        response.error,
      ),
    );
  }

  const status = statusOf(response.value);
  if (status === undefined || status < 200 || status >= 300) {
    request.logger.debug('source map lookup got an unusable status', {
      role: request.role,
      url: described,
      status,
    });
    return err(
      transportFailure(`The dev server answered ${String(status)} for ${described}.`, {
        reason: 'http-status',
        role: request.role,
        url: described,
        status,
      }),
    );
  }

  const declared = declaredContentLength(response.value);
  if (declared !== undefined && declared > request.maxBytes) {
    request.logger.debug('source map lookup refused an oversized response', {
      role: request.role,
      url: described,
      declaredBytes: declared,
      maxBytes: request.maxBytes,
    });
    return err(oversized(described, request.role, request.maxBytes, declared));
  }

  return readBodyWithinCeiling(response.value, request);
}

/**
 * Reads a response body as text without letting it exceed the ceiling.
 *
 * The preferred route is the body stream, because it is the only one that can
 * stop *while* an oversized body is arriving rather than after it has been
 * buffered. Two fallbacks follow it, in order, for a response object that has
 * no stream — a synthesised `Response`, or a test double:
 * `arrayBuffer()` and then `text()`, each measured against the same ceiling
 * once resolved. The ladder is honest about what it costs: only the streaming
 * rung enforces the ceiling *before* allocation, so a response reaching a
 * fallback rung is bounded by that rung's buffer. A real `fetch` response
 * always has a stream.
 */
async function readBodyWithinCeiling(
  response: Response,
  request: BoundedTextRequest,
): Promise<Result<string>> {
  const described = describeUrl(request.target);
  const body: unknown = response.body;

  if (isByteStreamSource(body)) {
    return readStreamWithinCeiling(body, request, described);
  }

  if (typeof response.arrayBuffer === 'function') {
    const buffered = await awaitGuarded(() => response.arrayBuffer());
    if (isErr(buffered)) {
      return err(unreadableBody(described, request.role, buffered.error));
    }
    const size = tryCatch(() => Buffer.from(buffered.value).byteLength);
    if (isErr(size)) {
      return err(unreadableBody(described, request.role, size.error));
    }
    if (size.value > request.maxBytes) {
      return err(oversized(described, request.role, request.maxBytes, size.value));
    }
    return decodeUtf8(() => Buffer.from(buffered.value), described, request.role);
  }

  if (typeof response.text === 'function') {
    const text = await awaitGuarded(() => response.text());
    if (isErr(text)) {
      return err(unreadableBody(described, request.role, text.error));
    }
    if (typeof text.value !== 'string') {
      return err(
        unreadableBody(
          described,
          request.role,
          new Error('response text() did not yield a string'),
        ),
      );
    }
    const bytes = Buffer.byteLength(text.value, 'utf8');
    if (bytes > request.maxBytes) {
      return err(oversized(described, request.role, request.maxBytes, bytes));
    }
    return ok(text.value);
  }

  return err(
    unreadableBody(described, request.role, new Error('response exposes no readable body')),
  );
}

/**
 * Drains a body stream, aborting the moment the accumulated byte count passes
 * the ceiling.
 *
 * The reader is cancelled on every exit that is not a clean end of stream —
 * the ceiling being hit, a mid-stream failure, a non-binary chunk — because an
 * abandoned reader holds the connection open, and with keep-alive it holds the
 * dev server's handler with it until that server times the request out.
 *
 * Chunks are concatenated and decoded once, at the end, rather than decoded
 * incrementally: a UTF-8 sequence may straddle a chunk boundary, and decoding
 * per chunk would corrupt exactly the non-ASCII identifiers and string literals
 * a source map is most likely to carry.
 */
async function readStreamWithinCeiling(
  source: ByteStreamSource,
  request: BoundedTextRequest,
  described: string,
): Promise<Result<string>> {
  const acquired = tryCatch(() => source.getReader());
  if (isErr(acquired)) {
    return err(unreadableBody(described, request.role, acquired.error));
  }

  const reader = acquired.value;
  const chunks: Uint8Array[] = [];
  let total = 0;

  for (;;) {
    const step = await awaitGuarded(() => reader.read());
    if (isErr(step)) {
      await cancelQuietly(reader);
      return err(unreadableBody(described, request.role, step.error));
    }

    const chunk = step.value.value;
    if (chunk !== undefined) {
      if (!(chunk instanceof Uint8Array)) {
        await cancelQuietly(reader);
        return err(
          unreadableBody(
            described,
            request.role,
            new Error('response stream produced a non-binary chunk'),
          ),
        );
      }

      total += chunk.byteLength;
      if (total > request.maxBytes) {
        await cancelQuietly(reader);
        request.logger.debug('source map lookup aborted an oversized response mid-stream', {
          role: request.role,
          url: described,
          readBytes: total,
          maxBytes: request.maxBytes,
        });
        return err(oversized(described, request.role, request.maxBytes, total));
      }

      chunks.push(chunk);
    }

    if (step.value.done) {
      break;
    }
  }

  return decodeUtf8(() => Buffer.concat(chunks), described, request.role);
}

/**
 * Joins collected bytes and decodes them as UTF-8, inside a guard.
 *
 * Both halves sit in the guard on purpose: the join can reject a chunk this
 * module did not produce, and the decode can exceed the runtime's maximum
 * string length — which the byte ceiling already prevents, but "this function
 * returns a `Result`" is a contract rather than an aspiration, and an
 * unguarded `Buffer` call would be the one statement in this module able to
 * break it.
 */
function decodeUtf8(produce: () => Buffer, described: string, role: RequestRole): Result<string> {
  const text = tryCatch(() => produce().toString('utf8'));
  if (isErr(text)) {
    return err(unreadableBody(described, role, text.error));
  }
  return text;
}

/**
 * Calls a promise-returning function and awaits it, catching a synchronous
 * throw as well as a rejection.
 *
 * Needed wherever this module calls a method on a value it did not construct —
 * an injected `fetchImpl`, a response object, a stream reader. `fromPromise`
 * alone would not help: a function that throws instead of rejecting does so
 * while the argument to `fromPromise` is being evaluated, which is outside its
 * `try`.
 *
 * Deliberately **not** `async`. Both branches already yield the value this
 * function promises — `fromPromise` returns the promise, and the synchronous
 * failure is lifted with `Promise.resolve` — so `async` would add a keyword
 * with no `await` under it: an extra microtask hop on every stream read, and a
 * `@typescript-eslint/require-await` violation of the `--max-warnings 0` lint
 * gate (AAP 0.8.5) the moment a return path stops being thenable. Callers
 * `await` the result either way, so the observable behaviour is identical.
 */
function awaitGuarded<T>(produce: () => PromiseLike<T>): Promise<Result<T>> {
  const started = tryCatch(produce);
  if (isErr(started)) {
    return Promise.resolve(started);
  }
  return fromPromise(started.value);
}

/** Cancels a reader, swallowing every outcome. See {@link readStreamWithinCeiling}. */
async function cancelQuietly(reader: ByteStreamReader): Promise<void> {
  // `cancel` is called on a reader this module did not construct, so both the
  // synchronous call and the returned promise are guarded: a test double whose
  // `cancel` is absent or rejects must not turn a handled failure into an
  // unhandled one.
  const cancellation = tryCatch(() => reader.cancel());
  if (isOk(cancellation)) {
    await fromPromise(cancellation.value);
  }
}

/**
 * Composes this request's deadline with the caller's cancellation signal.
 *
 * `AbortSignal.any` is what lets both cancel without either knowing about the
 * other: the timeout bounds a wedged dev server, and the caller's signal ends
 * an in-flight read when the session or the panel interaction that asked for it
 * is gone. Guarded because both statics are runtime features rather than
 * language ones, and this module's contract does not permit a `TypeError` to
 * escape.
 */
function composeSignal(
  timeoutMs: number,
  callerSignal: AbortSignal | undefined,
): Result<AbortSignal> {
  return tryCatch(() => {
    const deadline = AbortSignal.timeout(timeoutMs);
    return callerSignal === undefined ? deadline : AbortSignal.any([deadline, callerSignal]);
  });
}

/**
 * The response's status code, when it has a numeric one.
 *
 * Read defensively through `unknown` because `fetchImpl` is injectable: a test
 * double is a plain object, and treating a missing status as "unusable" is the
 * safe reading — a response this module cannot classify is one it declines to
 * parse as a source map.
 */
function statusOf(response: Response): number | undefined {
  const status: unknown = response.status;
  return typeof status === 'number' ? status : undefined;
}

/**
 * The declared body size in bytes, when the response states a usable one.
 *
 * A missing, non-numeric, negative or `Infinity` header yields `undefined`,
 * which means "no claim was made" and leaves the streaming ceiling as the only
 * enforcement — which is exactly why that second check exists.
 */
function declaredContentLength(response: Response): number | undefined {
  const headers: unknown = response.headers;
  if (typeof headers !== 'object' || headers === null) {
    return undefined;
  }

  const getter = (headers as { get?: unknown }).get;
  if (typeof getter !== 'function') {
    return undefined;
  }

  const raw = tryCatch(() => (headers as Headers).get('content-length'));
  if (isErr(raw) || raw.value === null) {
    return undefined;
  }

  const declared = Number(raw.value.trim());
  return Number.isFinite(declared) && declared >= 0 ? declared : undefined;
}

/**
 * Reads a document from an injected cache, treating a misbehaving cache as a
 * miss.
 *
 * {@link SourceMapCache} is an interface a consumer may implement, so its
 * methods are foreign code called from inside a function that promises to
 * return a `Result`. A cache that throws therefore degrades this lookup to an
 * uncached one — a slower correct answer — and says so at `debug`, rather than
 * turning a cache defect into a failed source-map resolution.
 */
function cacheGet(
  cache: SourceMapCache | undefined,
  key: string,
  described: string,
  logger: Logger,
): SourceMapDocument | undefined {
  if (cache === undefined) {
    return undefined;
  }

  const entry = tryCatch(() => cache.get(key));
  if (isErr(entry)) {
    logger.debug('source map cache lookup failed; continuing uncached', { url: described });
    return undefined;
  }

  return entry.value;
}

/** Stores a document in an injected cache, ignoring a misbehaving cache. */
function cacheSet(
  cache: SourceMapCache | undefined,
  key: string,
  document: SourceMapDocument,
  described: string,
  logger: Logger,
): void {
  if (cache === undefined) {
    return;
  }

  const stored = tryCatch(() => {
    cache.set(key, document);
  });
  if (isErr(stored)) {
    logger.debug('source map cache store failed; continuing uncached', { url: described });
  }
}

/** Whether `value` exposes the one method this module calls on a body stream. */
function isByteStreamSource(value: unknown): value is ByteStreamSource {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { getReader?: unknown }).getReader === 'function'
  );
}

/**
 * `value` when it is a finite positive number, `fallback` otherwise.
 *
 * Used for `maxBytes`, `timeoutMs` and `maxEntries`, each of which arrives from
 * a caller's configuration: `0`, `-1`, `NaN` and `Infinity` all mean a bound
 * that does not bound, so they take the default rather than disabling the
 * safety they were meant to configure.
 */
function positiveNumberOr(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * A URL-policy refusal: `FORBIDDEN_ORIGIN`, with the failed rule in
 * `details.reason`.
 *
 * One code for every refusal so a caller has one branch to write, and a
 * `reason` for the diagnostic difference. `details` never carries a query
 * string, a fragment or a userinfo component — see {@link describeUrl}.
 */
function refusal(
  problem: string,
  role: RequestRole,
  details: Readonly<Record<string, unknown>>,
): DebuggenError {
  return new DebuggenError(
    'FORBIDDEN_ORIGIN',
    `Refused to fetch a source map: the ${role} URL ${problem}.`,
    {
      hint: 'Debug Generator reads chunks and source maps only from a loopback dev server, over http or https, without credentials.',
      details: { role, ...details },
    },
  );
}

/**
 * The origin pin itself is unusable: `FORBIDDEN_ORIGIN` with
 * `details.reason = 'origin-pin-invalid'` and the failed property in
 * `details.problem`.
 *
 * The offending value is deliberately **not** included. A pin that failed to
 * parse is a caller-supplied string of unknown provenance, and the diagnostic a
 * developer needs is which property was wrong plus the hint below — not the
 * string echoed into a log file (AAP 0.5.2).
 */
function invalidOriginPin(
  problem: 'missing' | 'unparseable' | 'scheme' | 'credentials' | 'non-loopback',
): DebuggenError {
  return new DebuggenError(
    'FORBIDDEN_ORIGIN',
    `Refused to fetch a source map: the session's dev-server origin is unusable (${problem}).`,
    {
      hint: "Pass the session's devServerUrl as options.devServerOrigin — a credential-free http or https URL on a loopback host.",
      details: { reason: 'origin-pin-invalid', problem },
    },
  );
}

/** A request that could not be made, was refused, or could not be read. */
function transportFailure(
  message: string,
  details: Readonly<Record<string, unknown>>,
  cause?: unknown,
): DebuggenError {
  return new DebuggenError('DEV_SERVER_UNAVAILABLE', message, {
    hint: 'Check that the dev server is still running and serving this chunk, then try again.',
    details,
    cause,
  });
}

/** The byte ceiling was exceeded, by claim or in fact. */
function oversized(
  described: string,
  role: RequestRole,
  maxBytes: number,
  observedBytes: number,
): DebuggenError {
  return transportFailure(
    `The ${role} at ${described} exceeds the ${String(maxBytes)} byte limit for a source map lookup.`,
    { reason: 'too-large', role, url: described, maxBytes, observedBytes },
  );
}

/** The response arrived but its body could not be read to completion. */
function unreadableBody(described: string, role: RequestRole, cause: unknown): DebuggenError {
  return transportFailure(
    `The response body for the ${role} at ${described} could not be read.`,
    { reason: 'unreadable', role, url: described },
    cause,
  );
}

/**
 * A document was fetched and decoded but is not a source map:
 * `CODE_INDEX_FAILED`, with `details.reason = 'invalid-shape'`.
 */
function malformedDocument(describedUrl: string, problem: string): DebuggenError {
  return new DebuggenError(
    'CODE_INDEX_FAILED',
    `The document at ${describedUrl} is not a source map: ${problem}.`,
    {
      hint: 'The dev server may be serving a stale or unrelated file at this path; reload the page and try again.',
      details: { reason: 'invalid-shape', url: describedUrl, problem },
    },
  );
}
