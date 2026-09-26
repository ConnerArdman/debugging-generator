/**
 * Colocated suite for the outbound redaction guard.
 *
 * It pins the three things the guard is for and one thing it must never do:
 *
 * 1. **One case per deny-list class of AAP §0.5.2.** Eight rules, eight
 *    positive cases, each on the shape the specification's table names — plus
 *    one case per *enumerated member* of the two classes whose table row
 *    enumerates them: all six denied header names, in three spellings each, and
 *    all five provider credential prefixes. A rule that recognised five of six
 *    names would otherwise pass a suite built from one case per class.
 *    `high-entropy-secret`, which is the one class defined by a measurement,
 *    additionally pins both of its thresholds from above and below. The two
 *    position-driven classes are also pinned in their text forms — a URL
 *    embedded in prose and a header line inside text — against the
 *    redactor's compliant output and against ordinary source code.
 * 2. **The compliant output of the first checkpoint passes.** A denied header
 *    carrying `[redacted]`, a `?`-masked URL, parameterised SQL and a React
 *    prop preview truncated to 120 characters are what the ingest checkpoint
 *    produces, and every one of them must produce no finding — a second
 *    checkpoint that refused its own upstream would make the product unusable.
 * 3. **Refusal, never rewriting, and never a leak.** The request is unchanged
 *    after a refusal, and no finding, message, hint or detail carries any part
 *    of the value that caused it — asserted by sliding an eight-character
 *    window over every fixture secret and requiring that none of them appears
 *    in the serialised output.
 * 4. **Nothing throws.** A cycle, a hostile `Proxy`, a throwing getter, a
 *    null-prototype object, a megabyte string and a deeply nested array each
 *    have an asserted outcome.
 *
 * **Credential-shaped fixtures are assembled at runtime.** This file is tracked
 * and `scripts/check-secrets.mjs` scans tracked content with the same rule
 * classes the module under test implements, so no credential prefix, key-file
 * header, token body or credentialed URI appears here as a contiguous literal:
 * {@link assemble} joins short fragments and {@link cycle} builds bodies from an
 * alphabet, exactly as `./redact-guard.ts` assembles its own patterns and as
 * `scripts/check-secrets.test.mjs` builds its own fixtures. Nothing in this file
 * may be "simplified" into a literal; see the pattern-table comment in the
 * module under test for what that costs. The two entries of
 * `scripts/check-secrets.allowlist.json` are no help here and must not be
 * extended to make one: that allowlist is a *tracked-file* concession for the
 * repository's two development placeholders, while the guard itself has no
 * allowlist whatsoever — which is its own asserted case below.
 *
 * Fixtures are inline rather than loaded from a fixture directory, because the
 * whole point of one is to be read beside the expectation it drives.
 */

import { describe, expect, it } from 'vitest';

import { DEBUGGEN_ERROR_CODES, DebuggenError } from '@debuggen/shared';
import type { LogFields, Logger, Result } from '@debuggen/shared';

import {
  DEFAULT_MAX_DEPTH,
  DEFAULT_MAX_FINDINGS,
  DEFAULT_MAX_NODES,
  DEFAULT_MAX_STRING_LENGTH,
  DEFAULT_ROOT_PATH,
  DENIED_HEADER_NAMES,
  ENTROPY_MIN_BITS_PER_CHAR,
  ENTROPY_MIN_LENGTH,
  FRAME_CONTEXT_MAX_LENGTH,
  KEY_LIKE_NAME_TERMS,
  MASKED_QUERY_VALUES,
  MAX_SUPPORTED_DEPTH,
  MAX_URL_RUNS_PER_STRING,
  PATH_SEGMENT_MAX_LENGTH,
  PATH_SEGMENT_TRUNCATION_MARKER,
  REDACTION_MARKER,
  REDACTION_RULE_IDS,
  REDACTION_RULE_REASONS,
  REDACT_GUARD_LIMIT_IDS,
  SCAN_WINDOW_LENGTH,
  SCAN_WINDOW_OVERLAP,
  SUMMARY_MAX_PATHS_PER_RULE,
  TEXT_TRUNCATION_MARKER,
  URL_PARSE_MAX_LENGTH,
  URL_QUERY_MASK,
  assertOutboundSafe,
  inspectPayload,
  inspectPayloadReport,
  isDeniedHeaderName,
  isKeyLikeName,
  shannonEntropy,
  summarizeFindings,
} from './redact-guard.js';
import type {
  DeniedHeaderName,
  RedactGuardFinding,
  RedactGuardLimitId,
  RedactGuardOptions,
  RedactGuardReport,
  RedactionRuleId,
} from './redact-guard.js';
import { PROMPT_STAGES } from './types.js';
import type { JsonObject, ModelMessage, ModelRequest } from './types.js';

/*
 * ---------------------------------------------------------------------------
 * Fixture construction
 * ---------------------------------------------------------------------------
 */

/** The inclusive character range from `first` to `last`, by code unit. */
function charRange(first: string, last: string): string {
  let result = '';
  for (let code = first.charCodeAt(0); code <= last.charCodeAt(0); code += 1) {
    result += String.fromCharCode(code);
  }
  return result;
}

/**
 * A deterministic body of `length` characters cycled from `alphabet`.
 *
 * Deterministic so a failure reproduces, and cycled over the whole alphabet so
 * the result is as dense as real key material.
 */
function cycle(alphabet: string, length: number): string {
  let result = '';
  for (let index = 0; index < length; index += 1) {
    result += alphabet.charAt(index % alphabet.length);
  }
  return result;
}

/**
 * Joins fixture fragments.
 *
 * Every call exists to keep a credential prefix, key-file header or URI
 * authority from appearing as one contiguous literal in this tracked file. The
 * split points carry no other meaning.
 */
function assemble(...fragments: readonly string[]): string {
  return fragments.join('');
}

const DIGITS = charRange('0', '9');
const LOWER_LETTERS = charRange('a', 'z');
const UPPER_LETTERS = charRange('A', 'Z');

/** Base64url: 64 symbols, the alphabet of an opaque provider credential. */
const URLSAFE_CHARS = UPPER_LETTERS + LOWER_LETTERS + DIGITS + '-_';

/** Body characters of the underscore-delimited forge tokens. */
const WORD_CHARS = UPPER_LETTERS + LOWER_LETTERS + DIGITS + '_';

/** Body characters of an upper-case cloud access identifier. */
const UPPER_ID_CHARS = UPPER_LETTERS + DIGITS;

/** Lower-case hexadecimal: 16 symbols, so at most four bits per character. */
const HEX_CHARS = DIGITS + charRange('a', 'f');

/** A vendor API credential: its prefix and a long base64url body. */
const VENDOR_CREDENTIAL = assemble('s', 'k-', 'ant-') + cycle(URLSAFE_CHARS, 28);

/** The generic API credential prefix with a body long enough to identify it. */
const GENERIC_CREDENTIAL = assemble('s', 'k-') + cycle(URLSAFE_CHARS, 24);

/** A classic forge personal access token. */
const FORGE_CLASSIC_CREDENTIAL = assemble('gh', 'p_') + cycle(WORD_CHARS, 24);

/** A fine-grained forge token. */
const FORGE_FINE_CREDENTIAL = assemble('git', 'hub_', 'pat_') + cycle(WORD_CHARS, 28);

/** A cloud access-key identifier: prefix plus exactly sixteen characters. */
const ACCESS_KEY_IDENTIFIER = assemble('AK', 'IA') + cycle(UPPER_ID_CHARS, 16);

/** An HTTP bearer credential, scheme word and all. */
const BEARER_CREDENTIAL = assemble('Bea', 'rer ') + cycle(URLSAFE_CHARS, 36);

/** A signed JSON Web Token: three base64url segments. */
const WEB_TOKEN = assemble(
  assemble('ey', 'J'),
  cycle(URLSAFE_CHARS, 18),
  '.',
  cycle(URLSAFE_CHARS, 22),
  '.',
  cycle(URLSAFE_CHARS, 26),
);

/** The delimiter of a key-file block. */
const PEM_DELIMITER = '-'.repeat(5);

/** The opening delimiter of an algorithm-qualified private-key block. */
const PRIVATE_KEY_HEADER = assemble(
  PEM_DELIMITER,
  'BEGIN ',
  'RSA ',
  assemble('PRIVATE', ' KEY'),
  PEM_DELIMITER,
);

/** An absolute URI carrying a user and a password before its host. */
const CREDENTIALED_URI = assemble(
  'postgresql',
  ':',
  '//',
  'reporting-svc',
  ':',
  cycle(URLSAFE_CHARS, 14),
  '@',
  'warehouse.internal.test',
  ':5432/analytics',
);

/**
 * A development-placeholder URI of exactly the shape
 * `scripts/check-secrets.allowlist.json` permits in six tracked files.
 *
 * Same shape, deliberately different bytes: a userinfo whose user and password
 * are the same word, a loopback host and the conventional database port. The
 * point of the fixture is the distinction the "keeps no allowlist" case below
 * asserts — that allowlist is a *tracked-file* concession so `.env.example`,
 * the Compose file and the documentation can carry the demo database
 * credential, and it grants nothing to an **outbound payload**. The two lists
 * must never be harmonised.
 */
const DEV_CREDENTIALED_URI = assemble(
  'postgresql',
  ':',
  '//',
  'devuser',
  ':',
  'devuser',
  '@',
  'localhost',
  ':5432/',
  'analytics_dev',
);

/** An unmasked header value: what the ingest checkpoint should have replaced. */
const HEADER_VALUE = assemble('Ses', 'sion=') + cycle(URLSAFE_CHARS, 24);

/** An opaque secret: long, dense and bound to a credential-like name. */
const OPAQUE_SECRET = cycle(URLSAFE_CHARS, 44);

/** A hexadecimal digest: 64 characters, and exactly four bits each. */
const HEX_DIGEST = cycle(HEX_CHARS, 64);

/**
 * A dense value exactly {@link ENTROPY_MIN_LENGTH} characters long: the
 * shortest the entropy rule will measure.
 */
const THRESHOLD_LENGTH_VALUE = cycle(URLSAFE_CHARS, ENTROPY_MIN_LENGTH);

/** The same material one character short of the length threshold. */
const BELOW_LENGTH_VALUE = cycle(URLSAFE_CHARS, ENTROPY_MIN_LENGTH - 1);

/**
 * Fifteen symbols, so a value cycled from them tops out just below
 * {@link ENTROPY_MIN_BITS_PER_CHAR} — `log2(15)` is about 3.91 bits.
 */
const NARROW_ALPHABET = charRange('a', 'o');

/** A long value that is not dense enough to be measurable key material. */
const BELOW_ENTROPY_VALUE = cycle(NARROW_ALPHABET, 48);

/** Every fixture whose bytes must never appear in any output of the guard. */
const SECRET_FIXTURES: readonly string[] = [
  VENDOR_CREDENTIAL,
  GENERIC_CREDENTIAL,
  FORGE_CLASSIC_CREDENTIAL,
  FORGE_FINE_CREDENTIAL,
  ACCESS_KEY_IDENTIFIER,
  BEARER_CREDENTIAL,
  WEB_TOKEN,
  PRIVATE_KEY_HEADER,
  CREDENTIALED_URI,
  DEV_CREDENTIALED_URI,
  HEADER_VALUE,
  OPAQUE_SECRET,
];

/*
 * ---------------------------------------------------------------------------
 * Assertions and helpers
 * ---------------------------------------------------------------------------
 */

/**
 * Filler for the long-string fixtures: ordinary words, ending in a space.
 *
 * The trailing space is load-bearing. A provider credential is recognised only
 * where its prefix *starts a token*, so filler ending in a word character would
 * suppress the very match those fixtures exist to find — see the
 * "does not match a credential prefix inside a word" case for that rule.
 */
const FILLER = 'evidence ';

/** `length` code units of {@link FILLER}, ending at a token boundary. */
function padding(length: number): string {
  return `${FILLER.repeat(Math.ceil(length / FILLER.length)).slice(0, length - 1)} `;
}

/**
 * Width of the sliding window {@link expectNoValueLeak} compares.
 *
 * A `toContain` on a whole fixture proves very little: the disclosure a finding
 * could plausibly make is a prefix, a suffix or a fragment. Eight code units is
 * short enough to catch a fragment anywhere inside a fixture and long enough
 * that it cannot collide with ordinary prose in a reason string.
 */
const LEAK_WINDOW = 8;

/**
 * Asserts that `text` carries no part of `secret` — not the whole value, not a
 * prefix, not any eight-character fragment.
 */
function expectNoValueLeak(text: string, secret: string): void {
  expect(text).not.toContain(secret);
  for (let index = 0; index + LEAK_WINDOW <= secret.length; index += 1) {
    expect(text).not.toContain(secret.slice(index, index + LEAK_WINDOW));
  }
}

/** Serialises findings so every field of every one can be searched at once. */
function serialise(findings: readonly RedactGuardFinding[]): string {
  return JSON.stringify(findings);
}

/** One warning the recording logger captured. */
interface RecordedWarning {
  readonly message: string;
  readonly fields: LogFields | undefined;
}

/**
 * A {@link Logger} that records `warn` calls and drops every other level.
 *
 * `Logger` is message-first — `warn(message, fields?)` — and this is where that
 * shape is asserted: a guard that logged a field bag as its message would put a
 * path where a sentence belongs.
 */
