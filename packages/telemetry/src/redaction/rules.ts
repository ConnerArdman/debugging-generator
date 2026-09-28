/**
 * Deny-list vocabulary and redaction primitives — the foundation of the
 * telemetry privacy boundary.
 *
 * Captured runtime values pass through these primitives at two checkpoints:
 *
 * 1. **Service ingest.** `redactor.ts` (with the specialised `headers.ts`,
 *    `url.ts` and `sql.ts` handlers) scrubs every event before it is
 *    persisted or broadcast on the live tail.
 * 2. **Outbound model guard.** Before any prompt payload leaves the machine
 *    the model provider re-checks it with an equivalent vocabulary and
 *    refuses the call when a denied pattern survived.
 *
 * Two hard constraints shape this module.
 *
 * - **It is import-free, deliberately.** The page-injected browser agent
 *   bundles `../browser/fiber-diff.ts`, which consumes these primitives, and
 *   the agent build fails when any input resolves to a Node builtin, a
 *   cross-package runtime dependency or a schema library. Nothing here may
 *   import anything — no `node:` builtin, no schema library, no sibling
 *   module, not even a type. Everything needed is declared locally, and the
 *   truncation bound is a parameter rather than an import so that the single
 *   definition of the preview length stays in `../schema/attributes.ts`.
 * - **This file's own source is scanned for secrets.** The repository secret
 *   gate scans tracked content with the same rule classes implemented below,
 *   so every pattern is assembled at module load from short fragments and
 *   character classes: no credential prefix, token body or key-file header
 *   ever appears as a contiguous literal here, and no long literal is bound
 *   to a key-like identifier. Keeping the fragments split is what lets the
 *   gate pass without an allowlist entry.
 *
 * The rule ids and the replacement marker are shared — by convention, never
 * by an import edge — with the outbound model guard and the repository
 * secret gate. The package dependency graph forbids those three enforcement
 * points from depending on one another, so one vocabulary across them is a
 * documentation-and-test discipline rather than a compile-time guarantee.
 *
 * Every function here is pure: no I/O, no globals, no clock, no randomness
 * and no mutable module state beyond the frozen pattern table.
 */

/**
 * Replacement written in place of a denied value.
 *
 * The bytes are load-bearing: the outbound model guard declares the same
 * literal independently and treats a value equal to it as already redacted,
 * so an already-scrubbed payload passes the second checkpoint unchanged.
 */
export const REDACTION_MARKER = '[redacted]';

/**
 * Single-character mask written per removed URL query-parameter value and
 * per inline SQL literal.
 *
 * `url.ts` and `sql.ts` both replace values with this token, which keeps the
 * shape of a URL or statement diagnosable while removing its data. It lives
 * here so the two handlers cannot drift apart.
 */
export const REDACTION_MASK = '?';

/** Suffix appended by {@link truncate} (U+2026 HORIZONTAL ELLIPSIS). */
export const TRUNCATION_SUFFIX = '\u2026';

/**
 * The complete deny-list vocabulary, in reporting order.
 *
 * `url-query-value` classifies a value by its position rather than by its
 * content, so it is reported by `url.ts` and `redactor.ts` only.
 * `sensitive-header` is both: `headers.ts` and `redactor.ts` report it for a
 * value found under a denied header name, and it is also the content rule that
 * recognises a sensitive header *line* inside free text
 * (`Authorization: Bearer …`, `Cookie: session=…`), which
 * {@link findDeniedRules} reports like every other content rule. The remaining
 * ids are content or name driven and are reported by {@link findDeniedRules}.
 * Five ids (`provider-key`, `jwt`, `private-key`, `connection-string`,
 * `entropy`) deliberately match the repository secret gate's rule ids so that
 * logs, findings reports and documentation use one vocabulary across all three
 * enforcement points.
 *
 * Three ids are **ingest-only**: `email-address`, `payment-card` and
 * `labelled-secret` recognise private values that carry no credential shape —
 * an address or a card number quoted in an element's text or an error
 * message, a value introduced by a word such as `token` or `password` — and
 * mask them before an event is stored or tailed. Neither the outbound model
 * guard nor the repository secret gate knows them, deliberately: the source
 * excerpts a stage sends may legitimately contain an address or a test card
 * number, and refusing those would fail the pipeline on the developer's own
 * code. Their position in this list — after `connection-string`, and in this
 * order — is also the order they run in, which is load-bearing (see
 * {@link PATTERN_RULES}).
 */
export const REDACTION_RULE_IDS = [
  'sensitive-header',
  'provider-key',
  'bearer-token',
  'jwt',
  'private-key',
  'connection-string',
  'email-address',
  'payment-card',
  'labelled-secret',
  'url-query-value',
  'entropy',
] as const;

/** One rule of the deny-list vocabulary. */
export type RedactionRuleId = (typeof REDACTION_RULE_IDS)[number];

/**
 * Shortest value length considered for the entropy heuristic. Shorter values
 * carry too little signal for an entropy estimate to mean anything.
 */
export const ENTROPY_MIN_LENGTH = 32;

/**
 * Entropy threshold in bits per character, above which a value of at least
 * {@link ENTROPY_MIN_LENGTH} characters is treated as a likely credential.
 */
export const ENTROPY_MIN_BITS_PER_CHAR = 4;

/**
 * Upper bound, in UTF-16 code units, on how much of a value {@link scrub}
 * examines — and therefore on the length of what it returns.
 *
 * Arbitrary page data reaches this module on every captured event, so the
 * scan is bounded rather than unbounded. Input beyond the bound is never
 * returned unscanned: {@link scrub} replaces the unexamined tail with
 * {@link REDACTION_MARKER}.
 */
export const MAX_SCAN_LENGTH = 16_384;

/*
 * ---------------------------------------------------------------------------
 * Pattern fragments
 *
 * Each pattern is assembled from short pieces so that this tracked file
 * contains no contiguous credential prefix, token body or key-file header
 * (see the module documentation). The split points are the only reason these
 * concatenations are not written as single literals.
 *
 * Every quantifier below is bounded and no pattern uses a backreference or a
 * lookbehind, so none can backtrack catastrophically over hostile input.
 * ---------------------------------------------------------------------------
 */

/** Bound applied to trailing runs, tied to the window {@link scrub} reads. */
const RUN_LIMIT = String(MAX_SCAN_LENGTH);

/**
 * A run of `chars` that identifies a credential at between `min` and
 * `identifyingMax` characters and then consumes the rest of the run.
 *
 * The second quantifier is what keeps a credential longer than its usual
 * shape from leaving a tail of key material behind: without it, a replaced
 * match ends mid-run and the remainder survives the scrub. Nothing follows
 * the trailing run in any pattern that uses this helper, so the engine
 * matches it greedily and never backtracks over it.
 */
function wholeRun(chars: string, min: number, identifyingMax: number): string {
  const head = '{' + String(min) + ',' + String(identifyingMax) + '}';
  const tail = '{0,' + String(MAX_SCAN_LENGTH - identifyingMax) + '}';
  return chars + head + chars + tail;
}

/** Base64url and opaque token body characters. */
const TOKEN_CHARS = '[A-Za-z0-9_-]';

/** Body characters of underscore-delimited forge tokens. */
const WORD_CHARS = '[A-Za-z0-9_]';

/** Body characters of upper-case access identifiers. */
const UPPER_CHARS = '[0-9A-Z]';

/** Credential characters permitted after an HTTP authentication scheme. */
const BEARER_CHARS = '[A-Za-z0-9._~+/=-]';

/**
 * Provider credential shapes: the prefix that identifies each one and the
 * characters its body is drawn from.
 *
 * Prefix and body are held apart rather than written as one pattern so the
 * two patterns that need them — the rule itself and its crossing-run
 * counterpart (see {@link CROSSING_LIMIT}) — are built from one description
 * of each shape and cannot drift apart.
 */
interface ProviderShape {
  /** Pattern source for the prefix that identifies the shape. */
  readonly prefix: string;
  /** Character class its body is drawn from. */
  readonly chars: string;
  /** Body characters needed before the shape is treated as a credential. */
  readonly min: number;
  /** Body characters the shape's usual form carries. */
  readonly identifyingMax: number;
}

const PROVIDER_SHAPES: readonly ProviderShape[] = [
  { prefix: 's' + 'k-(?:ant-)?', chars: TOKEN_CHARS, min: 16, identifyingMax: 256 },
  { prefix: 'gh' + 'p_', chars: WORD_CHARS, min: 16, identifyingMax: 256 },
  { prefix: 'git' + 'hub_pat_', chars: WORD_CHARS, min: 16, identifyingMax: 256 },
  { prefix: 'AK' + 'IA', chars: UPPER_CHARS, min: 12, identifyingMax: 20 },
];

/** Provider credential shapes, each identified by its own prefix. */
const PROVIDER_ALTERNATIVES: readonly string[] = PROVIDER_SHAPES.map(
  (shape) => shape.prefix + wholeRun(shape.chars, shape.min, shape.identifyingMax),
);

/** `provider-key`: a prefixed provider credential, identifying on its own. */
const PROVIDER_SOURCE = '(?:' + PROVIDER_ALTERNATIVES.join('|') + ')';

/**
 * `bearer-token`: an HTTP bearer credential. The scheme word is captured so
 * that only the credential is replaced and its presence stays observable.
 *
 * The credential must be at least eight characters long, and that threshold
 * is deliberate. This rule runs over every captured string, and a bare
 * `bearer` followed by a short word is ordinary English — "bearer token",
 * "the bearer of", "bearer auth" — so matching any length here would replace
 * prose in labels, messages and questions for no privacy gain. A short
 * credential is not left behind by it: where one actually appears, inside a
 * header line such as `Authorization: Bearer abc`, the `sensitive-header`
 * line rule (see {@link HEADER_LINE_SOURCE}) replaces the whole value however
 * short it is, and that rule runs first.
 */
const BEARER_SOURCE = '\\b(bearer)\\s+' + wholeRun(BEARER_CHARS, 8, 4096);

