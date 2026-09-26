/**
 * Sensitive-header handling for the telemetry privacy boundary.
 *
 * This module implements exactly one row of the AAP §0.5.2 deny-list table:
 * for `authorization`, `cookie`, `set-cookie`, `x-api-key`, `x-auth-token`
 * and `proxy-authorization` the **value is replaced with `[redacted]` while
 * the header's presence is retained**. Keeping the name is deliberate and
 * diagnostic — that a request carried an authorization header explains an
 * authenticated call, a `401` or a cache miss, and how many cookies a
 * response set is useful and harmless — while the value itself is a
 * credential and must never be persisted, broadcast on the live tail or sent
 * to a model provider.
 *
 * **Position in the pipeline.** `./redactor.ts` owns dispatch: it recognises
 * a header-shaped attribute with {@link isHeaderAttributeKey} or
 * {@link isHeaderObjectAttributeKey} and delegates the masking to
 * {@link redactHeaderValue} / {@link redactHeaders}, at service ingest,
 * before an event is stored or forwarded. A second, independent checkpoint —
 * the outbound model guard in `packages/model-provider` — re-declares an
 * equivalent six-name list and the same marker literal, and treats a denied
 * header whose value *is* the marker as compliant rather than as a finding;
 * that is how it confirms this checkpoint ran. AAP §0.2.2's package edge list
 * forbids an import between the two packages, so the shared vocabulary is a
 * naming-and-test discipline, not a compile-time guarantee: a change to
 * {@link DENIED_HEADER_NAMES} here has to be mirrored there by hand, and the
 * colocated tests on both sides are what keep them aligned.
 *
 * **The list is short on purpose.** It carries only the six names AAP §0.5.2
 * enumerates. Every other sensitive header name is caught one layer down by
 * `scrubNamedValue`'s key vocabulary (`key`, `token`, `secret`, `password`,
 * `credential`, `auth`, …), which every non-denied header value passes
 * through, so a name outside the six is masked without being listed here.
 * `cookie` and `set-cookie` are the two names that vocabulary cannot see —
 * they are sensitive because of *where* they appear rather than what they are
 * called — which is precisely why this explicit list exists.
 *
 * **Bodies are never captured.** Per AAP §0.5.2 only the method, the redacted
 * URL, the status, the size and the timing of a request are recorded. This
 * module reads header names and header values and nothing else: no function
 * here accepts, copies, summarises or returns a request or response body, and
 * none has a parameter that could carry one.
 *
 * Two operational constraints shape the implementation. It runs **per
 * captured event**, on every event of every ingested batch, so every function
 * is pure — no I/O, no globals, no clock, no randomness, no logging and no
 * mutable module state — and linear in its input. And it **never throws**: a
 * throwing getter, a hostile `Proxy` or an exotic host object yields the
 * marker for the value concerned instead of costing the rest of the batch.
 *
 * `./rules.js` is the only import, by design. Keeping this module free of
 * schema, Node and cross-package dependencies is what lets the page-injected
 * browser agent, the Node dev-server preload and the service all use it.
 */

import { REDACTION_MARKER, scrubNamedValue } from './rules.js';

/**
 * The header deny list: the six names AAP §0.5.2 enumerates, lower-cased.
 *
 * Membership is tested case-insensitively through
 * {@link isDeniedHeaderName}, because header names are case-insensitive by
 * RFC 9110 and reach this module from browser producers, OpenTelemetry span
 * attributes and Node request objects in every spelling.
 *
 * Do not extend this list. It is mirrored verbatim by the outbound model
 * guard (see the module documentation), and an additional sensitive name does
 * not need an entry: {@link redactHeaderValue} routes every non-denied value
 * through `scrubNamedValue`, whose key vocabulary already covers names built
 * from `key`, `token`, `secret`, `password`, `credential` and `auth` in any
 * case or separator spelling.
 */
export const DENIED_HEADER_NAMES = [
  'authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'x-auth-token',
  'proxy-authorization',
] as const;

/** One of the six header names whose value is always masked. */
export type DeniedHeaderName = (typeof DENIED_HEADER_NAMES)[number];

/**
 * Normalised deny list, held as a `Set` so the membership test is O(1) rather
 * than a scan per header of every ingested event.
 */
const DENIED_HEADER_NAME_SET: ReadonlySet<string> = new Set<string>(DENIED_HEADER_NAMES);