function createRecordingLogger(): {
  readonly logger: Logger;
  readonly warnings: RecordedWarning[];
} {
  const warnings: RecordedWarning[] = [];
  const drop = (): void => undefined;
  const logger: Logger = {
    level: 'warn',
    trace: drop,
    debug: drop,
    info: drop,
    warn: (message: string, fields?: LogFields): void => {
      warnings.push({ message, fields });
    },
    error: drop,
    fatal: drop,
    child: (): Logger => logger,
  };
  return { logger, warnings };
}

/** The rule ids of a finding list, in order. */
function ruleIdsOf(findings: readonly RedactGuardFinding[]): RedactionRuleId[] {
  return findings.map((finding) => finding.ruleId);
}

/** The rendered prose of a clean request: English, and nothing else. */
const CLEAN_PROMPT =
  'Summarise the captured evidence for this interaction and cite the event ids that support each observed statement.';

/** The optional halves of a request a test may want to fill in. */
interface RequestParts {
  readonly system?: string;
  readonly prompt?: string;
  readonly messages?: readonly ModelMessage[];
  readonly input?: JsonObject;
}

/**
 * A request with the required fields filled in plausibly.
 *
 * Built branch by branch rather than by spreading a `Partial`, because this
 * package compiles with `exactOptionalPropertyTypes`: an omitted optional field
 * must be *absent*, not present and `undefined`, which is also what the guard
 * is entitled to assume when it reads one.
 */
function makeRequest(parts: RequestParts = {}): ModelRequest {
  const base = {
    prompt: parts.prompt ?? CLEAN_PROMPT,
    input: parts.input ?? {},
    metadata: {
      stage: 'analyze',
      promptVersion: 'v001',
      sessionId: 'ses_01JBQ8Z4T7',
    },
  } satisfies ModelRequest;
  if (parts.system !== undefined && parts.messages !== undefined) {
    return { ...base, system: parts.system, messages: parts.messages };
  }
  if (parts.system !== undefined) {
    return { ...base, system: parts.system };
  }
  if (parts.messages !== undefined) {
    return { ...base, messages: parts.messages };
  }
  return base;
}

/*
 * ---------------------------------------------------------------------------
 * The shared vocabulary
 * ---------------------------------------------------------------------------
 */

describe('the deny-list vocabulary', () => {
  it('holds exactly the eight classes of AAP §0.5.2, in reporting order', () => {
    // Pinned as a list rather than a count: a ninth rule would refuse payloads
    // the product is entitled to send, and a missing one would let a class
    // through.
    expect([...REDACTION_RULE_IDS]).toEqual([
      'sensitive-header',
      'provider-key',
      'bearer-token',
      'jwt',
      'private-key',
      'connection-string',
      'url-query-value',
      'high-entropy-secret',
    ]);
  });

  it('explains every class without naming a value', () => {
    for (const ruleId of REDACTION_RULE_IDS) {
      const reason = REDACTION_RULE_REASONS[ruleId];
      expect(reason.length).toBeGreaterThan(0);
      expect(reason.endsWith('.')).toBe(true);
    }
    expect(Object.keys(REDACTION_RULE_REASONS)).toHaveLength(REDACTION_RULE_IDS.length);
  });

  it('is the exact redaction marker the ingest checkpoint writes', () => {
    // The ONE place this suite spells the marker out. Its bytes are a
    // cross-package contract: `packages/telemetry/src/redaction/rules.ts`
    // declares the same literal independently (AAP §0.2.2 forbids an import
    // edge between the two packages) and its own suite asserts it from the
    // other side. A denied header carrying it is compliant, which is what
    // makes a second checkpoint able to tell "redacted" from "never touched".
    expect(REDACTION_MARKER).toBe('[redacted]');
  });

  it('is the exact single-character query mask the ingest checkpoint writes', () => {
    expect(URL_QUERY_MASK).toBe('?');
    expect(URL_QUERY_MASK).toHaveLength(1);
  });

  it('counts a query value as masked only in the four forms the first checkpoint writes', () => {
    // The empty value, the mask, and each of them cut short by the truncation
    // marker every bounded preview appends. Pinned as a list: a fifth form
    // would let page bytes through, and a missing one would refuse the
    // redactor's own output.
    expect(TEXT_TRUNCATION_MARKER).toBe('\u2026');
    expect([...MASKED_QUERY_VALUES]).toEqual(['', '?', '\u2026', '?\u2026']);
    expect(Object.isFrozen(MASKED_QUERY_VALUES)).toBe(true);
  });

  it('mirrors the six denied header names verbatim', () => {
    expect([...DENIED_HEADER_NAMES]).toEqual([
      'authorization',
      'cookie',
      'set-cookie',
      'x-api-key',
      'x-auth-token',
      'proxy-authorization',
    ]);
    for (const name of DENIED_HEADER_NAMES) {
      expect(name).toBe(name.toLowerCase());
    }
  });

  it('binds the entropy rule to the four field-name terms and the gate thresholds', () => {
    expect([...KEY_LIKE_NAME_TERMS]).toEqual(['key', 'token', 'secret', 'password']);
    // Same numbers as `scripts/check-secrets.mjs`, so the two gates agree.
    expect(ENTROPY_MIN_LENGTH).toBe(32);
    expect(ENTROPY_MIN_BITS_PER_CHAR).toBe(4);
  });

  it('names its bounds and its defaults', () => {
    expect([...REDACT_GUARD_LIMIT_IDS]).toEqual([
      'max-depth',
      'max-nodes',
      'max-string-length',
      'max-url-runs',
      'max-url-length',
      'max-findings',
      'inspection-error',
    ]);
    expect(MAX_URL_RUNS_PER_STRING).toBeGreaterThan(0);
    expect(FRAME_CONTEXT_MAX_LENGTH).toBeGreaterThan(0);
    expect(DEFAULT_MAX_DEPTH).toBeGreaterThan(0);
    expect(DEFAULT_MAX_NODES).toBeGreaterThan(0);
    expect(DEFAULT_MAX_STRING_LENGTH).toBeGreaterThan(SCAN_WINDOW_LENGTH);
    expect(DEFAULT_MAX_FINDINGS).toBeGreaterThan(0);
    expect(SCAN_WINDOW_OVERLAP).toBeGreaterThan(0);
    expect(SCAN_WINDOW_OVERLAP).toBeLessThan(SCAN_WINDOW_LENGTH);
    expect(DEFAULT_ROOT_PATH).toBe('input');
  });
});

/*
 * ---------------------------------------------------------------------------
 * The measurement and naming primitives
 * ---------------------------------------------------------------------------
 */

describe('shannonEntropy', () => {
  it('is zero for an empty string and for one repeated character', () => {
    expect(shannonEntropy('')).toBe(0);
    expect(shannonEntropy('a'.repeat(64))).toBe(0);
  });

  it('cannot exceed the threshold for hexadecimal, however long the run', () => {
    // This is why the threshold is *exceeded* rather than met: a trace id, a
    // span id, a content hash and the store's HMAC request key are all hex, and
    // none of them may be reported as a credential.
    expect(shannonEntropy(HEX_DIGEST)).toBeLessThanOrEqual(ENTROPY_MIN_BITS_PER_CHAR);
  });

  it('exceeds the threshold for dense base64url material', () => {
    expect(shannonEntropy(OPAQUE_SECRET)).toBeGreaterThan(ENTROPY_MIN_BITS_PER_CHAR);
  });

  it('is bounded by the logarithm of the alphabet size', () => {
    expect(shannonEntropy(cycle('ab', 32))).toBeCloseTo(1, 10);
    expect(shannonEntropy(cycle('abcd', 32))).toBeCloseTo(2, 10);
  });
});

describe('isKeyLikeName', () => {
  it('accepts the credential-like names an outbound payload actually carries', () => {
    for (const name of [
      'apiKey',
      'API_KEY',
      'x-api-key',
      'clientSecret',
      'accessToken',
      'password',
    ]) {
      expect(isKeyLikeName(name)).toBe(true);
    }
  });

  it('rejects a name with none of the terms in it, and the empty name', () => {
    for (const name of ['component', 'traceId', 'duration', 'statement', '']) {
      expect(isKeyLikeName(name)).toBe(false);
    }
  });

  it('over-matches on purpose rather than under-matching', () => {
    // The substring test is wider than the repository gate's separator-aware
    // form. That is the intended direction of error: a name alone is never a
    // finding, so the cost is measuring a value nobody meant as a credential.
    expect(isKeyLikeName('monkey')).toBe(true);
    expect(isKeyLikeName('keystore')).toBe(true);
  });
});

describe('isDeniedHeaderName', () => {
  it('matches each of the six names in any case, padded or not', () => {
    expect(isDeniedHeaderName('Authorization')).toBe(true);
    expect(isDeniedHeaderName('  SET-COOKIE  ')).toBe(true);
    expect(isDeniedHeaderName('X-Api-Key')).toBe(true);
    expect(isDeniedHeaderName('proxy-authorization')).toBe(true);
  });

  it('matches a flattened span-attribute key by its final segment', () => {
    expect(isDeniedHeaderName('http.request.header.authorization')).toBe(true);
    expect(isDeniedHeaderName('http.response.header.set-cookie')).toBe(true);
  });

  it('does not match a product field whose name merely contains one', () => {
    expect(isDeniedHeaderName('cookieConsentGiven')).toBe(false);
    expect(isDeniedHeaderName('authorizationPolicy')).toBe(false);
    expect(isDeniedHeaderName('header.authorization.notes')).toBe(false);
    expect(isDeniedHeaderName('')).toBe(false);
  });
});

/*
 * ---------------------------------------------------------------------------
 * One positive case per deny-list class
 * ---------------------------------------------------------------------------
 */

/** A value the query mask should have replaced. */
const QUERY_VALUE = cycle(URLSAFE_CHARS, 18);

/** One class, the payload that trips it, where, and the value it must not echo. */
interface RuleCase {
  readonly ruleId: RedactionRuleId;
  readonly label: string;
  readonly payload: JsonObject;
  readonly path: string;
  readonly secret: string;
}

const RULE_CASES: readonly RuleCase[] = [
  {
    ruleId: 'sensitive-header',
    label: 'a denied header whose value was never replaced',
    payload: { attributes: { authorization: BEARER_CREDENTIAL } },
    path: 'input.attributes.authorization',
    secret: BEARER_CREDENTIAL,
  },
  {
    ruleId: 'provider-key',
    label: 'a vendor API credential inside a source excerpt',
    payload: { excerpt: `const client = createClient({ auth: '${VENDOR_CREDENTIAL}' });` },
    path: 'input.excerpt',
    secret: VENDOR_CREDENTIAL,
  },
  {
    ruleId: 'bearer-token',
    label: 'a bearer credential in running text',
    payload: { excerpt: `request.setHeader('authorization', '${BEARER_CREDENTIAL}');` },
    path: 'input.excerpt',
    secret: BEARER_CREDENTIAL,
  },
  {
    ruleId: 'jwt',
    label: 'a three-segment web token',
    payload: { notes: `the session cookie held ${WEB_TOKEN}` },
    path: 'input.notes',
    secret: WEB_TOKEN,
  },
  {
    ruleId: 'private-key',
    label: 'a PEM private-key block header',
    payload: { excerpt: `${PRIVATE_KEY_HEADER}\n${cycle(URLSAFE_CHARS, 40)}` },
    path: 'input.excerpt',
    secret: PRIVATE_KEY_HEADER,
  },
  {
    ruleId: 'connection-string',
    label: 'a URI carrying a user and a password',
    payload: { environment: { url: CREDENTIALED_URI } },
    path: 'input.environment.url',
    secret: CREDENTIALED_URI,
  },
  {
    ruleId: 'url-query-value',
    label: 'an origin-relative URL that kept a query value',
    payload: { requests: [{ url: `/reports/summary?cursor=${QUERY_VALUE}&page=?` }] },
    path: 'input.requests[0].url?cursor',
    secret: QUERY_VALUE,
  },
  {
    ruleId: 'high-entropy-secret',
    label: 'an opaque secret bound to a credential-like field name',
    payload: { environment: { serviceToken: OPAQUE_SECRET } },
    path: 'input.environment.serviceToken',
    secret: OPAQUE_SECRET,
  },
];