/** JOSE header segment, identified by the base64url prefix of `{"`. */
const JWT_HEAD = 'ey' + 'J' + TOKEN_CHARS + '{8,' + RUN_LIMIT + '}';

/** JOSE payload segment, required — one `.` is what makes this a token. */
const JWT_PAYLOAD = '\\.' + TOKEN_CHARS + '{4,' + RUN_LIMIT + '}';

/**
 * JOSE signature segment, optional and possibly empty: an unsigned token
 * carries a trailing `.` with nothing after it, and a token cut by the scan
 * window has no third segment at all. Leaving the group optional means such
 * a token is still replaced rather than passed through with its header and
 * payload intact.
 */
const JWT_SIGNATURE = '(?:\\.' + TOKEN_CHARS + '{0,' + RUN_LIMIT + '})?';

/**
 * `jwt`: a JOSE compact-serialisation token. Segment bounds are the scan
 * window rather than a token-shaped guess, so an unusually large payload is
 * matched instead of slipping through, and the segment characters exclude
 * `.`, so each run ends at its separator and the pattern stays linear.
 */
const JWT_SOURCE = JWT_HEAD + JWT_PAYLOAD + JWT_SIGNATURE;

/** Label between a key-file delimiter and its trailing dashes. */
const PEM_LABEL = '[A-Z0-9 ]{0,40}';

/**
 * Trailing words and dashes shared by the header and the footer.
 *
 * Five of the six delimiters the repository secret gate recognises end in
 * `PRIVATE KEY` (`RSA`, `EC`, `DSA` and `OPENSSH` labels, plus the bare form);
 * the sixth, a PGP key block, spells it `PRIVATE KEY BLOCK`, which is why the
 * bounded ` BLOCK` suffix is optional here. Permitting the suffix rather than
 * enumerating the six labels keeps this rule deliberately *wider* than the
 * gate — any label ending in `PRIVATE KEY`, with or without ` BLOCK`, matches,
 * including one no enumeration would have anticipated — and over-matching is
 * the safe direction for a privacy boundary.
 */
const PEM_SUFFIX = 'PRIVATE' + ' KEY' + '(?: BLOCK)?' + '-{5}';

/**
 * Text form of {@link PEM_SUFFIX}, used as the private-key continuation when a
 * cut lands inside an opening delimiter (see {@link BOUNDARY_OVERLAP}). It is
 * plain text rather than a pattern, so it carries no quantifier.
 */
const PEM_SUFFIX_TEXT = 'PRIVATE' + ' KEY' + '-'.repeat(5);

/** `private-key`: the opening delimiter of a PEM private-key block. */
const PEM_HEADER_SOURCE = '-{5}BEGIN' + PEM_LABEL + PEM_SUFFIX;

/** The closing delimiter of a PEM private-key block. */
const PEM_FOOTER_SOURCE = '-{5}END' + PEM_LABEL + PEM_SUFFIX;

/** A complete PEM block: header, bounded body, footer. */
const PEM_BLOCK_SOURCE = PEM_HEADER_SOURCE + '[\\s\\S]{0,8192}?' + PEM_FOOTER_SOURCE;

/**
 * An unterminated PEM block: the header and everything after it. The bound
 * equals {@link MAX_SCAN_LENGTH} because {@link scrub} never applies a
 * pattern to more than that many code units, so it always reaches the end.
 */
const PEM_OPEN_SOURCE = PEM_HEADER_SOURCE + '[\\s\\S]{0,' + RUN_LIMIT + '}';

/** URL scheme, kept in the output so a redacted URL stays diagnosable. */
const SCHEME_SOURCE = '[A-Za-z][A-Za-z0-9+.-]{1,31}';

/** User part of a URL's userinfo; excludes `:` so the split is unambiguous. */
const USERINFO_USER = '[^\\s/?#@:]{1,256}';

/**
 * Password part of a URL's userinfo. Excluding `/`, `?` and `#` is what keeps
 * a `host:port` authority followed by an `@` inside a path from being
 * mistaken for a credential.
 */
const USERINFO_PASS = '[^\\s/?#@]{1,256}';

/**
 * `connection-string`: credentialed userinfo in an absolute URL. The scheme
 * is captured, and the authority after `@` is left alone, so a redacted
 * connection string stays diagnosable.
 */
const USERINFO_SOURCE = '(' + SCHEME_SOURCE + '://)' + USERINFO_USER + ':' + USERINFO_PASS + '@';

/*
 * ---------------------------------------------------------------------------
 * Personal data and labelled secrets in free text
 *
 * The rules above recognise a credential by its own shape. The three below
 * recognise values that have no credential shape and are private because of
 * what they are — an e-mail address, a payment card number — or because of
 * the word in front of them (`token secret-token-123`, `password=hunter22`).
 * Element text, error messages and stack text quote such values freely, and
 * every string attribute reaches these rules through `scrub`, so they are what
 * keeps them out of the store and the live tail.
 *
 * Each pattern consumes the character in front of its match as capture group
 * 1 (the kept prefix, by the convention of {@link PatternRule}) instead of
 * asserting a boundary, because this module uses no lookbehind. That same
 * boundary is what makes a match start where its run starts: a scan position
 * inside a run fails at once, so a long run is never matched from its middle.
 * ---------------------------------------------------------------------------
 */

/** Characters of an address's local part: the dot-atom characters addresses use in practice. */
const EMAIL_LOCAL_CHARS = '[A-Za-z0-9._%+-]';

/**
 * `email-address`: `local@domain.tld`, replaced whole — the domain can
 * identify a person as well as the local part can.
 *
 * The domain is one to eight labels and an alphabetic top-level label, and
 * the address must not continue into another label character. That keeps a
 * version specifier (`react@19.3.0`), a stack frame naming a function before
 * its URL (`handleClick@http://…`, where `http:` is no label) and a scoped
 * package name (`@scope/name`, which has no local part) from reading as an
 * address. An `@` inside a URL's authority (`//user:pw@host.test/`) is
 * userinfo rather than an address, and is left to the rules that own it —
 * see {@link maskEmailAddress}.
 */
const EMAIL_ADDRESS_SOURCE =
  '(^|[^A-Za-z0-9._%+-])' +
  EMAIL_LOCAL_CHARS +
  '{1,64}@(?:[A-Za-z0-9-]{1,63}\\.){1,8}[A-Za-z]{2,63}(?![A-Za-z0-9-])';

/** Fewest digits of a payment card number (ISO/IEC 7812 primary account number). */
const CARD_MIN_DIGITS = 13;

/** Most digits of a payment card number. */
const CARD_MAX_DIGITS = 19;

/**
 * A candidate for `payment-card`: a run of digits with at most one space or
 * hyphen between any two, starting where a word starts.
 *
 * Deliberately wider than a card. Which part of the run is a card number, if
 * any, is decided by {@link maskCardRun} — the Luhn checksum is arithmetic, not
 * a pattern. The repeat bound is the scan window, so a run inside the window
 * is always read whole: a run cut in two by a bound would be judged as two runs
 * on one pass and as one run on the next, and {@link scrub} would stop being
 * idempotent.
 */
const CARD_RUN_SOURCE =
  '(^|[^A-Za-z0-9_])[0-9](?:[ -]?[0-9]){' +
  String(CARD_MIN_DIGITS - 1) +
  ',' +
  String(MAX_SCAN_LENGTH) +
  '}';

/**
 * The words that label the value after them as a secret, as pattern sources.
 *
 * The same credential vocabulary {@link SENSITIVE_NAME_TERMS} applies to
 * names, narrowed to the words that introduce a value in prose: `key` and
 * `auth` alone are too common in ordinary text ("primary key 12", "auth
 * failed"), so a key only counts when it is an API or access key. A term may
 * end a longer identifier (`access_token`, `clientSecret`, `DB_PASSWORD`),
 * which the identifier run in front of it in {@link LABELLED_SECRET_SOURCE}
 * absorbs.
 */
const SECRET_LABEL_TERMS: readonly string[] = [
  'token',
  'secret',
  'password',
  'passwd',
  'pwd',
  'passphrase',
  'api[_-]?key',
  'access[_-]?key',
];

/** Characters of a labelled value: the credential characters a token, key or password is written in. */
const LABEL_VALUE_CHARS = '[A-Za-z0-9._~+/=-]';

/** An optional quote around a label or a value, written plain or JSON-escaped (`\"`). */
const LABEL_QUOTE = '(?:\\\\?["\'])?';

/**
 * A digit within the first 256 characters of the value.
 *
 * The requirement is what separates a value from prose: "Invalid token
 * provided", "password: Required" and "token expired" carry no digit, while
 * generated tokens, keys and nearly every password do. The window is bounded
 * so that a hostile run of labels inside one long value costs a bounded amount
 * per label rather than a rescan of the whole run.
 */
const LABEL_DIGIT_AHEAD = '(?=' + LABEL_VALUE_CHARS + '{0,255}[0-9])';

/** `token: …`, `password=…`: an assignment, with blanks allowed around the separator. */
const LABEL_ASSIGNED = '[ \\t]{0,16}[:=][ \\t]{0,16}' + LABEL_QUOTE;

/**
 * `token …`: a label followed by blanks only. A value in that position needs
 * six characters as well as a digit, because prose puts short words and
 * numbers after these terms far more often than an assignment does.
 */
const LABEL_SPACED = '[ \\t]{1,16}' + LABEL_QUOTE + '(?=' + LABEL_VALUE_CHARS + '{6})';

/**
 * `labelled-secret`: a value introduced by a credential word. The kept prefix
 * (group 1) is everything up to the value — the boundary, the label, its
 * quotes and the separator — so `token secret-token-123` becomes
 * `token [redacted]` and the label stays diagnosable.
 *
 * A label directly after `?`, `&` or `#` is a query or fragment parameter, and
 * is left to `./url.ts`, which masks the value positionally to `?`; masking it
 * here first would leave the marker standing as the parameter's value, which
 * reads worse and says less. The two denied header names that end in a label
 * (`X-Api-Key:`, `X-Auth-Token:`) are left to the `sensitive-header` line rule,
 * which already replaces their whole value, so one header line is one
 * finding. A value is never `[redacted]` — `[` is outside
 * {@link LABEL_VALUE_CHARS} — so the rule is a fixed point of its own output.
 */
