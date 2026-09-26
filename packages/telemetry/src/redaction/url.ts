/**
 * URL redaction, and the single URL/query parser the redaction layer owns.
 *
 * This module implements one row of the privacy model: *"URL query parameter
 * values → replaced with `?` per key for display and storage; path retained"*.
 * A captured `fetch`, `xhr`, `http.server` or `http.client` event carries the
 * request URL in its attributes, and a URL is where application data leaks
 * most casually — search terms, customer identifiers, one-time tokens in a
 * reset link, a signed-download signature. What survives redaction is the
 * *shape* of the request (scheme, host, port, path, which parameters were
 * present and in which order) because that is what a debugging panel needs;
 * every parameter value is replaced by a single mask character.
 *
 * ## Why this file does not use the `URL` global
 *
 * `new URL(value)` is a *normaliser*, not a parser. It re-encodes percent
 * escapes, lower-cases the host, drops default ports, sorts nothing but
 * rewrites plenty, resolves a relative reference against a base (or throws
 * when there is none) and re-serialises the result. Every one of those
 * behaviours is wrong here:
 *
 * - The value stored for display would stop matching the request the browser
 *   agent actually made, so a developer comparing the panel with the DevTools
 *   Network pane would see two different URLs.
 * - Origin-relative (`/api/products?slug=x`), protocol-relative (`//host/p`)
 *   and bare-relative (`products?a=1`) values all reach this function, and a
 *   parser that needs a base URL either throws on them or silently invents an
 *   origin.
 * - `%2F` in a path, an explicit `:443`, and a mixed-case host are diagnostic
 *   signals; normalising them away loses information that costs nothing to
 *   keep.
 *
 * So the parsing here is plain string work: split, slice, compare. The one
 * place percent-decoding happens is {@link decodeQueryComponent}, which exists
 * for canonicalisation by callers and never for reshaping the stored value.
 *
 * ## Relationship to duplicate detection
 *
 * `./request-key.ts` computes `request_key = HMAC-SHA256(sessionKey, method +
 * path + sorted query pairs)` from the **unredacted** URL, at ingest, *before*
 * this module runs — and it does so through {@link parseUrlParts},
 * {@link parseQueryPairs} and {@link decodeQueryComponent}, the very same
 * primitives used for masking. That is why one parser lives here instead of
 * two: `productId=A` and `productId=B` must hash to different keys (so the
 * aggregates do not merge two distinct requests) even though both are stored
 * and displayed as `productId=?`, and byte-identical requests must hash to the
 * same key (so a genuine duplicate is detected). A parsing discrepancy between
 * masking and keying would make those two views of one request disagree, which
 * is exactly the kind of bug that is invisible until a duplicate-request
 * investigation quietly returns nothing.
 *
 * ## Guarantees
 *
 * Every function here is pure — no I/O, no globals, no clock, no randomness,
 * no mutable module state — linear in the length of its input, and total: no
 * input throws, including binary junk, a lone delimiter or a megabyte of it.
 * {@link redactUrl} is idempotent, and its result is never longer than
 * `MAX_SCAN_LENGTH` code units, which is what keeps the second pass on the
 * unbounded path (see {@link redactUrl} for the argument).
 *
 * The two **redaction entry points** — {@link redactUrl} and
 * {@link redactQueryString} — take `unknown`, because a URL reaches them from a
 * parsed JSON event body or an OpenTelemetry span attribute, where nothing has
 * checked that it is a string; `asScannableText` decides what each type
 * becomes. The **parsers** ({@link parseUrlParts}, {@link parseQueryPairs},
 * {@link formatUrlParts}, {@link decodeQueryComponent},
 * {@link isUrlAttributeKey}) deliberately keep `string`: `./request-key.ts`
 * shares them for canonicalisation, and coercing there would change what a
 * request *keys* as rather than what it is redacted to — a value that is not a
 * string is not a request this parser has anything to say about, and the
 * caller that holds it is the one that must decide.
 *
 * The only import is `./rules.js`: the mask token, the marker, `scrub` and the
 * two boundary primitives (`asScannableText` for every value that arrives
 * untyped, `cutAtCredentialBoundary` for every cut this module makes) are
 * shared with the other handlers of this folder so that a URL and a SQL
 * statement come back in the same vocabulary, coerced and cut by the same
 * rules.
 */

import {
  MAX_SCAN_LENGTH,
  REDACTION_MARKER,
  REDACTION_MASK,
  asScannableText,
  cutAtCredentialBoundary,
  scrub,
} from './rules.js';

/**
 * Largest number of query parameters {@link parseQueryPairs} returns and
 * {@link redactQueryString} renders.
 *
 * A query is attacker-shaped data in the sense that matters here: it arrives
 * from an arbitrary page on every captured request, and a pathological one
 * (tens of thousands of parameters) must cost bounded work in the ingest hot
 * path. Parameters past the cap are dropped and replaced by a single
 * {@link REDACTION_MARKER} segment, never passed through unexamined.
 *
 * `./request-key.ts` canonicalises the same capped prefix, so a URL beyond the
 * cap still keys deterministically.
 */
export const MAX_QUERY_PAIRS = 512;

/**
 * Longest authority (userinfo, host and port together) reshaped verbatim.
 *
 * A real authority is a few dozen characters. Beyond this bound the value is
 * not an authority in any useful sense, and emitting it verbatim would both
 * defeat the output bound below and risk carrying credential-shaped text that
 * {@link scrub} cannot see (its connection-string rule needs the terminating
 * `@`, which a cut may have removed). Such a value is replaced wholesale.
 */
const MAX_AUTHORITY_LENGTH = 512;

/** Upper bound on the path {@link redactUrl} emits. */
const MAX_PATH_LENGTH = 4096;

/** Upper bound on the query string {@link redactQueryString} emits. */
const MAX_QUERY_LENGTH = 8192;

/**
 * A URL scheme: a letter followed by scheme characters, bounded well above
 * every registered scheme. Non-global, so `.test()` carries no `lastIndex`
 * state between calls.
 *
 * The bound is what stops a megabyte of junk before a stray `://` from being
 * read as a scheme; such a value keeps its text in {@link UrlParts.path}
 * instead, where it is scrubbed rather than trusted.
 */
const SCHEME_PATTERN = /^[A-Za-z][A-Za-z0-9+.-]{0,63}$/;

/**
 * A port: digits only, possibly empty, because `host:` is an odd but real
 * authority that must round-trip. A `:` followed by anything else (an IPv6
 * address written without brackets, say) stays part of the host verbatim.
 */
const PORT_PATTERN = /^[0-9]{0,15}$/;

/**
 * Attribute keys whose value is a URL and therefore belongs to
 * {@link redactUrl} rather than to the generic value scrubber.
 *
 * `url` is the key the fetch attribute vocabulary declares; `http.url`,
 * `http.target` and `target` are the OpenTelemetry spellings that reach the
 * service from the Node preload's span attributes; `error.source` is the
 * script or resource URL an `error` event carries, which `../browser/errors.ts`
 * takes from `ErrorEvent.filename` or from the failing element's `src` and
 * records verbatim.
 *
 * `error.source` is a full page URL with an ordinary query string on it — the
 * address the failing script or image was fetched from, which on a real
 * application routinely carries the same identifiers as any other request.
 * Without membership here it fell through to the generic string arm, which
 * masks credential *patterns* but never a query parameter value, so an error
 * raised from a page or asset URL kept every parameter it was loaded with,
 * into the store, the live tail and outbound prompts. AAP 0.5.2 admits a URL
 * only as "URL query parameter values → replaced with `?` per key for display
 * and storage; path retained", and that applies wherever a URL is captured,
 * not only under the keys a request span happens to use.
 *
 * The suffix rule in {@link isUrlAttributeKey} does not reach it: the key ends
 * in `source`, not in `url`. Naming it explicitly is the whole fix, and it is
 * spelled exactly as `../schema/attributes.ts` declares it in
 * `ERROR_ATTRIBUTE_KEYS` — a tie asserted by the colocated tests rather than
 * by an import, because this module deliberately imports nothing but
 * `./rules.js` so the page agent can bundle it.
 *
 * `redactor.ts` dispatches on {@link isUrlAttributeKey}, which also accepts
 * the conventional suffixes, and treats these keys as exempt from preview
 * truncation so a URL stays readable end to end — which `error.source` needs
 * too, since the source-map resolution route reads the whole value.
 */