describe('each deny-list class is detected', () => {
  for (const { ruleId, label, payload, path, secret } of RULE_CASES) {
    it(`${ruleId}: ${label}`, () => {
      // The rule is applied on its own, which isolates the class under test
      // and exercises the `rules` filter at the same time: several fixtures
      // legitimately trip more than one class (a bearer credential under an
      // `authorization` key is both a header finding and a content finding).
      const findings = inspectPayload(payload, { rules: [ruleId] });
      expect(findings).toHaveLength(1);
      expect(findings[0]?.ruleId).toBe(ruleId);
      expect(findings[0]?.path).toBe(path);
      expect(findings[0]?.reason).toBe(REDACTION_RULE_REASONS[ruleId]);
    });

    it(`${ruleId}: reports the field without echoing the value`, () => {
      // The hard requirement. Not the value, not a prefix, not any fragment of
      // it, in any field of any finding.
      expectNoValueLeak(serialise(inspectPayload(payload, { rules: [ruleId] })), secret);
      expectNoValueLeak(serialise(inspectPayload(payload)), secret);
    });
  }

  it('reports every class from one payload that carries all of them', () => {
    const payload: JsonObject = {
      headers: { cookie: WEB_TOKEN, 'x-auth-token': GENERIC_CREDENTIAL },
      excerpts: [
        `const a = '${FORGE_CLASSIC_CREDENTIAL}';`,
        `const b = '${FORGE_FINE_CREDENTIAL}';`,
        `const c = '${ACCESS_KEY_IDENTIFIER}';`,
        PRIVATE_KEY_HEADER,
        `authorization: '${BEARER_CREDENTIAL}'`,
      ],
      environment: { url: CREDENTIALED_URI, apiKey: OPAQUE_SECRET },
      requests: [{ url: `/reports/summary?cursor=${QUERY_VALUE}` }],
    };
    const report = inspectPayloadReport(payload);
    expect(report.complete).toBe(true);
    expect(new Set(ruleIdsOf(report.findings))).toEqual(new Set(REDACTION_RULE_IDS));
    for (const secret of SECRET_FIXTURES) {
      expectNoValueLeak(serialise(report.findings), secret);
    }
  });

  it('reports a class once per field, however often it occurs there', () => {
    // A count of occurrences would be a measurement of the value, which a
    // finding may not carry.
    const repeated = [VENDOR_CREDENTIAL, GENERIC_CREDENTIAL, VENDOR_CREDENTIAL].join(' and ');
    const findings = inspectPayload({ excerpt: repeated }, { rules: ['provider-key'] });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.path).toBe('input.excerpt');
  });

  it('applies the content rules to the prose halves of a request as well', () => {
    // A credential can arrive inside a bounded source excerpt that was
    // interpolated into the rendered prompt, so prose is scanned too.
    const request = makeRequest({
      system: `Never repeat a credential such as ${GENERIC_CREDENTIAL}.`,
      prompt: `${CLEAN_PROMPT} ${WEB_TOKEN}`,
      messages: [
        { role: 'user', content: 'Why did this take so long?' },
        { role: 'assistant', content: `I read ${PRIVATE_KEY_HEADER} in the configuration.` },
      ],
    });
    const result = assertOutboundSafe(request);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    const paths = result.error.details?.paths;
    expect(paths).toEqual(['system', 'prompt', 'messages[1].content']);
  });

  it('names a non-identifier key in brackets and quotes it', () => {
    const findings = inspectPayload(
      { attributes: { 'http.request.header.authorization': BEARER_CREDENTIAL } },
      { rules: ['sensitive-header'] },
    );
    expect(findings[0]?.path).toBe('input.attributes["http.request.header.authorization"]');
  });

  it('reports each value of a repeated denied header', () => {
    const findings = inspectPayload(
      { headers: { 'set-cookie': [REDACTION_MARKER, WEB_TOKEN] } },
      { rules: ['sensitive-header'] },
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.path).toBe('input.headers["set-cookie"][1]');
  });

  it('measures an array member under the key its array is bound to', () => {
    // An array inherits its parent's key, so a credential in `{ tokens: [...] }`
    // is measured under `tokens` instead of escaping the entropy rule because
    // its immediate parent had no name.
    const findings = inspectPayload(
      { tokens: [OPAQUE_SECRET] },
      { rules: ['high-entropy-secret'] },
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.path).toBe('input.tokens[0]');
  });

  it('honours a caller-supplied root path', () => {
    const findings = inspectPayload(
      { environment: { url: CREDENTIALED_URI } },
      { rootPath: 'context' },
    );
    expect(findings[0]?.path).toBe('context.environment.url');
  });

  it('names the query parameter of an absolute URL, and never its value', () => {
    // Both spellings reach a payload: a captured request target is usually
    // origin-relative (the table case above), and an outgoing call to another
    // service is absolute. The finding names the parameter because the name is
    // structure a developer needs and the value is the thing the rule objects
    // to.
    const findings = inspectPayload(
      { requests: [{ url: `https://warehouse.internal.test/v1/summary?token=${QUERY_VALUE}` }] },
      { rules: ['url-query-value'] },
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.ruleId).toBe('url-query-value');
    expect(findings[0]?.path).toBe(`${DEFAULT_ROOT_PATH}.requests[0].url${URL_QUERY_MASK}token`);
    expectNoValueLeak(serialise(findings), QUERY_VALUE);
  });
});

/*
 * ---------------------------------------------------------------------------
 * Every enumerated member of the two enumerated classes
 *
 * `sensitive-header` and `provider-key` are the two classes of AAP §0.5.2 whose
 * table row enumerates members, so one case per row is not enough: a rule that
 * recognised five of the six header names, or three of the five credential
 * prefixes, would pass a single-case suite and leak the rest.
 * ---------------------------------------------------------------------------
 */

/** A key the walk appends after a dot rather than bracketing and quoting. */
const IDENTIFIER_KEY_LIKE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** How a denied header's path is spelled once the walk has appended its key. */
function attributePath(key: string): string {
  return IDENTIFIER_KEY_LIKE.test(key)
    ? `${DEFAULT_ROOT_PATH}.attributes.${key}`
    : `${DEFAULT_ROOT_PATH}.attributes["${key}"]`;
}

describe('every denied header name is recognised where it sits', () => {
  for (const name of DENIED_HEADER_NAMES) {
    it(`reports an unreplaced value under ${name}`, () => {
      // Nested under an attributes-shaped object, which is how a captured
      // request's headers reach a prompt payload.
      const findings = inspectPayload(
        { attributes: { [name]: HEADER_VALUE } },
        { rules: ['sensitive-header'] },
      );
      expect(findings).toHaveLength(1);
      expect(findings[0]?.ruleId).toBe('sensitive-header');
      expect(findings[0]?.path).toBe(attributePath(name));
      expect(findings[0]?.reason).toBe(REDACTION_RULE_REASONS['sensitive-header']);
      expectNoValueLeak(serialise(findings), HEADER_VALUE);
    });
  }

  it('recognises a header name in the case the producer happened to write', () => {
    // A browser agent writes `authorization`, a source excerpt spells it
    // `Authorization`, and a response header arrives as `Set-Cookie`. The case
    // a producer chose cannot decide whether a credential is redacted.
    for (const key of ['Authorization', 'Set-Cookie', 'X-Api-Key', 'PROXY-AUTHORIZATION']) {
      const findings = inspectPayload(
        { attributes: { [key]: HEADER_VALUE } },
        { rules: ['sensitive-header'] },
      );
      expect(findings).toHaveLength(1);
      expect(findings[0]?.path).toBe(attributePath(key));
    }
  });

  it('recognises each name as the final segment of a flattened attribute key', () => {
    // A Node exporter flattens headers into span attributes, so the header name
    // arrives as the last dot-separated segment of a longer key.
    for (const name of DENIED_HEADER_NAMES) {
      const key = `http.request.header.${name}`;
      const findings = inspectPayload(
        { attributes: { [key]: HEADER_VALUE } },
        { rules: ['sensitive-header'] },
      );
      expect(findings).toHaveLength(1);
      expect(findings[0]?.path).toBe(`${DEFAULT_ROOT_PATH}.attributes["${key}"]`);
      expectNoValueLeak(serialise(findings), HEADER_VALUE);
    }
  });
});

/** One credential prefix of the `provider-key` class, and the value carrying it. */
interface CredentialCase {
  readonly label: string;
  readonly value: string;
}

const CREDENTIAL_CASES: readonly CredentialCase[] = [
  { label: 'the vendor prefix', value: VENDOR_CREDENTIAL },
  { label: 'the generic vendor prefix', value: GENERIC_CREDENTIAL },
  { label: 'a classic forge token prefix', value: FORGE_CLASSIC_CREDENTIAL },
  { label: 'a fine-grained forge token prefix', value: FORGE_FINE_CREDENTIAL },
  { label: 'a cloud access-key identifier prefix', value: ACCESS_KEY_IDENTIFIER },
];

describe('every provider credential prefix is recognised', () => {
  for (const { label, value } of CREDENTIAL_CASES) {
    it(`reports ${label}`, () => {
      const payload: JsonObject = { excerpt: `const client = createClient('${value}');` };
      const findings = inspectPayload(payload, { rules: ['provider-key'] });
      expect(findings).toHaveLength(1);
      expect(findings[0]?.ruleId).toBe('provider-key');
      expect(findings[0]?.path).toBe(`${DEFAULT_ROOT_PATH}.excerpt`);
      expect(findings[0]?.reason).toBe(REDACTION_RULE_REASONS['provider-key']);
      expectNoValueLeak(serialise(findings), value);
    });
  }

  it('covers every prefix the class enumerates', () => {
    // A prefix added to the module's shape table without a case here would be
    // untested, so the count is pinned rather than left to the reader.
    expect(CREDENTIAL_CASES).toHaveLength(5);
  });
});

