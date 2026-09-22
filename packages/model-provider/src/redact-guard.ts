/**
 * The outbound redaction guard: the last thing that runs before anything can
 * leave the developer's machine.
 *
 * AAP §0.5.2 gives redaction two checkpoints. The first is far upstream, in
 * `packages/telemetry/src/redaction/`, applied by the local service at
 * telemetry ingest before an event is persisted or broadcast. This module is
 * the second: it re-inspects **every outbound prompt payload** and **rejects
 * the call** when a value still matches the deny list.
 *
 * ## It is a guard, not a redactor
 *
 * Nothing here rewrites a payload. There is no `redact()`, no sanitised copy
 * and no "cleaned" request handed back to the caller — {@link inspectPayload}
 * reports, and {@link assertOutboundSafe} refuses. That is deliberate and it is
 * the whole design:
 *
 * - A rewrite would hide the regression. The payload arrives already redacted
 *   by construction (`ModelRequest` says so on its own interface), so a value
 *   that matches a rule here means an upstream checkpoint did not run, or ran
 *   and missed, or a new code path assembled a payload without going through
 *   one. Quietly scrubbing it turns a reportable defect into a silent one that
 *   nobody ever fixes.
 * - A rewrite cannot be correct. Removing a credential from prose the model was
 *   going to reason over changes the question being asked; removing a field
 *   from structured context changes what the deterministic provider answers
 *   from. Refusing keeps the caller in charge of both.
 *
 * So a caller that treats this as a sanitiser will see calls fail rather than
 * data get cleaned, which is the outcome `types.ts` warns about on
 * `ModelRequest` and the one this file exists to produce.
 *
 * ## A finding names the field, never the value
 *
 * A {@link RedactGuardFinding} carries a rule id, a path and a generic reason.
 * It never carries the matched substring, a prefix or suffix of it, its
 * character length, or a hash of it — a hash of a short credential is a
 * reversible disclosure, and a prefix is a disclosure outright. Findings are
 * logged, attached to a {@link DebuggenError}'s `details`, forwarded to two
 * user interfaces and persisted with a session, so the only safe thing to put
 * in one is the *location* of the problem. `packages/shared` sets the same
 * precedent for its own rejections.
 *
 * For the same reason, nothing in this module logs a value. The logger it
 * accepts is used for one thing only: to say that a bound was reached, and at
 * which path.
 *
 * ## Fail closed
 *
 * Every walk is bounded — by depth, by a node budget, by how much of a single
 * string is scanned and by how many findings are reported — because a
 * pathological payload must not be able to hang the pipeline. A bound that is
 * reached means part of the payload was never inspected, and an uninspected
 * payload is **not** a clean one: {@link inspectPayloadReport} reports
 * `complete: false` with the bounds it hit, and {@link assertOutboundSafe}
 * refuses on that alone, with no finding to show. The alternative — treating
 * "I did not look" as "there is nothing there" — is the failure mode a privacy
 * boundary cannot have.
 *
 * ## Why the patterns are written so oddly
 *
 * This file's job is to recognise secret shapes, and `scripts/check-secrets.mjs`
 * fails the build on precisely those shapes in any tracked file — this one
 * included. Every pattern is therefore assembled from fragments at load time so
 * that no denied literal appears as contiguous source text. The comment above
 * the pattern table says this again, at length, because the failure mode of
 * "tidying" a fragment back into a literal is a red gate with no obvious cause.
 *
 * ## Relationship to the other two enforcement points
 *
 * The rule ids, the `[redacted]` marker, the `?` query mask, the six denied
 * header names and the entropy thresholds are shared with
 * `packages/telemetry/src/redaction/` and with `scripts/check-secrets.mjs` **by
 * convention, never by an import edge**: AAP §0.2.2's package edge list allows
 * this package to import `@debuggen/shared` and nothing else, and the guard
 * script is a command-line tool outside every workspace. One vocabulary across
 * the three is therefore a documentation-and-test discipline. The colocated
 * suite pins each shared literal, and the telemetry suites pin the same bytes
 * from their side, so a change made in one place fails in the other two.
 *
 * ## Purity
 *
 * {@link inspectPayload}, {@link inspectPayloadReport},
 * {@link summarizeFindings} and {@link assertOutboundSafe} perform no I/O, read
 * no environment variable, touch no clock, mutate nothing they are given and
 * throw nothing — including on adversarial input: a cyclic object, a hostile
 * `Proxy`, a getter that throws, a null-prototype object, a ten-megabyte string
 * and a deeply nested array are all handled rather than propagated. The
 * injected logger is the single exception to "no I/O", and it defaults to
 * `noopLogger`, so this package is silent unless its host asks for output.
 */

import { DebuggenError, err, noopLogger, ok } from '@debuggen/shared';
import type { DebuggenErrorCode, Logger, Result } from '@debuggen/shared';

import type { ModelRequest } from './types.js';

// ---------------------------------------------------------------------------
// Rule vocabulary
// ---------------------------------------------------------------------------

/**
 * The deny-list classes of AAP §0.5.2, in reporting order.
 *
 * One id per class of the specification's table and **no others**: the table is
 * the authoritative deny list, so a rule invented here would refuse payloads
 * the product is entitled to send, and a class dropped from here would let one
 * through. Two of the eight classify a value by its *position* rather than by
 * its content (`sensitive-header` by the key it sits under,
 * `url-query-value` by being a query parameter's value) and one by the
 * *combination* of a name and a measurement (`high-entropy-secret`); the rest
 * are content shapes that identify themselves wherever they appear.
 *
 * Five ids — `provider-key`, `jwt`, `private-key`, `connection-string` and
 * `bearer-token` — are spelled exactly as `packages/telemetry`'s redaction
 * layer spells them, and four of those also match `scripts/check-secrets.mjs`'s
 * rule ids, so one vocabulary reads across all three enforcement points. The
 * repository gate calls the last class `entropy`; this module and the telemetry
 * layer name the same rule `high-entropy-secret` here because a finding that
 * travels to a user interface has to say what it found rather than how it was
 * measured.
 *
 * Declared `as const` so {@link RedactionRuleId} is derived from it: a class
 * added to the table widens the union in the same edit, and every exhaustive
 * consumer — the reason map below, the option filter, the colocated suite —
 * stops compiling until it says something about the new one.
 */
export const REDACTION_RULE_IDS = [
  'sensitive-header',
  'provider-key',
  'bearer-token',
  'jwt',
  'private-key',
  'connection-string',
  'url-query-value',
  'high-entropy-secret',
] as const;

/** One class of the deny list in {@link REDACTION_RULE_IDS}. */
export type RedactionRuleId = (typeof REDACTION_RULE_IDS)[number];

/**
 * The generic explanation carried by a finding of each class.
 *
 * Every string here describes the **rule**, never the value that matched it:
 * these become {@link RedactGuardFinding.reason}, which is read by a developer
 * in a log line and in a user interface, so it has to be intelligible on its
 * own and safe to print. The path beside it says where to look; this says what
 * was recognised and what to do about it.
 *
 * Held as a frozen record keyed by the rule id rather than written at each
 * detection site, so one class cannot come to have two wordings depending on
 * which branch found it.
 */
export const REDACTION_RULE_REASONS: Readonly<Record<RedactionRuleId, string>> = Object.freeze({
  'sensitive-header':
    'A denied header name carries a value other than the redaction marker; the ingest checkpoint replaces such a value while keeping the header present.',
  'provider-key':
    'A value matches the prefix shape of a provider API key, which identifies key material on its own.',
  'bearer-token': 'A value carries an HTTP bearer credential after its authentication scheme word.',
  jwt: 'A value matches the three-segment compact serialisation of a JSON Web Token.',
  'private-key': 'A value contains the opening delimiter of a PEM private-key block.',
  'connection-string':
    'A value is an absolute URI whose userinfo component carries a user and a password before its host.',
  'url-query-value':
    'A URL retains an unmasked query parameter value; the ingest checkpoint replaces each value with the query mask and keeps the key.',
  'high-entropy-secret':
    'A long, dense value is bound to a credential-like field name, which is the shape of an opaque secret.',
});

/**
 * The six header names of AAP §0.5.2, lower-cased.
 *
 * Exactly these six and no more. `packages/telemetry/src/redaction/headers.ts`
 * declares the same list — its own documentation says the list is "mirrored
 * verbatim by the outbound model guard", and this is that mirror — so the two
 * must be edited together or the checkpoints disagree about what counts as
 * redacted.
 *
 * Lower-cased here and compared case-insensitively at every call site, because
 * an attribute key arrives from whichever producer created it: a browser agent
 * writes `authorization`, a Node exporter writes it under
 * `http.request.header.authorization`, and a source excerpt can spell it
 * `Authorization` in whatever case the developer typed.
 */
export const DENIED_HEADER_NAMES = [
  'authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'x-auth-token',
  'proxy-authorization',
] as const;