export const URL_ATTRIBUTE_KEYS = [
  'url',
  'http.url',
  'http.target',
  'target',
  'error.source',
] as const;

/**
 * The decomposition of a URL-ish string, byte-faithful by construction.
 *
 * `path` is always present and may be empty (`http://host` has no path).
 * `query` and `fragment` distinguish *absent* from *present but empty*:
 * `undefined` means the delimiter was not there, `""` means it was and nothing
 * followed it. That distinction is what lets {@link formatUrlParts} reproduce
 * its input exactly, and the round-trip is this parser's correctness proof.
 *
 * `scheme` is set only when the value carried a `scheme://` authority marker,
 * so `mailto:someone@example.test` is a path, not a scheme plus a path —
 * masking never has to guess at a scheme-specific syntax it does not model.
 */
export interface UrlParts {
  /** Scheme without the `:`, verbatim, only when an authority followed it. */
  scheme?: string;
  /** Everything before the authority's `@`, verbatim; may be empty. */
  userinfo?: string;
  /** Host verbatim — never lower-cased. May be empty (`file:///tmp/x`). */
  host?: string;
  /** Port digits without the `:`; may be empty. */
  port?: string;
  /** Path including its leading `/` when it had one; always present. */
  path: string;
  /** Query without the `?`; `undefined` when there was no `?`. */
  query?: string;
  /** Fragment without the `#`; `undefined` when there was no `#`. */
  fragment?: string;
}

/**
 * Locates the `:` that introduces a port inside an authority's host part.
 *
 * A bracketed IPv6 literal contains colons of its own, so the search starts
 * after the closing bracket; anything else uses the last colon, which is the
 * only reading under which `host:port` and a bracket-less IPv6 address both
 * round-trip.
 *
 * @returns The index of the port colon, or `-1` when there is none.
 */
function findPortColon(hostAndPort: string): number {
  if (hostAndPort.startsWith('[')) {
    const close = hostAndPort.indexOf(']');
    return close < 0 ? -1 : hostAndPort.indexOf(':', close + 1);
  }
  return hostAndPort.lastIndexOf(':');
}

/**
 * Decomposes a URL-ish string into its components without normalising any of
 * them.
 *
 * The algorithm is the one the URL grammar implies, applied in the order the
 * delimiters bind: the first `#` ends everything before the fragment (so a `?`
 * inside a fragment stays in the fragment, as an SPA route's query does), the
 * first `?` then ends the path, and only then is an authority looked for —
 * either a leading `//` (protocol-relative) or a `scheme://` prefix whose
 * scheme satisfies {@link SCHEME_PATTERN}. Within the authority the **last**
 * `@` separates the userinfo, matching the URL standard, and the port is split
 * per {@link findPortColon}.
 *
 * Total: every string decomposes, and a value with no recognisable structure
 * becomes a bare {@link UrlParts.path}. Nothing throws.
 *
 * @param value Any string, including an empty one.
 * @returns The decomposition; `formatUrlParts(parseUrlParts(v)) === v` holds
 * for every `v`.
 */
export function parseUrlParts(value: string): UrlParts {
  let rest = value;
  let fragment: string | undefined;
  let query: string | undefined;

  const hash = rest.indexOf('#');
  if (hash >= 0) {
    fragment = rest.slice(hash + 1);
    rest = rest.slice(0, hash);
  }

  const question = rest.indexOf('?');
  if (question >= 0) {
    query = rest.slice(question + 1);
    rest = rest.slice(0, question);
  }

  let scheme: string | undefined;
  let authorityStart = -1;
  if (rest.startsWith('//')) {
    authorityStart = 2;
  } else {
    const marker = rest.indexOf('://');
    if (marker > 0 && SCHEME_PATTERN.test(rest.slice(0, marker))) {
      scheme = rest.slice(0, marker);
      authorityStart = marker + 3;
    }
  }

  const parts: UrlParts = { path: rest };

  if (authorityStart >= 0) {
    const pathStart = rest.indexOf('/', authorityStart);
    const authority =
      pathStart < 0 ? rest.slice(authorityStart) : rest.slice(authorityStart, pathStart);
    parts.path = pathStart < 0 ? '' : rest.slice(pathStart);
    if (scheme !== undefined) {
      parts.scheme = scheme;
    }

    const at = authority.lastIndexOf('@');
    const hostAndPort = at < 0 ? authority : authority.slice(at + 1);
    if (at >= 0) {
      parts.userinfo = authority.slice(0, at);
    }

    const colon = findPortColon(hostAndPort);
    if (colon >= 0 && PORT_PATTERN.test(hostAndPort.slice(colon + 1))) {
      parts.host = hostAndPort.slice(0, colon);
      parts.port = hostAndPort.slice(colon + 1);
    } else {
      parts.host = hostAndPort;
    }
  }

  if (query !== undefined) {
    parts.query = query;
  }
  if (fragment !== undefined) {
    parts.fragment = fragment;
  }
  return parts;
}

/**
 * Reassembles a URL from its components — the exact inverse of
 * {@link parseUrlParts} for any value that function produced, and the
 * serialiser {@link redactUrl} emits through, so masking can never reshape a
 * component it did not mean to touch.
 *
 * The authority marker `//` is emitted whenever any authority component is
 * present, which is what makes a protocol-relative value (host but no scheme)
 * and an authority-less relative value (neither) both come back unchanged.
 *
 * @param parts Components to serialise; only `path` is required.
 */
export function formatUrlParts(parts: UrlParts): string {
  const hasAuthority =
    parts.scheme !== undefined ||
    parts.userinfo !== undefined ||
    parts.host !== undefined ||
    parts.port !== undefined;

  let output = '';
  if (parts.scheme !== undefined) {
    output += `${parts.scheme}:`;
  }
  if (hasAuthority) {
    output += '//';
  }
  if (parts.userinfo !== undefined) {
    output += `${parts.userinfo}@`;
  }
  if (parts.host !== undefined) {
    output += parts.host;
  }
  if (parts.port !== undefined) {
    output += `:${parts.port}`;
  }
  output += parts.path;
  if (parts.query !== undefined) {
    output += `?${parts.query}`;
  }
  if (parts.fragment !== undefined) {
    output += `#${parts.fragment}`;
  }
  return output;
}

/** A query split into pairs, with the flag that says whether any were cut. */
interface QuerySegments {
  /** Pairs in arrival order, at most {@link MAX_QUERY_PAIRS} of them. */
  readonly pairs: Array<[string, string | undefined]>;
  /** `true` when at least one further non-empty segment existed. */
  readonly overflow: boolean;
}

/**
 * Splits a query into pairs, capping the work and reporting whether it capped.
 *
 * Implemented as an index walk rather than `String.prototype.split` so that a
 * pathological query costs `O(cap)` segments of work instead of allocating one
 * array entry per `&` in a value that may be megabytes long.
 */