describe('the guard keeps no allowlist', () => {
  it('flags a development-placeholder URI exactly as it flags any other', () => {
    // `scripts/check-secrets.allowlist.json` exempts two development
    // placeholders — the demo database URL and the Compose password line — in
    // six named **tracked files**, so a fresh clone can run `pnpm demo:db`.
    // That concession is about what may be *committed*. It says nothing about
    // what may be *sent*: a credentialed URI in an outbound payload is a
    // finding whatever it authenticates against, because the guard cannot know
    // that a loopback host in a captured attribute is the developer's own
    // throwaway container rather than their production warehouse. Do not
    // harmonise the two lists.
    for (const uri of [CREDENTIALED_URI, DEV_CREDENTIALED_URI]) {
      const findings = inspectPayload(
        { environment: { url: uri } },
        { rules: ['connection-string'] },
      );
      expect(findings).toHaveLength(1);
      expect(findings[0]?.ruleId).toBe('connection-string');
      expect(findings[0]?.path).toBe(`${DEFAULT_ROOT_PATH}.environment.url`);
      expectNoValueLeak(serialise(findings), uri);
    }
  });

  it('refuses a request carrying one, rather than exempting it', () => {
    const result = assertOutboundSafe(
      makeRequest({ input: { environment: { url: DEV_CREDENTIALED_URI } } }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.details?.ruleIds).toEqual(['connection-string']);
    expectNoValueLeak(JSON.stringify(result.error.details), DEV_CREDENTIALED_URI);
  });
});

describe('the entropy rule binds to a name and to both thresholds', () => {
  for (const term of KEY_LIKE_NAME_TERMS) {
    it(`measures a value bound to a field name containing "${term}"`, () => {
      // The field name is built from the exported vocabulary rather than
      // written out, so dropping a term from `KEY_LIKE_NAME_TERMS` fails here
      // instead of silently narrowing the rule.
      const key = `outbound_${term}`;
      expect(isKeyLikeName(key)).toBe(true);
      const findings = inspectPayload(
        { environment: { [key]: OPAQUE_SECRET } },
        { rules: ['high-entropy-secret'] },
      );
      expect(findings).toHaveLength(1);
      expect(findings[0]?.ruleId).toBe('high-entropy-secret');
      expect(findings[0]?.path).toBe(`${DEFAULT_ROOT_PATH}.environment.${key}`);
      expectNoValueLeak(serialise(findings), OPAQUE_SECRET);
    });
  }

  it('measures a value of exactly the threshold length', () => {
    // The length bound is inclusive, and this is the case that pins it.
    expect(THRESHOLD_LENGTH_VALUE).toHaveLength(ENTROPY_MIN_LENGTH);
    expect(shannonEntropy(THRESHOLD_LENGTH_VALUE)).toBeGreaterThan(ENTROPY_MIN_BITS_PER_CHAR);
    expect(
      inspectPayload({ apiKey: THRESHOLD_LENGTH_VALUE }, { rules: ['high-entropy-secret'] }),
    ).toHaveLength(1);
  });

  it('leaves a value one character short of the threshold alone', () => {
    // Below the bound an estimate says nothing: a short dense word and a short
    // credential are indistinguishable by density, and refusing on one would
    // refuse ordinary identifiers.
    expect(BELOW_LENGTH_VALUE).toHaveLength(ENTROPY_MIN_LENGTH - 1);
    expect(shannonEntropy(BELOW_LENGTH_VALUE)).toBeGreaterThan(ENTROPY_MIN_BITS_PER_CHAR);
    expect(
      inspectPayload({ apiKey: BELOW_LENGTH_VALUE }, { rules: ['high-entropy-secret'] }),
    ).toEqual([]);
  });

  it('leaves a long value that is not dense enough alone', () => {
    // Just under the density bound, from an alphabet of fifteen symbols.
    expect(BELOW_ENTROPY_VALUE.length).toBeGreaterThan(ENTROPY_MIN_LENGTH);
    expect(shannonEntropy(BELOW_ENTROPY_VALUE)).toBeLessThan(ENTROPY_MIN_BITS_PER_CHAR);
    expect(
      inspectPayload({ accessToken: BELOW_ENTROPY_VALUE }, { rules: ['high-entropy-secret'] }),
    ).toEqual([]);
  });

  it('stays bound to the name: the same material under an ordinary one passes', () => {
    // A content hash, a digest and a cache key are dense by construction, so a
    // rule that measured every long value would refuse every payload carrying
    // one. `hash` is not credential-like, and that is the whole difference.
    expect(isKeyLikeName('hash')).toBe(false);
    expect(inspectPayload({ hash: OPAQUE_SECRET })).toEqual([]);
    expect(inspectPayload({ digest: OPAQUE_SECRET })).toEqual([]);
    // The contrast, on the same bytes, so the name is demonstrably what decided
    // it rather than something about the value.
    expect(
      inspectPayload({ clientSecret: OPAQUE_SECRET }, { rules: ['high-entropy-secret'] }),
    ).toHaveLength(1);
  });
});

describe('a rule subset narrows what is reported and nothing else', () => {
  /** A payload carrying three classes at three distinct paths. */
  const mixed: JsonObject = {
    notes: `the cookie held ${WEB_TOKEN}`,
    environment: { url: CREDENTIALED_URI },
    keyFile: PRIVATE_KEY_HEADER,
  };

  it('reports only the selected class', () => {
    const findings = inspectPayload(mixed, { rules: ['jwt'] });
    expect(ruleIdsOf(findings)).toEqual(['jwt']);
    expect(findings[0]?.path).toBe(`${DEFAULT_ROOT_PATH}.notes`);
  });

  it('reports exactly the selected subset, in reporting order', () => {
    const findings = inspectPayload(mixed, { rules: ['private-key', 'jwt'] });
    expect(ruleIdsOf(findings)).toEqual(['jwt', 'private-key']);
  });

  it('reports all three when no subset is given', () => {
    // The other classes' fixtures are unchanged: they were silent because they
    // were not selected, not because they stopped matching.
    expect(new Set(ruleIdsOf(inspectPayload(mixed)))).toEqual(
      new Set(['jwt', 'connection-string', 'private-key']),
    );
  });
});

/*
 * ---------------------------------------------------------------------------
 * The compliant output of the first checkpoint must pass
 * ---------------------------------------------------------------------------
 */

/**
 * A React prop preview as the capture layer produces one: summarised, and cut
 * to 120 characters with the truncation marker.
 */
const PROP_PREVIEW = `${'a bounded preview of the previous value '.repeat(4).slice(0, 119)}\u2026`;

/**
 * A payload built only from shapes the ingest checkpoint produces.
 *
 * Every one of them is a negative case in its own right below; assembled here
 * as well because the property that matters in production is that a *whole*
 * realistic payload passes. A guard that refused its own upstream would make
 * the product unusable, which is a worse failure than the one it prevents.
 */
const COMPLIANT_PAYLOAD: JsonObject = {
  requests: [
    {
      url: '/reports/summary?cursor=?&page=?&flag',
      method: 'GET',
      status: 200,
      durationMs: 431.25,
      headers: {
        authorization: REDACTION_MARKER,
        cookie: REDACTION_MARKER,
        'set-cookie': [REDACTION_MARKER, REDACTION_MARKER],
        'x-api-key': '',
      },
    },
  ],
  queries: [
    {
      statement: 'SELECT id, quantity FROM movements WHERE warehouse_id = $1 AND created_at > $2',
      rowCount: 42,
      durationMs: 640.5,
    },
  ],
  renders: [
    {
      component: 'SummaryCard',
      renderCount: 4,
      trigger: 'context',
      changedProps: [{ name: 'items', type: 'array', preview: PROP_PREVIEW }],
    },
  ],
  attributes: {
    'http.request.header.authorization': REDACTION_MARKER,
    'http.response.header.set-cookie': REDACTION_MARKER,
  },
  traceId: cycle(HEX_CHARS, 32),
  spanId: cycle(HEX_CHARS, 16),
  request_key: HEX_DIGEST,
  summary: 'Four identical requests occurred within 22 ms of one another.',
};

describe('a payload the ingest checkpoint already redacted passes', () => {
  it('reports nothing for a whole realistic payload, and reports it as complete', () => {
    const report = inspectPayloadReport(COMPLIANT_PAYLOAD);
    expect(report.findings).toEqual([]);
    expect(report.complete).toBe(true);
    expect(report.limitsReached).toEqual([]);
    expect(report.inspected).toBeGreaterThan(0);
  });

  it('accepts a denied header carrying exactly the redaction marker', () => {
    // Positive evidence that the first checkpoint ran on this field. This is
    // the whole reason a second checkpoint can exist.
    expect(inspectPayload({ headers: { authorization: REDACTION_MARKER } })).toEqual([]);
    expect(inspectPayload({ headers: { cookie: `  ${REDACTION_MARKER}  ` } })).toEqual([]);
  });

  it('accepts a denied header that arrived without a value', () => {
    expect(inspectPayload({ headers: { 'x-api-key': '', 'x-auth-token': '   ' } })).toEqual([]);
  });

  it('accepts a URL whose query values are masked, empty or bare flags', () => {
    expect(inspectPayload({ url: '/reports/summary?cursor=?&page=?' })).toEqual([]);
    expect(inspectPayload({ url: '/reports/summary?cursor=&page' })).toEqual([]);
    expect(
      inspectPayload({ url: 'https://warehouse.internal.test/v1/summary?cursor=?#anchor' }),
    ).toEqual([]);
  });

  it('accepts parameterised SQL with its placeholders intact', () => {
    // `packages/telemetry/src/redaction/sql.ts` emits exactly this, and its own
    // suite asserts that what it emits "emits nothing the deny list
    // recognises" — from the other side of the same contract.
    expect(
      inspectPayload({
        statement: 'UPDATE carts SET quantity = $1 WHERE id = $2 AND owner = $3 RETURNING id',
      }),
    ).toEqual([]);
    expect(
      inspectPayload({ statement: 'SELECT * FROM prices WHERE sku = ? AND region = ?' }),
    ).toEqual([]);
  });

  it('accepts a React prop preview truncated to 120 characters', () => {
    expect(PROP_PREVIEW).toHaveLength(120);
    expect(inspectPayload({ changedProps: [{ name: 'items', preview: PROP_PREVIEW }] })).toEqual(
      [],
    );
  });

  it('accepts a hexadecimal digest bound to a credential-like name', () => {
    // The entropy threshold is exceeded rather than met precisely so that a
    // trace id, a span id and the store's HMAC request key can travel.
    expect(isKeyLikeName('request_key')).toBe(true);
    expect(inspectPayload({ request_key: HEX_DIGEST })).toEqual([]);
    expect(inspectPayload({ sessionKey: cycle(HEX_CHARS, 128) })).toEqual([]);
  });

  it('accepts a sentence bound to a credential-like field name', () => {
    // English prose sits right at the entropy threshold, so measuring a
    // sentence under such a name would refuse legitimate calls. A credential is
    // issued as one unbroken token and never carries a space — and a credential
    // *inside* a sentence is still found by the content rules, which read every
    // string whatever it contains.
    const sentence =
      'Ask Quentin for the vault phrase; combine it with 1984 and the Zebra/Xray prefix (v7).';
    expect(shannonEntropy(sentence)).toBeGreaterThan(ENTROPY_MIN_BITS_PER_CHAR);
    expect(inspectPayload({ passwordHint: sentence })).toEqual([]);
    expect(inspectPayload({ tokenNotes: sentence })).toEqual([]);
    expect(
      inspectPayload(
        { tokenNotes: `${sentence} ${GENERIC_CREDENTIAL}` },
        { rules: ['provider-key'] },
      ),
    ).toHaveLength(1);
  });

  it('accepts the scheme word followed by the marker, which is what the bearer rule leaves', () => {
    expect(inspectPayload({ excerpt: `${assemble('Bea', 'rer ')}${REDACTION_MARKER}` })).toEqual(
      [],
    );
  });

  it('accepts a URI whose userinfo was replaced wholesale', () => {
    const redactedUri = assemble(
      'postgresql',
      ':',
      '//',
      REDACTION_MARKER,
      '@',
      'warehouse.internal.test',
      ':5432/analytics',
    );
    expect(inspectPayload({ environment: { url: redactedUri } })).toEqual([]);
  });

  it('accepts English prose, which sits close to the entropy threshold', () => {
    // Prose is only safe because the entropy rule binds to a *name*: the
    // rendered prompt of every stage would otherwise be reported as a secret.
    const result = assertOutboundSafe(makeRequest({ input: COMPLIANT_PAYLOAD }));
    expect(result.ok).toBe(true);
  });

  it('ignores a value that is not a string', () => {
    expect(inspectPayload({ count: 4, ratio: 0.5, flag: true, absent: null })).toEqual([]);
  });

  it('accepts the ordinary furniture of an evidence payload', () => {
    // Everything a stage's structured context is mostly made of: project-relative
    // paths, component and symbol identifiers, prose, scalars and the empty
    // containers an aggregate produces when it found nothing. None of it is a
    // finding, and an empty container is not an excuse to stop early either —
    // the walk still reports itself complete.
    const report = inspectPayloadReport({
      files: ['src/components/SummaryCard.tsx', 'src/server/reporting.ts', './relative/module.tsx'],
      symbols: ['SummaryCard', 'handleSubmit', 'loadSummary'],
      summary: 'The interaction spent most of its time waiting on one query.',
      counts: { renders: 4, requests: 2, duplicates: 0 },
      flags: { duplicateSuspected: true, unresolved: false, owner: null },
      emptyObject: {},
      emptyArray: [],
      nested: { levels: [{}, [], { note: '' }] },
    });
    expect(report.findings).toEqual([]);
    expect(report.complete).toBe(true);
    expect(report.limitsReached).toEqual([]);
  });

  it('does not match a credential prefix inside a word', () => {
    // A prefix is only a credential where it *starts a token*. Without that
    // boundary, ordinary compound words carry the shortest prefix followed by
    // more than sixteen word characters, and a guard that refused calls over
    // ordinary prose is a guard a developer switches off.
    const inWord = `di${GENERIC_CREDENTIAL}`;
    expect(inspectPayload({ excerpt: inWord }, { rules: ['provider-key'] })).toEqual([]);
    expect(
      inspectPayload({ excerpt: `a ${GENERIC_CREDENTIAL}` }, { rules: ['provider-key'] }),
    ).toHaveLength(1);
  });
});

/*
 * ---------------------------------------------------------------------------
 * URLs embedded in prose
 *
 * A developer's question, a rendered prompt, a captured label and an error
 * message all quote URLs inside sentences, so `url-query-value` reads every
 * string for embedded runs as well as for whole-field URLs. The cases below pin
 * both directions of the contract with the first checkpoint: every value the
 * telemetry layer would have masked and did not is refused, and every form it
 * writes — and every ordinary line of source code — passes.
 * ---------------------------------------------------------------------------
 */

/** A short query value a page wrote, kept out of the source as one literal. */
const SHORT_QUERY_VALUE = assemble('ZIP', '42');

/** The `url-query-value` findings of one string, read under `input.note`. */
function urlFindings(text: string): readonly RedactGuardFinding[] {
  return inspectPayload({ note: text }, { rules: ['url-query-value'] });
}

/** Where a finding for parameter `name` of `input.note` is reported. */
function notePath(name: string): string {
  return `${DEFAULT_ROOT_PATH}.note${URL_QUERY_MASK}${name}`;
}

/** Asserts that one string yields exactly one finding, for `name`. */
function expectUnmaskedParameter(text: string, name: string): void {
  const findings = urlFindings(text);
  expect(findings, text).toHaveLength(1);
  expect(findings[0]?.ruleId, text).toBe('url-query-value');
  expect(findings[0]?.path, text).toBe(notePath(name));
  expect(findings[0]?.reason, text).toBe(REDACTION_RULE_REASONS['url-query-value']);
}

describe('a URL embedded in prose is inspected', () => {
  it('refuses a question that quotes an unmasked query value, naming only the parameter', () => {
    // The finding the whitespace shortcut used to let through: the rendered
    // prompt carries the question, and the value reached the provider.
    const question = `Why is /reset?code=${SHORT_QUERY_VALUE} slow?`;
    const result = assertOutboundSafe(makeRequest({ prompt: question }));
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.details?.ruleIds).toEqual(['url-query-value']);
    expect(result.error.details?.paths).toEqual([`prompt${URL_QUERY_MASK}code`]);
    const printed = [
      result.error.message,
      result.error.hint ?? '',
      JSON.stringify(result.error.details),
      JSON.stringify(result.error.toPayload()),
    ].join('\n');
    expect(printed).not.toContain(SHORT_QUERY_VALUE);
  });

  it('reads every prose half of a request and every string of the structured context', () => {
    const run = `/reset?code=${SHORT_QUERY_VALUE}`;
    const result = assertOutboundSafe(
      makeRequest({
        system: `Never repeat ${run} to the developer.`,
        prompt: `${CLEAN_PROMPT} The page linked ${run} twice.`,
        messages: [
          { role: 'user', content: 'Why did this take so long?' },
          { role: 'assistant', content: `The slow request was ${run} after the click.` },
        ],
        input: { requests: [{ note: `Visited ${run} before clicking` }] },
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.details?.paths).toEqual([
      `system${URL_QUERY_MASK}code`,
      `prompt${URL_QUERY_MASK}code`,
      `messages[1].content${URL_QUERY_MASK}code`,
      `${DEFAULT_ROOT_PATH}.requests[0].note${URL_QUERY_MASK}code`,
    ]);
    expect(JSON.stringify(result.error.details)).not.toContain(SHORT_QUERY_VALUE);
  });

  it('reports punctuation a page wrote as a value, not as the end of a sentence', () => {
    // Legal query characters. Whether they close the sentence or belong to the
    // value is the ambiguity the first checkpoint resolves by masking them, so
    // any that survive here were never masked — a mask followed by a full stop
    // included.
    expectUnmaskedParameter('Open /reset?code=!!!! to reproduce', 'code');
    expectUnmaskedParameter('Open /reset?code=.... to reproduce', 'code');
    expectUnmaskedParameter('See /p?id=?. for the list', 'id');
    for (const value of ['!!!!', '....', '?.']) {
      expect(serialise(urlFindings(`Open /reset?code=${value} now`))).not.toContain(value);
    }
  });

  it('reads an absolute URL anywhere in a sentence, and a relative one after a space or a bracket', () => {
    expectUnmaskedParameter('see https://x.test/a?b=1 now', 'b');
    expectUnmaskedParameter('see HTTP://x.test/a?b=1 now', 'b');
    expectUnmaskedParameter('(see /p?id=7)', 'id');
    expectUnmaskedParameter('/p?id=7 was the first request', 'id');
    expectUnmaskedParameter('then\n/p?id=7 again', 'id');
  });

  it('names the first unmasked parameter of a run, and each name once per field', () => {
    expectUnmaskedParameter('see /p?page=?&cursor=abc&sort=desc now', 'cursor');
    const repeated = urlFindings('first /p?cursor=abc then /q?cursor=def');
    expect(repeated.map((finding) => finding.path)).toEqual([notePath('cursor')]);
    const distinct = urlFindings('first /p?cursor=abc then /q?sort=desc');
    expect(distinct.map((finding) => finding.path)).toEqual([notePath('cursor'), notePath('sort')]);
  });

  it('passes every masked form the first checkpoint writes', () => {
    for (const text of [
      'Why is /reset?code=? slow?',
      'see https://x.test/a?b=?#? now',
      'see /p?id=\u2026',
      'see /p?id=?\u2026',
      'see /p?id=?&flag&empty= and /q?x=?&[redacted] now',
      'Why? It is slow.',
    ]) {
      const report = inspectPayloadReport({ note: text });
      expect(report.findings, text).toEqual([]);
      expect(report.complete, text).toBe(true);
    }
    expect(assertOutboundSafe(makeRequest({ prompt: 'Why is /reset?code=? slow?' })).ok).toBe(true);
  });

  it('accepts the position a stack frame keeps after its masked query, and only in a frame', () => {
    // The redactor re-attaches a frame's runtime-appended position after it
    // masks the URL, because the source-map route needs it; the parser reads
    // that position as part of the last value. Outside a frame nothing licenses
    // that reading, so the same run is a finding.
    const frame = '    at fn (http://127.0.0.1:3000/app.js?v=?:10:5)';
    expect(urlFindings(frame)).toEqual([]);
    expect(
      urlFindings(`Error: boom\n${frame}\n    at run (http://127.0.0.1:3000/app.js?v=?:2:1)`),
    ).toEqual([]);
    expect(urlFindings('fn@http://127.0.0.1:3000/app.js?v=?:10:5')).toEqual([]);
    expect(urlFindings('    at http://127.0.0.1:3000/app.js?v=&t=?:10:5')).toEqual([]);
    expect(urlFindings('    at fn (http://127.0.0.1:3000/app.js?v=?:10:\u2026')).toEqual([]);

    expectUnmaskedParameter('    at fn (http://127.0.0.1:3000/app.js?v=1:10:5)', 'v');
    expectUnmaskedParameter('loaded http://x/app.js?v=?:10:5', 'v');
    expectUnmaskedParameter('    at fn (/app.js?v=?:10:5)', 'v');
  });

  it('reads a frame marker only from the run line, and only within the look-back bound', () => {
    // Another line's `at` is not this frame's.
    expectUnmaskedParameter('    at fn (x)\nloaded http://x/app.js?v=?:10:5', 'v');
    // A marker further back than the bound is not read, which is the strict
    // direction: the position is reported rather than accepted.
    const far = `    at fn (${'w'.repeat(FRAME_CONTEXT_MAX_LENGTH)}http://x/app.js?v=?:10:5)`;
    expectUnmaskedParameter(far, 'v');
    // A look-back cut just before an `at` inside a word must not read as the
    // start of a line.
    const cut = `zzzzzat ${'w'.repeat(FRAME_CONTEXT_MAX_LENGTH - 3)}http://x/app.js?v=?:10:5`;
    expectUnmaskedParameter(cut, 'v');
  });

  it('leaves ordinary source code alone', () => {
    // A refusal fails a whole pipeline stage, and bounded source excerpts are
    // an ordinary part of a payload, so code that merely writes a path, a
    // ternary or a regular expression must never match.
    const excerpts = [
      'const RE = /^(?=\\S+$)(?:\\S*[0-9]\\S*|[^a-z]+)$/;',
      'const response = await fetch(`/api/x?a=${id}`);',
      "const url = '/api/x?limit=20';",
      'const url = "/api/x?limit=20";',
      'const size = y ? 1 : 2;',
      'x = y ? 1 : 2',
      'router.get("/api/items/:id", handler); // GET /api/items/:id',
      'const next = page ? `/catalog?page=${page}` : "/catalog";',
    ];
    const excerpt = excerpts.join('\n');
    expect(inspectPayloadReport({ excerpt }).findings).toEqual([]);
    for (const line of excerpts) {
      expect(inspectPayload({ excerpt: line }), line).toEqual([]);
    }
    expect(assertOutboundSafe(makeRequest({ prompt: `${CLEAN_PROMPT}\n${excerpt}` })).ok).toBe(
      true,
    );
  });

  it('ends a run at a JSON escape, so a masked URL rendered into a JSON section passes', () => {
    // A stage renders its structured context into the prompt with
    // JSON.stringify: the line break or quote the raw run stopped at arrives
    // as a two-character escape directly after the masked value.
    const masked = [
      '// GET /api/x?page=?\nconst next = 1;',
      'see "https://x.test/docs?tab=?" for details',
      'Error: boom\n    at fn (http://127.0.0.1:3000/app.js?v=?:10:5)\n    at g (x)',
      // An initiator stack starts with its first frame, which JSON rendering
      // puts directly after the string's opening quote.
      'at send (http://127.0.0.1:3000/app.js?v=?:18:3)\n    at flush (http://127.0.0.1:3000/b.js?v=?:2:1)',
      'first line\t/p?id=?\tsecond',
      'see /p?id=?\fnext and https://x.test/a?b=?\u000bnext',
    ];
    for (const text of masked) {
      const rendered = JSON.stringify({ excerpt: text });
      const report = inspectPayloadReport({ note: rendered });
      expect(report.findings, rendered).toEqual([]);
      expect(assertOutboundSafe(makeRequest({ prompt: `${CLEAN_PROMPT}\n${rendered}` })).ok).toBe(
        true,
      );
    }
    // An unmasked value before the escape is still read, whole.
    for (const [text, name] of [
      [`// GET /api/x?page=${SHORT_QUERY_VALUE}\nconst next = 1;`, 'page'],
      [`see "https://x.test/docs?tab=${SHORT_QUERY_VALUE}" now`, 'tab'],
      ['    at fn (http://127.0.0.1:3000/app.js?v=1:10:5)\n    at g (x)', 'v'],
    ] as const) {
      const rendered = JSON.stringify({ excerpt: text });
      expectUnmaskedParameter(rendered, name);
      expect(serialise(urlFindings(rendered))).not.toContain(SHORT_QUERY_VALUE);
    }
    // A backslash that opens no whitespace or quote escape belongs to the
    // value: an escaped backslash, `\b`, and a `\u` escape of anything but a
    // vertical tab, which is how `?code=?\u005a` would hide a value.
    expectUnmaskedParameter('see /p?id=\\ZIP now', 'id');
    expectUnmaskedParameter('see https://x.test/a?b=?\\x now', 'b');
    expectUnmaskedParameter('see /p?code=?\\u005a now', 'code');
    expectUnmaskedParameter('see https://x.test/a?b=?\\\\ now', 'b');
    expectUnmaskedParameter('see /p?id=?\\b now', 'id');
    expectUnmaskedParameter(JSON.stringify({ note: 'see /p?id=?\u0001 now' }), 'id');
  });

  it('anchors a relative run after a written whitespace escape, as the masker does', () => {
    // A prompt-only JSON section: the run starts a line of the raw string, so
    // the escape's `n` stands before it in the rendered text.
    for (const escape of ['\n', '\t', '\r', '\f', '\u000b']) {
      const rendered = JSON.stringify({ note: `first${escape}/reset?code=${SHORT_QUERY_VALUE}` });
      expectUnmaskedParameter(rendered, 'code');
      expect(
        assertOutboundSafe(makeRequest({ prompt: `${CLEAN_PROMPT}\n${rendered}`, input: {} })).ok,
        escape,
      ).toBe(false);
      const masked = JSON.stringify({ note: `first${escape}/reset?code=?` });
      expect(urlFindings(masked), escape).toEqual([]);
    }
    // A literal backslash-n in raw text anchors too; the masker masks it.
    expectUnmaskedParameter('const s = "a\\n/p?id=7";', 'id');
    expect(urlFindings('const s = "a\\n/p?id=?";')).toEqual([]);
  });

  it('skips a run the parser rejects without throwing', () => {
    // Not a URL, so not this rule's to judge; the first checkpoint masks the
    // query of any text shaped like one regardless.
    let report: RedactGuardReport | undefined;
    expect(() => {
      report = inspectPayloadReport({ note: 'see http://[not-an-address/p?x=1 now' });
    }).not.toThrow();
    expect(report?.complete).toBe(true);
  });

  it('bounds the runs parsed per string, and refuses a string with more of them', () => {
    // Only a run that can carry a value is parsed and counted; the bound is
    // generous for a real prompt and fails closed on a hostile one.
    const run = '/a?b=? ';
    const atBound = inspectPayloadReport({ note: run.repeat(MAX_URL_RUNS_PER_STRING) });
    expect(atBound.findings).toEqual([]);
    expect(atBound.complete).toBe(true);

    const pastBound = { note: run.repeat(MAX_URL_RUNS_PER_STRING + 1) };
    const report = inspectPayloadReport(pastBound);
    expect(report.findings).toEqual([]);
    expect(report.complete).toBe(false);
    expect(report.limitsReached).toEqual(['max-url-runs']);
    expect(assertOutboundSafe(makeRequest({ input: pastBound })).ok).toBe(false);

    const flags = inspectPayloadReport({ note: '/a?b '.repeat(MAX_URL_RUNS_PER_STRING + 16) });
    expect(flags.complete).toBe(true);
  });

  it('reads nothing past the string bound', () => {
    // The embedded scan reads the same code units as the windowed patterns, so
    // a run past the bound is not read — and the string bound is recorded.
    const beyond = `${padding(2_048 + SCAN_WINDOW_OVERLAP + 16)}/p?id=${SHORT_QUERY_VALUE}`;
    const report = inspectPayloadReport(
      { note: beyond },
      { maxStringLength: 2_048, rules: ['url-query-value'] },
    );
    expect(report.findings).toEqual([]);
    expect(report.limitsReached).toEqual(['max-string-length']);
  });
});

/*
 * ---------------------------------------------------------------------------
 * Header lines inside text
 *
 * A header travels as a field under its name, which the key rule checks, and
 * as a line of text — a question that pastes a request, a log message, an
 * attribute rendered into a prompt as JSON. The line form carries no length a
 * rule could lean on (a short credential is still a credential) and a cookie
 * line has no scheme word at all, so it is recognised by its header name. The
 * cases pin both directions: every line that still carries a value is
 * refused, and the compliant output and ordinary code pass.
 * ---------------------------------------------------------------------------
 */

/** A credential shorter than the bearer rule's minimum, from fragments. */
const SHORT_CREDENTIAL = assemble('S3', 'CRET');

/** A short cookie value, from fragments. */
const COOKIE_VALUE = assemble('q7', 'Zr');

/** A short API key, from fragments. */
const API_KEY_VALUE = assemble('k9', 'Xw2');

/** The `sensitive-header` findings of one string, read under `input.note`. */
function headerFindings(text: string): readonly RedactGuardFinding[] {
  return inspectPayload({ note: text }, { rules: ['sensitive-header'] });
}

describe('a header line inside text is inspected', () => {
  it('reports a header line that still carries its value, in each of the three value shapes', () => {
    const lines = [
      `Authorization: Bearer ${SHORT_CREDENTIAL}`,
      `authorization:bearer ${SHORT_CREDENTIAL}`,
      `AUTHORIZATION :\tBEARER\t${SHORT_CREDENTIAL}`,
      `Proxy-Authorization: Basic ${SHORT_CREDENTIAL}`,
      `Authorization: Digest username="${SHORT_CREDENTIAL}"`,
      `Authorization: NTLM ${SHORT_CREDENTIAL}`,
      `Authorization: Bearer ${SHORT_CREDENTIAL}_${COOKIE_VALUE}`,
      `http.request.header.authorization: Negotiate ${SHORT_CREDENTIAL}`,
      `Cookie: session=${COOKIE_VALUE}`,
      `Cookie: theme=dark; session=${COOKIE_VALUE}`,
      'Set-Cookie: sid=1',
      `X-Api-Key: ${API_KEY_VALUE}`,
      `X-Api-Key: live_${API_KEY_VALUE}`,
      `x-auth-token: ${API_KEY_VALUE}`,
      `curl -H "Authorization: Bearer ${SHORT_CREDENTIAL}" http://127.0.0.1:3000/api`,
    ];
    for (const line of lines) {
      for (const text of [line, `The request sent ${line} before it failed.`]) {
        const findings = headerFindings(text);
        expect(findings, text).toHaveLength(1);
        expect(findings[0]?.ruleId, text).toBe('sensitive-header');
        expect(findings[0]?.path, text).toBe(`${DEFAULT_ROOT_PATH}.note`);
        expect(findings[0]?.reason, text).toBe(REDACTION_RULE_REASONS['sensitive-header']);
        const printed = serialise(inspectPayload({ note: text }));
        for (const value of [SHORT_CREDENTIAL, COOKIE_VALUE, API_KEY_VALUE]) {
          expect(printed, text).not.toContain(value);
        }
      }
    }
  });

  it('reads a quoted cookie value, a later cookie pair, and a header line after a written escape', () => {
    for (const text of [
      `Cookie: session="${COOKIE_VALUE}"`,
      `Set-Cookie: sid="${COOKIE_VALUE}"; Path=/`,
      `Cookie: session=; theme=${COOKIE_VALUE}`,
      `Cookie: a=; b=""; session="${COOKIE_VALUE}"`,
      `// Cookie: session="${COOKIE_VALUE}"`,
      JSON.stringify({ note: `first\nAuthorization: Bearer ${SHORT_CREDENTIAL}` }),
      JSON.stringify({ note: `first\r\nCookie: session=${COOKIE_VALUE}` }),
    ]) {
      expect(ruleIdsOf(headerFindings(text)), text).toEqual(['sensitive-header']);
      expect(serialise(headerFindings(text)), text).not.toContain(COOKIE_VALUE);
    }
    // A source excerpt the context builder sends unscrubbed, in the prompt
    // and in the structured input alike.
    const excerpt = `// Cookie: session="${COOKIE_VALUE}"\nconst next = 1;`;
    expect(
      assertOutboundSafe(
        makeRequest({ prompt: `${CLEAN_PROMPT}\n${excerpt}`, input: { excerpts: [excerpt] } }),
      ).ok,
    ).toBe(false);
  });

  it('leaves a Set-Cookie attribute, a code template and the compliant forms alone', () => {
    for (const text of [
      '// Set-Cookie: sid=<id>; Path=/; HttpOnly',
      'Set-Cookie: sid=; Path=/; Max-Age=3600',
      'Cookie: session="${id}"',
      'Cookie: session=""',
      `Cookie: ${REDACTION_MARKER}`,
      JSON.stringify({ note: `first\nCookie: ${REDACTION_MARKER}` }),
      JSON.stringify({ code: 'const s = "a\\\\cookie: x";' }),
    ]) {
      expect(headerFindings(text), text).toEqual([]);
    }
  });

  it('catches the short credential the length-bound bearer rule cannot', () => {
    const line = `Authorization: Bearer ${SHORT_CREDENTIAL}`;
    expect(inspectPayload({ note: line }, { rules: ['bearer-token'] })).toEqual([]);
    expect(ruleIdsOf(inspectPayload({ note: line }))).toEqual(['sensitive-header']);
    // A credential long enough for both is reported by both, once each.
    expect(ruleIdsOf(inspectPayload({ note: `Authorization: ${BEARER_CREDENTIAL}` }))).toEqual([
      'sensitive-header',
      'bearer-token',
    ]);
  });

  it('refuses a question, a message and a JSON-rendered attribute carrying a header line', () => {
    const rendered = JSON.stringify({
      note: `Authorization: Bearer ${SHORT_CREDENTIAL}`,
      log: `Cookie: session=${COOKIE_VALUE}\nnext line`,
      trace: `Authorization: Bearer ${SHORT_CREDENTIAL}\nat handler`,
    });
    const result = assertOutboundSafe(
      makeRequest({
        system: `Never repeat X-Api-Key: ${API_KEY_VALUE} to anyone.`,
        prompt: `Why does the call with Authorization: Bearer ${SHORT_CREDENTIAL} fail?`,
        messages: [
          { role: 'user', content: 'Why did this take so long?' },
          { role: 'assistant', content: rendered },
        ],
        input: { requests: [{ note: `Set-Cookie: sid=${COOKIE_VALUE}; Path=/` }] },
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.details?.ruleIds).toEqual(['sensitive-header']);
    expect(result.error.details?.paths).toEqual([
      'system',
      'prompt',
      'messages[1].content',
      `${DEFAULT_ROOT_PATH}.requests[0].note`,
    ]);
    const printed = [
      result.error.message,
      result.error.hint ?? '',
      JSON.stringify(result.error.details),
      JSON.stringify(result.error.toPayload()),
    ].join('\n');
    for (const value of [SHORT_CREDENTIAL, COOKIE_VALUE, API_KEY_VALUE]) {
      expect(printed).not.toContain(value);
    }
  });

  it('reports a header line under a denied key once, at the key', () => {
    const findings = inspectPayload(
      { headers: { authorization: `Authorization: Bearer ${SHORT_CREDENTIAL}` } },
      { rules: ['sensitive-header'] },
    );
    expect(findings.map((finding) => finding.path)).toEqual([
      `${DEFAULT_ROOT_PATH}.headers.authorization`,
    ]);
  });

  it('passes the compliant output of the first checkpoint', () => {
    for (const text of [
      `Authorization: ${REDACTION_MARKER}`,
      `Proxy-Authorization: ${assemble('Bea', 'rer ')}${REDACTION_MARKER}`,
      `Cookie: ${REDACTION_MARKER}`,
      `Set-Cookie: sid=${REDACTION_MARKER}`,
      `X-Api-Key: ${REDACTION_MARKER}`,
      `x-auth-token:${REDACTION_MARKER}`,
      'Authorization:',
      'Cookie: ',
      JSON.stringify({ note: `Authorization: ${REDACTION_MARKER}` }),
    ]) {
      const report = inspectPayloadReport({ note: text });
      expect(report.findings, text).toEqual([]);
      expect(report.complete, text).toBe(true);
    }
  });

  it('leaves code that merely writes a header alone', () => {
    // A refusal fails a whole pipeline stage, so an excerpt that builds a
    // header from a variable, declares its type or reads it must never match.
    const excerpts = [
      'const init = { headers: { Authorization: `Bearer ${token}` } };',
      'interface Headers { authorization: string; }',
      'const schema = z.object({ authorization: z.string() });',
      'const cookie = { cookie: req.headers.cookie };',
      "const headers = { 'x-api-key': apiKey };",
      "const headers = { Authorization: 'Bearer ' + token };",
      'const headers = { Authorization: await getToken() };',
      'const headers = { Authorization: Basic btoa(credentials) };',
      '// Send Authorization: Bearer <token> with every call.',
      'const header = `Cookie: session=${sessionId}`;',
      'const header = { cookie: `session=${sessionId}` };',
      'const header = { cookie: (value) => value.trim() };',
      'const parse = { cookie: x=>x, check: a==b };',
      'const authorizationHeader: string = header;',
      'const scheme = { authorization: bearer ? token : undefined };',
      'Authorization: bearer',
    ];
    const excerpt = excerpts.join('\n');
    expect(inspectPayloadReport({ excerpt }).findings).toEqual([]);
    for (const line of excerpts) {
      expect(inspectPayload({ excerpt: line }), line).toEqual([]);
    }
    expect(assertOutboundSafe(makeRequest({ prompt: `${CLEAN_PROMPT}\n${excerpt}` })).ok).toBe(
      true,
    );
  });

  it('does not match a header name inside a longer word', () => {
    for (const text of [
      `preauthorization: Bearer ${SHORT_CREDENTIAL}`,
      `my_cookie: session=${COOKIE_VALUE}`,
      `x-api-key-hint: ${API_KEY_VALUE}`,
    ]) {
      expect(headerFindings(text), text).toEqual([]);
    }
  });
});

/*
 * ---------------------------------------------------------------------------
 * Adversarial input: nothing throws, nothing loops
 * ---------------------------------------------------------------------------
 */

describe('adversarial input', () => {
  it('skips a revisited object instead of following a cycle', () => {
    const cyclic: Record<string, unknown> = { notes: `saw ${GENERIC_CREDENTIAL} in the log` };
    cyclic.self = cyclic;
    cyclic.list = [cyclic, { deeper: cyclic }];
    const report = inspectPayloadReport(cyclic);
    expect(report.complete).toBe(true);
    expect(ruleIdsOf(report.findings)).toEqual(['provider-key']);
  });

  it('inspects a shared reference once, at the path it was first reached by', () => {
    const leaf = { notes: GENERIC_CREDENTIAL };
    const report = inspectPayloadReport({ first: leaf, second: leaf });
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]?.path).toBe('input.first.notes');
  });

  /*
   * The two cases above pin the cheap half of aliasing: two benign names for
   * one object are one inspection. The five below pin the half that is not a
   * function of the value at all. Whether a subtree yields a finding depends on
   * the *name context* it is reached under, because the entropy rule binds to
   * the nearest enclosing key and an array inherits that key from its parent —
   * so an alias reached under a benign name and again under a credential-like
   * one has to be inspected twice, while a second alias in a context already
   * inspected must not cost a third traversal.
   */

  it('inspects an aliased array again under the credential-like name it is also reached by', () => {
    // The escape the context-keyed memo exists to close. The array is reached
    // first under `notes`, a name the entropy rule never measures under, and
    // then under `accessToken`, a name it does: a walk-wide visited set marked
    // the array inspected on the benign path and skipped the credential-like
    // one, so the value left the machine unexamined.
    const shared: readonly string[] = [OPAQUE_SECRET];
    const payload: JsonObject = { notes: shared, accessToken: shared };
    const report = inspectPayloadReport(payload, { rules: ['high-entropy-secret'] });
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]?.ruleId).toBe('high-entropy-secret');
    expect(report.findings[0]?.path).toBe(`${DEFAULT_ROOT_PATH}.accessToken[0]`);
    expect(report.complete).toBe(true);
    expect(assertOutboundSafe(makeRequest({ input: payload })).ok).toBe(false);
  });

  it('reports an aliased array once when the credential-like name comes first', () => {
    // The same two names in the other order. The credential-like context is
    // inspected first and reported; the benign re-inspection that follows adds
    // no second finding, because the entropy rule does not apply under it.
    const shared: readonly string[] = [OPAQUE_SECRET];
    const payload: JsonObject = { accessToken: shared, notes: shared };
    const report = inspectPayloadReport(payload, { rules: ['high-entropy-secret'] });
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]?.ruleId).toBe('high-entropy-secret');
    expect(report.findings[0]?.path).toBe(`${DEFAULT_ROOT_PATH}.accessToken[0]`);
    expect(report.complete).toBe(true);
  });

  it('keys the memo on the name context rather than on the name, so a third alias is free', () => {
    // There are exactly two contexts, so an object is traversed at most twice
    // however many names alias it: `apiKey` and `accessToken` are the same
    // equivalence class and the second of them is a skip. Asserted through the
    // node count as well as the findings, because the bound on work is what
    // makes re-inspection affordable: root, the array and its element under
    // `apiKey`, the skipped visit under `accessToken`, then the array and its
    // element under `notes` — six visits, not nine.
    const shared: readonly string[] = [OPAQUE_SECRET];
    const payload: JsonObject = { apiKey: shared, accessToken: shared, notes: shared };
    const report = inspectPayloadReport(payload, { rules: ['high-entropy-secret'] });
    expect(report.findings.map((finding) => finding.path)).toEqual([
      `${DEFAULT_ROOT_PATH}.apiKey[0]`,
    ]);
    expect(report.inspected).toBe(6);
    expect(report.complete).toBe(true);
  });

  it('terminates on a cycle whose paths interleave the two name contexts', () => {
    // The memo is the *only* cycle-detection mechanism, so a structure that
    // returns to itself under a benign name, under a credential-like name and
    // through an array has to terminate on the memo alone. Each (object,
    // context) pair is entered at most once and there are two contexts, so the
    // descent is finite and no bound is reached.
    const cyclic: Record<string, unknown> = { notes: 'ordinary text' };
    cyclic.self = cyclic;
    cyclic.sessionToken = cyclic;
    cyclic.branch = [cyclic, { clientSecret: cyclic }];
    let report: RedactGuardReport | undefined;
    expect(() => {
      report = inspectPayloadReport(cyclic);
    }).not.toThrow();
    expect(report?.findings).toEqual([]);
    expect(report?.complete).toBe(true);
    expect(report?.limitsReached).toEqual([]);
  });

  it('names the aliased field in the refusal without carrying any part of the value', () => {
    // Re-inspection must not become a second disclosure route: the finding and
    // every part of the refusal built from it name the aliased path and nothing
    // about the value, under every rule rather than the entropy rule alone.
    const shared: readonly string[] = [OPAQUE_SECRET];
    const payload: JsonObject = { notes: shared, accessToken: shared };
    const findings = inspectPayload(payload);
    expect(ruleIdsOf(findings)).toEqual(['high-entropy-secret']);
    expectNoValueLeak(serialise(findings), OPAQUE_SECRET);
    const result = assertOutboundSafe(makeRequest({ input: payload }));
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.details?.paths).toEqual([`${DEFAULT_ROOT_PATH}.accessToken[0]`]);
    const printed = [
      result.error.message,
      result.error.hint ?? '',
      JSON.stringify(result.error.details),
      JSON.stringify(result.error.toPayload()),
    ].join('\n');
    expectNoValueLeak(printed, OPAQUE_SECRET);
  });

  it('reports a throwing getter as an inspection error rather than propagating it', () => {
    const payload: Record<string, unknown> = { component: 'SummaryCard' };
    Object.defineProperty(payload, 'apiKey', {
      enumerable: true,
      get(): string {
        throw new Error('unreadable');
      },
    });
    const report = inspectPayloadReport(payload);
    expect(report.limitsReached).toContain('inspection-error');
    // Uninspected is not clean: the field could not be read, so the payload is
    // refused rather than sent.
    expect(report.complete).toBe(false);
    expect(assertOutboundSafe(makeRequest({ input: payload as JsonObject })).ok).toBe(false);
  });

  it('reports an object whose key set cannot be read as an inspection error', () => {
    const hostile = new Proxy(
      {},
      {
        ownKeys(): never {
          throw new Error('unreadable');
        },
      },
    );
    const report = inspectPayloadReport({ context: hostile });
    expect(report.limitsReached).toContain('inspection-error');
    expect(report.complete).toBe(false);
  });

  it('walks a null-prototype object', () => {
    const bare = Object.create(null) as Record<string, unknown>;
    bare.authorization = BEARER_CREDENTIAL;
    const findings = inspectPayload({ headers: bare }, { rules: ['sensitive-header'] });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.path).toBe('input.headers.authorization');
  });

  it("walks a class instance's own enumerable fields, which are what a serialiser sends", () => {
    class OutboundContext {
      constructor(readonly serviceToken: string) {}
    }
    const findings = inspectPayload(new OutboundContext(OPAQUE_SECRET), {
      rules: ['high-entropy-secret'],
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.path).toBe('input.serviceToken');
  });

  it('skips the built-ins whose contents no serialiser would send', () => {
    const report = inspectPayloadReport({
      lookup: new Map([['authorization', BEARER_CREDENTIAL]]),
      seen: new Set([GENERIC_CREDENTIAL]),
      when: new Date(0),
      pattern: /x/,
      bytes: new Uint8Array([1, 2, 3]),
      pending: Promise.resolve(GENERIC_CREDENTIAL),
    });
    expect(report.findings).toEqual([]);
    expect(report.complete).toBe(true);
  });

  it('skips values no serialiser could send without losing the ones it can', () => {
    // `undefined`, a function and a symbol are not JSON values, and a
    // symbol-keyed property is not enumerable by name, so none of them can
    // carry a credential into a request — while a plain sibling string still
    // must be inspected. Typed through `Record<string, unknown>` because
    // `ModelRequest.input` cannot express any of them.
    const odd: Record<string | symbol, unknown> = {
      absent: undefined,
      handler: (): string => 'noop',
      marker: Symbol('marker'),
      notes: `the log line held ${GENERIC_CREDENTIAL}`,
    };
    odd[Symbol('hidden')] = VENDOR_CREDENTIAL;
    let report: RedactGuardReport | undefined;
    expect(() => {
      report = inspectPayloadReport(odd, { rules: ['provider-key'] });
    }).not.toThrow();
    expect(report?.complete).toBe(true);
    expect(report?.findings.map((finding) => finding.path)).toEqual([`${DEFAULT_ROOT_PATH}.notes`]);
  });

  it('finds a credential near the end of a very wide array', () => {
    // A walk that gave up part-way through a long array would report clean on
    // a payload whose last element is the credential, so the element index is
    // asserted rather than merely the count.
    const width = 5_000;
    const excerpts: string[] = [];
    for (let index = 0; index < width - 1; index += 1) {
      excerpts.push(`line ${String(index)} of the captured excerpt`);
    }
    excerpts.push(`tail ${GENERIC_CREDENTIAL}`);
    const report = inspectPayloadReport({ excerpts }, { rules: ['provider-key'] });
    expect(report.complete).toBe(true);
    expect(report.findings.map((finding) => finding.path)).toEqual([
      `${DEFAULT_ROOT_PATH}.excerpts[${String(width - 1)}]`,
    ]);
    expectNoValueLeak(serialise(report.findings), GENERIC_CREDENTIAL);
  });

  it('caps a wide array of findings while the verdict stays unsafe', () => {
    const offenders: string[] = [];
    for (let index = 0; index < 200; index += 1) {
      offenders.push(CREDENTIALED_URI);
    }
    const report = inspectPayloadReport(
      { environments: offenders },
      { maxFindings: 4, rules: ['connection-string'] },
    );
    expect(report.findings).toHaveLength(4);
    expect(report.limitsReached).toContain('max-findings');
    expect(report.complete).toBe(false);
    // The cap is a reporting bound, never a softer verdict: there is at least
    // one finding, so the request is refused either way.
    expect(
      assertOutboundSafe(makeRequest({ input: { environments: offenders } }), { maxFindings: 4 })
        .ok,
    ).toBe(false);
  });

  it('finds a credential in a megabyte string without scanning all of it', () => {
    const large = `${FILLER.repeat(200)}${GENERIC_CREDENTIAL} ${FILLER.repeat(200_000)}`;
    const report = inspectPayloadReport({ excerpt: large }, { rules: ['provider-key'] });
    expect(ruleIdsOf(report.findings)).toEqual(['provider-key']);
    // Scanning stopped at the bound, so the verdict is "unsafe and truncated".
    expect(report.limitsReached).toContain('max-string-length');
    expect(report.complete).toBe(false);
  });

  it('inspects a multi-megabyte payload in a sane time rather than hanging', () => {
    // The bound that matters is per string, so the work one hostile value can
    // cause is `maxStringLength + SCAN_WINDOW_OVERLAP` code units however long
    // it is. Three megabytes of it takes tens of milliseconds in practice; the
    // budget asserted here is two orders of magnitude above that, so it fails
    // on an unbounded scan and not on a loaded machine.
    const huge = `${padding(64)}${GENERIC_CREDENTIAL} ${FILLER.repeat(350_000)}`;
    expect(huge.length).toBeGreaterThan(3_000_000);
    const startedAt = performance.now();
    const report = inspectPayloadReport({ excerpt: huge }, { rules: ['provider-key'] });
    const elapsedMs = performance.now() - startedAt;
    expect(ruleIdsOf(report.findings)).toEqual(['provider-key']);
    expect(report.limitsReached).toContain('max-string-length');
    expect(elapsedMs).toBeLessThan(4_000);
  });

  it('finds a credential that straddles the scanned region boundary', () => {
    const maxStringLength = 2_048;
    const straddling = `${padding(maxStringLength - 4)}${GENERIC_CREDENTIAL}`;
    const findings = inspectPayload(
      { excerpt: straddling },
      { maxStringLength, rules: ['provider-key'] },
    );
    expect(findings).toHaveLength(1);
  });

  it('finds a credential that straddles an interior window boundary', () => {
    const boundary = `${padding(SCAN_WINDOW_LENGTH - 5)}${GENERIC_CREDENTIAL} ${FILLER.repeat(16)}`;
    const findings = inspectPayload({ excerpt: boundary }, { rules: ['provider-key'] });
    expect(findings).toHaveLength(1);
  });

  it('refuses rather than reporting clean when a credential lies past the bound', () => {
    const beyond = `${padding(DEFAULT_MAX_STRING_LENGTH + SCAN_WINDOW_OVERLAP + 16)}${GENERIC_CREDENTIAL}`;
    const report = inspectPayloadReport({ excerpt: beyond });
    expect(report.findings).toEqual([]);
    expect(report.complete).toBe(false);
    expect(report.limitsReached).toContain('max-string-length');
    const result = assertOutboundSafe(makeRequest({ input: { excerpt: beyond } }));
    expect(result.ok).toBe(false);
  });

  it('stops at the depth bound and says so', () => {
    const deep = nest(DEFAULT_MAX_DEPTH + 8, { notes: GENERIC_CREDENTIAL });
    const bounded = inspectPayloadReport(deep);
    expect(bounded.findings).toEqual([]);
    expect(bounded.complete).toBe(false);
    expect(bounded.limitsReached).toContain('max-depth');

    const widened = inspectPayloadReport(deep, { maxDepth: DEFAULT_MAX_DEPTH * 4 });
    expect(ruleIdsOf(widened.findings)).toEqual(['provider-key']);
    expect(widened.complete).toBe(true);
  });

  it('stops at the node budget and says so', () => {
    const wide: Record<string, string> = {};
    for (let index = 0; index < 64; index += 1) {
      wide[`field${String(index)}`] = 'value';
    }
    const report = inspectPayloadReport(wide, { maxNodes: 5 });
    expect(report.complete).toBe(false);
    expect(report.limitsReached).toContain('max-nodes');
    expect(report.inspected).toBeLessThanOrEqual(6);
  });

  it('caps the report without softening the verdict', () => {
    const many: Record<string, string> = {
      first: CREDENTIALED_URI,
      second: CREDENTIALED_URI,
      third: CREDENTIALED_URI,
    };
    const report = inspectPayloadReport(many, { maxFindings: 2, rules: ['connection-string'] });
    expect(report.findings).toHaveLength(2);
    expect(report.limitsReached).toContain('max-findings');
    expect(report.complete).toBe(false);
  });

  it('treats a zero bound as "inspect nothing", never as "nothing to find"', () => {
    const report = inspectPayloadReport(
      { environment: { url: CREDENTIALED_URI } },
      { maxDepth: 0 },
    );
    expect(report.findings).toEqual([]);
    expect(report.complete).toBe(false);
  });

  it('survives a bound expressed as a fraction or a non-number', () => {
    const report = inspectPayloadReport(
      { environment: { url: CREDENTIALED_URI } },
      { maxDepth: 8.7, maxNodes: Number.NaN, maxStringLength: Number.POSITIVE_INFINITY },
    );
    expect(ruleIdsOf(report.findings)).toEqual(['connection-string']);
    expect(report.complete).toBe(true);
  });

  it('refuses every adversarial payload instead of throwing on any of them', () => {
    // The whole battery above, put through the decision function rather than
    // the inspection: the last thing between a payload and the network cannot
    // be the thing that throws, and a payload it could not read in full is
    // refused rather than sent.
    const cyclic: Record<string, unknown> = { notes: 'ordinary text' };
    cyclic.self = cyclic;
    const bare = Object.create(null) as Record<string, unknown>;
    bare.cookie = HEADER_VALUE;
    const throwingGetter: Record<string, unknown> = {};
    Object.defineProperty(throwingGetter, 'apiKey', {
      enumerable: true,
      get(): string {
        throw new Error('unreadable');
      },
    });
    const hostile = new Proxy(
      {},
      {
        ownKeys(): never {
          throw new Error('unreadable');
        },
      },
    );
    // `sendable` records the verdict each shape earns, because "hostile" and
    // "unsafe" are different questions: a cycle of ordinary text and an opaque
    // built-in are structures a serialiser would flatten or drop, so they carry
    // nothing and may be sent. Everything that hid a value, or that could not
    // be read in full, must be refused.
    const adversarial: readonly {
      readonly label: string;
      readonly input: unknown;
      readonly sendable: boolean;
    }[] = [
      { label: 'a cycle of ordinary text', input: cyclic, sendable: true },
      {
        label: 'a null-prototype object holding a header',
        input: { headers: bare },
        sendable: false,
      },
      { label: 'a throwing getter', input: throwingGetter, sendable: false },
      { label: 'an unreadable key set', input: { context: hostile }, sendable: false },
      {
        label: 'built-ins no serialiser would send',
        input: { lookup: new Map([['cookie', HEADER_VALUE]]), when: new Date(0) },
        sendable: true,
      },
      {
        label: 'nesting past the depth ceiling',
        input: nest(MAX_SUPPORTED_DEPTH + 32, { notes: GENERIC_CREDENTIAL }),
        sendable: false,
      },
      {
        label: 'a credential past the string bound',
        input: {
          excerpt: `${padding(DEFAULT_MAX_STRING_LENGTH + SCAN_WINDOW_OVERLAP + 16)}${WEB_TOKEN}`,
        },
        sendable: false,
      },
    ];
    for (const { label, input, sendable } of adversarial) {
      let result: Result<void, DebuggenError> | undefined;
      expect(() => {
        result = assertOutboundSafe(makeRequest({ input: input as JsonObject }));
      }, label).not.toThrow();
      expect(result?.ok, label).toBe(sendable);
      if (result === undefined || result.ok) {
        continue;
      }
      expect(DEBUGGEN_ERROR_CODES, label).toContain(result.error.code);
      const printed = [
        result.error.message,
        result.error.hint ?? '',
        JSON.stringify(result.error.details),
      ].join('\n');
      for (const secret of SECRET_FIXTURES) {
        expectNoValueLeak(printed, secret);
      }
    }
  });
});