/** One of the six names in {@link DENIED_HEADER_NAMES}. */
export type DeniedHeaderName = (typeof DENIED_HEADER_NAMES)[number];

/**
 * The exact replacement the first checkpoint writes in place of a denied value.
 *
 * The bytes are a cross-package contract. `packages/telemetry`'s redaction
 * layer writes this literal and its suites assert it character for character
 * *because* this module re-declares it independently — no import edge is
 * permitted between the two packages (AAP §0.2.2) — and treats a denied header
 * whose value **is** this marker as compliant rather than as a finding.
 *
 * That last point is the entire reason a second checkpoint is worth having:
 * seeing the marker is positive evidence that the first checkpoint ran on this
 * field, so the guard can distinguish "redacted" from "never touched" instead
 * of having to refuse every payload that mentions a header at all.
 */
export const REDACTION_MARKER = '[redacted]';

/**
 * The mask the first checkpoint writes in place of each URL query parameter
 * value.
 *
 * AAP §0.5.2: query parameter values are "replaced with `?` per key" while the
 * path is retained, which keeps a URL diagnosable without keeping its data.
 * `packages/telemetry/src/redaction/url.ts` declares the same single character
 * as `REDACTION_MASK`; a query value that is neither empty nor this mask is a
 * `url-query-value` finding.
 */
export const URL_QUERY_MASK = '?';

// ---------------------------------------------------------------------------
// Thresholds and defaults
// ---------------------------------------------------------------------------

/**
 * Shortest value the entropy heuristic will measure.
 *
 * Mirrors `ENTROPY_MIN_LENGTH` in `scripts/check-secrets.mjs` and in the
 * telemetry redaction layer. Below this length an entropy estimate says
 * nothing: a six-character word and a six-character credential are
 * indistinguishable by density.
 */
export const ENTROPY_MIN_LENGTH = 32;

/**
 * Entropy threshold in bits per character, **exceeded** rather than met.
 *
 * The strictness of the comparison is load-bearing and is why the repository
 * gate uses the same number: lower-case hexadecimal has an alphabet of sixteen
 * symbols and therefore tops out at exactly four bits per character, so a hex
 * digest — a trace id, a span id, a content hash, the store's HMAC request key
 * — can never clear the bar however long it is. Random base64url material,
 * drawn from sixty-four symbols, sits near six.
 */
export const ENTROPY_MIN_BITS_PER_CHAR = 4;

/**
 * Default nesting depth the walk descends before it stops and reports the
 * bound.
 *
 * A prompt payload is aggregates and bounded excerpts: trace trees flattened
 * into arrays, per-component render statistics, request and query groups. Those
 * are units deep, not tens. Thirty-two leaves an order of magnitude of headroom
 * while keeping a hostile or accidentally recursive structure from turning the
 * walk into a stack problem.
 */
export const DEFAULT_MAX_DEPTH = 32;

/**
 * Hard ceiling on {@link RedactGuardOptions.maxDepth}, whatever a caller asks
 * for.
 *
 * The walk is recursive, so a depth bound is also a bound on the call stack: a
 * caller that passed a million would turn "this module never throws" into a
 * stack overflow on a deep payload. A request for more than this is clamped to
 * it, and a payload deeper than the clamp is reported as truncated — and
 * therefore refused — rather than crashing the pipeline.
 */
export const MAX_SUPPORTED_DEPTH = 512;

/**
 * Default total node budget for one walk: strings, objects, arrays and scalars
 * together.
 *
 * Deliberately generous, because the two ways to get this number wrong are not
 * symmetrical. Too high risks a slow inspection of a payload that is already in
 * memory — the walk is linear in the number of nodes, so its cost is bounded by
 * the payload's own size. Too low **refuses a legitimate call**, and a stage
 * whose evidence is a few thousand aggregated events with a dozen fields each
 * is an ordinary payload, not an attack. Half a million nodes is far past any
 * payload `apps/local-service`'s context builder assembles and still a hard
 * ceiling on a structure that is pathological rather than large.
 */
export const DEFAULT_MAX_NODES = 500_000;

/**
 * Default number of UTF-16 code units of a single string that are scanned.
 *
 * Sized against the largest string a request legitimately carries, which is the
 * rendered prompt: a versioned prompt file with bounded source excerpts
 * substituted into it runs to tens, occasionally hundreds, of kilobytes. A
 * mebibyte leaves an order of magnitude above that, so no real prompt or
 * excerpt is ever truncated — while a value past it is a blob rather than a
 * prompt, and truncation there is reported and refused rather than ignored (see
 * {@link SCAN_WINDOW_OVERLAP} for how a credential straddling the cut is still
 * caught).
 *
 * The bound that matters for cost is per string, not overall: a payload is
 * already resident in memory, so the total text one walk can scan is bounded by
 * the payload's own size, and this constant is what keeps one hostile
 * multi-megabyte value from dominating that.
 */
export const DEFAULT_MAX_STRING_LENGTH = 1_048_576;

/**
 * Default cap on how many findings one report carries.
 *
 * A reporting cap and nothing more: reaching it never softens the verdict —
 * there is at least one finding, so the payload is unsafe — it only keeps a
 * thousand-line error out of a log and a user interface. The report says the cap
 * was reached, so "50 findings" is never mistaken for "exactly 50 problems".
 */
export const DEFAULT_MAX_FINDINGS = 50;

/**
 * Width of one scanning window, in UTF-16 code units.
 *
 * Patterns are applied window by window rather than to a whole string, so a
 * hostile ten-megabyte value costs a bounded number of bounded matches instead
 * of one unbounded one. Sixteen kibibytes matches the telemetry layer's
 * `MAX_SCAN_LENGTH`, which keeps the two checkpoints' sensitivity comparable on
 * the same value.
 */
export const SCAN_WINDOW_LENGTH = 16_384;

/**
 * Overlap between consecutive windows, and the distance read past the
 * {@link RedactGuardOptions.maxStringLength} cut.
 *
 * Windowing a string introduces boundaries, and a pattern that straddles a
 * boundary matches in neither window — which is exactly where a credential
 * would hide if the boundary were visible from outside. Overlapping the windows
 * by a kibibyte means any match shorter than a kibibyte lies wholly inside at
 * least one window, and reading the same distance past the cut means a
 * credential that begins before the cut is seen whole rather than beheaded.
 *
 * The compromise this encodes, stated plainly: a *single* match longer than
 * this overlap that also happens to straddle a boundary can be missed. Every
 * pattern in the table below identifies its class within a bounded prefix — a
 * scheme word and eight characters, a prefix and sixteen, a delimiter and a
 * label — so a real credential is recognised far inside the overlap. The
 * unbounded tails exist to *cover* long key material, not to identify it.
 */
export const SCAN_WINDOW_OVERLAP = 1_024;

/**
 * Upper bound, in code units, on a string the URL rules will try to parse.
 *
 * `new URL` is a full parser and a URL in a prompt payload is a request target,
 * not a document: four kibibytes is far past any real one, and refusing to parse
 * beyond it keeps a megabyte of prose from being handed to the parser on the
 * off-chance it is a link.
 */
export const URL_PARSE_MAX_LENGTH = 4_096;

/**
 * Longest path segment a finding's path will carry before it is shortened.
 *
 * A path is built from object keys, array indices and URL parameter names, all
 * of which are structure rather than data — but a producer that flattens data
 * *into* a key can make one arbitrarily long, and a finding is read by a human.
 * The cap keeps a path legible; it is not a privacy measure, and the shortening
 * is marked so a truncated segment is never mistaken for a complete one.
 */
export const PATH_SEGMENT_MAX_LENGTH = 64;

/** Marks a path segment shortened by {@link PATH_SEGMENT_MAX_LENGTH}. */
export const PATH_SEGMENT_TRUNCATION_MARKER = '\u2026';

/**
 * The field-name terms that make a value's *name* credential-like.
 *
 * AAP §0.5.2 binds the entropy rule to these four, and the repository gate
 * binds its own to the same words. Matching is a case-insensitive **substring**
 * test, which is deliberately wider than the gate's separator-aware form: for a
 * privacy boundary the safe direction of error is to measure a value nobody
 * meant as a credential, because the cost is a refused call a developer can fix
 * at its source, whereas the cost of the other direction is a credential on the
 * network.
 */
export const KEY_LIKE_NAME_TERMS = ['key', 'token', 'secret', 'password'] as const;

/**
 * How many field paths {@link summarizeFindings} lists for one rule class
 * before it counts the rest.
 *
 * A summary is a line in a log and a sentence in an error message, and a
 * developer who has twenty fields to fix finds the twenty-first from the
 * `details` of the error rather than from the sentence.
 */
export const SUMMARY_MAX_PATHS_PER_RULE = 5;

// ---------------------------------------------------------------------------
// Findings, limits and options
// ---------------------------------------------------------------------------