function splitQueryPairs(query: string): QuerySegments {
  const pairs: Array<[string, string | undefined]> = [];
  let overflow = false;
  let cursor = 0;

  while (cursor <= query.length) {
    const ampersand = query.indexOf('&', cursor);
    const end = ampersand < 0 ? query.length : ampersand;

    // Empty segments (`a=1&&b=2`, a leading or trailing `&`) carry no
    // parameter and are dropped rather than rendered as a nameless pair.
    if (end > cursor) {
      if (pairs.length >= MAX_QUERY_PAIRS) {
        overflow = true;
        break;
      }
      const segment = query.slice(cursor, end);
      const equals = segment.indexOf('=');
      pairs.push(
        equals < 0 ? [segment, undefined] : [segment.slice(0, equals), segment.slice(equals + 1)],
      );
    }

    if (ampersand < 0) {
      break;
    }
    cursor = ampersand + 1;
  }

  return { pairs, overflow };
}

/**
 * Splits a query string into `[key, value]` pairs, raw and in arrival order.
 *
 * Nothing is decoded and nothing is reordered: the pairs are slices of the
 * input, which is what `./request-key.ts` needs in order to canonicalise
 * deterministically and what masking needs in order to re-emit keys exactly as
 * they arrived. Splitting a segment on its **first** `=` only means `a=b=c`
 * yields `["a", "b=c"]`, matching how servers read it.
 *
 * A segment with no `=` is a bare flag and yields `undefined` rather than
 * `""`, so a caller can tell `?flag` from `?flag=`. Empty segments are
 * dropped. At most {@link MAX_QUERY_PAIRS} pairs come back; the remainder is
 * reported to callers inside this module and marked in
 * {@link redactQueryString}'s output.
 *
 * @param query Query string **without** the leading `?`.
 * @returns Pairs in arrival order; empty for an empty query.
 */
export function parseQueryPairs(query: string): Array<[string, string | undefined]> {
  return splitQueryPairs(query).pairs;
}

/**
 * Decodes one `application/x-www-form-urlencoded` component: `+` becomes a
 * space, then percent escapes are decoded.
 *
 * Malformed input (`%zz`, a trailing `%`, a lone surrogate escape) makes
 * `decodeURIComponent` throw a `URIError`; this returns its input unchanged
 * instead, because a captured URL is untrusted text and losing a whole
 * telemetry batch to one malformed parameter would be absurd. The `+`
 * substitution is applied either way, so the function is deterministic and its
 * result is always a valid canonicalisation input.
 *
 * It lives in this module so that masking and keying share one decoding
 * policy: `a%20b`, `a+b` and `a b` must canonicalise identically for duplicate
 * detection, and that is only true while a single implementation decides it.
 *
 * @param raw Raw key or value slice, as {@link parseQueryPairs} returned it.
 */
export function decodeQueryComponent(raw: string): string {
  const spaced = raw.includes('+') ? raw.replaceAll('+', ' ') : raw;
  try {
    return decodeURIComponent(spaced);
  } catch {
    return spaced;
  }
}

/** Renders one parsed pair in its masked form. */
function renderMaskedPair(pair: readonly [string, string | undefined]): string {
  // The key is emitted as it arrived — never decoded, never re-encoded — but
  // it does pass through `scrub`, because a credential is perfectly capable of
  // arriving as a bare flag (`?<token>`) or as a parameter *name*. `scrub`
  // leaves an ordinary key untouched, cannot introduce `&`, `=` or `?`, and is
  // idempotent, so the masked query re-parses to exactly these pairs.
  const key = scrub(pair[0]);
  const value = pair[1];
  if (value === undefined) {
    return key;
  }
  // `a=` carries no data, so the empty value is preserved verbatim: masking it
  // would invent a value that was never sent.
  return value.length === 0 ? `${key}=` : `${key}=${REDACTION_MASK}`;
}

/** A masked query, with the flag that says whether anything was dropped. */
interface MaskedQuery {
  /** The masked query string, without the leading `?`. */
  readonly text: string;
  /** `true` when a pair was dropped and the marker segment was appended. */
  readonly truncated: boolean;
}

/**
 * Masks a query and bounds the result, marking the cut when it makes one.
 *
 * The truncation point is chosen so the result is a **fixed point**: pairs are
 * only ever dropped whole, and the remainder is signalled by one trailing bare
 * `[redacted]` segment. Re-running this function over its own output therefore
 * reproduces it — the emitted pairs re-parse to themselves (a `?` value masks
 * to `?`, an empty value stays empty, a bare key scrubs to itself), the marker
 * segment re-parses as a bare key that scrubs to itself, and the counts and
 * lengths that decided the cut are unchanged. Both budgets reserve nothing for
 * the marker, which is safe in either direction: if the marker segment fits on
 * the second pass it is emitted as an ordinary pair, and if it does not it is
 * dropped and re-appended — the same string.
 */
function buildMaskedQuery(query: string): MaskedQuery {
  const { pairs, overflow } = splitQueryPairs(query);
  // When pairs were already dropped, one slot is spent on the marker segment
  // so that the output has at most MAX_QUERY_PAIRS segments in total and the
  // second pass sees no overflow.
  const limit = overflow ? MAX_QUERY_PAIRS - 1 : MAX_QUERY_PAIRS;

  const rendered: string[] = [];
  let length = 0;
  let truncated = overflow;

  for (const pair of pairs) {
    if (rendered.length >= limit) {
      truncated = true;
      break;
    }
    const text = renderMaskedPair(pair);
    const added = (rendered.length === 0 ? 0 : 1) + text.length;
    if (length + added > MAX_QUERY_LENGTH) {
      truncated = true;
      break;
    }
    rendered.push(text);
    length += added;
  }

  const prefix = rendered.join('&');
  if (!truncated) {
    return { text: prefix, truncated: false };
  }
  return {
    text: prefix.length === 0 ? REDACTION_MARKER : `${prefix}&${REDACTION_MARKER}`,
    truncated: true,
  };
}

/**
 * Masks every query parameter value while keeping the parameter names and
 * their order.
 *
 * `productId=42&limit=20` becomes `productId=?&limit=?`. A bare flag stays
 * bare, an explicitly empty value stays empty, a repeated key is masked once
 * per occurrence (never collapsed), and nothing is decoded or re-encoded. A
 * query beyond {@link MAX_QUERY_PAIRS} pairs, or beyond the internal length
 * budget, is cut at a pair boundary and ends with {@link REDACTION_MARKER}; no
 * text is ever returned unexamined.
 *
 * Idempotent: masking a masked query returns it unchanged.
 *
 * **Never throws**, for any input of any type: this is a redaction entry point,
 * so a query that is not a string is coerced by `asScannableText` rather than
 * rejected — see the module documentation for why the parsers do not do the
 * same.
 *
 * @param query Query string **without** the leading `?`. A number, bigint or
 * boolean is rendered by its canonical text; anything else that is not a string
 * becomes {@link REDACTION_MARKER}, per `asScannableText`.
 * @returns The masked query, without a leading `?`; `""` for an empty query.
 */
export function redactQueryString(query: unknown): string {
  return buildMaskedQuery(asScannableText(query)).text;
}

/**
 * Scrubs `text` by content and holds the result to `limit` code units.
 *
 * The cut is safe to re-apply: cutting a scrubbed string cannot expose new
 * credential material (none of the deny-list patterns is anchored, so anything
 * that matches a prefix matched the whole and was already replaced) and
 * appending the marker cannot create a match, so the result is a fixed point
 * of `scrub` and short enough that a second call does not cut again.
 *
 * The cut nevertheless goes through `cutAtCredentialBoundary` rather than a
 * plain slice. That argument holds only because `scrub` runs *first* here, and
 * it is exactly the kind of ordering that a later change reverses without
 * noticing; routing every cut in this module through the one primitive means
 * the guarantee does not rest on the order of two lines. It also keeps the
 * path and query budgets cutting by the same rule as the scan bound, so a
 * truncated URL reads the same wherever the cut fell.
 */