/** Wraps `leaf` in `depth` levels of single-key objects. */
function nest(depth: number, leaf: JsonObject): JsonObject {
  let current: JsonObject = leaf;
  for (let level = 0; level < depth; level += 1) {
    current = { child: current };
  }
  return current;
}

/*
 * ---------------------------------------------------------------------------
 * Reporting: the logger and the summary
 * ---------------------------------------------------------------------------
 */

describe('reporting', () => {
  it('logs a reached bound message-first, with the limit and the path as fields', () => {
    const { logger, warnings } = createRecordingLogger();
    inspectPayloadReport(nest(DEFAULT_MAX_DEPTH + 4, { notes: 'ordinary text' }), { logger });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toBe('Outbound redaction guard stopped at a bound');
    expect(warnings[0]?.fields?.limit).toBe('max-depth');
    expect(typeof warnings[0]?.fields?.path).toBe('string');
  });

  it('logs each bound once rather than once per occurrence', () => {
    const { logger, warnings } = createRecordingLogger();
    const branch = nest(8, { notes: 'ordinary text' });
    inspectPayloadReport({ a: branch, b: branch, c: { ...branch } }, { logger, maxDepth: 3 });
    expect(warnings).toHaveLength(1);
  });

  it('is silent by default', () => {
    // No logger injected and nothing thrown: `noopLogger` is the default, so a
    // library never chooses a logging backend for its host process.
    expect(() => inspectPayloadReport(nest(64, { notes: 'ordinary text' }))).not.toThrow();
  });

  it('applies every rule when an explicitly empty rule list is given, and warns', () => {
    // A guard that can be configured to guard nothing would answer "clean" for
    // any payload at all.
    const { logger, warnings } = createRecordingLogger();
    const findings = inspectPayload(
      { environment: { url: CREDENTIALED_URI } },
      {
        rules: [],
        logger,
      },
    );
    expect(ruleIdsOf(findings)).toEqual(['connection-string']);
    expect(warnings[0]?.message).toContain('no applicable rule');
  });

  it('ignores an unknown rule id without dropping the known ones', () => {
    const findings = inspectPayload(
      { environment: { url: CREDENTIALED_URI } },
      {
        rules: ['connection-string', 'not-a-rule' as RedactionRuleId],
      },
    );
    expect(ruleIdsOf(findings)).toEqual(['connection-string']);
  });
});