/**
 * A single header value, or the multi-value form.
 *
 * The array form is not defensive typing: a response legitimately repeats
 * `set-cookie`, and both Node's `IncomingHttpHeaders` and the Fetch API's
 * `Headers.getSetCookie()` surface that as a list.
 */
export type HeaderValue = string | readonly string[];

/**
 * A header set as captured by a producer.
 *
 * The value type includes `undefined` because Node's header records do, and
 * because a caller spreading a partially populated object produces it.
 * {@link redactHeaders} omits such keys — see its documentation.
 */
export type HeaderRecord = Readonly<Record<string, HeaderValue | undefined>>;

/**
 * Attribute-key prefixes under which a *single* header value arrives on a
 * span, following the OpenTelemetry HTTP convention
 * (`http.request.header.<name>`).
 *
 * `../schema/attributes.ts` declares the per-kind attribute catalog, but the
 * `attributes` record of a telemetry event is deliberately **open**, so header
 * data can reach ingest as a dotted key the catalog never lists — in
 * particular from the Node preload, which forwards the spans Next.js and the
 * OpenTelemetry instrumentations emit. These prefixes are declared here, next
 * to the deny list, so `./redactor.ts` can recognise such keys without
 * re-declaring the vocabulary.
 */
export const HEADER_ATTRIBUTE_PREFIXES = ['http.request.header.', 'http.response.header.'] as const;

/**
 * Attribute keys whose *value* is a whole header map rather than a scalar.
 *
 * Producers spell this in several ways, so the match is case- and
 * separator-insensitive: `requestHeaders`, `request_headers` and
 * `Request-Headers` are all the same key. `./redactor.ts` passes the value of
 * such a key to {@link redactHeaders} instead of {@link redactHeaderValue}.
 */
export const HEADER_OBJECT_ATTRIBUTE_KEYS = [
  'headers',
  'requestHeaders',
  'responseHeaders',
  'http.request.headers',
  'http.response.headers',
] as const;

/** One of the attribute keys whose value is a header map. */
export type HeaderObjectAttributeKey = (typeof HEADER_OBJECT_ATTRIBUTE_KEYS)[number];

/**
 * Separators removed before an attribute key is matched, which makes
 * {@link isHeaderObjectAttributeKey} insensitive to camelCase, snake_case,
 * kebab-case and dotted spellings. Global, and therefore used only with
 * `replace`.
 */
const ATTRIBUTE_KEY_SEPARATORS = /[\s._-]/g;

/** Lower-cases an attribute key and removes its separators. */
function foldAttributeKey(key: string): string {
  return key.toLowerCase().replace(ATTRIBUTE_KEY_SEPARATORS, '');
}

/**
 * Folded header-map keys, as a `Set` for the same reason as the deny list.
 */
const HEADER_OBJECT_ATTRIBUTE_KEY_SET: ReadonlySet<string> = new Set<string>(
  HEADER_OBJECT_ATTRIBUTE_KEYS.map(foldAttributeKey),
);

/**
 * Normalises a header name for comparison: surrounding whitespace removed and
 * lower-cased.
 *
 * Header names are case-insensitive, and a name arriving from a loose producer
 * can carry padding, so `'  Authorization  '` and `'AUTHORIZATION'` both
 * normalise to `'authorization'`. Normalisation is for *comparison only* —
 * {@link redactHeaders} keeps the caller's spelling in its result so a panel
 * can display the header as it was sent.
 *
 * @param name Header name in any spelling.
 * @returns The trimmed, lower-cased name.
 */