/**
 * One reason a payload may not be sent.
 *
 * Three fields, and the absence of a fourth is the point: there is nowhere here
 * to put the value that matched, so no code path can leak it by accident.
 */
export interface RedactGuardFinding {
  /** The deny-list class that recognised the field. */
  readonly ruleId: RedactionRuleId;

  /**
   * Where the field is, as a dotted-and-bracketed pointer into the inspected
   * request.
   *
   * Built by the walk and precise enough to find the field in the code that
   * assembled it: `'prompt'`, `'messages[0].content'`,
   * `'input.spans[3].attributes.authorization'`,
   * `'input.attributes["http.request.header.authorization"]'`. A non-identifier
   * key is bracketed and quoted; an array index is bracketed; a URL query
   * parameter is named after a `?`, as in `'input.requests[0].url?cursor'`.
   */
  readonly path: string;

  /**
   * Why the class matched, in generic prose from
   * {@link REDACTION_RULE_REASONS}.
   *
   * About the rule, never about the value: no substring, no prefix, no length,
   * no digest. Safe to log, to persist and to show.
   */
  readonly reason: string;
}

/**
 * A bound that stopped part of an inspection.
 *
 * `max-findings` is a reporting cap and appears only alongside findings;
 * the other four mean some of the payload was never examined, which is why
 * {@link RedactGuardReport.complete} is false whenever any of them is present
 * and why {@link assertOutboundSafe} refuses on that alone.
 */
export const REDACT_GUARD_LIMIT_IDS = [
  'max-depth',
  'max-nodes',
  'max-string-length',
  'max-findings',
  'inspection-error',
] as const;

/** One of the bounds in {@link REDACT_GUARD_LIMIT_IDS}. */
export type RedactGuardLimitId = (typeof REDACT_GUARD_LIMIT_IDS)[number];

/**
 * The full result of one inspection: what was found, and whether the whole
 * payload was actually looked at.
 *
 * {@link inspectPayload} returns the findings alone because that is the shape
 * the file's brief specifies and the shape most callers want. This is the shape
 * {@link assertOutboundSafe} needs, because "no findings" and "safe" are only
 * the same statement when {@link RedactGuardReport.complete} is true.
 */
export interface RedactGuardReport {
  /** Every finding, in walk order, capped at `maxFindings`. */
  readonly findings: readonly RedactGuardFinding[];

  /**
   * Whether the whole payload was inspected within the configured bounds.
   *
   * `false` means at least one bound was reached, so some field, some nesting
   * level or some part of some string was never examined. A `false` here with
   * an empty `findings` array is **not** a clean verdict.
   */
  readonly complete: boolean;

  /** The bounds that were reached, in {@link REDACT_GUARD_LIMIT_IDS} order. */
  readonly limitsReached: readonly RedactGuardLimitId[];

  /** How many nodes — scalars, strings, arrays and objects — were visited. */
  readonly inspected: number;
}

/**
 * How one inspection is bounded, filtered and reported.
 *
 * Every member is optional and every default is a `SCREAMING_SNAKE` constant
 * above, so a caller that passes nothing gets the product's configuration
 * rather than a number hidden in a function body. Optional members are
 * **absent** rather than present-and-`undefined`: this package compiles with
 * `exactOptionalPropertyTypes`.
 */
export interface RedactGuardOptions {
  /**
   * The subset of rules to apply. Omitted means all of
   * {@link REDACTION_RULE_IDS}.
   *
   * Exists for the colocated suite, which exercises one class at a time, and
   * for a caller whose payload legitimately contains a shape one rule
   * recognises. Narrowing it in production narrows the guard, so a caller that
   * does should say why where it does.
   */
  readonly rules?: readonly RedactionRuleId[];

  /** Nesting depth to descend. Defaults to {@link DEFAULT_MAX_DEPTH}. */
  readonly maxDepth?: number;

  /**
   * Code units of a single string to scan. Defaults to
   * {@link DEFAULT_MAX_STRING_LENGTH}.
   */
  readonly maxStringLength?: number;

  /** Node budget for the walk. Defaults to {@link DEFAULT_MAX_NODES}. */
  readonly maxNodes?: number;

  /** Findings to report. Defaults to {@link DEFAULT_MAX_FINDINGS}. */
  readonly maxFindings?: number;

  /**
   * What a finding's path calls the value being inspected. Defaults to
   * {@link DEFAULT_ROOT_PATH}.
   *
   * Every path in a report is this string plus the route the walk took to the
   * field, so it is what makes a finding locatable in the code that assembled
   * the payload. The default names the payload `input`, after the
   * `ModelRequest` field this guard exists for, which is why a standalone
   * inspection reads as `input.spans[3].attributes.authorization`.
   * {@link assertOutboundSafe} overrides it per field, naming `system`,
   * `prompt`, `messages[0].content` and `input` in turn.
   */
  readonly rootPath?: string;

  /**
   * Where to report a reached bound, at `warn`.
   *
   * Defaults to `noopLogger`, so this package is silent unless its host injects
   * a logger. Only paths, rule ids and limit ids are ever logged:
   * `packages/shared/src/logger.ts` performs no redaction of its own by design
   * and names this module as one of the two places redaction lives, so
   * everything handed to it here is already safe to print.
   */
  readonly logger?: Logger;
}

/*
 * ---------------------------------------------------------------------------
 * Pattern table
 *
 * READ THIS BEFORE SIMPLIFYING ANY PATTERN BELOW.
 *
 * Every pattern here is assembled from short fragments at load time — `'s' +
 * 'k-'`, `'gh' + 'p_'`, `'AK' + 'IA'`, `'ey' + 'J'`, `'PRIVATE' + ' KEY'` —
 * rather than written as one string literal. The split points carry no meaning
 * whatsoever beyond this: `scripts/check-secrets.mjs` scans every tracked file,
 * this one included, and fails the build on exactly the shapes this module
 * detects. Its rules are `provider-key` (those four credential prefixes), `jwt`,
 * `private-key`, `connection-string` and `entropy`, and its allowlist holds
 * exactly two development placeholders and is not an escape hatch.
 *
 * So joining `'s' + 'k-'` back into one literal — an edit that looks like pure
 * tidying and changes nothing about the compiled pattern — makes
 * `pnpm check:secrets` fail on this file with a finding that points at a
 * regular expression, which is a confusing half-hour for whoever inherits it.
 * The same applies to a "clearer" example in a comment: no denied shape may
 * appear as contiguous source text anywhere in this file, including in prose.
 * `packages/telemetry/src/redaction/rules.ts` assembles its own patterns the
 * same way and for the same reason, and `scripts/check-secrets.mjs` does it to
 * avoid tripping over itself.
 *
 * Two further properties hold across the table and are worth keeping:
 *
 * - **No pattern can backtrack catastrophically.** Every quantifier is bounded
 *   and anchored to a character class that excludes whatever follows it, and no
 *   pattern uses a backreference, so hostile input costs linear time. That
 *   matters here more than in most places: the strings being scanned come from
 *   a page the developer is debugging.
 * - **Every instance is non-global.** A global regular expression carries a
 *   mutable `lastIndex` between calls, so a shared instance would answer
 *   `true`, then `false`, then `true` for the same input. Detection is all this
 *   module does, `test` is all it calls, and no instance below has the `g`
 *   flag.
 * ------------------------------------------------------------------------ */

/**
 * Joins pattern fragments.
 *
 * Exists only to break a literal, as the comment above explains at length. It
 * is a function rather than a `+` chain at each site so that a reader who
 * follows one call arrives at that explanation.
 */
function assemble(...parts: readonly string[]): string {
  return parts.join('');
}

/** Base64url and opaque token body characters. */
const TOKEN_CHARS = '[A-Za-z0-9_-]';

/** Body characters of the underscore-delimited forge tokens. */
const WORD_CHARS = '[A-Za-z0-9_]';

/** Body characters of an upper-case cloud access-key identifier. */
const UPPER_CHARS = '[0-9A-Z]';

/**
 * Credential characters permitted after an HTTP authentication scheme word.
 *
 * `[` is deliberately absent, which is what makes the compliant output of the
 * first checkpoint — the scheme word followed by {@link REDACTION_MARKER} —
 * unmatchable by the bearer rule. Without that, an already-redacted header
 * would be reported as a finding and no payload carrying one could ever be
 * sent.
 */
const BEARER_CHARS = '[A-Za-z0-9._~+/=-]';

/**
 * Left word boundary for a credential prefix: the prefix must start a token.
 *
 * Without it, the shortest provider prefix matches inside ordinary words —
 * `check-secrets` records `disk-usage_report_threshold` as a specimen — and a
 * guard that refuses calls over ordinary prose is a guard a developer disables.
 */
const LEFT_BOUNDARY = '(?<![A-Za-z0-9_-])';

/**
 * Bound on every unbounded-looking run in the table: one scanning window plus
 * its overlap, which is the longest text any pattern is ever applied to.
 */