describe('bounds, paths and the two inspection views', () => {
  it('clamps a depth bound to the ceiling instead of exhausting the stack', () => {
    const veryDeep = nest(MAX_SUPPORTED_DEPTH + 64, { notes: GENERIC_CREDENTIAL });
    const options: RedactGuardOptions = { maxDepth: 1_000_000 };
    let report: RedactGuardReport | undefined;
    expect(() => {
      report = inspectPayloadReport(veryDeep, options);
    }).not.toThrow();
    expect(report?.complete).toBe(false);
    const limits: readonly RedactGuardLimitId[] = report?.limitsReached ?? [];
    expect(limits).toContain('max-depth');
  });

  it('does not hand a pathologically long whole-field URL to the URL parser', () => {
    // A documented bound of the whole-field half: a request target is not a
    // document, so past the parse bound that half declines to look rather than
    // parsing megabytes on the off-chance the value is a link. A scheme the
    // embedded scan does not read isolates the half under test.
    const enormous = `ws://warehouse.internal.test/feed?cursor=${'b'.repeat(URL_PARSE_MAX_LENGTH)}`;
    const report = inspectPayloadReport({ url: enormous }, { rules: ['url-query-value'] });
    expect(report.findings).toEqual([]);
    expect(report.complete).toBe(true);
  });

  it('parses an over-long embedded run only up to the bound, and refuses the rest', () => {
    // The embedded half parses the first URL_PARSE_MAX_LENGTH code units, so a
    // value inside them is still named; the remainder was never parsed, so the
    // run is recorded as uninspected and the payload is refused even when the
    // prefix is clean.
    const longValue = 'b'.repeat(URL_PARSE_MAX_LENGTH);
    const leading = inspectPayloadReport(
      { url: `/reports/summary?cursor=${QUERY_VALUE}&pad=${longValue}` },
      { rules: ['url-query-value'] },
    );
    expect(leading.findings.map((finding) => finding.path)).toEqual([
      `${DEFAULT_ROOT_PATH}.url${URL_QUERY_MASK}cursor`,
    ]);
    expect(leading.limitsReached).toEqual(['max-url-length']);
    expectNoValueLeak(serialise(leading.findings), QUERY_VALUE);

    const masked = { note: `see /reports/summary?cursor=?&${longValue}=? for the history` };
    const clean = inspectPayloadReport(masked, { rules: ['url-query-value'] });
    expect(clean.findings).toEqual([]);
    expect(clean.complete).toBe(false);
    expect(clean.limitsReached).toEqual(['max-url-length']);
    expect(assertOutboundSafe(makeRequest({ input: masked })).ok).toBe(false);
  });

  it('shortens an over-long path segment and marks the cut', () => {
    // A key is structure rather than data, so this is a legibility bound; the
    // marker is what keeps a shortened segment from reading as a complete one.
    // A shortened segment is always bracketed and quoted, whatever the key
    // looked like: the truncation marker is not an identifier character, so a
    // dotted form would misread as a member access on an impossible name.
    for (const key of [
      `contextField${'X'.repeat(PATH_SEGMENT_MAX_LENGTH * 2)}`,
      `context-field-${'X'.repeat(PATH_SEGMENT_MAX_LENGTH * 2)}`,
    ]) {
      const path = inspectPayload({ [key]: CREDENTIALED_URI })[0]?.path ?? '';
      expect(path.startsWith(`${DEFAULT_ROOT_PATH}["${key.slice(0, 12)}`)).toBe(true);
      expect(path.endsWith(`${PATH_SEGMENT_TRUNCATION_MARKER}"]`)).toBe(true);
      expect(path.length).toBe(DEFAULT_ROOT_PATH.length + PATH_SEGMENT_MAX_LENGTH + 4);
    }

    // A key inside the bound keeps its natural form.
    expect(inspectPayload({ contextField: CREDENTIALED_URI })[0]?.path).toBe(
      `${DEFAULT_ROOT_PATH}.contextField`,
    );
  });

  it('agrees with itself: the findings view is the report view', () => {
    const payload: JsonObject = {
      headers: { authorization: BEARER_CREDENTIAL },
      environment: { url: CREDENTIALED_URI },
    };
    expect(inspectPayload(payload)).toEqual(inspectPayloadReport(payload).findings);
  });

  it('names exactly the six denied headers as a typed vocabulary', () => {
    // Typed so a name outside the six cannot be written here by accident.
    const denied: readonly DeniedHeaderName[] = DENIED_HEADER_NAMES;
    for (const name of denied) {
      expect(isDeniedHeaderName(name)).toBe(true);
    }
  });
});