function boundedScrub(text: string, limit: number): string {
  const cleaned = scrub(text);
  if (cleaned.length <= limit) {
    return cleaned;
  }
  const room = limit - REDACTION_MARKER.length;
  return cutAtCredentialBoundary(cleaned, room) + REDACTION_MARKER;
}

/**
 * Whether a decomposition carries enough structure to be treated as a URL.
 *
 * Anything with an authority, a query, a fragment or an absolute path is
 * reshaped component by component. Anything else — a bare word, a sentence, a
 * blob of binary junk — has no components to mask and goes through
 * {@link scrub} instead. The two treatments coincide for a relative path with
 * no query, which is why the test is deliberately this coarse.
 */
function isUrlShaped(parts: UrlParts): boolean {
  return (
    parts.host !== undefined ||
    parts.query !== undefined ||
    parts.fragment !== undefined ||
    parts.path.startsWith('/')
  );
}

/**
 * Appends the overflow marker as a trailing bare query segment, unless the
 * query already ends with one.
 *
 * Appending to the *query* rather than to the end of the whole URL is what
 * keeps the result stable: a marker appended after a masked fragment would be
 * re-read as fragment text and masked again on the next pass, whereas a bare
 * query segment re-parses as a key that scrubs to itself.
 */
function withOverflowSegment(query: string | undefined): string {
  if (query === undefined || query.length === 0) {
    return REDACTION_MARKER;
  }
  if (query === REDACTION_MARKER || query.endsWith(`&${REDACTION_MARKER}`)) {
    return query;
  }
  return `${query}&${REDACTION_MARKER}`;
}

/**
 * Redacts a URL for storage, display and outbound prompts.
 *
 * What is kept, and why:
 *
 * - **Scheme, host and port** — verbatim, never lower-cased, never
 *   re-serialised. They identify the tier being called and carry no user data.
 * - **Path** — kept, because the route *is* the diagnosis, but passed through
 *   `scrub`: a token can sit in a path segment (a password-reset link, a
 *   signed download). Path segments are never masked wholesale.
 * - **Query parameter names and their order** — kept; every non-empty value
 *   becomes `?`. Which parameters were sent, and how many times, is what
 *   duplicate-request analysis reads; the values are exactly what must not be
 *   stored.
 * - **Fragment** — a non-empty fragment becomes `?` with the `#` kept, because
 *   client-side routing state and, occasionally, an implicit-flow token live
 *   there. An empty fragment (`#`) is preserved as sent.
 * - **Userinfo** — replaced whole with `[redacted]`, keeping the `@` so the
 *   topology stays visible: `scheme://userinfo@host:5432/db` comes back as
 *   `scheme://[redacted]@host:5432/db`. Connection strings really do reach
 *   span attributes, and this is deliberately the same shape `rules.ts`
 *   produces for its `connection-string` rule, so a URL redacted here and a
 *   connection string scrubbed there look identical; the two must be kept
 *   consistent if either changes. An empty userinfo (`//@host`) has nothing to
 *   hide and is preserved.
 *
 * **Bounds.** Input beyond `MAX_SCAN_LENGTH` is not examined, and the
 * remainder is replaced by `[redacted]` instead of being passed through; the
 * authority, path and query each have their own budget. The returned string is
 * therefore never longer than `MAX_SCAN_LENGTH`, which is what keeps a second
 * call on the unbounded path.
 *
 * **No credential is split by a bound.** Every cut goes through
 * `cutAtCredentialBoundary`, never a plain slice. A plain cut is made *before*
 * any pattern can run, so a credential straddling the bound loses the run that
 * identifies it and keeps the head that reveals it — and that head then
 * survives as a stored path segment or query key, because `scrub` has nothing
 * left to match it against. Cutting at the credential's start instead is what
 * makes the marker mean *nothing examined here* rather than *the first
 * characters of something*.
 *
 * **Fallback.** A value with no URL structure at all (no authority, no query,
 * no fragment, no absolute path) is returned as `scrub(value)` — pattern
 * cleaned, never raw — because there is nothing to mask positionally but the
 * content rules still apply.
 *
 * **Idempotence.** `redactUrl(redactUrl(v)) === redactUrl(v)` for every input.
 * Each component of the output is a fixed point of its own treatment (`?`
 * masks to `?` and never to `??` or `%3F`, `[redacted]` scrubs to itself, a
 * cut path and a marker query segment both survive re-parsing unchanged), and
 * because the output is always within every bound, the second pass takes the
 * unbounded path and reproduces the first.
 *
 * **Never throws**, for any input of any type. A URL reaches this function from
 * a parsed JSON event body, an OpenTelemetry span attribute or a page's own
 * `fetch` argument, none of which guarantees a string, and a privacy boundary
 * that threw on the value it was meant to redact would take the whole batch
 * with it. Coercion is `asScannableText`'s single policy rather than one
 * invented here, so a non-string URL, header value and SQL statement all come
 * back in the same vocabulary.
 *
 * @param value Absolute, origin-relative, protocol-relative, bare-relative
 * or malformed URL text, as captured from a fetch, XHR or span attribute. A
 * value of any other type is normalised by `asScannableText` first: a number,
 * bigint or boolean keeps its canonical text as evidence, and anything else
 * (`null`, `undefined`, an object, an array, a function, a symbol) becomes
 * {@link REDACTION_MARKER} without a single property of it being read.
 * @returns The redacted URL.
 */
export function redactUrl(value: unknown): string {
  const text = asScannableText(value);
  if (text.length === 0) {
    return text;
  }

  // `overLength` decides whether a marker is appended; `scanned` decides what
  // is examined. They are computed separately because a boundary-aware cut may
  // fall short of `MAX_SCAN_LENGTH` — the loss still has to be reported.
  const overLength = text.length > MAX_SCAN_LENGTH;
  const scanned = cutAtCredentialBoundary(text, MAX_SCAN_LENGTH);
  const parts = parseUrlParts(scanned);

  if (!isUrlShaped(parts)) {
    // Room is reserved for the marker only when one is going to be appended,
    // so an ordinary value is never shortened.
    const limit = overLength ? MAX_SCAN_LENGTH - REDACTION_MARKER.length : MAX_SCAN_LENGTH;
    const cleaned = boundedScrub(scanned, limit);
    return overLength ? cleaned + REDACTION_MARKER : cleaned;
  }

  const authorityLength =
    (parts.userinfo?.length ?? 0) + (parts.host?.length ?? 0) + (parts.port?.length ?? 0);
  if (authorityLength > MAX_AUTHORITY_LENGTH) {
    // Nothing about such a value is diagnosable, and a cut authority could
    // strip the `@` that makes a credential recognisable, so the authority and
    // everything after it are dropped. The result re-parses to itself: the
    // marker becomes the whole host.
    return `${parts.scheme === undefined ? '' : `${parts.scheme}:`}//${REDACTION_MARKER}`;
  }

  const masked = parts.query === undefined ? undefined : buildMaskedQuery(parts.query);
  const truncated = overLength || (masked?.truncated ?? false);

  const output: UrlParts = { path: boundedScrub(parts.path, MAX_PATH_LENGTH) };
  if (parts.scheme !== undefined) {
    output.scheme = parts.scheme;
  }
  if (parts.userinfo !== undefined) {
    output.userinfo = parts.userinfo.length === 0 ? '' : REDACTION_MARKER;
  }
  if (parts.host !== undefined) {
    output.host = parts.host;
  }
  if (parts.port !== undefined) {
    output.port = parts.port;
  }

  if (truncated) {
    // Everything after the truncation point is gone, the fragment included:
    // it sits past the query in the value, so keeping it would report state
    // that was never examined.
    output.query = withOverflowSegment(masked?.text);
  } else {
    if (masked !== undefined) {
      output.query = masked.text;
    }
    if (parts.fragment !== undefined) {
      output.fragment = parts.fragment.length === 0 ? '' : REDACTION_MASK;
    }
  }

  return formatUrlParts(output);
}