const LABELLED_SECRET_SOURCE =
  '((?:^|[^A-Za-z0-9_?&#-])(?!(?:x-api-key|x-auth-token)[ \\t]*:)[A-Za-z0-9_-]{0,32}(?:' +
  SECRET_LABEL_TERMS.join('|') +
  ')' +
  LABEL_QUOTE +
  '(?:' +
  LABEL_ASSIGNED +
  '|' +
  LABEL_SPACED +
  ')' +
  LABEL_DIGIT_AHEAD +
  ')' +
  LABEL_VALUE_CHARS +
  '{4,' +
  RUN_LIMIT +
  '}';

/**
 * The six header names whose value is always replaced, lower-cased.
 *
 * The same list as `DENIED_HEADER_NAMES` in `./headers.ts` and as the outbound
 * model guard's own copy — shared by convention, never by an import edge,
 * because this module imports nothing. The colocated tests assert that every
 * name `./headers.ts` denies is masked here as a header line, which is what
 * keeps the copies aligned.
 *
 * A name that another name ends with comes after it (`proxy-authorization`
 * before `authorization`, `set-cookie` before `cookie`), so the alternation
 * reads the longer name whenever the text carries it.
 */
const HEADER_LINE_NAMES: readonly string[] = [
  'proxy-authorization',
  'authorization',
  'set-cookie',
  'cookie',
  'x-api-key',
  'x-auth-token',
];

/**
 * Pattern source for `word` in any letter case, one character class per
 * letter.
 *
 * Used instead of the `i` flag so that case-insensitivity applies to the
 * header names alone: the already-redacted test in {@link HEADER_LINE_SOURCE}
 * must match {@link REDACTION_MARKER} byte for byte, and under `i` it would
 * also accept `[REDACTED]`, which is not the marker and must not be treated as
 * one. Non-letters (the `-` inside a name) are literal outside a class.
 */
function anyCase(word: string): string {
  let source = '';
  for (const character of word) {
    const lower = character.toLowerCase();
    const upper = character.toUpperCase();
    source += lower === upper ? character : '[' + lower + upper + ']';
  }
  return source;
}