describe('summarizeFindings', () => {
  it('says so when there is nothing to summarise', () => {
    expect(summarizeFindings([])).toBe('no findings');
  });

  it('groups by class in reporting order, with counts and paths', () => {
    const findings = inspectPayload({
      headers: { authorization: BEARER_CREDENTIAL },
      environment: { url: CREDENTIALED_URI },
    });
    const summary = summarizeFindings(findings);
    expect(summary).toContain('sensitive-header \u00d71 (input.headers.authorization)');
    expect(summary).toContain('connection-string \u00d71 (input.environment.url)');
    expect(summary.indexOf('sensitive-header')).toBeLessThan(summary.indexOf('connection-string'));
    for (const secret of SECRET_FIXTURES) {
      expectNoValueLeak(summary, secret);
    }
  });

  it('counts the paths it does not list', () => {
    const many: Record<string, string> = {};
    for (let index = 0; index < SUMMARY_MAX_PATHS_PER_RULE + 2; index += 1) {
      many[`field${String(index)}`] = CREDENTIALED_URI;
    }
    const summary = summarizeFindings(inspectPayload(many, { rules: ['connection-string'] }));
    expect(summary).toContain(`connection-string \u00d7${String(SUMMARY_MAX_PATHS_PER_RULE + 2)}`);
    expect(summary).toContain('+2 more');
  });
});