const RUN_LIMIT = String(SCAN_WINDOW_LENGTH + SCAN_WINDOW_OVERLAP);

/** A prefixed credential shape: what identifies it, and what its body holds. */
interface CredentialShape {
  /** Pattern source for the prefix that identifies the shape. */
  readonly prefix: string;
  /** Character class the body is drawn from. */
  readonly chars: string;
  /** Body characters required before the shape is treated as a credential. */
  readonly min: number;
}

/**
 * The prefixed provider credentials of AAP §0.5.2, each identified by its own
 * prefix and body alphabet.
 *
 * The minimum body lengths are the repository gate's: sixteen characters for
 * the vendor and classic-forge prefixes, twenty for the fine-grained forge
 * prefix. Below its minimum a prefix is a word, not a credential.
 */
const PROVIDER_SHAPES: readonly CredentialShape[] = [
  { prefix: assemble('s', 'k-(?:ant-)?'), chars: TOKEN_CHARS, min: 16 },
  { prefix: assemble('gh', 'p_'), chars: WORD_CHARS, min: 16 },
  { prefix: assemble('git', 'hub_pat_'), chars: WORD_CHARS, min: 20 },
];

/**
 * An upper-case cloud access-key identifier: its prefix and exactly sixteen
 * upper-case alphanumerics.
 *
 * The right-hand guard is what makes "exactly" true rather than "at least",
 * which is how the gate spells the same shape; it is kept apart from
 * {@link PROVIDER_SHAPES} because a fixed-width shape cannot be expressed
 * through a minimum.
 */
const ACCESS_KEY_SOURCE = assemble('AK', 'IA') + UPPER_CHARS + '{16}(?![A-Za-z0-9])';

/** `provider-key`: any of the prefixed credential shapes, at a token start. */
const PROVIDER_KEY_SOURCE =
  LEFT_BOUNDARY +
  '(?:' +
  [
    ...PROVIDER_SHAPES.map(
      (shape) => shape.prefix + shape.chars + '{' + String(shape.min) + ',' + RUN_LIMIT + '}',
    ),
    ACCESS_KEY_SOURCE,
  ].join('|') +
  ')';

/**
 * `bearer-token`: an HTTP bearer credential, wherever it appears in text.
 *
 * Applied case-insensitively, because the scheme word is written every way a
 * header, a code excerpt and a log line can write it.
 */
const BEARER_TOKEN_SOURCE = '\\b' + 'bearer' + '\\s+' + BEARER_CHARS + '{8,' + RUN_LIMIT + '}';

/**
 * `jwt`: the compact serialisation of a JSON Web Token.
 *
 * The header segment's prefix is the base64url encoding of the two characters
 * that open a JSON object with a string key, which is what makes a token
 * identifiable rather than merely dense. One separator is required — that is
 * what distinguishes a token from a dense run — and the signature segment is
 * optional and may be empty, so an unsigned token is recognised too.
 */
const JWT_SOURCE =
  LEFT_BOUNDARY +
  assemble('ey', 'J') +
  TOKEN_CHARS +
  '{8,' +
  RUN_LIMIT +
  '}\\.' +
  TOKEN_CHARS +
  '{4,' +
  RUN_LIMIT +
  '}(?:\\.' +
  TOKEN_CHARS +
  '{0,' +
  RUN_LIMIT +
  '})?';

/**
 * `private-key`: the opening delimiter of a PEM private-key block.
 *
 * The bounded label class between the delimiter word and the trailing words
 * covers the algorithm-qualified labels (and any future one of the same shape)
 * without enumerating them, and the optional suffix covers the block form. Only
 * the *header* is matched: key material only ever follows a complete delimiter,
 * so the delimiter is the whole signal.
 */
const PRIVATE_KEY_SOURCE = '-{5}BEGIN[A-Z0-9 ]{0,40}' + assemble('PRIVATE', ' KEY') + '(?: BLOCK)?';

/** URL scheme, bounded so a long word before `://` cannot start a match. */
const SCHEME_SOURCE = '[A-Za-z][A-Za-z0-9+.-]{1,31}';

/** User part of a URI's userinfo; excludes `:` so the split is unambiguous. */
const USERINFO_USER = '[^\\s/?#@:]{1,256}';

/**
 * Password part of a URI's userinfo.
 *
 * Excluding `/`, `?` and `#` is what keeps a `host:port` authority followed by
 * an `@` later in a path from reading as a credential.
 */
const USERINFO_PASS = '[^\\s/?#@]{1,256}';

/**
 * `connection-string`: credentialed userinfo in an absolute URI.
 *
 * A userinfo without a colon does not match, which is why the compliant output
 * of the first checkpoint — the userinfo replaced wholesale by
 * {@link REDACTION_MARKER} — passes.
 */
const CONNECTION_STRING_SOURCE =
  SCHEME_SOURCE + ':\\/\\/' + USERINFO_USER + ':' + USERINFO_PASS + '@';

/**
 * The content-driven rules, compiled once, in {@link REDACTION_RULE_IDS} order.
 *
 * Each is applied to every string the walk reaches and to the rendered prose of
 * a request, because a credential can arrive inside a bounded source excerpt
 * just as easily as inside an attribute. The two position-driven rules
 * (`sensitive-header`, `url-query-value`) and the name-driven one
 * (`high-entropy-secret`) are not here: they need more than a string to reach a
 * verdict.
 */
const CONTENT_PATTERNS: readonly (readonly [RedactionRuleId, RegExp])[] = Object.freeze([
  Object.freeze(['provider-key', new RegExp(PROVIDER_KEY_SOURCE)] as const),
  Object.freeze(['bearer-token', new RegExp(BEARER_TOKEN_SOURCE, 'i')] as const),
  Object.freeze(['jwt', new RegExp(JWT_SOURCE)] as const),
  Object.freeze(['private-key', new RegExp(PRIVATE_KEY_SOURCE)] as const),
  Object.freeze(['connection-string', new RegExp(CONNECTION_STRING_SOURCE)] as const),
]);

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Shannon entropy of `value` in bits per character, over UTF-16 code units, in
 * one pass.
 *
 * Implemented here rather than imported, on purpose and in two directions:
 * `scripts/check-secrets.mjs` is a command-line tool outside every workspace
 * and cannot be imported at all, and `packages/telemetry` is not a permitted
 * dependency of this package (AAP §0.2.2). The three implementations agree
 * because they compute the same textbook quantity, and the colocated suite pins
 * the values that matter: `0` for an empty string and for one repeated
 * character, and at most `log2(n)` for `n` distinct characters — which is why
 * hexadecimal cannot clear {@link ENTROPY_MIN_BITS_PER_CHAR}.
 *
 * @param value - Value to measure. Never inspected for meaning.
 * @returns Bits of entropy per character; always finite and non-negative.
 */
export function shannonEntropy(value: string): number {
  if (value.length === 0) {
    return 0;
  }
  const counts = new Map<string, number>();
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charAt(index);
    counts.set(unit, (counts.get(unit) ?? 0) + 1);
  }
  let bits = 0;
  for (const count of counts.values()) {
    const probability = count / value.length;
    bits -= probability * Math.log2(probability);
  }
  return bits;
}

/**
 * Whether a field name denotes something whose value would be a credential.
 *
 * A case-insensitive substring test against {@link KEY_LIKE_NAME_TERMS}, which
 * is wider than the repository gate's separator-aware form: `apiKey`,
 * `API_KEY`, `x-api-key`, `clientSecret`, `accessToken` and `password` all
 * qualify, and so do `monkey` and `keystore`. That over-match is the intended
 * direction of error — see {@link KEY_LIKE_NAME_TERMS} — and it is harmless on
 * its own, because a name alone is never a finding: the value must also be at
 * least {@link ENTROPY_MIN_LENGTH} characters and denser than
 * {@link ENTROPY_MIN_BITS_PER_CHAR}.
 *
 * @param name - An object key, or the empty string where there is none.
 */
export function isKeyLikeName(name: string): boolean {
  if (name.length === 0) {
    return false;
  }
  const lowered = name.toLowerCase();
  return KEY_LIKE_NAME_TERMS.some((term) => lowered.includes(term));
}

/**
 * Whether a key names one of the six denied headers of
 * {@link DENIED_HEADER_NAMES}.
 *
 * Two spellings are recognised, because both reach an outbound payload:
 *
 * - the header name on its own, in any case (`Authorization`, `set-cookie`);
 * - a flattened attribute key whose **final dot-separated segment** is the
 *   header name, which is how a span attribute carries one
 *   (`http.request.header.authorization`, `http.response.header.set-cookie`).
 *
 * The test is exact per segment rather than a substring search, so a product
 * field whose name merely contains one of the six — `cookieConsentGiven`, say —
 * is not mistaken for a header. A value under such a name is still measured by
 * the entropy rule if its name is credential-like.
 *
 * @param key - The object key as it arrived, in any case, padded or not.
 */