/** Escapes every pattern metacharacter in `text`, so it matches only itself. */
function literalSource(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * What must precede a header name: the start of the text, or one character
 * that cannot continue a name.
 *
 * The class is the character set of a header token as it is written in
 * practice, so `mycookie:` and `x-cookie:` are other names rather than a
 * `cookie` header, while `note: Cookie: …`, a line break or a quote in front of
 * the name all qualify. So does a written whitespace escape — `\n`, `\r`,
 * `\t`, `\f` or `\u000b`, as `JSON.stringify` and string literals write a line
 * break or a tab — because the outbound guard reads a JSON-rendered prompt
 * section's `…\nAuthorization: …` as a header line, and text that went through
 * this rule must never be one it refuses. It is consumed rather than asserted,
 * because this module uses no lookbehind; it is therefore part of the kept
 * prefix.
 */
const HEADER_NAME_BOUNDARY = '(?:^|\\\\(?:[nrtf]|u000[bB])|[^A-Za-z0-9_-])';

/** One of {@link HEADER_LINE_NAMES}, in any letter case. */
const HEADER_NAME_SOURCE = '(?:' + HEADER_LINE_NAMES.map(anyCase).join('|') + ')';

/** Spaces and tabs around the separator: never a line break. */
const HEADER_SPACING = '[ \\t]{0,' + RUN_LIMIT + '}';

/**
 * The kept prefix of a header line, as capture group 1: the boundary, the
 * name, the `:` separator and the spacing on both sides of it — everything
 * that says *which* header was there and nothing of what it carried.
 */
const HEADER_PREFIX_SOURCE =
  '(' + HEADER_NAME_BOUNDARY + HEADER_NAME_SOURCE + HEADER_SPACING + ':' + HEADER_SPACING + ')';

/**
 * A header value: the rest of the line, starting at its first character that
 * is not a space or a tab. A line break ends it, so a multi-line value loses
 * only the header's own line; an empty value (`Cookie:` at the end of a line)
 * has nothing to hide and is not matched.
 */
const HEADER_VALUE_SOURCE = '[^ \\t\\r\\n][^\\r\\n]{0,' + RUN_LIMIT + '}';

/**
 * Pattern source matching any prefix of `text` — the empty one and `text`
 * itself included — as nested optional groups, so a mismatch backtracks at
 * most `text.length` steps.
 */
function prefixSource(text: string): string {
  let source = '';
  for (const character of Array.from(text).reverse()) {
    source = '(?:' + literalSource(character) + source + ')?';
  }
  return source;
}

/**
 * Refuses a value that is already redacted, in one of two forms:
 *
 * - exactly {@link REDACTION_MARKER}, ending at a line break or at the end of
 *   the text. That is the form this rule produces, so the rule is a fixed
 *   point of its own output, and it is the form the outbound model guard
 *   treats as already redacted rather than as a finding;
 * - a prefix of the marker (possibly empty) followed by
 *   {@link TRUNCATION_SUFFIX} at the very end of the text — `Cookie: [red…`,
 *   `Cookie: …`. That is what {@link truncate} leaves when a preview bound
 *   cuts a redacted header line, and it is made of fixed characters only, so
 *   it carries nothing to hide. Treating it as a value would make a bounded
 *   preview stop being a fixed point of {@link scrub}: a second pass would
 *   re-mask it, report a finding that hides nothing, and the preview would be
 *   cut back to the same text.
 *
 * Exact, not case-folded: `[REDACTED]` is not the marker and is replaced.
 */
const HEADER_ALREADY_REDACTED =
  '(?!' +
  literalSource(REDACTION_MARKER) +
  '(?:[\\r\\n]|$)|' +
  prefixSource(REDACTION_MARKER) +
  literalSource(TRUNCATION_SUFFIX) +
  '$)';

/**
 * `sensitive-header`: a sensitive header written out as a line of free text —
 * `Authorization: Bearer abc`, `note: Cookie: session=abc; theme=dark`,
 * `X-Api-Key:k` — anywhere in a captured string, a question or a label.
 *
 * `./headers.ts` masks a header value by *position*, when it arrives under a
 * header attribute key or inside a header map. The same header copied into a
 * log message, an error string or a page's own text arrives under an ordinary
 * key, and no other content rule recognises it: a short bearer credential is
 * below the bearer rule's threshold and a cookie has no credential shape at
 * all. So the line itself is the pattern: one of the six denied names, a `:`,
 * and a non-empty value. The whole value is replaced — never only a token
 * inside it — which is how `./headers.ts` treats the same header, and the name
 * is kept so the header's presence stays diagnosable:
 * `Authorization: Bearer abc` becomes `Authorization: [redacted]`.
 */
const HEADER_LINE_SOURCE = HEADER_PREFIX_SOURCE + HEADER_ALREADY_REDACTED + HEADER_VALUE_SOURCE;

/**
 * Every sensitive header line with a value, the already-redacted form
 * included — the form {@link cutAtCredentialBoundary} locates.
 *
 * The cut has to move back to the kept prefix even when the value is already
 * the marker: a cut inside `Cookie: [redacted]` followed by a line break would
 * otherwise leave `Cookie: [reda` in front of the appended marker, a value the
 * rule no longer recognises as redacted, and the cut result would stop being
 * a fixed point of {@link scrub}. Moved back, the cut produces the same
 * `Cookie: [redacted]` the replacement produces.
 */
const HEADER_LINE_LOCATE_SOURCE = HEADER_PREFIX_SOURCE + HEADER_VALUE_SOURCE;

/*
 * ---------------------------------------------------------------------------
 * Cut boundaries
 *
 * Every rule above identifies a credential by a prefix followed by a bounded
 * run, so cutting a value *before* the patterns run can discard the run that
 * identifies a credential while keeping the prefix that reveals it — a value
 * cut mid-credential comes back carrying the head of that credential in plain
 * text. {@link cutAtCredentialBoundary} is what keeps a cut from doing that,
 * and the two constants below are what it reasons with.
 * ---------------------------------------------------------------------------
 */

/**
 * Code units past a cut that {@link cutAtCredentialBoundary} examines before
 * deciding where to cut.
 *
 * Reading past the cut is what lets a credential the cut would split be seen
 * *whole*: the rule that owns it matches across the cut, and the cut moves
 * back to where the credential begins. Every rule reaches its decision within
 * a bounded prefix, and the longest of them belongs to
 * {@link USERINFO_SOURCE}: a scheme, its separator, a user, a colon, a
 * password and the terminating `@`, which is 31 + 3 + 256 + 1 + 256 + 1 = 548
 * code units at their bounds. This window is wider than any rule needs.
 *
 * The parts of that URI are named rather than written out as one specimen on
 * purpose: `scripts/check-secrets.mjs` scans this tracked file with its own
 * `connection-string` rule, and a credentialed URI spelled contiguously here —
 * placeholder or not — fails the commit gate, exactly as the module
 * documentation above says of every other credential shape.
 */
const BOUNDARY_OVERLAP = 1_024;

/**
 * Character appended past a cut to stand in for text the window did not
 * reach.
 *
 * It belongs to every body class above — token, word, upper-case identifier,
 * bearer credential, URL password and PEM label — so one character serves
 * every rule. Its purpose is to answer the question a cut cannot otherwise
 * answer: *could* the text at the cut have been the start of a credential
 * whose remainder was never examined? Where the examined window already
 * settles that question — because the real text breaks the run — no
 * continuation can revive it, which is what keeps this from over-redacting a
 * value whose tail is merely credential-shaped prose.
 */
const CONTINUATION_CHAR = 'A';

/**
 * A continuation run long enough to satisfy every identifying minimum in the
 * table (the longest is 16, for a provider credential).
 */
const CONTINUATION_RUN = CONTINUATION_CHAR.repeat(64);

/**
 * Bound for the crossing-run patterns below: the longest text
 * {@link cutAtCredentialBoundary} ever applies one to, which is the cut plus
 * the window it examines past it.
 *
 * It is deliberately larger than {@link MAX_SCAN_LENGTH}, the bound the rules
 * themselves use. A rule whose match needs a *terminator* after a bounded run
 * — the `.` that separates a JOSE token's segments, the `@` that ends a URL's
 * userinfo — cannot match at all once the run in front of that terminator is
 * longer than the rule's own bound, and a credential in exactly that state is
 * the one a cut is most likely to fall inside. The crossing-run patterns exist
 * for that case and so must be able to span everything they are shown.
 */
const CROSSING_LIMIT = String(MAX_SCAN_LENGTH + BOUNDARY_OVERLAP);

/*
 * Crossing-run sources. Each matches its rule's *identifying prefix* followed
 * by a run of its body characters that reaches the end of the text — never a
 * whole credential, which is what the rules above are for. Used only by
 * {@link cutAtCredentialBoundary}, and only when the run continues past
 * everything the cut window examined, which is the one situation in which
 * whether the text is a credential cannot be decided from what was read.
 *
 * `private-key` has no crossing run: its rule needs no terminator after a run,
 * so a delimiter inside the examined text always matches, and key material
 * only ever follows a complete delimiter.
 */
const PROVIDER_CROSSING_SOURCE =
  '(?:' +
  PROVIDER_SHAPES.map((shape) => shape.prefix + shape.chars + '{0,' + CROSSING_LIMIT + '}').join(
    '|',
  ) +
  ')$';

const BEARER_CROSSING_SOURCE = '\\b(bearer\\s+)' + BEARER_CHARS + '{0,' + CROSSING_LIMIT + '}$';

const JWT_CROSSING_SOURCE =
  'ey' +
  'J' +
  TOKEN_CHARS +
  '{0,' +
  CROSSING_LIMIT +
  '}' +
  '(?:\\.' +
  TOKEN_CHARS +
  '{0,' +
  CROSSING_LIMIT +
  '}){0,2}$';

const USERINFO_CROSSING_SOURCE =
  '(' + SCHEME_SOURCE + '://)' + USERINFO_USER + ':' + '[^\\s/?#@]{0,' + CROSSING_LIMIT + '}$';

/*
 * A header line whose value is still going where the examined text ends. The
 * prefix is the rule's own kept prefix with every bound widened to the
 * crossing limit, so a line whose spacing or value is longer than the rule's
 * bounds is still recognised by the name that identifies it.
 */
const HEADER_CROSSING_SPACING = '[ \\t]{0,' + CROSSING_LIMIT + '}';

const HEADER_LINE_CROSSING_SOURCE =
  '(' +
  HEADER_NAME_BOUNDARY +
  HEADER_NAME_SOURCE +
  HEADER_CROSSING_SPACING +
  ':' +
  HEADER_CROSSING_SPACING +
  ')' +
  '[^\\r\\n]{0,' +
  CROSSING_LIMIT +
  '}$';

/*
 * Patterns are compiled exactly once, in three roles that never share an
 * instance. Detection instances are non-global so that `test` never carries
 * `lastIndex` state between calls; the replacement instances are global and
 * used only with `String.prototype.replace`, which resets `lastIndex` itself;
 * the location instances are global, used only by
 * {@link cutAtCredentialBoundary}, and reset before every scan. Mixing two
 * roles on one instance is a classic source of redaction that passes
 * intermittently, so each role gets its own.
 */
const HEADER_LINE_DETECT = new RegExp(HEADER_LINE_SOURCE);
const HEADER_LINE_REPLACE = new RegExp(HEADER_LINE_SOURCE, 'g');
const HEADER_LINE_LOCATE = new RegExp(HEADER_LINE_LOCATE_SOURCE, 'g');
const PROVIDER_DETECT = new RegExp(PROVIDER_SOURCE);
const PROVIDER_REPLACE = new RegExp(PROVIDER_SOURCE, 'g');
const PROVIDER_LOCATE = new RegExp(PROVIDER_SOURCE, 'g');
const BEARER_DETECT = new RegExp(BEARER_SOURCE, 'i');
const BEARER_REPLACE = new RegExp(BEARER_SOURCE, 'gi');
const BEARER_LOCATE = new RegExp(BEARER_SOURCE, 'gi');
const JWT_DETECT = new RegExp(JWT_SOURCE);
const JWT_REPLACE = new RegExp(JWT_SOURCE, 'g');
const JWT_LOCATE = new RegExp(JWT_SOURCE, 'g');
const PEM_DETECT = new RegExp(PEM_HEADER_SOURCE);
const PEM_FOOTER_DETECT = new RegExp(PEM_FOOTER_SOURCE);
const PEM_BLOCK_REPLACE = new RegExp(PEM_BLOCK_SOURCE, 'g');
const PEM_OPEN_REPLACE = new RegExp(PEM_OPEN_SOURCE, 'g');
/*
 * The private-key locator is the opening delimiter alone, never
 * {@link PEM_OPEN_SOURCE}: an open block's pattern runs to the end of the text
 * it is given, so using it here would report every block as crossing any later
 * cut and would take the text after a *closed* block with it. The delimiter
 * crossing a cut is the only case a cut has to move for, because key material
 * only ever follows a complete delimiter — which the replacement rules already
 * remove.
 */
const PEM_LOCATE = new RegExp(PEM_HEADER_SOURCE, 'g');
const USERINFO_DETECT = new RegExp(USERINFO_SOURCE);
const USERINFO_REPLACE = new RegExp(USERINFO_SOURCE, 'g');
const USERINFO_LOCATE = new RegExp(USERINFO_SOURCE, 'g');
/*
 * The address and card rules need a fourth role, a *scan*, because their
 * detection is not a `test`: a match is only a finding once the code behind
 * the pattern accepts it (the address is not userinfo; the run holds a
 * checksum-valid number). Each scan instance is global, used only with `exec`
 * by {@link scanningDetector}, and reset before every scan, exactly like the
 * location instances.
 */
const EMAIL_SCAN = new RegExp(EMAIL_ADDRESS_SOURCE, 'g');
const EMAIL_REPLACE = new RegExp(EMAIL_ADDRESS_SOURCE, 'g');
const EMAIL_LOCATE = new RegExp(EMAIL_ADDRESS_SOURCE, 'g');
const CARD_RUN_SCAN = new RegExp(CARD_RUN_SOURCE, 'g');
const CARD_RUN_REPLACE = new RegExp(CARD_RUN_SOURCE, 'g');
const CARD_RUN_LOCATE = new RegExp(CARD_RUN_SOURCE, 'g');
/*
 * Case-insensitive, so `Password:`, `API_KEY=` and `accessToken` are labels.
 * The flag is safe here where it is not for the header line rule: this rule's
 * already-redacted test is structural (`[` cannot start a value), not a
 * byte-for-byte comparison with the marker.
 */
const LABELLED_DETECT = new RegExp(LABELLED_SECRET_SOURCE, 'i');
const LABELLED_REPLACE = new RegExp(LABELLED_SECRET_SOURCE, 'gi');
const LABELLED_LOCATE = new RegExp(LABELLED_SECRET_SOURCE, 'gi');
/*
 * The crossing-run instances are non-global: each is used once, with `exec`,
 * to find its leftmost match, and a non-global instance ignores `lastIndex`
 * altogether — so this fourth role, like the first, carries no state between
 * calls.
 */
const HEADER_LINE_CROSSING = new RegExp(HEADER_LINE_CROSSING_SOURCE);
const PROVIDER_CROSSING = new RegExp(PROVIDER_CROSSING_SOURCE);
const BEARER_CROSSING = new RegExp(BEARER_CROSSING_SOURCE, 'i');
const JWT_CROSSING = new RegExp(JWT_CROSSING_SOURCE);
const USERINFO_CROSSING = new RegExp(USERINFO_CROSSING_SOURCE);

/** Keeps a header line's name and separator and replaces its whole value. */
function redactHeaderLineValue(_match: string, prefix: string): string {
  return prefix + REDACTION_MARKER;
}

/** Keeps the scheme word and replaces only the credential after it. */
function redactBearerCredential(_match: string, scheme: string): string {
  return scheme + ' ' + REDACTION_MARKER;
}

/** Keeps the scheme and the authority and replaces only the userinfo. */
function redactUserInfo(_match: string, scheme: string): string {
  return scheme + REDACTION_MARKER + '@';
}

/**
 * Replaces PEM private-key material.
 *
 * Complete blocks are replaced precisely, which preserves any surrounding
 * text. A header with no footer — a truncated or streamed key — is replaced
 * together with everything after it, because the remainder of the value is
 * key material by construction. The footer probe keeps the bounded lazy body
 * scan off hostile input that repeats the header without ever closing it.
 */
function redactPemBlocks(input: string): string {
  if (!PEM_DETECT.test(input)) {
    return input;
  }
  let output = input;
  if (PEM_FOOTER_DETECT.test(output)) {
    output = output.replace(PEM_BLOCK_REPLACE, REDACTION_MARKER);
  }
  return output.replace(PEM_OPEN_REPLACE, REDACTION_MARKER);
}

/**
 * How far back the token readers below look for the start of the token a
 * match sits in. A URL's authority, or the part of a URL in front of one query
 * value, is far shorter than this.
 */
const TOKEN_LOOKBACK = 1_024;

/** Characters that end a whitespace-delimited token of text. Non-global, so it carries no state. */
const TOKEN_BREAK = /[\s"'`<>()]/;

/** Characters that end a URL's authority. Non-global, so it carries no state. */
const AUTHORITY_END = /[/?#]/;

/** Characters that open a URL's query or fragment. Non-global, so it carries no state. */
const QUERY_OPENER = /[?#]/;

/** The text of the token `start` sits in, from the token's start up to `start`. */
function tokenBefore(input: string, start: number): string {
  const from = Math.max(0, start - TOKEN_LOOKBACK);
  let tokenStart = from;
  for (let index = start - 1; index >= from; index -= 1) {
    if (TOKEN_BREAK.test(input.charAt(index))) {
      tokenStart = index + 1;
      break;
    }
  }
  return input.slice(tokenStart, start);
}

/**
 * Whether the text in front of `start` opens a URL authority that `start` is
 * still inside: a `//` earlier in the same token with no `/`, `?` or `#` after
 * it (`https://`, `//user:`). An `@` there separates userinfo from a host.
 */
function isInsideAuthority(input: string, start: number): boolean {
  const token = tokenBefore(input, start);
  const opener = token.lastIndexOf('//');
  return opener >= 0 && !AUTHORITY_END.test(token.slice(opener + 2));
}

/**
 * The replacement for an address, a card number or a labelled value that
 * starts at `start`: {@link REDACTION_MASK} when it sits in a URL's query or
 * fragment (a `?` or `#` earlier in the same token), {@link REDACTION_MARKER}
 * anywhere else.
 *
 * Inside a query the value is replaced by exactly what `./url.ts` writes for
 * a query value, so the text is already a fixed point of every URL masker
 * that reads it next. The marker there would be misread: the URL maskers take
 * a run ending in the marker for text a scan bound cut and move the marker to
 * a line of its own, and a masker that strips trailing punctuation from a URL
 * would keep the marker's closing bracket after the value's mask.
 *
 * @param input The whole text being scanned, for the context in front.
 * @param start Offset in `input` where the masked value starts.
 */
function contentMaskAt(input: string, start: number): string {
  return QUERY_OPENER.test(tokenBefore(input, start)) ? REDACTION_MASK : REDACTION_MARKER;
}

/**
 * The replacement for one address match: the leading boundary followed by the
 * mask of {@link contentMaskAt}, or the match itself when the `@` is a URL's
 * userinfo separator.
 *
 * Userinfo is left to the rules that own it: `connection-string` replaces a
 * credentialed one wherever a scheme introduces it, and `./url.ts` replaces
 * any other positionally while keeping the host. Replacing it here would take
 * the host with it — `//demo:pw@host.test/p` would lose `host.test` and keep
 * the user name — so an address inside an authority is not an address.
 *
 * @param input The whole text being scanned, for the context in front.
 * @param index Offset of the match in `input`.
 * @param matched The matched text: `lead` followed by the address.
 * @param lead Capture group 1, the boundary character in front of the address.
 */
function maskEmailAddress(input: string, index: number, matched: string, lead: string): string {
  const start = index + lead.length;
  return isInsideAuthority(input, start) ? matched : lead + contentMaskAt(input, start);
}

/** Replaces every e-mail address in `input` (see {@link maskEmailAddress}). */
function redactEmailAddresses(input: string): string {
  return input.replace(EMAIL_REPLACE, (matched: string, lead: string, offset: number) =>
    maskEmailAddress(input, offset, matched, lead),
  );
}

/**
 * Keeps a labelled value's label and separator and replaces only the value,
 * with the mask of {@link contentMaskAt}.
 *
 * @param _match The whole match: `label` followed by the value.
 * @param label Capture group 1, the kept label, separator and quote.
 * @param offset Offset of the match in `input`.
 * @param input The whole text being scanned.
 */
function redactLabelledValue(_match: string, label: string, offset: number, input: string): string {
  return label + contentMaskAt(input, offset + label.length);
}

/** Exactly one character that continues a word. Non-global, so it carries no state. */
const WORD_CHARACTER = /^[A-Za-z0-9_]$/;

/** Whether `unit` is the UTF-16 code of an ASCII digit. */
function isDigitCode(unit: number): boolean {
  return unit >= 0x30 && unit <= 0x39;
}

/**
 * Whether a digit string is a payment card number: 13 to 19 digits, a first
 * digit of 2 to 6, and a valid Luhn check digit.
 *
 * The first-digit range is the major industry identifiers card networks issue
 * under (2 and 5 for one network family, 3 for travel and entertainment cards,
 * 4 for another, 6 for merchandising and banking). It is also what keeps the
 * commonest long numbers in telemetry out: an epoch timestamp in milliseconds
 * or microseconds starts with 1 for the rest of this century.
 *
 * @param digits ASCII digits only; separators already removed.
 */
function isCardNumber(digits: string): boolean {
  if (digits.length < CARD_MIN_DIGITS || digits.length > CARD_MAX_DIGITS) {
    return false;
  }
  const first = digits.charCodeAt(0) - 0x30;
  if (first < 2 || first > 6) {
    return false;
  }
  let sum = 0;
  let doubled = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = digits.charCodeAt(index) - 0x30;
    if (doubled) {
      digit *= 2;
      if (digit > 9) {
        digit -= 9;
      }
    }
    sum += digit;
    doubled = !doubled;
  }
  return sum % 10 === 0;
}

/** One group of a candidate run: consecutive digits, with their offsets in the run. */
interface DigitGroup {
  readonly start: number;
  readonly end: number;
  readonly digits: string;
}

/** Splits a candidate run (digits with single separators) into its digit groups. */
function digitGroups(run: string): DigitGroup[] {
  const groups: DigitGroup[] = [];
  let start = -1;
  for (let index = 0; index <= run.length; index += 1) {
    const isDigit = index < run.length && isDigitCode(run.charCodeAt(index));
    if (isDigit && start < 0) {
      start = index;
    } else if (!isDigit && start >= 0) {
      groups.push({ start, end: index, digits: run.slice(start, index) });
      start = -1;
    }
  }
  return groups;
}

/**
 * The replacement for one candidate run: the run with every card number in it
 * replaced by the mask of {@link contentMaskAt}, or the match itself when it
 * holds none.
 *
 * A card number is written whole or in groups, so it is looked for along
 * group boundaries: from each group, the longest span of whole groups that is
 * a card number ({@link isCardNumber}) is masked, and the search resumes after
 * it. That masks `4111 1111 1111 1111` inside `…1111 1111 123` (a number
 * followed by its security code) without taking the security code for part of
 * it, and both cards of a list separated by single spaces.
 *
 * Two contexts are numbers rather than cards, and are left alone:
 *
 * - **A decimal.** A run whose leading boundary is `.` or `,` after a digit is
 *   the fraction of a number (`0.4111111111111111` is what `Math.random()`
 *   prints), and a last group followed by `.` or `,` and a digit is its
 *   integer part.
 * - **A word.** A last group followed by a letter or `_` belongs to that word —
 *   the digits that open a hexadecimal identifier or a trace id — and so does
 *   one followed by another digit, which only happens when the run reached the
 *   repeat bound and was not read to its end.
 *
 * Deterministic and a fixed point: a second pass sees the unmasked groups
 * again, split by the mask, and every span it can form was already tried and
 * refused on the first.
 *
 * @param input The whole text being scanned, for the context either side.
 * @param index Offset of the match in `input`.
 * @param matched The matched text: `lead` followed by the run.
 * @param lead Capture group 1, the boundary character in front of the run.
 */
function maskCardRun(input: string, index: number, matched: string, lead: string): string {
  if ((lead === '.' || lead === ',') && index > 0 && isDigitCode(input.charCodeAt(index - 1))) {
    return matched;
  }
  const run = matched.slice(lead.length);
  const groups = digitGroups(run);
  const after = index + matched.length;
  const next = input.charAt(after);
  const gluedToWord = WORD_CHARACTER.test(next);
  const decimalPoint = (next === '.' || next === ',') && isDigitCode(input.charCodeAt(after + 1));
  if (gluedToWord || decimalPoint) {
    groups.pop();
  }

  const mask = contentMaskAt(input, index + lead.length);
  let output = '';
  let copied = 0;
  let first = 0;
  while (first < groups.length) {
    let chosen = -1;
    let digits = '';
    for (let last = first; last < groups.length; last += 1) {
      digits += groups[last]?.digits ?? '';
      if (digits.length > CARD_MAX_DIGITS) {
        break;
      }
      if (isCardNumber(digits)) {
        chosen = last;
      }
    }
    const opening = groups[first];
    const closing = chosen < 0 ? undefined : groups[chosen];
    if (opening === undefined || closing === undefined) {
      first += 1;
      continue;
    }
    output += run.slice(copied, opening.start) + mask;
    copied = closing.end;
    first = chosen + 1;
  }
  return copied === 0 ? matched : lead + output + run.slice(copied);
}

/** Replaces every card number in `input` (see {@link maskCardRun}). */
function redactCardNumbers(input: string): string {
  return input.replace(CARD_RUN_REPLACE, (matched: string, lead: string, offset: number) =>
    maskCardRun(input, offset, matched, lead),
  );
}

/**
 * What a rule's detection needs: a `test` over a value. A `RegExp` is one, for
 * the rules a pattern decides alone; {@link scanningDetector} builds the other
 * kind, for the rules whose matches a pattern can only propose.
 */
interface ContentDetector {
  test(input: string): boolean;
}

/** The replacement a proposing rule computes for one match; the match itself means "not a finding". */
type MatchMasker = (input: string, index: number, matched: string, lead: string) => string;

/**
 * Detection for a rule whose pattern proposes candidates and whose code
 * decides them: whether any candidate the scan finds would be changed by the
 * rule's own masker.
 *
 * It answers from the replacement itself, so detection and redaction cannot
 * disagree. `scan` is a global instance used only here, with `exec`, and reset
 * before every scan; like every detector it reads the value it is given end to
 * end.
 */
function scanningDetector(scan: RegExp, mask: MatchMasker): ContentDetector {
  return Object.freeze<ContentDetector>({
    test(input: string): boolean {
      scan.lastIndex = 0;
      let match = scan.exec(input);
      while (match !== null) {
        if (mask(input, match.index, match[0], match[1] ?? '') !== match[0]) {
          return true;
        }
        match = scan.exec(input);
      }
      return false;
    },
  });
}

/** `email-address` detection: an address outside a URL authority. */
const EMAIL_DETECTOR: ContentDetector = scanningDetector(EMAIL_SCAN, maskEmailAddress);

/** `payment-card` detection: a candidate run holding a card number. */
const CARD_DETECTOR: ContentDetector = scanningDetector(CARD_RUN_SCAN, maskCardRun);

/**
 * One content-driven rule: how it is detected, how it is replaced, and how a
 * cut near it is placed.
 *
 * Capture group 1, where a pattern has one, is by convention the **kept
 * prefix**: text that survives redaction because it is diagnostic rather than
 * secret (a bearer scheme word, a URL's scheme, a header line's name and
 * separator). Both the replacement
 * functions and {@link cutAtCredentialBoundary} rely on that convention, so a
 * pattern added here must use a non-capturing group for anything else.
 */
interface PatternRule {
  /** Vocabulary id reported for this rule. */
  readonly id: RedactionRuleId;
  /**
   * Answers whether a value holds this rule's shape: a non-global `RegExp`,
   * used only with `test`, or a {@link scanningDetector} for a rule whose
   * matches a pattern can only propose.
   */
  readonly detect: ContentDetector;
  /** Replaces every occurrence, leaving no partial match behind. */
  readonly redact: (input: string) => string;
  /**
   * Global instance used only to find match *positions*, never to test or to
   * replace. {@link cutAtCredentialBoundary} resets its `lastIndex` before
   * every scan. It may be wider than the replacement pattern — the header
   * line rule locates its own already-redacted form too — because a cut has
   * to move back to the kept prefix wherever this rule's shape crosses it.
   */
  readonly locate: RegExp;
  /**
   * Text this rule's credential could have continued with, appended past a
   * cut to stand in for input the cut window did not examine. It has to be
   * enough for {@link locate} to complete a match that begins before the cut:
   * a run of body characters for the runs, a segment separator for a JOSE
   * token, the `@` that terminates a URL's userinfo, the remainder of a
   * key-file delimiter, a separator and a value for a header line.
   */
  readonly continuation: string;
  /**
   * Non-global instance matching this rule's identifying prefix followed by a
   * run of its body characters that reaches the end of the text it is given.
   *
   * It is the backstop for the one case {@link continuation} cannot settle: a
   * run so long that the rule's own bound cannot span it, so the terminator
   * the rule needs is unreachable and no amount of appended text completes a
   * match. Absent for a rule that needs no terminator.
   */
  readonly crossing?: RegExp;
}

/**
 * The `sensitive-header` line rule, named on its own because
 * {@link applyPatterns} runs it twice (see there).
 */
const SENSITIVE_HEADER_LINE_RULE: PatternRule = Object.freeze<PatternRule>({
  id: 'sensitive-header',
  detect: HEADER_LINE_DETECT,
  redact: (input) => input.replace(HEADER_LINE_REPLACE, redactHeaderLineValue),
  locate: HEADER_LINE_LOCATE,
  // A separator and a value: what a header name or its spacing that reaches
  // the end of the examined window could have continued with. A match
  // completed this way keeps everything up to its value, all of it past the
  // cut, so it never moves a cut in front of text that was examined.
  continuation: ':' + CONTINUATION_RUN,
  crossing: HEADER_LINE_CROSSING,
});

/**
 * The content-driven rules, held in {@link REDACTION_RULE_IDS} order so that
 * {@link findDeniedRules} can report in that order by iterating once. Each id
 * appears exactly once, which is what makes the reported list unique.
 *
 * The header line rule is first, and that order is part of its meaning: it
 * replaces a header's *whole* value, so running it before the bearer and JOSE
 * rules turns `Authorization: Bearer <credential>` into
 * `Authorization: [redacted]` whatever the credential's length, rather than
 * letting the bearer rule keep the scheme word of a long credential and pass a
 * short one through.
 */
const PATTERN_RULES: readonly PatternRule[] = Object.freeze<PatternRule[]>([
  SENSITIVE_HEADER_LINE_RULE,
  {
    id: 'provider-key',
    detect: PROVIDER_DETECT,
    redact: (input) => input.replace(PROVIDER_REPLACE, REDACTION_MARKER),
    locate: PROVIDER_LOCATE,
    continuation: CONTINUATION_RUN,
    crossing: PROVIDER_CROSSING,
  },
  {
    id: 'bearer-token',
    detect: BEARER_DETECT,
    redact: (input) => input.replace(BEARER_REPLACE, redactBearerCredential),
    locate: BEARER_LOCATE,
    continuation: CONTINUATION_RUN,
    crossing: BEARER_CROSSING,
  },
  {
    id: 'jwt',
    detect: JWT_DETECT,
    redact: (input) => input.replace(JWT_REPLACE, REDACTION_MARKER),
    locate: JWT_LOCATE,
    // A token cut inside its header segment needs a separator and a payload
    // before the pattern can complete; one cut inside its payload needs the
    // payload's remaining characters, which the leading run supplies.
    continuation: CONTINUATION_RUN + '.' + CONTINUATION_RUN,
    // A first segment longer than the rule's own bound puts the separator it
    // needs out of reach, so the continuation cannot complete a match however
    // much of it is appended; this is what catches such a token.
    crossing: JWT_CROSSING,
  },
  {
    id: 'private-key',
    detect: PEM_DETECT,
    redact: redactPemBlocks,
    locate: PEM_LOCATE,
    // A cut inside an opening delimiter leaves `-----BEGIN` and part of the
    // label behind; the label class absorbs whatever of the label survived,
    // and this completes the delimiter.
    continuation: PEM_SUFFIX_TEXT,
  },
  {
    id: 'connection-string',
    detect: USERINFO_DETECT,
    redact: (input) => input.replace(USERINFO_REPLACE, redactUserInfo),
    locate: USERINFO_LOCATE,
    // A password run and the `@` that terminates it. Deliberately no leading
    // `:`: without one in the examined text there is no password material on
    // the near side of the cut, and supplying it would replace an ordinary
    // `scheme://host` authority at every truncation boundary.
    continuation: CONTINUATION_RUN + '@',
    // Likewise for a password longer than the rule's `{1,256}` bound: the `@`
    // that would terminate it can no longer be reached.
    crossing: USERINFO_CROSSING,
  },
  // The three ingest-only rules run after every credential rule, and their
  // order among themselves matters:
  //
  // - `connection-string` first, because a credentialed URL's password
  //   followed by `@host.tld` also reads as an address; replacing the address
  //   first would take the host with it and leave the user name behind.
  // - `email-address` before `payment-card`, because an address's replacement
  //   ends in `]` (or is `?`, inside a URL query), which is a boundary a card
  //   run can start after: masking the address first means the card rule sees
  //   that boundary on this pass rather than on the next, which is what keeps
  //   `scrub` idempotent.
  //
  // None of the three needs a crossing pattern or a continuation. The longest
  // address (64 + 1 + 8 × 64 + 63 code units) and the longest card span (19
  // digits and 18 separators) are far shorter than `BOUNDARY_OVERLAP`, so a
  // match that begins before a cut always ends inside the examined window.
  // A labelled value can be longer, but its rule needs no terminator after
  // the value, so it matches across a cut whatever the value's length; its
  // continuation only stands in for the digit its value requires.
  {
    id: 'email-address',
    detect: EMAIL_DETECTOR,
    redact: redactEmailAddresses,
    // Locates userinfo-shaped matches too: a cut inside `//user:pw@host.test`
    // moving back to where the run starts drops what the URL rules would have
    // masked anyway, which is the safe direction.
    locate: EMAIL_LOCATE,
    continuation: '',
  },
  {
    id: 'payment-card',
    detect: CARD_DETECTOR,
    redact: redactCardNumbers,
    // Locates every candidate run, not only a checksum-valid one, so a cut
    // moves in front of any long digit run it would split: a head of digits
    // cannot be judged once its tail is gone, and dropping it is the safe
    // direction.
    locate: CARD_RUN_LOCATE,
    continuation: '',
  },
  {
    id: 'labelled-secret',
    detect: LABELLED_DETECT,
    redact: (input) => input.replace(LABELLED_REPLACE, redactLabelledValue),
    locate: LABELLED_LOCATE,
    continuation: '0'.repeat(8),
  },
]);

/**
 * Key-like vocabulary. A normalised attribute or header name containing any
 * of these terms names a value that must not be captured.
 *
 * `session` is deliberately absent: it would swallow the legitimate
 * `sessionId` attribute that every correlated event carries. `auth` is
 * deliberately present and matches more than authorization headers (an
 * `author` attribute is redacted too) — over-redaction is the safe direction
 * for a privacy boundary, and the analysis pipeline never needs such a
 * value.
 *
 * Names that are sensitive because of *where* they appear rather than what
 * they are called — `cookie` and `set-cookie` in a header set, for instance —
 * are not listed here. `headers.ts` holds the header deny list and reports
 * them as `sensitive-header`, and the `sensitive-header` line rule above
 * recognises the same six names written out as a header line inside free
 * text; this vocabulary covers names wherever they occur, including React
 * props, hook state and span attributes.
 */
const SENSITIVE_NAME_TERMS: readonly string[] = [
  'key',
  'token',
  'secret',
  'password',
  'passwd',
  'pwd',
  'credential',
  'auth',
];

/**
 * Normalised names that survive the vocabulary above, matched exactly.
 *
 * These are the product's own correlation identifiers, which must reach the
 * panel intact: `request_key` is the per-session keyed hash used to group
 * duplicate requests (never the request's data), while `sessionId`,
 * `spanId` and `traceId` are service-assigned ids. `redactor.ts` additionally
 * exempts the service-assigned event fields, so the two layers agree; a
 * reader of this file should know that these four names are expected to
 * survive redaction by design.
 *
 * The match is exact on the normalised name, so a decorated variant such as
 * `x-request-key` is still treated as sensitive.
 */
const NAME_EXEMPTIONS: readonly string[] = ['requestkey', 'sessionid', 'spanid', 'traceid'];

/**
 * Separators stripped before a name is matched, which makes the match
 * insensitive to camelCase, snake_case, kebab-case and dotted spellings.
 * Global, and therefore used only with `replace`.
 */
const NAME_SEPARATORS = /[\s._-]/g;

/** Lower-cases a name and removes its separators. */
function normaliseName(name: string): string {
  return name.toLowerCase().replace(NAME_SEPARATORS, '');
}

/**
 * Slices `value` to at most `end` UTF-16 code units without splitting a
 * surrogate pair, so no lone surrogate is ever emitted.
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

/** Matches one whitespace code unit. Non-global, so it carries no state. */
const WHITESPACE = /\s/;

/**
 * Where a cut at `headLength` has to move to for one rule, or `undefined`
 * when that rule has nothing to say about it.
 *
 * `probe` is the text before the cut, followed by whatever of the input the
 * cut window examined and then the rule's continuation, so a credential that
 * begins before the cut and continues past it matches here even though it
 * cannot match the text before the cut alone. Only such a crossing match
 * matters: one that ends at or before the cut is replaced in place by
 * {@link applyPatterns}, and one that begins at or after the cut is in text
 * that is being removed anyway.
 */
function boundaryCutFor(rule: PatternRule, probe: string, headLength: number): number | undefined {
  const { locate } = rule;
  locate.lastIndex = 0;
  let match = locate.exec(probe);
  while (match !== null) {
    if (match.index >= headLength) {
      return undefined;
    }
    const matched = match[0];
    if (matched.length === 0) {
      // Unreachable for every pattern in the table — each requires at least
      // two literal characters — and cheap insurance against a future one
      // that does not, which would otherwise spin here for ever.
      locate.lastIndex += 1;
    } else if (match.index + matched.length > headLength) {
      return cutPosition(probe, match, headLength);
    }
    match = locate.exec(probe);
  }
  return undefined;
}

/**
 * Where a cut at `headLength` has to move to because a credential-shaped run
 * crosses it and never ended in anything this call examined, or `undefined`
 * when this rule has no such run there.
 *
 * `text` is the text before the cut followed by the whole window examined
 * past it, and the rule's pattern is anchored to the end of that text, so a
 * match means the run occupies every code unit from its prefix to the end of
 * what was read. The caller only asks when the input continues beyond that
 * window, which is what makes an unbroken run there unanswerable: the
 * characters that would settle it — a JOSE token's separator, the `@` after a
 * URL's password — were never seen, and for runs this long they are also out
 * of reach of the rule's own bound, so no continuation can stand in for them.
 * The conservative reading is the only safe one, and it is the reading the
 * privacy boundary takes.
 */
function crossingCutFor(rule: PatternRule, text: string, headLength: number): number | undefined {
  const { crossing } = rule;
  if (crossing === undefined) {
    return undefined;
  }
  const match = crossing.exec(text);
  if (match === null || match.index >= headLength) {
    return undefined;
  }
  return cutPosition(text, match, headLength);
}

/**
 * The cut for one crossing match: where it begins, plus any prefix the rule
 * keeps.
 *
 * Keeping the prefix is what makes a cut produce the same shape the
 * replacement produces — `Bearer [redacted]` once the caller appends the
 * marker, or `scheme://[redacted]` — so a truncated value stays as
 * diagnosable as a redacted one. The whitespace walk exists for the bearer
 * rule, whose capture ends at the scheme word while the credential starts
 * after the separator. The header line rule's prefix already ends with its own
 * spacing, and no other rule's prefix is followed by whitespace, so it is a
 * no-op for them.
 */
function cutPosition(probe: string, match: RegExpExecArray, headLength: number): number {
  const kept = match[1] ?? '';
  let cut = match.index + kept.length;
  while (cut < headLength && WHITESPACE.test(probe.charAt(cut))) {
    cut += 1;
  }
  return cut;
}

/**
 * Slices `value` to at most `limit` code units, moving the cut back when a
 * credential would otherwise be split by it.
 *
 * Every caller of this function is about to throw text away and signal the
 * loss with {@link REDACTION_MARKER}. A plain slice is unsafe there: each rule
 * identifies a credential by a prefix followed by a run, so a cut through the
 * run leaves the prefix and the characters before the cut in plain text with
 * nothing left to match them. This reads {@link BOUNDARY_OVERLAP} code units
 * past the cut and moves the cut back to where the credential begins, keeping
 * whatever prefix the rule keeps.
 *
 * Three questions can be asked of the cut, and the answer to each comes from
 * a different place:
 *
 * 1. *Does a credential cross it?* The rule's own pattern, applied to the text
 *    on both sides of the cut, answers this from the real input.
 * 2. *Could one have crossed it, had the input continued?* The rule's
 *    {@link PatternRule.continuation} stands in for text the window did not
 *    reach, so a credential whose identifying length is met just past the
 *    window is cut rather than trusted.
 * 3. *Is a credential-shaped run still going where the window ends?* The
 *    rule's {@link PatternRule.crossing} run answers this, and it is the only
 *    answer available once a run is longer than the rule's own bound: the
 *    terminator the rule needs is then unreachable and neither of the first
 *    two questions can be answered at all.
 *
 * Guarantees:
 *
 * - **Nothing is cut when nothing is removed.** A `value` already within
 *   `limit` comes back unchanged, so an ordinary value is never shortened and
 *   never has its tail second-guessed.
 * - **No surrogate pair is split**, at either the length cut or the moved one.
 * - **The result is never longer than `limit`**, so `limit` may reserve room
 *   for the marker the caller appends.
 * - **Total and pure.** Any string and any bound are accepted, including a
 *   bound of zero or less, and nothing throws.
 *
 * @param value Text to cut, examined past the cut as described.
 * @param limit Maximum number of code units to return.
 * @returns The head of `value`, cut clear of any credential crossing it.
 */
export function cutAtCredentialBoundary(value: string, limit: number): string {
  const head = sliceWithoutSplit(value, limit);
  if (head.length >= value.length) {
    return head;
  }
  const examined = value.slice(head.length, head.length + BOUNDARY_OVERLAP);
  const read = head + examined;
  // True when input remains past the window: only then can a run that is still
  // going at the end of the window have continued into text nobody examined.
  const unexamined = value.length > read.length;
  let cut = head.length;
  for (const rule of PATTERN_RULES) {
    const candidates = [
      boundaryCutFor(rule, read + rule.continuation, head.length),
      unexamined ? crossingCutFor(rule, read, head.length) : undefined,
    ];
    for (const candidate of candidates) {
      if (candidate !== undefined && candidate < cut) {
        cut = candidate;
      }
    }
  }
  return cut < head.length ? sliceWithoutSplit(head, cut) : head;
}

/**
 * Holds a scrubbed result to {@link MAX_SCAN_LENGTH} code units.
 *
 * Several rules grow the text they replace (`Bearer x` becomes
 * `Bearer [redacted]`, `Cookie: a` becomes `Cookie: [redacted]`,
 * `token: ab12` becomes `token: [redacted]`, and short userinfo or a short
 * address such as `a@b.io` becomes the marker), so a value just under the
 * bound can come back over it. Clamping here keeps
 * {@link scrub} idempotent: its output is always short enough that a second
 * call takes the unbounded path and changes nothing. The cut goes through
 * {@link cutAtCredentialBoundary} like every other cut in this module: the
 * text being cut is already scrubbed, so a credential it recognises has
 * already gone, and the guard is what keeps that reasoning from having to be
 * re-derived at each call site.
 */
function clampScanned(result: string): string {
  if (result.length <= MAX_SCAN_LENGTH) {
    return result;
  }
  const room = MAX_SCAN_LENGTH - REDACTION_MARKER.length;
  return cutAtCredentialBoundary(result, room) + REDACTION_MARKER;
}

/**
 * Applies every content-driven rule once, in table order, and then the header
 * line rule a second time if any later rule changed the text.
 *
 * The second pass is what keeps {@link scrub} idempotent. A header name only
 * counts when the character in front of it cannot continue a name, and a
 * replacement can create exactly such a character: the marker ends in `]`.
 * Text such as a key-file block's closing dashes or an upper-case access
 * identifier followed directly by `cookie: …` puts a name character in front
 * of the header on the first pass, and the marker in front of it once that
 * credential is replaced — so without the second pass the header line would be
 * masked by the *next* call rather than this one. The second pass cannot
 * create work for the other rules in turn: it only ever replaces text between
 * a separator and a line break with the marker, which no other pattern's run
 * can extend into.
 *
 * Nothing is rescanned when the later rules changed nothing, which is almost
 * every value: that case costs one string comparison.
 */
function applyPatterns(input: string): string {
  let output = input;
  let afterHeaderLines = input;
  for (const rule of PATTERN_RULES) {
    output = rule.redact(output);
    if (rule === SENSITIVE_HEADER_LINE_RULE) {
      afterHeaderLines = output;
    }
  }
  return output === afterHeaderLines ? output : SENSITIVE_HEADER_LINE_RULE.redact(output);
}

/**
 * Shannon entropy of `value` in bits per character, computed over UTF-16
 * code units in a single pass.
 *
 * Returns `0` for an empty string and for a string of one repeated
 * character; the theoretical maximum for a string of `n` distinct
 * characters is `log2(n)`.
 *
 * @param value Value to measure. Never inspected for meaning.
 * @returns Bits of entropy per character, always finite and non-negative.
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
 * Normalises a value of unknown type into text these primitives can examine.
 *
 * This module sits on a process boundary. Events arrive as parsed JSON, span
 * attributes are declared `unknown`, and React props and hook state are
 * whatever the page put there — so a primitive that threw on a value that was
 * not a string would take the whole batch it belongs to down with it, and one
 * that stringified anything at all could run page-supplied code through a
 * `toString` getter. The policy is therefore explicit:
 *
 * - A **string** is returned as it arrived.
 * - A **number, bigint or boolean** is rendered by its canonical string form.
 *   These are the scalars a captured attribute legitimately carries — a status
 *   code, a duration, a flag — and keeping their text keeps the evidence a
 *   panel is built from. `NaN` and `Infinity` render as themselves, which is
 *   information rather than a credential.
 * - **Anything else** — `null`, `undefined`, a symbol, a function, an object,
 *   an array — yields {@link REDACTION_MARKER}. Such a value cannot be
 *   examined for credential material, so it is reported as removed rather
 *   than stringified (which could run page code) or silently dropped (which
 *   would hide that anything was there).
 *
 * @param value Value of any type, as an untrusted caller supplied it.
 * @returns Text to scan, or the marker when the value cannot be scanned.
 */
export function asScannableText(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') {
    return String(value);
  }
  return REDACTION_MARKER;
}

/**
 * Whether `value` looks like a high-entropy credential: long enough to
 * measure and denser than {@link ENTROPY_MIN_BITS_PER_CHAR}.
 *
 * This is the strict content-only test. {@link findDeniedRules} reports the
 * `entropy` rule from the value's *name* instead, because a short password
 * under a `password` key must be redacted whether or not it clears this bar;
 * this function stays exported for callers that need the stricter test on
 * its own, such as a heuristic over unnamed values.
 *
 * @param value Value to test.
 */
export function isHighEntropySecret(value: string): boolean {
  if (value.length < ENTROPY_MIN_LENGTH) {
    return false;
  }
  return shannonEntropy(value) > ENTROPY_MIN_BITS_PER_CHAR;
}

/**
 * Whether an attribute, header or property name denotes a value that must
 * not be captured.
 *
 * Matching is case-insensitive and separator-insensitive, so `X-Api-Key`,
 * `api_key`, `apiKey` and `http.request.header.authorization` all match,
 * while the product's own identifiers (`sessionId`, `request_key`, `spanId`,
 * `traceId`) are exempt by exact normalised name.
 *
 * @param name Attribute, header or property name.
 */
export function isSensitiveKeyName(name: string): boolean {
  const normalised = normaliseName(name);
  if (normalised.length === 0) {
    return false;
  }
  if (NAME_EXEMPTIONS.includes(normalised)) {
    return false;
  }
  return SENSITIVE_NAME_TERMS.some((term) => normalised.includes(term));
}

/**
 * Removes credential material from a value by content, applying every
 * content-driven rule: sensitive header lines, provider credentials, bearer
 * credentials, JOSE tokens, PEM private keys and credentialed connection
 * strings, then e-mail addresses, payment card numbers and values labelled by
 * a credential word.
 *
 * Guarantees, each covered by the colocated tests:
 *
 * - **Idempotent.** `scrub(scrub(v)) === scrub(v)` for every input. No
 *   pattern matches {@link REDACTION_MARKER}, the `Bearer [redacted]` form
 *   that the bearer rule produces or the `Cookie: [redacted]` form that the
 *   header line rule produces.
 * - **No unscanned input is ever returned.** A value longer than
 *   {@link MAX_SCAN_LENGTH} is scrubbed up to the bound and its unexamined
 *   tail is replaced by {@link REDACTION_MARKER} rather than passed through.
 * - **No credential head survives the cut.** The cut itself goes through
 *   {@link cutAtCredentialBoundary}, which reads past it, so a credential that
 *   straddles the bound is removed from where it begins instead of leaving its
 *   prefix and first characters in front of the marker.
 * - **Bounded output.** The result is never longer than
 *   {@link MAX_SCAN_LENGTH} code units.
 * - **Presence is preserved where it is diagnosable.** A bearer scheme word,
 *   a header line's name and a URL's scheme and authority survive; only the
 *   credential goes. That holds at a cut too: a bearer credential the bound
 *   removes still reads `Bearer [redacted]`, and a header value it removes
 *   still reads `Cookie: [redacted]`.
 * - **No credential tail survives.** A match consumes the whole run of
 *   credential characters, not just the length that identified it, so a
 *   credential longer than its usual shape does not leave a remainder.
 * - **Total.** Any value is accepted — any string including an empty one, and
 *   any other type through {@link asScannableText} — and nothing throws.
 *
 * Scrub before truncating, never the other way round — see {@link truncate}.
 *
 * @param value Value to scrub. Typed `unknown` because the callers on the
 * ingest path hold untrusted, unvalidated data; see {@link asScannableText}
 * for what each type becomes.
 * @returns The value with every matched credential replaced.
 */
export function scrub(value: unknown): string {
  const text = asScannableText(value);
  if (text.length === 0) {
    return text;
  }
  if (text.length > MAX_SCAN_LENGTH) {
    const room = MAX_SCAN_LENGTH - REDACTION_MARKER.length;
    const head = cutAtCredentialBoundary(text, room);
    return clampScanned(applyPatterns(head) + REDACTION_MARKER);
  }
  return clampScanned(applyPatterns(text));
}

/**
 * Scrubs a named value: a value whose name is sensitive is replaced whole,
 * and any other value is scrubbed by content.
 *
 * Redaction is deliberately stricter than detection here. A value under a
 * key-like name is replaced with {@link REDACTION_MARKER} however short or
 * low-entropy it is, because a four-character password is still a password;
 * the entropy heuristic only ever adds to what the name already decided.
 * An empty value is returned as is — there is nothing to hide, and the name
 * is already reported by {@link findDeniedRules}.
 *
 * Like {@link scrub} this accepts a value of any type and never throws: a
 * header value, a prop or a hook state slot is whatever the page put there,
 * and {@link asScannableText} decides what each type becomes before the name
 * rule is applied.
 *
 * @param name Attribute, header or property name.
 * @param value Value captured under that name, of any type.
 */
export function scrubNamedValue(name: string, value: unknown): string {
  const text = asScannableText(value);
  if (text.length > 0 && isSensitiveKeyName(name)) {
    return REDACTION_MARKER;
  }
  return scrub(text);
}

/**
 * Reports which deny-list rules a value matches, for findings reports, logs
 * and the outbound guard's rejection path.
 *
 * Ids come back in {@link REDACTION_RULE_IDS} order and without duplicates.
 * **No part of the matched value is ever returned, embedded or logged** — the
 * ids are the whole report, which is what makes it safe to write a finding to
 * a log that a redacted payload could not be written to.
 *
 * `entropy` is reported whenever `name` is sensitive and `value` is
 * non-empty: detection here is name-driven, matching exactly the case
 * {@link scrubNamedValue} redacts, while {@link isHighEntropySecret} remains
 * available for the stricter content-only test.
 *
 * `sensitive-header` is reported here when the value contains a sensitive
 * header *line* — one of the six denied names, a `:` and a value that is not
 * already redacted (exactly {@link REDACTION_MARKER}, or what a preview cut
 * leaves of it at the end of the text; see {@link HEADER_ALREADY_REDACTED}) —
 * which is the content rule {@link scrub} applies. A value that merely sits under a denied header name
 * is the positional case, which only `headers.ts` and `redactor.ts` can see
 * and which they report themselves. `url-query-value` is never reported by
 * this function: it classifies a value by its position in a query string,
 * which only `url.ts` can see, and it is part of the vocabulary so that
 * handler reports in the same terms.
 *
 * Unlike {@link scrub}, detection reads the whole value rather than a bounded
 * window: a caller asking whether a value is safe must not be told "yes"
 * because the credential sits past the scan bound. Every pattern is linear
 * over its input, so this stays cheap. That difference is deliberate layering
 * — a credential so long that the scan window cuts off the terminator a
 * pattern needs (the `@` of a credentialed URL, say) is still reported here,
 * which is what lets the outbound guard refuse such a payload outright rather
 * than send a bounded scrub of it, whose tail the bound replaced.
 *
 * @param value Value to inspect.
 * @param name Optional name the value was captured under.
 * @returns Matched rule ids, ordered and unique; empty when nothing matched.
 */
export function findDeniedRules(value: string, name?: string): RedactionRuleId[] {
  const found: RedactionRuleId[] = [];
  for (const rule of PATTERN_RULES) {
    if (rule.detect.test(value)) {
      found.push(rule.id);
    }
  }
  if (value.length > 0 && name !== undefined && isSensitiveKeyName(name)) {
    found.push('entropy');
  }
  return found;
}

/**
 * Whether a value matches any deny-list rule, short-circuiting on the first
 * match. Equivalent to `findDeniedRules(value, name).length > 0`.
 *
 * @param value Value to inspect.
 * @param name Optional name the value was captured under.
 */
export function containsDenied(value: string, name?: string): boolean {
  if (value.length > 0 && name !== undefined && isSensitiveKeyName(name)) {
    return true;
  }
  for (const rule of PATTERN_RULES) {
    if (rule.detect.test(value)) {
      return true;
    }
  }
  return false;
}

/**
 * Shortens a value to at most `maxLength` code points, appending
 * {@link TRUNCATION_SUFFIX} when anything was removed.
 *
 * **Scrub before truncating.** Cutting a value first can leave a credential
 * half-matched and therefore unreplaced, so `redactor.ts` and
 * `../browser/fiber-diff.ts` both call {@link scrub} or
 * {@link scrubNamedValue} and truncate the result. This order is part of the
 * contract, not an implementation detail.
 *
 * The bound is a parameter rather than a constant of this module: the single
 * definition of the preview length lives in `../schema/attributes.ts`, which
 * the caller passes in, keeping that number in exactly one place.
 *
 * Length is counted in code points, so a surrogate pair is never split and a
 * lone surrogate is never emitted. The result, suffix included, is never
 * longer than `maxLength` code points, which makes truncation idempotent.
 *
 * @param value Value to shorten, expected to be scrubbed already.
 * @param maxLength Maximum number of code points to return. A value of `0`
 * or less yields an empty string; a non-integer bound is floored; a
 * non-finite bound means no truncation.
 */
export function truncate(value: string, maxLength: number): string {
  if (!Number.isFinite(maxLength)) {
    return value;
  }
  const limit = Math.floor(maxLength);
  if (limit <= 0) {
    return '';
  }
  if (value.length <= limit) {
    return value;
  }
  const points = Array.from(value);
  if (points.length <= limit) {
    return value;
  }
  return points.slice(0, limit - 1).join('') + TRUNCATION_SUFFIX;
}