/*
 * ---------------------------------------------------------------------------
 * The refusal
 * ---------------------------------------------------------------------------
 */

describe('assertOutboundSafe', () => {
  it('is exercised with requests whose provenance is real', () => {
    // A fixture request has to be one the pipeline could actually make: the
    // stage comes from the exported vocabulary and the prompt version has the
    // `vNNN` shape the loader reports, so a request that would never exist
    // cannot be what the refusal path is proved on.
    const { metadata } = makeRequest();
    expect(PROMPT_STAGES).toContain(metadata.stage);
    expect(metadata.promptVersion).toMatch(/^v\d{3}$/);
  });

  it('passes a request whose every field is already redacted', () => {
    const result = assertOutboundSafe(
      makeRequest({
        system: 'Cite the event ids that support each observed statement.',
        messages: [{ role: 'user', content: 'Why is this slow?' }],
        input: COMPLIANT_PAYLOAD,
      }),
    );
    expect(result).toEqual({ ok: true, value: undefined });
  });

  it('refuses with a code from the closed vocabulary rather than an invented one', () => {
    const result = assertOutboundSafe(
      makeRequest({ input: { environment: { url: CREDENTIALED_URI } } }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(DebuggenError.is(result.error)).toBe(true);
    expect(DEBUGGEN_ERROR_CODES).toContain(result.error.code);
    expect(result.error.code).toBe('INTERNAL');
  });

  it('carries the rule ids, the paths and the provenance in details', () => {
    const result = assertOutboundSafe(
      makeRequest({
        input: {
          headers: { authorization: BEARER_CREDENTIAL },
          requests: [{ url: `/x?a=${QUERY_VALUE}` }],
        },
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    const details = result.error.details;
    expect(details?.ruleIds).toEqual(['sensitive-header', 'bearer-token', 'url-query-value']);
    expect(details?.paths).toEqual([
      'input.headers.authorization',
      'input.headers.authorization',
      'input.requests[0].url?a',
    ]);
    expect(details?.findingCount).toBe(3);
    expect(details?.complete).toBe(true);
    expect(details?.stage).toBe('analyze');
    expect(details?.promptVersion).toBe('v001');
    expect(details?.sessionId).toBe('ses_01JBQ8Z4T7');
  });

  it('reads a bearer credential out of the rendered prose, not only out of a header', () => {
    // A credential reaches the prose half of the payload the same way anything
    // else does: a bounded source excerpt is substituted into the prompt the
    // loader rendered. A guard that only inspected structure would send it.
    const result = assertOutboundSafe(
      makeRequest({
        prompt: `${CLEAN_PROMPT} One excerpt reads: fetch(url, { headers: { authorization: '${BEARER_CREDENTIAL}' } }).`,
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.details?.ruleIds).toEqual(['bearer-token']);
    expect(result.error.details?.paths).toEqual(['prompt']);
    expectNoValueLeak(
      [result.error.message, JSON.stringify(result.error.details)].join('\n'),
      BEARER_CREDENTIAL,
    );
  });

  it('names the full path of a credential buried deep in the structured context', () => {
    // The path is what makes a refusal actionable, so it has to survive array
    // indices and a non-identifier key on the way down to the field.
    const result = assertOutboundSafe(
      makeRequest({
        input: {
          spans: [
            { name: 'interaction', attributes: {} },
            { name: 'render', attributes: { component: 'SummaryCard' } },
            {
              name: 'fetch',
              attributes: { 'http.request.header.authorization': HEADER_VALUE },
            },
          ],
        },
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.details?.ruleIds).toEqual(['sensitive-header']);
    expect(result.error.details?.paths).toEqual([
      'input.spans[2].attributes["http.request.header.authorization"]',
    ]);
    expectNoValueLeak(JSON.stringify(result.error.details), HEADER_VALUE);
  });

  it('keeps every part of the error free of the value that caused it', () => {
    const result = assertOutboundSafe(
      makeRequest({
        system: `Never repeat ${VENDOR_CREDENTIAL}.`,
        input: {
          headers: { cookie: WEB_TOKEN },
          environment: { url: CREDENTIALED_URI, apiKey: OPAQUE_SECRET },
        },
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    const payload = result.error.toPayload();
    expect(payload.code).toBe('INTERNAL');
    expect(payload.hint).toBeDefined();
    const printed = [
      result.error.message,
      result.error.hint ?? '',
      JSON.stringify(result.error.details),
      JSON.stringify(payload),
    ].join('\n');
    for (const secret of SECRET_FIXTURES) {
      expectNoValueLeak(printed, secret);
    }
  });

  it('says what to do, and says that retrying unchanged will not help', () => {
    const result = assertOutboundSafe(makeRequest({ input: { token: OPAQUE_SECRET } }));
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.hint ?? '').toContain('never rewrites');
    expect(result.error.message).toContain('refused');
    expect(result.error.message).toContain('high-entropy-secret');
  });

  it('refuses a payload it could not inspect in full, with no finding to show', () => {
    const result = assertOutboundSafe(makeRequest({ input: nest(DEFAULT_MAX_DEPTH + 4, {}) }));
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.message).toContain('could not be inspected in full');
    expect(result.error.details?.findingCount).toBe(0);
    expect(result.error.details?.limitsReached).toEqual(['max-depth']);
    expect(result.error.hint ?? '').toContain('never treated as safe');
  });

  it('never rewrites, redacts or otherwise touches the request', () => {
    const request = makeRequest({
      system: 'Cite the event ids.',
      messages: [{ role: 'user', content: `saw ${WEB_TOKEN}` }],
      input: { headers: { authorization: BEARER_CREDENTIAL } },
    });
    const before = structuredClone(request);
    expect(assertOutboundSafe(request).ok).toBe(false);
    expect(request).toEqual(before);
    // The same request is refused again: refusal is the contract, so a caller
    // cannot use this as a sanitiser and retry.
    expect(assertOutboundSafe(request).ok).toBe(false);
  });

  it('refuses rather than throwing when the request itself cannot be read', () => {
    const throwing = Object.defineProperties(
      { ...makeRequest() },
      {
        prompt: {
          enumerable: true,
          get(): string {
            throw new Error('unreadable');
          },
        },
      },
    );
    let result: Result<void, DebuggenError> | undefined;
    expect(() => {
      result = assertOutboundSafe(throwing);
    }).not.toThrow();
    expect(result?.ok).toBe(false);
    if (result === undefined || result.ok) {
      return;
    }
    expect(result.error.code).toBe('INTERNAL');
    expect(result.error.details?.limitsReached).toEqual(['inspection-error']);
    expect(result.error.cause).toBeInstanceOf(Error);
  });

  it('shares one budget across the prose and the structured context', () => {
    // One pass, one state: a request cannot spend four separate node budgets.
    const result = assertOutboundSafe(
      makeRequest({
        system: 'Cite the event ids.',
        prompt: CLEAN_PROMPT,
        messages: [{ role: 'user', content: 'Why is this slow?' }],
        input: COMPLIANT_PAYLOAD,
      }),
      { maxNodes: 6 },
    );
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.details?.limitsReached).toEqual(['max-nodes']);
  });
});