export function isDeniedHeaderName(key: string): boolean {
  const normalised = key.trim().toLowerCase();
  if (normalised.length === 0) {
    return false;
  }
  if ((DENIED_HEADER_NAMES as readonly string[]).includes(normalised)) {
    return true;
  }
  const lastSeparator = normalised.lastIndexOf('.');
  if (lastSeparator < 0 || lastSeparator === normalised.length - 1) {
    return false;
  }
  return (DENIED_HEADER_NAMES as readonly string[]).includes(normalised.slice(lastSeparator + 1));
}

/**
 * Whether a denied header's value is the compliant output of the first
 * checkpoint.
 *
 * Two values are compliant: {@link REDACTION_MARKER} exactly, which is what the
 * ingest checkpoint writes, and a value that is empty or whitespace-only, which
 * is a header that arrived without one. Anything else — including a value that
 * merely *contains* the marker alongside other text, which is a partially
 * rewritten value and therefore evidence that something went wrong — is a
 * finding.
 */
function isRedactedHeaderValue(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length === 0 || trimmed === REDACTION_MARKER;
}

/**
 * Any whitespace, which is what separates prose from a credential.
 *
 * Read by the entropy rule only, and it is the same exclusion
 * `scripts/check-secrets.mjs` applies for the same reason: English prose
 * measures around four bits per character, right at the threshold, so measuring
 * a sentence under a credential-like name (`passwordHint`, `tokenNotes`) would
 * refuse legitimate calls while adding no credential class the rule could
 * otherwise see — a credential is issued as one unbroken token and never
 * carries a space. A credential *inside* a sentence is still found, by the
 * content rules, which read every string whatever it contains.
 */
const WHITESPACE = /\s/;

/** A key that can be written after a dot without quoting. */
const IDENTIFIER_KEY_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * Shortens an over-long path segment, marking the cut.
 *
 * Keys and URL parameter names are structure rather than data, so this is a
 * legibility bound and not a privacy measure; the marker is what keeps a
 * shortened segment from reading as a complete one.
 */
function shortenSegment(segment: string): string {
  if (segment.length <= PATH_SEGMENT_MAX_LENGTH) {
    return segment;
  }
  return (
    segment.slice(0, PATH_SEGMENT_MAX_LENGTH - PATH_SEGMENT_TRUNCATION_MARKER.length) +
    PATH_SEGMENT_TRUNCATION_MARKER
  );
}

/**
 * Appends an object key to a path.
 *
 * An identifier-shaped key is appended after a dot; anything else — a key with
 * dots, spaces, brackets or non-ASCII characters in it — is bracketed and
 * quoted, with `\` and `"` escaped, so the result is unambiguous:
 * `input.attributes["http.request.header.authorization"]`.
 *
 * A key shortened by {@link PATH_SEGMENT_MAX_LENGTH} therefore always comes out
 * bracketed, because {@link PATH_SEGMENT_TRUNCATION_MARKER} is not an
 * identifier character: a dotted form would read as a member access on a name
 * that cannot exist, while the quoted form says plainly that the key was cut.
 */
function appendKey(path: string, key: string): string {
  const segment = shortenSegment(key);
  if (IDENTIFIER_KEY_PATTERN.test(segment)) {
    return path.length === 0 ? segment : `${path}.${segment}`;
  }
  const quoted = segment.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `${path}["${quoted}"]`;
}

/** Appends an array index to a path: `input.spans[3]`. */
function appendIndex(path: string, index: number): string {
  return `${path}[${String(index)}]`;
}

/**
 * Appends a URL query parameter name to a path: `input.requests[0].url?page`.
 *
 * The `?` is a deliberate departure from the dotted-and-bracketed syntax: the
 * segment names a parameter *inside* a URL-valued field rather than a member of
 * an object, and spelling it the way a URL spells it is what makes that
 * readable. Only the parameter's name appears — never its value, which is the
 * thing the rule objects to.
 */
function appendQueryParameter(path: string, parameter: string): string {
  return `${path}${URL_QUERY_MASK}${shortenSegment(parameter)}`;
}

/**
 * Base used to parse an origin-relative URL.
 *
 * A reserved, unresolvable host, so nothing about it can be mistaken for a real
 * origin if it ever reaches a log line. It is never part of a finding: only the
 * parameter name is.
 */
const RELATIVE_URL_PROBE_BASE = 'http://probe.invalid/';

/**
 * The name of the first query parameter of `value` whose value is neither empty
 * nor {@link URL_QUERY_MASK}, or `undefined` when there is none.
 *
 * Structure is decided by the URL parser, never by a regular expression: a
 * pattern that tries to recognise a URL is wrong in ways that only show up on
 * the input that matters, whereas `new URL` is the same parser the browser and
 * the service use, and a value it rejects is not a URL. Both forms that reach a
 * payload are covered:
 *
 * - an **absolute** URL, parsed directly;
 * - an **origin-relative** URL (`/path?key=value`), parsed against
 *   {@link RELATIVE_URL_PROBE_BASE}. This form is not optional: the telemetry
 *   layer's own cross-checkpoint suite states the condition this rule enforces
 *   using origin-relative fixtures, because that is how a captured request
 *   target is usually spelled.
 *
 * Three bounds keep the rule from reporting things that are not URLs at all,
 * and they are the compromise this rule encodes:
 *
 * - The whole string must be one token: a value **containing whitespace is not
 *   examined**, so a URL embedded in prose is not checked here. That is a
 *   deliberate gap rather than an oversight — the prose in a request is rendered
 *   *from* the structured context, and the URL-valued fields of that context are
 *   each checked on their own, which is where a finding is actionable anyway.
 * - A string with no `?` in it cannot carry a query and is skipped before the
 *   parser is reached.
 * - A string longer than {@link URL_PARSE_MAX_LENGTH} is not parsed.
 *
 * A protocol-relative string (`//host/path`) is not treated as
 * origin-relative, because the parser would read its host as a path segment.
 */
function findUnmaskedQueryParameter(value: string): string | undefined {
  const candidate = value.trim();
  if (
    candidate.length === 0 ||
    candidate.length > URL_PARSE_MAX_LENGTH ||
    !candidate.includes('?') ||
    WHITESPACE.test(candidate)
  ) {
    return undefined;
  }
  let parsed: URL | undefined;
  try {
    parsed = new URL(candidate);
  } catch {
    parsed = undefined;
  }
  if (parsed === undefined && candidate.startsWith('/') && !candidate.startsWith('//')) {
    try {
      parsed = new URL(candidate, RELATIVE_URL_PROBE_BASE);
    } catch {
      parsed = undefined;
    }
  }
  if (parsed === undefined) {
    return undefined;
  }
  for (const [name, parameter] of parsed.searchParams) {
    if (parameter.length > 0 && parameter !== URL_QUERY_MASK) {
      return name;
    }
  }
  return undefined;
}

/**
 * Internal tags of the built-in objects whose contents this walk does not
 * enumerate.
 *
 * None of them can carry a credential *into a model request*, which is the only
 * question that matters here: a `Map`, a `Set` and a `WeakMap` serialise to
 * `{}`, a `Promise` to `{}`, an `Error`'s message is non-enumerable, a `Date`
 * to a timestamp string and a `RegExp` to `{}`. `ModelRequest.input` is typed
 * `JsonObject` precisely so none of them can appear; this list is the safety
 * net for a caller that hands the guard an `unknown`, and skipping them is what
 * keeps that safety net from reading a hostile `toString` or burning the node
 * budget on a typed array's indices.
 *
 * A **class instance** is deliberately *not* on this list. Its own enumerable
 * properties are exactly what `JSON.stringify` would send, so they are walked
 * like any other object's.
 */
const OPAQUE_OBJECT_TAGS: ReadonlySet<string> = new Set([
  '[object Map]',
  '[object Set]',
  '[object WeakMap]',
  '[object WeakSet]',
  '[object WeakRef]',
  '[object Promise]',
  '[object Date]',
  '[object RegExp]',
  '[object Error]',
  '[object Function]',
  '[object GeneratorFunction]',
  '[object AsyncFunction]',
  '[object ArrayBuffer]',
  '[object SharedArrayBuffer]',
  '[object DataView]',
]);

/**
 * Whether an object's contents are skipped rather than walked.
 *
 * Both tests are wrapped, because both can run page-supplied code on a hostile
 * object: `Object.prototype.toString` consults `Symbol.toStringTag`, which may
 * be an accessor, and `ArrayBuffer.isView` is safe but is reached through a
 * property lookup on a possible `Proxy`. A value that cannot even be classified
 * is treated as opaque — the conservative answer, since it is also a value no
 * JSON serialiser could send.
 */
function isOpaqueObject(value: object): boolean {
  try {
    if (ArrayBuffer.isView(value)) {
      return true;
    }
    return OPAQUE_OBJECT_TAGS.has(Object.prototype.toString.call(value));
  } catch {
    return true;
  }
}