export function normalizeHeaderName(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * Whether `name` is one of the six names of {@link DENIED_HEADER_NAMES}.
 *
 * The test is **exact on the normalised name**, not a substring match: a
 * near-miss such as an `authorization-context` or an `x-api-keys` header is
 * *not* denied by this function. That is not a gap — {@link redactHeaderValue}
 * routes every non-denied value through `scrubNamedValue`, whose key
 * vocabulary masks both of those names anyway. Keeping this predicate exact is
 * what lets it mean "one of the six positional names the outbound guard also
 * knows", which is the question `./redactor.ts` and that guard both ask.
 *
 * @param name Header name in any spelling.
 */
export function isDeniedHeaderName(name: string): boolean {
  return DENIED_HEADER_NAME_SET.has(normalizeHeaderName(name));
}

/**
 * Extracts the header name from a dotted span-attribute key such as
 * `http.request.header.authorization`.
 *
 * The prefix is matched case-insensitively and the returned segment keeps its
 * original spelling, so the caller can both compare it (every predicate here
 * and `scrubNamedValue` normalise internally) and display it. A key with no
 * matching prefix, or one whose trailing segment is empty or blank and
 * therefore names no header, yields `undefined`.
 *
 * @param key Attribute key as captured.
 * @returns The header name, or `undefined` when `key` is not a header
 * attribute key.
 */
export function headerNameFromAttributeKey(key: string): string | undefined {
  const trimmed = key.trim();
  const lowered = trimmed.toLowerCase();
  for (const prefix of HEADER_ATTRIBUTE_PREFIXES) {
    if (lowered.startsWith(prefix)) {
      const name = trimmed.slice(prefix.length).trim();
      return name.length > 0 ? name : undefined;
    }
  }
  return undefined;
}

/**
 * Whether `key` is a span-attribute key carrying a single header value.
 *
 * Equivalent to `headerNameFromAttributeKey(key) !== undefined`, and
 * implemented that way so the two can never disagree: a key this predicate
 * accepts always yields a name for the redaction call that follows.
 *
 * @param key Attribute key as captured.
 */
export function isHeaderAttributeKey(key: string): boolean {
  return headerNameFromAttributeKey(key) !== undefined;
}

/**
 * Whether `key` is an attribute key whose value is a whole header map.
 *
 * Matching folds case and separators (see {@link HEADER_OBJECT_ATTRIBUTE_KEYS}),
 * so `responseHeaders`, `response_headers` and `Response-Headers` all match
 * while a single-value header key such as `http.request.header.authorization`
 * does not — that one is {@link isHeaderAttributeKey}'s business.
 *
 * @param key Attribute key as captured.
 */
export function isHeaderObjectAttributeKey(key: string): boolean {
  return HEADER_OBJECT_ATTRIBUTE_KEY_SET.has(foldAttributeKey(key.trim()));
}

/*
 * ---------------------------------------------------------------------------
 * Masking
 *
 * The three helpers below are the whole decision tree, written once so the
 * single-value, multi-value and attribute-key paths cannot drift apart. They
 * take `unknown` rather than {@link HeaderValue} because a producer is not a
 * compiler: a number, a `null`, an object or a throwing getter does reach
 * ingest, and the exported signatures stay typed while the runtime stays
 * total.
 * ---------------------------------------------------------------------------
 */

/**
 * Whether a value is the multi-value form. A local guard rather than a bare
 * `Array.isArray` call so the narrowing is explicit and no cast is needed for
 * a `readonly` array.
 */
function isHeaderValueArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

/**
 * Coerces a scalar header value to a string, or reports that it has no safe
 * string form.
 *
 * A number or boolean is a loose producer's spelling of a numeric or flag
 * header (`content-length`, `x-cache-hit`) and stringifies faithfully; a
 * `bigint` is included for the same reason. Anything else — `null`,
 * `undefined`, an object, an array, a function, a symbol — has no faithful
 * header form, and guessing one would mean passing an unexamined shape
 * through the privacy boundary, so it is reported as uncoercible and the
 * caller substitutes the marker.
 */
function coerceHeaderScalar(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  return undefined;
}

/**
 * Masks one scalar value under a header name already classified as denied or
 * not.
 *
 * A denied name is positional: the value is replaced whole, whatever it
 * contains. Any other name is handed to `scrubNamedValue`, which masks the
 * value when the *name* is key-like and otherwise scrubs credential material
 * out of the *content*, leaving a benign value untouched.
 */
function redactHeaderScalar(name: string, value: unknown, denied: boolean): string {
  if (denied) {
    return REDACTION_MARKER;
  }
  const scalar = coerceHeaderScalar(value);
  if (scalar === undefined) {
    return REDACTION_MARKER;
  }
  return scrubNamedValue(name, scalar);
}

/**
 * Masks the multi-value form element-wise into a **fresh** array, preserving
 * element count and order.
 *
 * The count is retained for the same reason the header name is: how many
 * cookies a response set is diagnostic and carries no data. The array is new
 * on every call, so the caller's array is never shared into a stored event.
 */
function redactHeaderArray(name: string, values: readonly unknown[], denied: boolean): string[] {
  const masked: string[] = [];
  for (const element of values) {
    masked.push(redactHeaderScalar(name, element, denied));
  }
  return masked;
}

/**
 * The untyped core of {@link redactHeaderValue}, shared with
 * {@link redactHeaders} so a value read off a record needs no cast.
 *
 * Total by construction: the classification happens before the value is
 * touched, and every remaining step is wrapped, so a throwing getter or a
 * hostile `Proxy` on an element yields the marker rather than an exception.
 */
function redactUnknownHeaderValue(name: string, value: unknown): HeaderValue {
  const denied = isDeniedHeaderName(name);
  try {
    if (isHeaderValueArray(value)) {
      return redactHeaderArray(name, value, denied);
    }
    return redactHeaderScalar(name, value, denied);
  } catch {
    // Reading or iterating the value failed. Ingest processes batches, so one
    // exotic value must not cost the rest: the header's presence is kept and
    // its value is reported as redacted.
    return REDACTION_MARKER;
  }
}

/**
 * Masks one header value.
 *
 * Semantics, each pinned by the colocated test:
 *
 * - **Denied name** (one of {@link DENIED_HEADER_NAMES}, compared
 *   case-insensitively) → `REDACTION_MARKER`, unconditionally. An empty value
 *   becomes the marker too: the classification is positional, over-redaction
 *   is the safe direction for a privacy boundary, and the outbound guard
 *   accepts both the marker and an empty value as already-redacted.
 * - **Multi-value form** → a fresh array of the same length, each element
 *   masked by the same rules.
 * - **Any other name** → `scrubNamedValue(name, value)`, so a sensitive name
 *   outside the six is masked by the key vocabulary and a credential sitting
 *   inside a benign header's value is scrubbed by the pattern rules, while a
 *   benign value passes through byte-for-byte.
 * - **Uncoercible value** → `REDACTION_MARKER`, never the value itself (see
 *   {@link coerceHeaderScalar}).
 *
 * **Idempotent.** `redactHeaderValue(n, redactHeaderValue(n, v))` deep-equals
 * `redactHeaderValue(n, v)` for every name and value: the marker is not
 * re-marked, no pattern rule matches the marker, and element counts are
 * stable.
 *
 * @param name Header name in any spelling. For a dotted span-attribute key,
 * pass `headerNameFromAttributeKey(key) ?? key`.
 * @param value Value as captured.
 * @returns The masked value: a string, or an array of masked strings for the
 * multi-value form.
 */
export function redactHeaderValue(name: string, value: HeaderValue): HeaderValue {
  return redactUnknownHeaderValue(name, value);
}

/**
 * Masks a whole header set, returning a **new** record.
 *
 * - The input is never mutated, and no array or object from it is shared into
 *   the result, because ingest may keep the parsed event and the browser
 *   agent's batch is shared across events.
 * - **Keys keep the caller's casing**, so a panel can display the header as it
 *   was sent (`Authorization: [redacted]`) while the deny-list comparison
 *   stays case-insensitive.
 * - **Insertion order is preserved** (JavaScript's own ordering of
 *   integer-like keys aside, which no real header name triggers), so a
 *   redacted event is byte-stable for snapshot comparison and storage.
 * - **A key whose value is `undefined` is omitted entirely.** An absent header
 *   is not data, and the telemetry event schema cannot carry `undefined`
 *   inside `attributes`; keeping the key would turn a missing header into a
 *   present one.
 * - Only own, enumerable, string-keyed properties are read — symbol-keyed
 *   properties are not header data and are ignored.
 * - **It never throws.** A property with a throwing getter yields the marker
 *   for that key and every other key is still produced; a record that cannot
 *   be enumerated at all yields an empty record rather than an exception.
 *
 * **Idempotent.** `redactHeaders(redactHeaders(h))` deep-equals
 * `redactHeaders(h)`.
 *
 * @param headers Header set as captured. Never modified.
 * @returns A new record of masked values, `undefined`-valued keys removed.
 */
export function redactHeaders(headers: HeaderRecord): Record<string, HeaderValue> {
  let keys: readonly string[];
  try {
    keys = Object.keys(headers);
  } catch {
    // An exotic or absent record cannot be enumerated. Nothing is known about
    // its contents, so nothing is reported — and ingest continues.
    return {};
  }

  const entries: [string, HeaderValue][] = [];
  for (const key of keys) {
    let value: unknown;
    try {
      value = headers[key];
    } catch {
      entries.push([key, REDACTION_MARKER]);
      continue;
    }
    if (value === undefined) {
      continue;
    }
    entries.push([key, redactUnknownHeaderValue(key, value)]);
  }

  // `Object.fromEntries` defines own data properties, so a header literally
  // named `__proto__` becomes a key of the result instead of reassigning its
  // prototype — which a `result[key] = …` loop would do.
  return Object.fromEntries(entries);
}
