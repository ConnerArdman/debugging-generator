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
 * The only import is `./rules.js`: the mask token, the marker and `scrub` are
 * shared with the other handlers of this folder so that a URL and a SQL
 * statement come back in the same vocabulary.
 */

import { MAX_SCAN_LENGTH, REDACTION_MARKER, REDACTION_MASK, scrub } from './rules.js';

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
 * `url` is the key the fetch attribute vocabulary declares; the rest are the
 * OpenTelemetry spellings that reach the service from the Node preload's span
 * attributes. `redactor.ts` dispatches on {@link isUrlAttributeKey}, which
 * also accepts the conventional suffixes, and treats these keys as exempt from
 * preview truncation so a URL stays readable end to end.
 */
export const URL_ATTRIBUTE_KEYS = ['url', 'http.url', 'http.target', 'target'] as const;

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
 * Slices `value` to at most `end` UTF-16 code units without splitting a
 * surrogate pair, so a bounded result never ends in a lone surrogate.
 *
 * Local to this module on purpose: `./rules.js` keeps its own copy private,
 * and duplicating eight lines is cheaper than widening that module's surface,
 * which is deliberately import-free for the browser-agent bundle.
 */
function sliceWithoutSplit(value: string, end: number): string {
  if (end <= 0) {
    return '';
  }
  if (end >= value.length) {
    return value;
  }
  const lastUnit = value.charCodeAt(end - 1);
  const splitsPair = lastUnit >= 0xd800 && lastUnit <= 0xdbff;
  return value.slice(0, splitsPair ? end - 1 : end);
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
 * @param value - Any string, including an empty one.
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
 * @param parts - Components to serialise; only `path` is required.
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
 * @param query - Query string **without** the leading `?`.
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
 * @param raw - Raw key or value slice, as {@link parseQueryPairs} returned it.
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
 * @param query - Query string **without** the leading `?`.
 * @returns The masked query, without a leading `?`; `""` for an empty query.
 */
export function redactQueryString(query: string): string {
  return buildMaskedQuery(query).text;
}

/**
 * Scrubs `text` by content and holds the result to `limit` code units.
 *
 * The cut is safe to re-apply: cutting a scrubbed string cannot expose new
 * credential material (none of the deny-list patterns is anchored, so anything
 * that matches a prefix matched the whole and was already replaced) and
 * appending the marker cannot create a match, so the result is a fixed point
 * of `scrub` and short enough that a second call does not cut again.
 */
function boundedScrub(text: string, limit: number): string {
  const cleaned = scrub(text);
  if (cleaned.length <= limit) {
    return cleaned;
  }
  const room = limit - REDACTION_MARKER.length;
  return sliceWithoutSplit(cleaned, room) + REDACTION_MARKER;
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
 * **Never throws**, for any input.
 *
 * @param value - Absolute, origin-relative, protocol-relative, bare-relative
 * or malformed URL text, as captured from a fetch, XHR or span attribute.
 * @returns The redacted URL.
 */
export function redactUrl(value: string): string {
  if (value.length === 0) {
    return value;
  }

  const overLength = value.length > MAX_SCAN_LENGTH;
  const scanned = overLength ? sliceWithoutSplit(value, MAX_SCAN_LENGTH) : value;
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
 * @param key - Attribute key, exactly as captured.
 */
export function isUrlAttributeKey(key: string): boolean {
  if ((URL_ATTRIBUTE_KEYS as readonly string[]).includes(key)) {
    return true;
  }
  return key.endsWith('.url') || key.endsWith('Url');
}