/**
 * The own enumerable string keys of an object, or an empty list when they
 * cannot be read.
 *
 * `Object.keys` invokes a `Proxy`'s `ownKeys` and
 * `getOwnPropertyDescriptor` traps, either of which may throw; a null-prototype
 * object, by contrast, is read without ceremony. An unreadable key set is
 * reported as an inspection error by the caller rather than silently treated as
 * an empty object.
 */
function ownEnumerableKeys(value: object): readonly string[] | undefined {
  try {
    return Object.keys(value);
  } catch {
    return undefined;
  }
}

/**
 * The windows one string is scanned in, as `[start, end)` pairs over its code
 * units.
 *
 * The windows tile the **scanned region** — the first `maxStringLength` code
 * units, or the whole string when it is shorter — with a stride of
 * {@link SCAN_WINDOW_LENGTH}, and each one reads {@link SCAN_WINDOW_OVERLAP}
 * code units past where the next one begins. Two consequences, both deliberate:
 *
 * - Consecutive windows overlap, so a credential that straddles an interior
 *   window boundary lies wholly inside one of them.
 * - The last window reads the same distance past the region, so a credential
 *   that begins just before the cut is seen whole rather than beheaded.
 *
 * Total work is bounded by `maxStringLength + SCAN_WINDOW_OVERLAP` code units
 * however long the string is, and a `maxStringLength` **smaller** than one
 * window narrows the region as asked rather than being silently widened to a
 * window. See {@link SCAN_WINDOW_OVERLAP} for the one case the compromise does
 * not cover.
 */
function scanWindows(
  length: number,
  maxStringLength: number,
): readonly (readonly [number, number])[] {
  const region = Math.min(length, Math.max(0, maxStringLength));
  if (region === 0) {
    return [];
  }
  const windows: [number, number][] = [];
  let start = 0;
  while (start < region) {
    const end = Math.min(
      length,
      Math.min(start + SCAN_WINDOW_LENGTH, region) + SCAN_WINDOW_OVERLAP,
    );
    windows.push([start, end]);
    if (end >= length) {
      break;
    }
    start += SCAN_WINDOW_LENGTH;
  }
  return windows;
}

// ---------------------------------------------------------------------------
// The walk
// ---------------------------------------------------------------------------

/** The four bounds of one walk, resolved from options and defaults. */
interface WalkLimits {
  readonly maxDepth: number;
  readonly maxNodes: number;
  readonly maxStringLength: number;
  readonly maxFindings: number;
}

/**
 * Everything one walk carries: what to look for, what it may spend, what it has
 * found and where it had to stop.
 *
 * Mutable by design and private to this module — a walk is a fold over a tree
 * and threading four accumulators through every recursive call would obscure
 * the rules it applies. Nothing in the inspected value is mutated, which is the
 * promise that matters.
 */
interface WalkState {
  readonly rules: ReadonlySet<RedactionRuleId>;
  /**
   * The content patterns this walk applies, filtered by
   * {@link WalkState.rules} once rather than per string.
   */
  readonly contentPatterns: readonly (readonly [RedactionRuleId, RegExp])[];
  readonly limits: WalkLimits;
  readonly logger: Logger;
  readonly findings: RedactGuardFinding[];
  /** `ruleId` and `path`, joined, so one class is reported once per field. */
  readonly reported: Set<string>;
  /** Objects already walked, so a cycle is skipped rather than followed. */
  readonly visited: WeakSet<object>;
  readonly limitsReached: Set<RedactGuardLimitId>;
  nodes: number;
  /** Set once a walk-wide budget is gone: no further node is visited. */
  exhausted: boolean;
}

/** Separates the two halves of a {@link WalkState.reported} entry. */
const REPORTED_KEY_SEPARATOR = '\u0000';

/** Root path {@link inspectPayload} names the value it was given. */
export const DEFAULT_ROOT_PATH = 'input';

/**
 * Normalises one numeric bound: a non-finite or fractional value is floored,
 * and a negative one becomes zero.
 *
 * Zero is a legal bound and behaves the way a guard should: a zero depth, node
 * or string budget inspects nothing and records the bound, which makes the walk
 * incomplete and the payload refused. A caller cannot switch the guard off by
 * passing `0`, only by passing a bound wide enough to finish.
 */
function resolveBound(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(0, Math.floor(value));
}

/**
 * The rules one walk applies.
 *
 * An omitted list means every rule. A list naming unknown ids keeps only the
 * known ones. An **empty** effective list falls back to every rule and says so
 * at `warn`: a guard that can be configured to guard nothing would answer
 * "clean" for any payload at all, which is the one answer this module must
 * never give by accident.
 */
function resolveRules(
  rules: readonly RedactionRuleId[] | undefined,
  logger: Logger,
): ReadonlySet<RedactionRuleId> {
  if (rules === undefined) {
    return new Set(REDACTION_RULE_IDS);
  }
  const selected = new Set(REDACTION_RULE_IDS.filter((ruleId) => rules.includes(ruleId)));
  if (selected.size === 0) {
    logger.warn('Outbound redaction guard was given no applicable rule; applying all of them', {
      requested: rules.length,
    });
    return new Set(REDACTION_RULE_IDS);
  }
  return selected;
}

/** Builds the state for one walk from a caller's options. */
function createState(options: RedactGuardOptions | undefined): WalkState {
  const logger = options?.logger ?? noopLogger;
  const rules = resolveRules(options?.rules, logger);
  return {
    rules,
    contentPatterns: CONTENT_PATTERNS.filter(([ruleId]) => rules.has(ruleId)),
    limits: {
      maxDepth: Math.min(resolveBound(options?.maxDepth, DEFAULT_MAX_DEPTH), MAX_SUPPORTED_DEPTH),
      maxNodes: resolveBound(options?.maxNodes, DEFAULT_MAX_NODES),
      maxStringLength: resolveBound(options?.maxStringLength, DEFAULT_MAX_STRING_LENGTH),
      maxFindings: resolveBound(options?.maxFindings, DEFAULT_MAX_FINDINGS),
    },
    logger,
    findings: [],
    reported: new Set(),
    visited: new WeakSet(),
    limitsReached: new Set(),
    nodes: 0,
    exhausted: false,
  };
}

/**
 * Records that a bound was reached, once per bound, at `warn`.
 *
 * Once per bound rather than once per occurrence: a shallow `maxDepth` on a wide
 * tree would otherwise emit thousands of identical lines, and the first path is
 * as diagnostic as the ten-thousandth. The set of bounds reached is what travels
 * in the report, and the path is what travels in the log.
 */
function noteLimit(state: WalkState, limit: RedactGuardLimitId, path: string): void {
  if (state.limitsReached.has(limit)) {
    return;
  }
  state.limitsReached.add(limit);
  state.logger.warn('Outbound redaction guard stopped at a bound', { limit, path });
}

/**
 * Records one finding, unless this class has already been reported for this
 * path.
 *
 * Reaching {@link WalkLimits.maxFindings} stops the walk and records the bound.
 * It never softens the verdict: there is at least one finding, so the payload is
 * refused either way — the cap only keeps the report readable.
 */
function record(state: WalkState, ruleId: RedactionRuleId, path: string): void {
  const key = `${ruleId}${REPORTED_KEY_SEPARATOR}${path}`;
  if (state.reported.has(key)) {
    return;
  }
  if (state.findings.length >= state.limits.maxFindings) {
    noteLimit(state, 'max-findings', path);
    state.exhausted = true;
    return;
  }
  state.reported.add(key);
  state.findings.push({ ruleId, path, reason: REDACTION_RULE_REASONS[ruleId] });
}

/**
 * Applies every rule that needs only a string, plus the two that need a string
 * and its field name.
 *
 * Content patterns are applied window by window and each is dropped once it has
 * matched, so a ten-megabyte value costs at most one match per rule per window
 * and a repeated credential is reported once per field rather than once per
 * occurrence — a count of occurrences would be a measurement of the value,
 * which a finding may not carry.
 */
function scanString(state: WalkState, value: string, path: string, name: string): void {
  if (value.length === 0) {
    return;
  }
  const { maxStringLength } = state.limits;
  if (value.length > maxStringLength) {
    noteLimit(state, 'max-string-length', path);
  }
  const patterns = state.contentPatterns;
  if (patterns.length > 0) {
    const matched = new Set<RedactionRuleId>();
    for (const [start, end] of scanWindows(value.length, maxStringLength)) {
      if (matched.size === patterns.length || state.exhausted) {
        break;
      }
      const text = value.slice(start, end);
      for (const [ruleId, pattern] of patterns) {
        if (matched.has(ruleId) || !pattern.test(text)) {
          continue;
        }
        matched.add(ruleId);
        record(state, ruleId, path);
      }
    }
  }

  if (state.rules.has('url-query-value')) {
    const parameter = findUnmaskedQueryParameter(value);
    if (parameter !== undefined) {
      record(state, 'url-query-value', appendQueryParameter(path, parameter));
    }
  }

  if (state.rules.has('high-entropy-secret') && isKeyLikeName(name) && !WHITESPACE.test(value)) {
    // Measured over the scanned region only, so the bound on work holds here
    // too; a value longer than the bound has already recorded it, and its
    // prefix is representative of key material by construction.
    const measured = value.length > maxStringLength ? value.slice(0, maxStringLength) : value;
    if (
      measured.length >= ENTROPY_MIN_LENGTH &&
      shannonEntropy(measured) > ENTROPY_MIN_BITS_PER_CHAR
    ) {
      record(state, 'high-entropy-secret', path);
    }
  }
}

