/**
 * Colocated suite for the outbound redaction guard.
 *
 * It pins the three things the guard is for and one thing it must never do:
 *
 * 1. **One case per deny-list class of AAP §0.5.2.** Eight rules, eight
 *    positive cases, each on the shape the specification's table names.
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
 * module under test for what that costs.
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
  KEY_LIKE_NAME_TERMS,
  MAX_SUPPORTED_DEPTH,
  PATH_SEGMENT_MAX_LENGTH,
  PATH_SEGMENT_TRUNCATION_MARKER,
  REDACTION_MARKER,
  REDACTION_RULE_IDS,
  REDACTION_RULE_REASONS,
  REDACT_GUARD_LIMIT_IDS,
  SCAN_WINDOW_LENGTH,
  SCAN_WINDOW_OVERLAP,
  SUMMARY_MAX_PATHS_PER_RULE,
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

/** An opaque secret: long, dense and bound to a credential-like name. */
const OPAQUE_SECRET = cycle(URLSAFE_CHARS, 44);

/** A hexadecimal digest: 64 characters, and exactly four bits each. */
const HEX_DIGEST = cycle(HEX_CHARS, 64);

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
      'max-findings',
      'inspection-error',
    ]);
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

  it('finds a credential in a megabyte string without scanning all of it', () => {
    const large = `${FILLER.repeat(200)}${GENERIC_CREDENTIAL} ${FILLER.repeat(200_000)}`;
    const report = inspectPayloadReport({ excerpt: large }, { rules: ['provider-key'] });
    expect(ruleIdsOf(report.findings)).toEqual(['provider-key']);
    // Scanning stopped at the bound, so the verdict is "unsafe and truncated".
    expect(report.limitsReached).toContain('max-string-length');
    expect(report.complete).toBe(false);
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

  it('does not hand a pathologically long string to the URL parser', () => {
    // A documented bound: a request target is not a document, so past the
    // parse bound the rule declines to look rather than parsing megabytes on
    // the off-chance the value is a link.
    const enormous = `/reports/summary?cursor=${'b'.repeat(URL_PARSE_MAX_LENGTH)}`;
    expect(inspectPayload({ url: enormous }, { rules: ['url-query-value'] })).toEqual([]);
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