/**
 * An `http`/`https` URL embedded in surrounding text.
 *
 * The run stops at whitespace, at a quote and at an angle bracket, none of
 * which can appear in a URL a runtime prints, and deliberately *not* at a
 * closing parenthesis: `(` and `)` are legal path characters and a V8 frame
 * wraps its URL in parentheses, so {@link maskFrameUrl} decides afterwards
 * whether a closing bracket can be told apart from the URL (see
 * {@link FRAME_TRAILING_PATTERN}) rather than guessing at it here.
 *
 * Only `http` and `https` are matched, in any letter case — a scheme is
 * case-insensitive, so `HTTP://` and `Https://` are the same URL and must not
 * keep their parameter values for being spelled differently. Every other
 * scheme a bundler emits — `webpack-internal:///`, `turbopack:///`, `file://`,
 * `node:` — is either a module identifier with no query string or a path this
 * module has nothing to mask in, and
 * `packages/code-analysis/src/source-map/resolver.ts` restricts its own frame
 * grammar to `http`/`https` for the same reason. Leaving them untouched keeps
 * a frame that resolves to source byte-identical.
 *
 * Global, and therefore used only with `replace`, which resets `lastIndex`
 * around every call.
 */
const STACK_URL_PATTERN = /https?:\/\/[^\s"'<>`]+/gi;

/**
 * The `:line` or `:line:column` position a runtime appends directly to a
 * frame's URL, anchored at the end of the run.
 *
 * Digits are bounded so a long numeric tail cannot be read as a position.
 */
const FRAME_POSITION_PATTERN = /(?::\d{1,9}){1,2}$/;

/**
 * Characters that may follow a URL in stack text rather than belong to it: the
 * closing bracket of a V8 frame, a quote, and ordinary sentence punctuation.
 *
 * "May", because every one of them is also a legal query-value character:
 * `/reset?code=);` is a value of `);`, not a value of nothing followed by a
 * sentence ending. {@link maskFrameUrl} therefore peels this run off only
 * where doing so cannot keep data — a URL with no query and no fragment, whose
 * path is kept anyway, and a stack frame whose runtime-appended position sits
 * between the URL and the bracket — and otherwise masks it with the last value
 * or fragment it may belong to.
 *
 * `?` is **not** in the set. A trailing `?` is a query delimiter, and peeling
 * it would hand {@link redactUrl} a URL whose query it can no longer see.
 */
const FRAME_TRAILING_PATTERN = /[)\]}>,;'".]+$/;

/**
 * What must precede a URL for the text around it to be a **stack frame**
 * rather than prose that happens to contain a URL.
 *
 * Both engine forms are recognised, tested against the text from the start of
 * the line up to the URL:
 *
 * - V8 / JavaScriptCore: `    at fn (‹url›:42:17)`, `    at ‹url›:42:17`,
 *   `    at new Fn (‹url›…)`, `    at async fn (‹url›…)` — the `at` token,
 *   matched as a word so "look at" in a log line is not mistaken for it (a
 *   false positive costs only a preserved position, never a value).
 * - SpiderMonkey / WebKit: `fn@‹url›:42:17` — the `@` immediately before.
 *
 * Why the distinction matters: inside a frame, the trailing `:line:column` was
 * appended by the runtime, which is exactly the assumption
 * `packages/code-analysis/src/source-map/resolver.ts` makes when it reads a
 * frame, so the position can be detached before masking and re-attached after
 * it. In arbitrary text nothing licenses that reading, and the conservative
 * treatment applies instead.
 */