/** Narrows an object to an array whose members are `unknown` rather than `any`. */
function isUnknownArray(value: object): value is readonly unknown[] {
  return Array.isArray(value);
}

/**
 * Applies `sensitive-header` to the value found under a denied header name.
 *
 * Two value shapes are checked, which are the two a header legitimately has: a
 * string, and an array of strings (a repeated header, `set-cookie` above all).
 * A number, a boolean or `null` under such a key carries no credential and is
 * not reported; an object under such a key is walked like any other, so a
 * credential nested inside one is still found by the content rules and by the
 * entropy rule.
 */
function checkDeniedHeader(state: WalkState, value: unknown, path: string): void {
  if (typeof value === 'string') {
    if (!isRedactedHeaderValue(value)) {
      record(state, 'sensitive-header', path);
    }
    return;
  }
  if (typeof value !== 'object' || value === null || !isUnknownArray(value)) {
    return;
  }
  for (let index = 0; index < value.length; index += 1) {
    let element: unknown;
    try {
      element = value[index];
    } catch {
      // Unreadable: the walk visits the same element and records the error.
      continue;
    }
    if (typeof element === 'string' && !isRedactedHeaderValue(element)) {
      record(state, 'sensitive-header', appendIndex(path, index));
    }
  }
}

/**
 * Walks one value depth-first, applying every selected rule as it goes.
 *
 * What is skipped, and why none of it is a hole:
 *
 * - **A revisited object.** A `WeakSet` of visited objects makes a cycle — or a
 *   value shared between two fields — a skip rather than an infinite descent.
 *   The first visit inspected it.
 * - **A non-object, non-string value.** A number, a boolean, `null`,
 *   `undefined`, a symbol and a function cannot carry a credential into a
 *   request: the first four have no room for one and the last two are not
 *   serialisable at all.
 * - **An opaque built-in.** See {@link OPAQUE_OBJECT_TAGS}.
 *
 * What is *not* skipped is a class instance's own enumerable properties, since
 * those are exactly what a serialiser would send.
 *
 * The `name` argument is the nearest enclosing object key, which is what the
 * entropy rule binds to. An array **inherits its key**, so a credential in
 * `{ tokens: [ ... ] }` is measured under `tokens` rather than escaping because
 * its immediate parent was an array.
 */
function walk(state: WalkState, value: unknown, path: string, depth: number, name: string): void {
  if (state.exhausted) {
    return;
  }
  state.nodes += 1;
  if (state.nodes > state.limits.maxNodes) {
    noteLimit(state, 'max-nodes', path);
    state.exhausted = true;
    return;
  }
  if (typeof value === 'string') {
    scanString(state, value, path, name);
    return;
  }
  if (typeof value !== 'object' || value === null) {
    return;
  }
  if (state.visited.has(value)) {
    return;
  }
  state.visited.add(value);
  if (isOpaqueObject(value)) {
    return;
  }
  if (depth >= state.limits.maxDepth) {
    noteLimit(state, 'max-depth', path);
    return;
  }
  if (isUnknownArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (state.exhausted) {
        return;
      }
      const elementPath = appendIndex(path, index);
      let element: unknown;
      try {
        element = value[index];
      } catch {
        noteLimit(state, 'inspection-error', elementPath);
        continue;
      }
      walk(state, element, elementPath, depth + 1, name);
    }
    return;
  }
  const keys = ownEnumerableKeys(value);
  if (keys === undefined) {
    noteLimit(state, 'inspection-error', path);
    return;
  }
  for (const key of keys) {
    if (state.exhausted) {
      return;
    }
    const memberPath = appendKey(path, key);
    let member: unknown;
    try {
      member = (value as Record<string, unknown>)[key];
    } catch {
      // A throwing getter. The field is uninspected, so the walk is incomplete
      // and the payload is refused — which is also what would happen to a
      // caller trying to serialise it.
      noteLimit(state, 'inspection-error', memberPath);
      continue;
    }
    if (state.rules.has('sensitive-header') && isDeniedHeaderName(key)) {
      checkDeniedHeader(state, member, memberPath);
    }
    walk(state, member, memberPath, depth + 1, key);
  }
}

/** Freezes a walk's accumulated state into the report a caller sees. */
function toReport(state: WalkState): RedactGuardReport {
  const limitsReached = REDACT_GUARD_LIMIT_IDS.filter((limit) => state.limitsReached.has(limit));
  return Object.freeze({
    findings: Object.freeze([...state.findings]),
    complete: limitsReached.length === 0,
    limitsReached: Object.freeze(limitsReached),
    inspected: state.nodes,
  });
}

/**
 * Inspects any value and reports both what was found **and** whether the whole
 * value was examined.
 *
 * This is the shape a refusal decision needs, because "no findings" is only
 * equivalent to "safe" when {@link RedactGuardReport.complete} is true.
 * {@link inspectPayload} is the findings-only view of the same walk, and
 * {@link assertOutboundSafe} is the decision built on this one.
 *
 * Pure, and total: no I/O beyond the injected logger, no mutation of `value`,
 * and nothing thrown for any input — a cycle, a hostile `Proxy`, a throwing
 * getter, a null-prototype object, a ten-megabyte string and a deeply nested
 * array each have a defined outcome above.
 *
 * @param value - The payload to inspect. Typed `unknown` because this is a
 * safety net: a caller's `ModelRequest.input` is `JsonObject`, but a guard that
 * trusted the type would be no guard at all.
 * @param options - Rules, bounds, root path and logger. See
 * {@link RedactGuardOptions}.
 */
export function inspectPayloadReport(
  value: unknown,
  options?: RedactGuardOptions,
): RedactGuardReport {
  const state = createState(options);
  const rootPath = options?.rootPath ?? DEFAULT_ROOT_PATH;
  walk(state, value, rootPath, 0, '');
  return toReport(state);
}

/**
 * Every deny-list finding in `value`, in walk order.
 *
 * The findings-only view of {@link inspectPayloadReport}: convenient where a
 * caller wants to report or assert on what is there, and deliberately *not*
 * enough on its own to conclude that a payload is safe — an empty array can
 * also mean the walk hit a bound before it finished. Use
 * {@link inspectPayloadReport} (or {@link assertOutboundSafe}, which does it
 * for you) to decide whether to send.
 *
 * @param value - The payload to inspect.
 * @param options - Rules, bounds, root path and logger.
 * @returns A frozen array of findings, each naming a field and a rule and never
 * a value.
 */
export function inspectPayload(
  value: unknown,
  options?: RedactGuardOptions,
): readonly RedactGuardFinding[] {
  return inspectPayloadReport(value, options).findings;
}

/**
 * One line naming what was found: counts by rule class, with the field paths.
 *
 * Grouped in {@link REDACTION_RULE_IDS} order so two reports of the same
 * findings read identically, and capped at {@link SUMMARY_MAX_PATHS_PER_RULE}
 * paths per class so a message stays a message. Carries rule ids and paths and,
 * like every other output of this module, no value.
 *
 * @param findings - The findings to summarise, from {@link inspectPayload}.
 * @returns A human-readable summary, or `'no findings'` for an empty list.
 */
export function summarizeFindings(findings: readonly RedactGuardFinding[]): string {
  if (findings.length === 0) {
    return 'no findings';
  }
  const grouped = new Map<RedactionRuleId, string[]>();
  for (const finding of findings) {
    const paths = grouped.get(finding.ruleId);
    if (paths === undefined) {
      grouped.set(finding.ruleId, [finding.path]);
    } else {
      paths.push(finding.path);
    }
  }
  const parts: string[] = [];
  for (const ruleId of REDACTION_RULE_IDS) {
    const paths = grouped.get(ruleId);
    if (paths === undefined) {
      continue;
    }
    const shown = paths.slice(0, SUMMARY_MAX_PATHS_PER_RULE);
    const hidden = paths.length - shown.length;
    const tail = hidden > 0 ? `, +${String(hidden)} more` : '';
    parts.push(`${ruleId} \u00d7${String(paths.length)} (${shown.join(', ')}${tail})`);
  }
  return parts.join('; ');
}

// ---------------------------------------------------------------------------
// The refusal
// ---------------------------------------------------------------------------