const FRAME_CONTEXT_PATTERN = /(?:^|[\s(])at\s|@$/;

/**
 * Cuts masked stack text to {@link MAX_SCAN_LENGTH} and reports the loss on a
 * line of its own.
 *
 * The marker goes on a **new line** rather than at the end of the last one.
 * A stack is line-oriented, so the truncation reads as its own frame — but the
 * load-bearing reason is idempotence: {@link STACK_URL_PATTERN} runs up to
 * whitespace, so a marker appended directly after a cut URL would be re-read
 * as part of that URL's query on the next pass and masked away, and the second
 * pass would return something different from the first. A newline terminates
 * the run, and the marker alone matches no pattern here.
 *
 * The text being cut has already had its URLs masked, so the cut itself cannot
 * expose data — wherever it falls, what remains is a host, a path, a bare
 * parameter name or a mask, each of which is a fixed point of
 * {@link redactUrl}. The cut nevertheless goes through
 * `cutAtCredentialBoundary` like every other cut in this module.
 */
function truncatedStack(masked: string): string {
  // One code unit is reserved for the separator on top of the marker's own.
  const room = Math.max(0, MAX_SCAN_LENGTH - REDACTION_MARKER.length - 1);
  return `${cutAtCredentialBoundary(masked, room)}\n${REDACTION_MARKER}`;
}

/**
 * Masks one URL run found in stack text, keeping the frame's position and
 * closing bracket when they can be told apart from the URL's own data.
 *
 * A frame is `at fn (‹url›:‹line›:‹column›)`, appended by the runtime with no
 * delimiter, so the position and the bracket after it are only recoverable by
 * shape. Both are detached before masking and re-attached after it in two
 * cases:
 *
 * 1. **The URL carries no query and no fragment.** Nothing after the path is
 *    masked, so detaching cannot keep data: a trailing `:digits:digits` and
 *    any punctuation after it come back as they were, and so does the whole
 *    run.
 * 2. **The run sits in a recognised stack frame**
 *    ({@link FRAME_CONTEXT_PATTERN}) **and ends in a position** — then the
 *    runtime appended the position, which is exactly how
 *    `packages/code-analysis/src/source-map/resolver.ts` reads the same text,
 *    and AAP 0.4.2 requires that route to map a generated-chunk frame back to
 *    TypeScript. A dev-server chunk URL almost always carries a
 *    cache-busting query, so dropping the position here would disable source
 *    resolution for the common case. The brackets after the position are the
 *    frame's own (`at fn (‹url›?v=?:10:5)` keeps `:10:5)`). The residual risk
 *    is a query value that itself ends in `:digits:digits`, of which at most
 *    two short numeric groups would be kept — digits only, never an
 *    identifier — and only inside text a runtime wrote as a frame.
 *
 * Otherwise — a URL with a query or a fragment in prose, in a log line, in a
 * frame with no position — nothing separates the last value from what follows
 * it: `/reset?code=);` is the value `);`, and `?v=1:10:5` is both "the chunk
 * `?v=1` at 10:5" and "the value `1:10:5`". So the whole run, trailing
 * punctuation and any position included, goes through {@link redactUrl}, and
 * whatever might be part of the last value or fragment is masked with it. A
 * bracket or a full stop lost that way costs the text one character; one kept
 * that way would have been a value.
 *
 * @param candidate The matched URL run.
 * @param offset Where the run starts in `whole`, supplied by `replace`.
 * @param whole The stack text being masked, used only to read the frame
 * context on the run's own line.
 */
function maskFrameUrl(candidate: string, offset: number, whole: string): string {
  // `scrub` runs before this function on the redaction path and may have cut
  // the text mid-URL, appending its marker with nothing between. The marker is
  // this layer's own token, so it is lifted out rather than read as query
  // text — and it comes back on a line of its own, where a later pass cannot
  // absorb it into the URL it was cut from.
  const cut = candidate.endsWith(REDACTION_MARKER);
  const body = cut ? candidate.slice(0, candidate.length - REDACTION_MARKER.length) : candidate;
  const suffix = cut ? `\n${REDACTION_MARKER}` : '';

  const trailing = FRAME_TRAILING_PATTERN.exec(body)?.[0] ?? '';
  const url = trailing.length === 0 ? body : body.slice(0, body.length - trailing.length);
  const position = FRAME_POSITION_PATTERN.exec(url)?.[0] ?? '';
  const head = url.slice(0, url.length - position.length);
  const parts = parseUrlParts(head);
  if (parts.query === undefined && parts.fragment === undefined) {
    return redactUrl(head) + position + trailing + suffix;
  }

  if (position.length > 0) {
    // The URL carries a query or a fragment, so the position is only
    // distinguishable from that text by the frame it sits in.
    const lineStart = whole.lastIndexOf('\n', Math.max(0, offset - 1)) + 1;
    if (FRAME_CONTEXT_PATTERN.test(whole.slice(lineStart, offset))) {
      return redactUrl(head) + position + trailing + suffix;
    }
  }
  return redactUrl(body) + suffix;
}

/**
 * Redacts every URL embedded in stack text, leaving the frames around them
 * intact.
 *
 * A call-site stack is captured for two attributes — a request's `initiator`
 * and an error's `error.stack` — and both are read end to end: the initiator
 * is what duplicate-request analysis attributes a request to, and the
 * source-map resolution route maps a generated-chunk frame back to
 * TypeScript (AAP 0.4.2). They are therefore exempt from the preview bound in
 * `redactor.ts`, which means a frame's URL travels whole, and a dev-server
 * chunk URL carries a query string like any other request URL. Scrubbing by
 * content does not touch a query value — that is positional, and only this
 * module can see it — so before this function existed every parameter inside
 * a frame's URL was stored, broadcast and sent to the model provider, under
 * keys the privacy model had already ruled on everywhere else (AAP 0.5.2).
 *
 * What is kept is what a stack is for: `at`, the function names, the
 * indentation, the parentheses, the frame order, and each frame's file and
 * position. What changes is inside the URLs, and by exactly the rules
 * {@link redactUrl} applies to a request URL — query values masked, path and
 * authority kept. Punctuation directly after a URL that carries a query or a
 * fragment is masked with its last value unless a frame position separates
 * the two (see {@link maskFrameUrl}): `https://x.test/a?b=1).` becomes
 * `https://x.test/a?b=?`, while `at fn (https://x.test/a.js?v=1:10:5)` becomes
 * `at fn (https://x.test/a.js?v=?:10:5)`.
 *
 * Content scrubbing is **not** performed here: the caller in `redactor.ts`
 * runs `scrub` first (and must, since cutting before scrubbing can split a
 * credential), and this function's single job is the positional masking that
 * `scrub` cannot do.
 *
 * **Idempotent.** Every component of the output is a fixed point of its own
 * treatment: `redactUrl` is idempotent, a masked query re-parses to itself, a
 * re-attached position re-detaches to the same place, punctuation peeled off a
 * URL is re-appended verbatim and punctuation masked with a value stays
 * masked. The result is bounded, so a second pass takes the same path as the
 * first.
 *
 * **Never throws**, for any input of any type, like every other entry point
 * here: a stack reaches this function from a parsed JSON event body, where
 * nothing has checked that it is a string.
 *
 * @param value Stack text, as captured by `../browser/fetch.ts` or
 * `../browser/errors.ts`. A non-string value is normalised by
 * `asScannableText` first.
 * @returns The stack with every embedded `http`/`https` URL redacted.
 */
export function redactStackUrls(value: unknown): string {
  const text = asScannableText(value);
  if (text.length === 0) {
    return text;
  }

  // Nothing past the bound is examined, and an unexamined frame is reported as
  // removed rather than passed through — the rule `scrub` applies to any
  // over-long value. The masked result can also come back marginally longer
  // than what went in (a short `userinfo` becomes the ten-character marker),
  // and a result over the bound would be cut again on the next pass, so both
  // cases take the same exit.
  const overLength = text.length > MAX_SCAN_LENGTH;
  const scanned = overLength ? cutAtCredentialBoundary(text, MAX_SCAN_LENGTH) : text;
  const masked = scanned.replace(STACK_URL_PATTERN, maskFrameUrl);

  if (!overLength && masked.length <= MAX_SCAN_LENGTH) {
    return masked;
  }
  return truncatedStack(masked);
}

/**
 * A query carried inside free text: a `?`, then a run up to the first
 * whitespace, quote, angle bracket or backtick (the delimiters of
 * {@link STACK_URL_PATTERN}) that holds at least one `name=value` pair before
 * any `#`, then the fragment that follows it, if any.
 *
 * The first `=` must come before a second `?`, so `Why? a=b` or `a?b?c=1`
 * anchor the match at the `?` that actually opens the pairs. A `?` with no pair
 * after it — `Why?`, `?flag` — carries no value and is not matched.
 *
 * The whole run is the query. Nothing at its end is set aside as sentence
 * punctuation: `)`, `]`, `,`, `;`, `.` and `!` are all legal in a query value,
 * so `/reset?code=!!!!` carries the value `!!!!` and a run that ends in them
 * may end in data. {@link maskTextQuery} masks them with the value they may
 * belong to.
 *
 * Global, and therefore used only with `replace`, which resets `lastIndex`
 * around every call.
 */
const TEXT_QUERY_PATTERN = /\?[^\s"'<>`?#=]*=[^\s"'<>`#]*(?:#[^\s"'<>`]*)?/g;

/**
 * Masks the text that follows a query's `?`: every value becomes
 * {@link REDACTION_MASK} through {@link redactQueryString}, and a fragment
 * after the first `#` becomes the mask too when it is non-empty (an empty one
 * is kept, as {@link redactUrl} keeps it). Keys, their order and the
 * delimiters survive; nothing of the text is returned unexamined.
 *
 * Idempotent: every piece of its output re-masks to itself.
 */
function maskQueryAndFragment(text: string): string {
  const hash = text.indexOf('#');
  const query = hash === -1 ? text : text.slice(0, hash);
  const fragment = hash === -1 ? undefined : text.slice(hash + 1);
  const maskedFragment =
    fragment === undefined ? '' : fragment.length === 0 ? '#' : `#${REDACTION_MASK}`;
  return `${redactQueryString(query)}${maskedFragment}`;
}

/**
 * Masks one query run found by {@link TEXT_QUERY_PATTERN}, the whole of it:
 * `?code=!!!!` becomes `?code=?`, and `?id=7).` becomes `?id=?`.
 */
function maskTextQuery(run: string): string {
  return `?${maskQueryAndFragment(run.slice(1))}`;
}

/**
 * An origin-relative reference carrying a query, embedded in text that may be
 * source code: a `/` that is not the start of `//`, at the start of the text
 * or directly after whitespace, a written whitespace escape or an opening
 * parenthesis (group 1); then path
 * characters, then the `?`, then everything up to the first whitespace,
 * quote, angle bracket or backtick — the delimiters of
 * {@link TEXT_QUERY_PATTERN} (group 2).
 *
 * The anchoring is what makes this safe to run over code. A regular expression
 * literal (`/^(?=\S+$)…/`) has no path character before its `?`; a ternary has
 * no `/`; a comment's `//` is excluded; and a path inside a string or template
 * literal (`'/api/x?a=1'`, `` `/x?a=${v}` ``) follows a quote, which is not an
 * anchor. A bare-relative `p?id=1` or a query-only `?id=1` is not matched
 * either: in code, both are far more often an optional-chaining or ternary
 * expression than a URL.
 *
 * A written whitespace escape — `\n`, `\r`, `\t`, `\f` or `\u000b`, as
 * `JSON.stringify` and string literals write a line break or a tab — anchors a
 * run as the whitespace it stands for does. The outbound guard reads the
 * JSON-rendered sections of a prompt that way, so a run that starts a line
 * there must be masked here too, including in a code excerpt whose string
 * literal writes `"…\n/api/x?id=1"`; the masked literal loses nothing a model
 * reasons about.
 *
 * The path class is RFC 3986's `pchar` set without the percent-escape's
 * structure, plus `/`; it excludes `?` and `#`, so the first `?` after the
 * path opens the query. Group 1 is re-emitted, because this module uses no
 * lookbehind.
 *
 * Global, and therefore used only with `replace`, which resets `lastIndex`
 * around every call.
 */
const ORIGIN_RELATIVE_PATTERN =
  /(^|[\s(]|\\(?:[nrtf]|u000[bB]))(\/(?!\/)[A-Za-z0-9._~!$&*+,;=:@%/-]*\?[^\s"'<>`]*)/g;

/**
 * Masks one run found by {@link ORIGIN_RELATIVE_PATTERN}: the anchor and the
 * path are kept, and everything after the `?` goes through
 * {@link maskQueryAndFragment} — punctuation at the end of the run included.
 */
function maskOriginRelativeRun(_match: string, anchor: string, run: string): string {
  const question = run.indexOf('?');
  return `${anchor}${run.slice(0, question + 1)}${maskQueryAndFragment(run.slice(question + 1))}`;
}

/**
 * Holds masked text to {@link MAX_SCAN_LENGTH}, reporting a cut on a line of
 * its own exactly as {@link redactStackUrls} does.
 *
 * Masking replaces values with a single character, so a result longer than
 * its input needs a query key that `redactQueryString` scrubbed into something
 * longer; the bound is enforced anyway, because it is the guarantee both text
 * maskers state and the reason their second pass never cuts again.
 */
function boundedMaskedText(masked: string): string {
  return masked.length <= MAX_SCAN_LENGTH ? masked : truncatedStack(masked);
}

/**
 * Redacts every URL embedded in text that may be **source code** or
 * model-authored prose, masking only what is unambiguously a URL.
 *
 * The context builder runs this over every string of a stage's structured
 * input — questions, summaries, code excerpts — before a prompt is rendered,
 * and code is where {@link redactTextUrls}'s over-matching stops being free:
 * it would rewrite `a?.b` guards, ternaries and regular expressions in an
 * excerpt the model is asked to reason about. So two passes run, both
 * anchored:
 *
 * 1. every absolute `http`/`https` URL, in any letter case, goes through
 *    {@link redactStackUrls} — the {@link redactUrl} treatment a request URL
 *    gets, with a stack frame's position kept;
 * 2. every origin-relative run {@link ORIGIN_RELATIVE_PATTERN} finds — a
 *    `/path?…` at the start of the text or after whitespace, a written
 *    whitespace escape (`\n`) or `(` — has every
 *    non-empty query value replaced by `?` (through {@link redactQueryString})
 *    and a non-empty fragment replaced by `?`. The whole run is masked,
 *    punctuation at its end included, so `(see /reset?code=ZIP42).` becomes
 *    `(see /reset?code=?`.
 *
 * Left unchanged: a bare-relative `p?id=1`, a query-only `?id=1`, regular
 * expression literals such as `/^(?=\S+$)(?:\S*[0-9]\S*|[^a-z]+)$/;`,
 * ternaries, and paths that follow a quote or a backtick (`'/api/x?a=1'`,
 * `` `/x?a=${v}` ``). Page text, where none of those readings exists, takes
 * {@link redactTextUrls} instead, which masks all of them.
 *
 * **The outbound guard checks a subset of this.** The embedded-URL check in
 * `packages/model-provider/src/redact-guard.ts` refuses a prompt in which a
 * URL run anchored as above — an absolute `http(s)` run, or an origin-relative
 * run at the start of the text or after whitespace, a written whitespace
 * escape or `(` — still carries an
 * unmasked query value. Every such value is one this function masks, so text
 * that went through it passes that check. The two agree by convention — no
 * import edge joins the packages — and each side's tests state the shared
 * cases.
 *
 * Content scrubbing is **not** performed here: a caller runs `scrub` first,
 * so a credential is replaced by pattern before its position in a URL is
 * considered.
 *
 * **Bounded, idempotent and total.** The result is never longer than
 * {@link MAX_SCAN_LENGTH} (input past the bound is reported as removed, on a
 * line of its own, as {@link redactStackUrls} reports it); a masked run
 * re-masks to itself, so a second pass returns its input; and nothing throws,
 * for any input of any type (`asScannableText` normalises a non-string).
 *
 * @example
 * ```ts
 * redactEmbeddedUrls('GET /reset?code=ZIP42 then https://x.test/a?b=1#top');
 * // → 'GET /reset?code=? then https://x.test/a?b=?#?'
 * redactEmbeddedUrls("const url = '/api/x?a=1'; if (a?.b) {}");
 * // → unchanged
 * ```
 *
 * @param value Text that may be code or prose, already scrubbed by content.
 * @returns The text with every anchored URL's query values and fragment
 * masked.
 */
export function redactEmbeddedUrls(value: unknown): string {
  const absolute = redactStackUrls(value);
  if (!absolute.includes('?')) {
    return absolute;
  }
  return boundedMaskedText(absolute.replace(ORIGIN_RELATIVE_PATTERN, maskOriginRelativeRun));
}

/**
 * Redacts every URL embedded in free text — a label, a selector, a sentence —
 * leaving the text around it intact.
 *
 * Page-derived strings that are not URL-valued fields still carry URLs: a link
 * whose visible text is its own address, an attribute selector such as
 * `a[href="/reset?code=…"]`, a sentence quoting `/orders?id=…`. The privacy
 * model's URL rule applies to them all (query values become `?` per key for
 * display and storage), so two passes run:
 *
 * 1. {@link redactEmbeddedUrls}, in full: every absolute `http`/`https` URL
 *    gets the {@link redactUrl} treatment a request URL gets (query values and
 *    a non-empty fragment masked, userinfo replaced, path scrubbed), and every
 *    anchored origin-relative run has its query values and fragment masked;
 * 2. every remaining query run holding a `name=value` pair
 *    ({@link TEXT_QUERY_PATTERN}) — the query of a bare relative reference or
 *    of a quoted path (`p?id=7`, `?id=7`, `href="/p?id=7"`) — has its values
 *    masked with {@link redactQueryString}, and a non-empty fragment after it
 *    becomes `?`. Keys, their order, the path and the text before the run are
 *    kept.
 *
 * Every run is masked whole: punctuation at its end is part of what it may
 * carry (`/reset?code=!!!!` is the value `!!!!`), so `See /p?id=7.` becomes
 * `See /p?id=?` and `(open /p?id=7)` becomes `(open /p?id=?`.
 *
 * Over-matching is the safe direction, as for {@link isUrlAttributeKey}: prose
 * that merely looks like `a?b=c` is masked to `a?b=?`, which loses nothing a
 * debugging question needs.
 *
 * **A superset of the outbound guard's check, and of
 * {@link redactEmbeddedUrls}.** Everything that function masks, this one masks
 * too, so text that went through either passes the embedded-URL check of
 * `packages/model-provider/src/redact-guard.ts` — by convention, with no import
 * edge between the packages.
 *
 * Content scrubbing is **not** performed here: a caller runs `scrub` first, as
 * `redactor.ts` does, so a credential is replaced by pattern before its
 * position in a query is considered.
 *
 * **Idempotent** — a masked query re-masks to itself — **bounded** to
 * {@link MAX_SCAN_LENGTH} as {@link redactEmbeddedUrls} is, and **never
 * throws**, for any input of any type (`asScannableText` normalises a
 * non-string).
 *
 * @example
 * ```ts
 * redactTextUrls('Visit /reset?coupon=SPRING and https://x.test/a?b=1#top');
 * // → 'Visit /reset?coupon=? and https://x.test/a?b=?#?'
 * redactTextUrls('a[href="/reset?code=!!!!"]');
 * // → 'a[href="/reset?code=?"]'
 * ```
 *
 * @param value Free text, already scrubbed by content.
 * @returns The text with every embedded query value and fragment masked.
 */
export function redactTextUrls(value: unknown): string {
  const embedded = redactEmbeddedUrls(value);
  if (!embedded.includes('?')) {
    return embedded;
  }
  return boundedMaskedText(embedded.replace(TEXT_QUERY_PATTERN, maskTextQuery));
}

/**
 * A whole line of stack text that is a runtime-written frame: a V8 or
 * JavaScriptCore frame, which opens with `at` after its indentation
 * (`    at fn (‹url›:10:5)`), or a SpiderMonkey or WebKit frame, which is a
 * function name, optionally followed by ` code` (`global code`), then `@` and
 * the location, with no other whitespace on the line (`fn@‹url›:10:5`).
 *
 * The whole line is classified, never a fragment of it: a message line that
 * merely contains `@https://…` has whitespace before its `@` and is not a
 * frame. Every other line of a stack — the thrown error's message, which is
 * how a stack begins, and any continuation of it — is text the page wrote.
 */
const STACK_FRAME_LINE_PATTERN = /^\s*at\s|^[^\s@]*(?: code)?@[A-Za-z][A-Za-z0-9+.-]*:\S*$/;

/**
 * The punctuation a frame closes its location with after the position: the
 * `)` of `at fn (‹url›:10:5)`, and the brackets and separators an engine or a
 * producer's own formatting may add.
 */
const FRAME_CLOSING_PATTERN = /[)\]}>,;'".]*$/;

/**
 * Masks one query run found on a frame line, keeping the frame's position.
 *
 * On a frame line, the `:line:column` directly after a URL was appended by the
 * runtime, and the source-map route reads it; the free-text pass would take it
 * as part of the last value (`?v=?:10:5)` is the value `?:10:5)` to it). So the
 * closing punctuation and a trailing position are set aside, the query before
 * them is masked by {@link maskTextQuery}, and the two are re-attached. What is
 * kept is digits and closing punctuation only, never an identifier: a
 * bare-relative frame `at h (src/a.ts?code=ZIP42:3:4)` becomes
 * `at h (src/a.ts?code=?:3:4)`. The residual risk is the one
 * {@link maskFrameUrl} states: a query value that itself ends in
 * `:digits:digits`, of which at most two short numeric groups are kept, on a
 * line the runtime wrote as a frame.
 */
function maskFrameLineQuery(run: string): string {
  const closing = FRAME_CLOSING_PATTERN.exec(run)?.[0] ?? '';
  const beforeClosing = run.slice(0, run.length - closing.length);
  const position = FRAME_POSITION_PATTERN.exec(beforeClosing)?.[0] ?? '';
  if (position.length === 0) {
    return maskTextQuery(run);
  }
  const query = beforeClosing.slice(0, beforeClosing.length - position.length);
  return `${maskTextQuery(query)}${position}${closing}`;
}

/**
 * Applies the free-text query pass of {@link redactTextUrls} to one line of
 * stack text: every query run holding a `name=value` pair has its values
 * masked, on a frame line ({@link STACK_FRAME_LINE_PATTERN}) with the frame's
 * position kept ({@link maskFrameLineQuery}).
 */
function maskStackLine(line: string): string {
  return STACK_FRAME_LINE_PATTERN.test(line)
    ? line.replace(TEXT_QUERY_PATTERN, maskFrameLineQuery)
    : line.replace(TEXT_QUERY_PATTERN, maskTextQuery);
}

/**
 * Redacts every URL embedded in stack text: the frames keep their positions,
 * and the message lines are masked as free text.
 *
 * A stack attribute (`error.stack`, a fetch `initiator`, a React
 * `componentStack`) is two kinds of text on separate lines. Its frames were
 * written by the runtime, and the source-map route needs each frame's
 * `:line:column`, which only {@link redactStackUrls}'s frame treatment keeps.
 * Its first line, and any line that is not a frame, is the thrown error's
 * message, which a page writes and which quotes URLs the way any page text
 * does — `Error: failed '/reset?code=…'`, `reset?code=…`, `?code=…`. The same
 * message under `error.message` is masked by {@link redactTextUrls}, so a
 * stack must not carry it unmasked. Two passes run:
 *
 * 1. {@link redactEmbeddedUrls} over the whole text: every absolute URL is
 *    masked with a frame's position kept, and every anchored origin-relative
 *    run is masked;
 * 2. on every line, the free-text query pass of {@link redactTextUrls}: every
 *    remaining query run holding a `name=value` pair has its values masked,
 *    quoted and bare-relative references included. On a frame line the
 *    frame's trailing position survives the pass ({@link maskStackLine}); on
 *    any other line nothing but the masked run does.
 *
 * **A superset of {@link redactEmbeddedUrls}**, and therefore of the outbound
 * guard's check in `packages/model-provider/src/redact-guard.ts`, by
 * convention with no import edge. **Idempotent** — both passes are, a kept
 * position re-detaches to the same place, and neither pass changes whether a
 * line is a frame — **bounded** to
 * {@link MAX_SCAN_LENGTH} as {@link redactEmbeddedUrls} is, and **never
 * throws**, for any input of any type.
 *
 * Content scrubbing is **not** performed here: the caller in `redactor.ts`
 * runs `scrub` first.
 *
 * @example
 * ```ts
 * redactStackText("Error: failed '/reset?code=ZIP42'\n    at fn (http://x.test/a.js?v=1:10:5)");
 * // → "Error: failed '/reset?code=?'\n    at fn (http://x.test/a.js?v=?:10:5)"
 * ```
 *
 * @param value Stack text, already scrubbed by content.
 * @returns The stack with every message-line query value and every frame
 * URL's query values masked, and every frame's position kept.
 */
export function redactStackText(value: unknown): string {
  const embedded = redactEmbeddedUrls(value);
  if (!embedded.includes('?')) {
    return embedded;
  }
  return boundedMaskedText(embedded.split('\n').map(maskStackLine).join('\n'));
}

/**
 * Whether an attribute key names a URL value, and therefore selects
 * {@link redactUrl} in `redactor.ts`'s dispatch table.
 *
 * Accepts the declared keys of {@link URL_ATTRIBUTE_KEYS} plus the two
 * conventional suffixes — a dotted `*.url` and a camelCase `*Url` — so a span
 * attribute this module has not seen before is still treated as a URL. The
 * suffix match is case-sensitive on purpose: it must catch `documentUrl` while
 * leaving an unrelated word that merely ends in `url` (`curl`) alone.
 *
 * Over-matching here is the safe direction. A non-URL value that reaches
 * {@link redactUrl} is scrubbed by content and returned, while a URL that
 * misses this test would keep its parameter values.
 *
 * @param key Attribute key, exactly as captured.
 */
export function isUrlAttributeKey(key: string): boolean {
  if ((URL_ATTRIBUTE_KEYS as readonly string[]).includes(key)) {
    return true;
  }
  return key.endsWith('.url') || key.endsWith('Url');
}