/**
 * The code every refusal carries, from the **closed** `DEBUGGEN_ERROR_CODES`
 * tuple in `@debuggen/shared`.
 *
 * No code in that vocabulary names a redaction refusal, and inventing one is
 * not an option — the tuple is closed, `@debuggen/protocol` embeds its type in
 * the wire `error` payload, and both user interfaces switch over it. `INTERNAL`
 * is the honest classification of what has happened: a payload reached the
 * model boundary still carrying material that an upstream checkpoint was
 * supposed to have removed, which is a defect in the code that assembled it
 * rather than a state the developer put the product into.
 *
 * The three near neighbours were each considered and rejected for a specific
 * reason, recorded here so the choice is not re-litigated on a hunch:
 *
 * - **`MODEL_UNAVAILABLE`** is documented as the provider being unreachable or
 *   refusing the call, and AAP §0.5.5 maps it to the developer-facing
 *   instruction to check the API key or switch provider. Nothing is wrong with
 *   the provider here, and sending a developer to their credentials over a
 *   redaction defect wastes their time.
 * - **`MODEL_OUTPUT_INVALID`** is about a model's *output* failing its
 *   authoring schema, and the structured-output loop answers it with a repair
 *   attempt. A refusal here must never be retried: the payload is identical on
 *   the second attempt, so a retry is a second chance to leak, not a fix.
 * - **`CONFIG_INVALID`** would blame the environment for a defect in code.
 *
 * `INTERNAL`'s own documentation warns that reaching for it where a specific
 * code fits removes the only signal a user interface has. That warning is
 * respected rather than ignored: no specific code fits, and the specificity a
 * user interface needs is supplied through the error's `hint` (a remediation
 * sentence) and `details` (the rule ids and the field paths), both of which
 * `DebuggenError.toPayload` and the protocol's `error` payload carry.
 */
const REFUSAL_CODE: DebuggenErrorCode = 'INTERNAL';

/**
 * Remediation for a payload that still matches the deny list.
 *
 * Says the one thing a developer can act on — fix it where the payload is
 * assembled — and says explicitly that retrying will not help, because the
 * guard is not a redactor and the same request will be refused again unchanged.
 */
const REFUSAL_HINT =
  'Redact the field where the payload is assembled — telemetry is redacted at ingest and source excerpts are bounded by the context builder — then rebuild the request. This guard refuses a call and never rewrites a payload, so retrying the same request will be refused again.';

/** Remediation for a payload the guard could not finish inspecting. */
const INCOMPLETE_HINT =
  'Reduce the size, depth or nesting of the payload this stage assembles, or raise the guard bounds deliberately, so the whole payload can be inspected. A payload that was not inspected in full is never treated as safe.';

/**
 * Provenance for a refusal's `details`: which stage asked, with which prompt
 * version, for which session.
 *
 * Read defensively and separately from the walk, because a refusal must be
 * constructible even for a malformed request — the guard is the last thing
 * between a payload and the network, so it cannot be the thing that throws.
 * None of these values is a credential: a stage name and a prompt version are
 * repository constants and a session id is an opaque product identifier.
 */
function metadataDetails(request: ModelRequest): Record<string, unknown> {
  const details: Record<string, unknown> = {};
  try {
    const metadata = request.metadata;
    if (metadata !== undefined) {
      details.stage = metadata.stage;
      details.promptVersion = metadata.promptVersion;
      if (metadata.sessionId !== undefined) {
        details.sessionId = metadata.sessionId;
      }
    }
  } catch {
    // Provenance is context, not evidence: a refusal never depends on it.
  }
  return details;
}

/**
 * Inspects one request in a single pass: the system instruction, the rendered
 * prompt, every prior message's content and the structured context.
 *
 * One {@link WalkState} across all four is what makes it one pass — the node
 * budget, the finding cap, the cycle set and the reported set are shared — so a
 * request cannot spend four budgets, and a value shared between the prose and
 * the context is inspected once.
 *
 * Each field is walked under its own root path, so a finding says which half of
 * the dual payload it came from: `'system'`, `'prompt'`, `'messages[0].content'`
 * or the configured root for the structured context. The prose fields are
 * walked under their own field names, none of which is credential-like, which
 * is what keeps the entropy rule from measuring English: prose runs close to
 * the entropy threshold, and it is the *name binding* that stops a rendered
 * prompt being reported as a secret.
 *
 * `metadata` is deliberately **not** inspected. It is provenance rather than
 * payload — a stage name and a prompt version are repository constants and a
 * session id is an opaque product identifier — and none of it is sent to a
 * provider as prose or as data. It travels instead into a refusal's `details`,
 * where it says which stage assembled the payload that was refused.
 */
function inspectRequest(
  request: ModelRequest,
  options: RedactGuardOptions | undefined,
): RedactGuardReport {
  const state = createState(options);
  const system = request.system;
  if (system !== undefined) {
    walk(state, system, 'system', 0, 'system');
  }
  walk(state, request.prompt, 'prompt', 0, 'prompt');
  const messages = request.messages;
  if (messages !== undefined) {
    for (let index = 0; index < messages.length; index += 1) {
      const message = messages[index];
      if (message === undefined) {
        continue;
      }
      walk(state, message.content, `messages[${String(index)}].content`, 0, 'content');
    }
  }
  walk(state, request.input, options?.rootPath ?? DEFAULT_ROOT_PATH, 0, '');
  return toReport(state);
}

/**
 * Builds the refusal for a report that is not clean.
 *
 * Two shapes, because there are two ways to be unsafe: fields that matched, and
 * a payload that was not inspected in full. Both carry the same code and the
 * same guarantee — the message and the `hint` name rules, paths and next steps
 * and never a captured value, and `details` carries the machine-readable rule
 * ids, paths and bounds for a user interface to render.
 */
function buildRefusal(request: ModelRequest, report: RedactGuardReport): DebuggenError {
  const ruleIds = REDACTION_RULE_IDS.filter((ruleId) =>
    report.findings.some((finding) => finding.ruleId === ruleId),
  );
  const details: Record<string, unknown> = {
    ...metadataDetails(request),
    findingCount: report.findings.length,
    inspected: report.inspected,
    complete: report.complete,
  };
  if (ruleIds.length > 0) {
    details.ruleIds = ruleIds;
    details.paths = report.findings.map((finding) => finding.path);
  }
  if (report.limitsReached.length > 0) {
    details.limitsReached = [...report.limitsReached];
  }
  const message =
    report.findings.length > 0
      ? `Outbound model request refused: ${String(report.findings.length)} payload field(s) still match the redaction deny list (${summarizeFindings(report.findings)}).`
      : `Outbound model request refused: the payload could not be inspected in full (${report.limitsReached.join(', ')}), and an uninspected payload is never treated as safe.`;
  return new DebuggenError(REFUSAL_CODE, message, {
    hint: report.findings.length > 0 ? REFUSAL_HINT : INCOMPLETE_HINT,
    details: Object.freeze(details),
  });
}

/**
 * The gate every provider with a transport must pass before it sends anything.
 *
 * `ok(undefined)` means the whole request was inspected and nothing matched the
 * deny list. An `err` means the call must not be made — and the caller returns
 * that error **unchanged** rather than reinterpreting it: the Anthropic
 * provider calls this before it constructs a client, so
 * `providers/anthropic.test.ts` can assert that a payload with a denied pattern
 * never reaches the mocked transport. The deterministic provider needs no gate
 * because nothing it does leaves the machine, though calling it there is
 * harmless.
 *
 * The request is **never** mutated, redacted or partially sent. Refusal is the
 * contract; see this module's overview for why rewriting would be both
 * dishonest and incorrect.
 *
 * Nothing thrown, for any input: a malformed or hostile request produces a
 * refusal carrying the original as the error's `cause`, because the last thing
 * between a payload and the network cannot be the thing that throws.
 *
 * @param request - The request about to be sent, prose and structured context
 * alike.
 * @param options - Rules, bounds, root path and logger. See
 * {@link RedactGuardOptions}; the defaults are the product's configuration.
 * @returns `ok(undefined)` when the request may be sent; otherwise `err` with a
 * {@link DebuggenError} whose `details` name the rule ids and field paths and
 * whose `hint` says what to do.
 */
export function assertOutboundSafe(
  request: ModelRequest,
  options?: RedactGuardOptions,
): Result<void, DebuggenError> {
  let report: RedactGuardReport;
  try {
    report = inspectRequest(request, options);
  } catch (cause) {
    return err(
      new DebuggenError(
        REFUSAL_CODE,
        'Outbound model request refused: the payload could not be inspected, so it cannot be treated as safe.',
        {
          hint: INCOMPLETE_HINT,
          details: Object.freeze({
            ...metadataDetails(request),
            complete: false,
            limitsReached: ['inspection-error'],
          }),
          cause,
        },
      ),
    );
  }
  if (report.complete && report.findings.length === 0) {
    return ok(undefined);
  }
  return err(buildRefusal(request, report));
}
