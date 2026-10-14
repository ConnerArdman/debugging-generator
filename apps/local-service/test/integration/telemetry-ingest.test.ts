/**
 * `telemetry-ingest` — the integration suite for the service's evidence entry
 * point (AAP §0.8.3, §0.5.2, §0.4.2).
 *
 * `src/telemetry/ingest.test.ts` already pins the pipeline's call order with
 * spies and fake ports. This suite proves the same order **by outcome**, across
 * the real transports and the real store: a batch goes in over the bound tab's
 * `telemetry.event` WebSocket frame and over `POST /telemetry/ingest`, and every
 * claim is then checked against what the service *kept* — the `telemetry_events`
 * rows read back through `TelemetryRepo` and as raw column text, the
 * `telemetry.tail` frames the DevTools client received, every service log
 * record and every HTTP response body.
 *
 * ## What is proven
 *
 * - **Redaction before persistence and before the tail.** Each assertion of
 *   `ingest-redaction-expected.json` is interpreted against the persisted row,
 *   and no credential material this file substituted survives anywhere the
 *   service writes or sends. A value that survives anywhere means redaction ran
 *   too late.
 * - **`request_key` from the unredacted URL.** Byte-identical requests share a
 *   key, requests differing only in a query value do not — although all of them
 *   are stored as `…?trailId=?` — and a digest recomputed over the *masked* URL
 *   never equals the stored key. That last comparison is the one that fails if
 *   the order were inverted, because a key computed after masking still looks
 *   plausible.
 * - **Attribution.** Browser batches belong to the session bound to the tab the
 *   frame acts for — its envelope `tabId`, else a single-tab connection's hello
 *   tab — server batches to the capture owner of the credential's scoped
 *   project, and only inside an open capture window; everything else is dropped
 *   under the closed `DROP_REASONS` vocabulary, as a count. A relayed frame
 *   whose acting tab cannot be established, holds no live binding this
 *   credential made, or carries a stale session routing key is refused whole
 *   with `TAB_NOT_BOUND` before ingest — one credential and one multiplexing
 *   connection carry every inspected tab, so the connection's other tab is
 *   never substituted.
 * - **`ingestSeq`.** Store-assigned, strictly increasing across batches and
 *   producers, untouched by an idempotent replay, and the final tie-break of a
 *   deterministic canonical order.
 * - **Loss-only reports.** A `telemetry.event` frame with no events and a
 *   positive `droppedCount` — a producer's last word at a capture's end — is
 *   accepted, persists and tails nothing, and reaches the capture's loss
 *   ledger, so the stopped capture's persisted coverage counts the loss and is
 *   not complete. An empty frame without a positive loss is refused as
 *   `PROTOCOL_INVALID_MESSAGE`, and one naming another capture is dropped as
 *   `stale-capture`; neither records anything. The service's ledger lives in
 *   its own repository instance, out of the suite's reach, so its total is
 *   read from the record ingest writes when the ledger accepts a report, then
 *   from the persisted coverage.
 * - **Server-tier capture identity and loss.** A `POST /telemetry/ingest` body
 *   naming the open capture as `armedCaptureId` is stored under it; one naming
 *   a capture that has since closed — a preload batch retried across a stop and
 *   a start — is dropped whole as `stale-capture` while the next capture is
 *   open, storing nothing and recording none of its loss; a body naming no
 *   capture is attributed as before; and a malformed `armedCaptureId` or
 *   `droppedCount` is refused `400`. A body's `droppedCount`, beside events or
 *   alone, reaches the open capture's ledger, so the stopped capture's
 *   persisted coverage counts it and is not complete.
 * - **A retried loss report counts once.** The same body sent again — events,
 *   `droppedCount` and `lossReportId` byte for byte, as the preload retries a
 *   post whose acknowledgement was lost — is answered `202` both times, stores
 *   its events once and adds its loss to the ledger once. Two reports under
 *   different ids both count, a report without an id counts on every
 *   delivery, and a `lossReportId` beside no loss is refused `400` with
 *   nothing stored or recorded. The stopped capture's persisted coverage holds
 *   the single-counted total, and no report id is echoed or logged.
 *
 * ## The sentinel protocol (AAP §0.10 — no committed secrets)
 *
 * The input fixture carries only neutral `{{SENTINEL}}` tokens. This suite owns
 * the substitution material: every value is assembled at run time from short
 * fragments and `node:crypto` randomness (through the harness's
 * {@link randomSecretLike} where a shape exists), so `scripts/check-secrets.mjs`
 * finds nothing in this tracked file. Material is chosen by each sentinel's
 * `ruleId`, and before any of it is used the suite proves that it really
 * matches that deny-list rule — a substitution that did not would make the
 * redaction assertions pass vacuously. Substitution happens on a parsed copy in
 * memory; the committed fixtures are only read, and their bytes are re-hashed
 * at teardown.
 *
 * ## Why not `redacted === true`
 *
 * The event schema defines `redacted` as the list of attribute paths the
 * redactor replaced, absent when nothing needed replacing, and both event
 * schemas are strict — no boolean marker can exist (see `live-tail.ts`,
 * "Why not a `redacted === true` flag"). The tail's defence-in-depth guard is
 * therefore checked in its faithful form: every tailed event parses as a
 * *persisted* event of the session (a one-based, store-assigned `ingestSeq` is
 * the evidence it crossed the privacy boundary), equals the stored row, and
 * carries a non-empty `redacted` list exactly where the fixture says one is due.
 *
 * ## `MAX_EVENTS_PER_BATCH`
 *
 * The transport ceiling protocol calls `MAX_EVENTS_PER_BATCH` is module-local to
 * protocol on purpose (`@debuggen/telemetry` exports a different number, the
 * agent's 200-event flush trigger, under that name). Ingest reads the ceiling
 * from protocol's two batch schemas and exports it as `MAX_INGEST_BATCH`, which
 * is what the over-size cases below exceed by one.
 *
 * @module
 */

import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { isMessageOfType } from '@debuggen/protocol';
import type {
  CreateEnvelopeOptions,
  MessagePayload,
  ProtocolMessage,
  SessionRecord,
} from '@debuggen/protocol';
import {
  isErr,
  newCaptureId,
  newEventId,
  newProducerId,
  newSpanId,
  newTraceId,
} from '@debuggen/shared';
import {
  DEFAULT_DUPLICATE_WINDOW_MS,
  MAX_PREVIEW_LENGTH,
  REDACTION_MARKER,
  REDACTION_MASK,
  REDACTION_RULE_IDS,
  REQUEST_KEY_SESSION_KEY_PATTERN,
  createRequestKeyHasher,
  findDeniedRules,
  isHighEntropySecret,
  parseTelemetryEvent,
  parseTelemetryEventIngress,
} from '@debuggen/telemetry';
import type { RedactionRuleId, TelemetryEvent, TelemetryEventIngress } from '@debuggen/telemetry';

import { TELEMETRY_QUERY_MAX_LIMIT } from '../../src/store/telemetry-repo.js';
import { DROP_REASONS, TIER_BY_ORIGIN, isDropReason } from '../../src/telemetry/attribute.js';
import type { DropReason } from '../../src/telemetry/attribute.js';
import {
  INGEST_REQUEST_KEY_ATTRIBUTE,
  INGEST_SUBSYSTEM,
  MAX_INGEST_BATCH,
} from '../../src/telemetry/ingest.js';
import { TAIL_CLIENT_KINDS } from '../../src/telemetry/live-tail.js';
import {
  HARNESS_TIMEOUTS,
  fixturePath,
  randomSecretLike,
  readFixtureJson,
  startHarness,
} from './harness.js';
import type { CapturedLogRecord, DevtoolsCredential, Harness, HarnessWsClient } from './harness.js';

/* -------------------------------------------------------------------------------------------------
 * Fixture names and suite constants
 * ---------------------------------------------------------------------------------------------- */

/** The batch whose `{{SENTINEL}}` tokens this suite substitutes. */
const INPUT_FIXTURE = 'ingest-redaction-input.json';

/** The expectation document that drives every redaction assertion. */
const EXPECTED_FIXTURE = 'ingest-redaction-expected.json';

/** The inspected tab the DevTools client speaks for. */
const TAB_ID = 4_217;

/** The same credential's second inspected tab, bound to a session of another project. */
const SECOND_TAB_ID = 4_218;

/** The pattern of one sentinel token as it appears in the committed input. */
const SENTINEL_TOKEN_PATTERN = /\{\{[A-Z0-9_]+\}\}/gu;

/**
 * The shortest leak fingerprint accepted. A fingerprint is searched for as a
 * substring of large haystacks, so a short one could match by accident and a
 * test that "found a leak" would be wrong; every material below yields
 * fingerprints well above this bound.
 */
const MIN_FINGERPRINT_LENGTH = 12;

/**
 * The key of the standard `subsystem` binding on every service log record
 * (`src/logging.ts` `LOG_BINDING_KEYS.subsystem`), which is how the ingest
 * module's own records are told apart from the rest of the log.
 */
const SUBSYSTEM_FIELD = 'subsystem';

/** The deny-list rules classified by *position* (a header slot, a query slot), not by content. */
const POSITIONAL_RULES: ReadonlySet<RedactionRuleId> = new Set<RedactionRuleId>([
  'sensitive-header',
  'url-query-value',
]);

/* -------------------------------------------------------------------------------------------------
 * Small, total utilities
 * ---------------------------------------------------------------------------------------------- */

/** Whether a value is a plain, non-array object. */
function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Joins fragments; the split points are why this tracked file holds no credential literal. */
function assemble(...fragments: readonly string[]): string {
  return fragments.join('');
}

/** `bytes` random bytes as base64url. */
function randomBase64Url(bytes: number): string {
  return randomBytes(bytes).toString('base64url');
}

/** `bytes` random bytes as lowercase hex. */
function randomHex(bytes: number): string {
  return randomBytes(bytes).toString('hex');
}

/** The SHA-256 of a committed fixture's bytes, to prove the suite never wrote one. */
function fixtureDigest(name: string): string {
  return createHash('sha256')
    .update(readFileSync(fixturePath(name)))
    .digest('hex');
}

/** Every string leaf of a JSON-shaped value, depth-first. */
function stringLeaves(value: unknown): string[] {
  if (typeof value === 'string') {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap((element: unknown) => stringLeaves(element));
  }
  if (isRecord(value)) {
    return Object.values(value).flatMap((element) => stringLeaves(element));
  }
  return [];
}

/** Returns a deep copy of a JSON-shaped value with `replace` applied to every string leaf. */
function mapStrings(value: unknown, replace: (text: string) => string): unknown {
  if (typeof value === 'string') {
    return replace(value);
  }
  if (Array.isArray(value)) {
    return value.map((element: unknown) => mapStrings(element, replace));
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, element]) => [key, mapStrings(element, replace)]),
    );
  }
  return value;
}

/** Counts code points, which is how the preview bound is measured. */
function codePointLength(text: string): number {
  return Array.from(text).length;
}

/* -------------------------------------------------------------------------------------------------
 * Attribute paths — the fixture's key resolution rule
 * ---------------------------------------------------------------------------------------------- */

/** One step of a path: an object key or an array index. */
type PathSegment = string | number;

/** Where a fixture key resolved, and to what. */
interface Resolved {
  readonly found: boolean;
  readonly value: unknown;
}

/** Splits `a.b[0].c` into `['a', 'b', 0, 'c']`. */
function parsePath(key: string): PathSegment[] {
  const segments: PathSegment[] = [];
  for (const match of key.matchAll(/([^.[\]]+)|\[(\d+)\]/gu)) {
    const [, name, index] = match;
    if (index !== undefined) {
      segments.push(Number(index));
    } else if (name !== undefined) {
      segments.push(name);
    }
  }
  return segments;
}

/** Walks `segments` from `root`. */
function walk(root: unknown, segments: readonly PathSegment[]): Resolved {
  let current: unknown = root;
  for (const segment of segments) {
    if (typeof segment === 'number') {
      if (!Array.isArray(current) || segment >= current.length) {
        return { found: false, value: undefined };
      }
      current = current[segment];
    } else {
      if (!isRecord(current) || !Object.hasOwn(current, segment)) {
        return { found: false, value: undefined };
      }
      current = current[segment];
    }
  }
  return { found: true, value: current };
}

/**
 * Resolves a fixture `key` against an attribute bag the way the expectation
 * document defines it: by exact key first, and only then as a path of
 * dot-separated keys and `[index]` elements.
 */
function resolveAttribute(attributes: unknown, key: string): Resolved {
  if (isRecord(attributes) && Object.hasOwn(attributes, key)) {
    return { found: true, value: attributes[key] };
  }
  return walk(attributes, parsePath(key));
}

/** A path rendered for a failure message. */
function describePath(path: readonly PathSegment[]): string {
  return path
    .map((segment) => (typeof segment === 'number' ? `[${String(segment)}]` : `.${segment}`))
    .join('')
    .replace(/^\./u, '');
}

/* -------------------------------------------------------------------------------------------------
 * The expectation document, validated by hand (no schema library is a dependency here)
 * ---------------------------------------------------------------------------------------------- */

/** The closed assertion vocabulary of `ingest-redaction-expected.json`. */
const EXPECTATION_KINDS = Object.freeze([
  'equals',
  'marker',
  'mask',
  'unchanged',
  'absent',
  'maxLength',
  'excludesSubstitutedSentinel',
  'elementCount',
] as const);

/** One member of {@link EXPECTATION_KINDS}. */
type ExpectationKind = (typeof EXPECTATION_KINDS)[number];

/** One attribute assertion: a key and exactly one vocabulary entry with its argument. */
interface AttributeExpectation {
  readonly key: string;
  readonly kind: ExpectationKind;
  readonly argument: unknown;
}

/** Everything the document asserts about one redacted event. */
interface EventExpectation {
  readonly id: string;
  readonly redactedMarker: boolean;
  readonly attributes: readonly AttributeExpectation[];
  readonly absentAttributes: readonly string[];
}

/** The class a sentinel's slot collapses to. */
type SentinelFate = 'marker' | 'mask' | 'scrubbed';

/** One sentinel: its token, the rule its material must match, and its fate. */
interface SentinelSpec {
  readonly token: string;
  readonly ruleId: RedactionRuleId | null;
  readonly fate: SentinelFate;
}

/** The whole expectation document. */
interface ExpectedDocument {
  readonly markers: {
    readonly redacted: string;
    readonly mask: string;
    readonly maxPreviewLength: number;
  };
  readonly sentinels: readonly SentinelSpec[];
  readonly events: readonly EventExpectation[];
  readonly mustGroup: readonly (readonly string[])[];
  readonly mustNotGroup: readonly (readonly string[])[];
}

/** Throws a fixture-drift error naming the expectation document. */
function drift(message: string): never {
  throw new Error(`${EXPECTED_FIXTURE} drifted: ${message}`);
}

/** Reads a string property or fails. */
function requireString(record: Readonly<Record<string, unknown>>, key: string): string {
  const value = record[key];
  return typeof value === 'string' ? value : drift(`"${key}" must be a string`);
}

/** Reads a list of id tuples or fails. */
function requireIdTuples(value: unknown, label: string): (readonly string[])[] {
  if (!Array.isArray(value)) {
    return drift(`"${label}" must be an array of id tuples`);
  }
  return value.map((tuple: unknown) => {
    if (!Array.isArray(tuple) || tuple.length < 2 || !tuple.every((id) => typeof id === 'string')) {
      return drift(`"${label}" must hold tuples of at least two event ids`);
    }
    return tuple.map(String);
  });
}

/** Whether a string names a deny-list rule. */
function isRuleId(value: unknown): value is RedactionRuleId {
  return REDACTION_RULE_IDS.some((rule) => rule === value);
}

/** Whether a string names an assertion of the closed vocabulary. */
function isExpectationKind(value: string): value is ExpectationKind {
  return EXPECTATION_KINDS.some((kind) => kind === value);
}

/** Validates one attribute assertion: exactly one vocabulary entry, with a sound argument. */
function parseAttributeExpectation(value: unknown, eventId: string): AttributeExpectation {
  if (!isRecord(value) || !isRecord(value.expect)) {
    return drift(`an attribute assertion of ${eventId} must be { key, expect }`);
  }
  const key = requireString(value, 'key');
  const entries = Object.entries(value.expect);
  const [entry] = entries;
  if (entries.length !== 1 || entry === undefined) {
    return drift(`${eventId} ${key}: "expect" must carry exactly one assertion`);
  }
  const [kind, argument] = entry;
  if (!isExpectationKind(kind)) {
    return drift(`${eventId} ${key}: "${kind}" is not in the closed vocabulary`);
  }
  const flag = kind === 'marker' || kind === 'mask' || kind === 'unchanged' || kind === 'absent';
  if ((flag || kind === 'excludesSubstitutedSentinel') && argument !== true) {
    return drift(`${eventId} ${key}: "${kind}" takes the argument true`);
  }
  if (
    (kind === 'maxLength' || kind === 'elementCount') &&
    (typeof argument !== 'number' || !Number.isSafeInteger(argument) || argument < 0)
  ) {
    return drift(`${eventId} ${key}: "${kind}" takes a non-negative integer`);
  }
  return { key, kind, argument };
}

/** Validates the whole expectation document. */
function parseExpectedDocument(value: unknown): ExpectedDocument {
  if (!isRecord(value)) {
    return drift('the document must be an object');
  }
  const { markers, sentinels, events, requestKeyGroups } = value;
  if (
    !isRecord(markers) ||
    typeof markers.redacted !== 'string' ||
    typeof markers.mask !== 'string' ||
    typeof markers.maxPreviewLength !== 'number'
  ) {
    return drift('"markers" must be { redacted, mask, maxPreviewLength }');
  }
  if (!Array.isArray(sentinels) || sentinels.length === 0) {
    return drift('"sentinels" must be a non-empty array');
  }
  const parsedSentinels = sentinels.map((sentinel: unknown): SentinelSpec => {
    if (!isRecord(sentinel)) {
      return drift('every sentinel must be an object');
    }
    const token = requireString(sentinel, 'token');
    const ruleId = sentinel.ruleId;
    const fate = sentinel.expect;
    if (ruleId !== null && !isRuleId(ruleId)) {
      return drift(`${token}: ruleId must be null or a member of REDACTION_RULE_IDS`);
    }
    if (fate !== 'marker' && fate !== 'mask' && fate !== 'scrubbed') {
      return drift(`${token}: expect must be marker, mask or scrubbed`);
    }
    return { token, ruleId, fate };
  });
  if (!Array.isArray(events) || events.length === 0) {
    return drift('"events" must be a non-empty array');
  }
  const parsedEvents = events.map((event: unknown): EventExpectation => {
    if (!isRecord(event) || typeof event.redactedMarker !== 'boolean') {
      return drift('every event entry must be { id, redactedMarker, attributes }');
    }
    const id = requireString(event, 'id');
    if (!Array.isArray(event.attributes)) {
      return drift(`${id}: "attributes" must be an array`);
    }
    const absent = event.absentAttributes ?? [];
    if (!Array.isArray(absent) || !absent.every((key) => typeof key === 'string')) {
      return drift(`${id}: "absentAttributes" must be an array of keys`);
    }
    return {
      id,
      redactedMarker: event.redactedMarker,
      attributes: event.attributes.map((entry: unknown) => parseAttributeExpectation(entry, id)),
      absentAttributes: absent.map(String),
    };
  });
  if (!isRecord(requestKeyGroups)) {
    return drift('"requestKeyGroups" must be an object');
  }
  return {
    markers: {
      redacted: markers.redacted,
      mask: markers.mask,
      maxPreviewLength: markers.maxPreviewLength,
    },
    sentinels: parsedSentinels,
    events: parsedEvents,
    mustGroup: requireIdTuples(requestKeyGroups.mustGroup, 'mustGroup'),
    mustNotGroup: requireIdTuples(requestKeyGroups.mustNotGroup, 'mustNotGroup'),
  };
}

/* -------------------------------------------------------------------------------------------------
 * Substitution material — assembled at run time, never committed
 * ---------------------------------------------------------------------------------------------- */

/**
 * The material substituted for one sentinel, and the fragments of it that
 * must never survive anywhere the service writes or sends.
 *
 * `fingerprints` always include the whole value; shapes that are only partly
 * secret (a connection string keeps its scheme and host, a bearer value keeps
 * its scheme word) add the secret parts, so a leak of the part alone is caught
 * too.
 */
interface Substitution {
  readonly spec: SentinelSpec;
  readonly value: string;
  readonly fingerprints: readonly string[];
}

/** The PEM delimiter dashes, built rather than written. */
const PEM_DASHES = '-'.repeat(5);

/** A private-key block: delimiters from fragments, a random body. */
function randomPrivateKeyBlock(): { readonly value: string; readonly body: string } {
  const label = assemble('PRIVATE', ' ', 'KEY');
  const body = randomBytes(48).toString('base64');
  const value = [
    assemble(PEM_DASHES, 'BEGIN ', label, PEM_DASHES),
    body,
    assemble(PEM_DASHES, 'END ', label, PEM_DASHES),
  ].join('\n');
  return { value, body };
}

/** An opaque, high-entropy credential under a key-like name: retried until it clears the bar. */
function randomHighEntropyValue(): string {
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const candidate = randomBase64Url(36);
    if (isHighEntropySecret(candidate)) {
      return candidate;
    }
  }
  throw new Error('No high-entropy candidate was drawn in 32 attempts.');
}

/**
 * A random 16-digit card number with a valid Luhn check digit, starting with
 * `4` so it sits in the issuer range the `payment-card` rule recognises.
 */
function randomCardNumber(): string {
  const payload = assemble('4', Array.from(randomBytes(14), (byte) => String(byte % 10)).join(''));
  let sum = 0;
  for (let index = 0; index < payload.length; index += 1) {
    const digit = Number(payload.charAt(payload.length - 1 - index));
    const doubled = index % 2 === 0 ? digit * 2 : digit;
    sum += doubled > 9 ? doubled - 9 : doubled;
  }
  return assemble(payload, String((10 - (sum % 10)) % 10));
}

/**
 * Assembles fresh material for one sentinel, chosen by its `ruleId` — so a new
 * sentinel with an existing rule is a fixture edit, not new code.
 *
 * - `sensitive-header` and `bearer-token`: an `Authorization`-shaped bearer
 *   value; a denied header is masked by position whatever its value.
 * - `url-query-value`: an opaque, URL-safe token.
 * - `provider-key`, `jwt`, `connection-string`: the harness's shapes.
 * - `private-key`: a PEM block.
 * - `email-address`: an address with a random local part.
 * - `payment-card`: a random, checksum-valid card number.
 * - `labelled-secret`: an opaque value holding a digit; the fixture slot
 *   supplies the label (`token: {{…}}`) the rule keys on.
 * - `entropy`: a dense opaque value above the entropy threshold.
 * - `null` (positional, any material): a neutral random literal free of quotes.
 */
function materialFor(spec: SentinelSpec): Substitution {
  switch (spec.ruleId) {
    case 'sensitive-header':
    case 'bearer-token': {
      const value = randomSecretLike('bearer');
      const body = value.slice(value.indexOf(' ') + 1);
      return { spec, value, fingerprints: [value, body] };
    }
    case 'url-query-value': {
      const value = randomBase64Url(24);
      return { spec, value, fingerprints: [value] };
    }
    case 'provider-key': {
      const value = randomSecretLike('provider-key');
      return { spec, value, fingerprints: [value, value.slice(-24)] };
    }
    case 'jwt': {
      const value = randomSecretLike('jwt');
      const [, payload = '', signature = ''] = value.split('.');
      return { spec, value, fingerprints: [value, payload, signature] };
    }
    case 'connection-string': {
      const value = randomSecretLike('connection-string');
      const parsed = new URL(value);
      return {
        spec,
        value,
        fingerprints: [
          value,
          decodeURIComponent(parsed.username),
          decodeURIComponent(parsed.password),
        ],
      };
    }
    case 'private-key': {
      const block = randomPrivateKeyBlock();
      return { spec, value: block.value, fingerprints: [block.value, block.body] };
    }
    case 'email-address': {
      const local = assemble('buyer.', randomHex(6));
      const value = assemble(local, '@', 'mail.example.test');
      return { spec, value, fingerprints: [value, local] };
    }
    case 'payment-card': {
      const value = randomCardNumber();
      return { spec, value, fingerprints: [value, value.slice(4)] };
    }
    case 'labelled-secret': {
      const value = assemble('k3y-', randomHex(8));
      return { spec, value, fingerprints: [value] };
    }
    case 'entropy': {
      const value = randomHighEntropyValue();
      return { spec, value, fingerprints: [value] };
    }
    case null: {
      const value = assemble('observer-', randomHex(8));
      return { spec, value, fingerprints: [value] };
    }
  }
}

/**
 * Every form a fingerprint could take in a haystack: verbatim, JSON-escaped
 * once (a stored `event` column, a frame, a log line) and URL-encoded.
 */
function needlesOf(fingerprint: string): string[] {
  return [
    ...new Set([
      fingerprint,
      JSON.stringify(fingerprint).slice(1, -1),
      encodeURIComponent(fingerprint),
    ]),
  ];
}

/** Every needle of every fingerprint of `substitutions`. */
function allNeedles(substitutions: readonly Substitution[]): { token: string; needle: string }[] {
  return substitutions.flatMap((substitution) =>
    substitution.fingerprints.flatMap((fingerprint) =>
      needlesOf(fingerprint).map((needle) => ({ token: substitution.spec.token, needle })),
    ),
  );
}

/** The tokens of `substitutions` any of whose needles occur in `text`. */
function leakedTokens(text: string, substitutions: readonly Substitution[]): string[] {
  return [
    ...new Set(
      allNeedles(substitutions)
        .filter(({ needle }) => text.includes(needle))
        .map(({ token }) => token),
    ),
  ];
}

/* -------------------------------------------------------------------------------------------------
 * Fixture loading — synchronous, so the table-driven cases exist at collection time
 * ---------------------------------------------------------------------------------------------- */

/** The committed fixtures' bytes at load, re-checked at teardown. */
const FIXTURE_DIGESTS: ReadonlyMap<string, string> = new Map(
  [INPUT_FIXTURE, EXPECTED_FIXTURE].map((name) => [name, fixtureDigest(name)]),
);

/** The expectation document, validated. */
const EXPECTED: ExpectedDocument = parseExpectedDocument(
  readFixtureJson<unknown>(EXPECTED_FIXTURE),
);

/** The input batch as committed: sentinel tokens, never material. */
const RAW_INPUT: unknown = readFixtureJson<unknown>(INPUT_FIXTURE);

/** One substitution per sentinel, built once for the whole file. */
const SUBSTITUTIONS: readonly Substitution[] = EXPECTED.sentinels.map(materialFor);

/** Sentinel token → its substitution. */
const SUBSTITUTION_BY_TOKEN: ReadonlyMap<string, Substitution> = new Map(
  SUBSTITUTIONS.map((substitution) => [substitution.spec.token, substitution]),
);

/** Replaces every sentinel token inside one string. */
function substitute(text: string): string {
  let result = text;
  for (const substitution of SUBSTITUTIONS) {
    result = result.split(substitution.spec.token).join(substitution.value);
  }
  return result;
}

/** Parses one element through the owning strict schema, re-exported by `@debuggen/telemetry`. */
function parseIngress(value: unknown, label: string): TelemetryEventIngress {
  const parsed = parseTelemetryEventIngress(value);
  if (isErr(parsed)) {
    throw new Error(`${INPUT_FIXTURE} ${label} does not parse as ingress: ${parsed.error.message}`);
  }
  return parsed.value;
}

if (!Array.isArray(RAW_INPUT)) {
  throw new Error(`${INPUT_FIXTURE} must be a bare array of ingress events.`);
}

/** The committed events, parsed: the source of every sentinel slot. */
const ORIGINAL_EVENTS: readonly TelemetryEventIngress[] = RAW_INPUT.map(
  (element: unknown, index: number) => parseIngress(element, `[${String(index)}]`),
);

/** The substituted events, re-validated after substitution: what the transports carry. */
const SUBSTITUTED_EVENTS: readonly TelemetryEventIngress[] = RAW_INPUT.map(
  (element: unknown, index: number) =>
    parseIngress(mapStrings(element, substitute), `[${String(index)}] after substitution`),
);

/** Id → committed event. */
const ORIGINAL_BY_ID: ReadonlyMap<string, TelemetryEventIngress> = new Map(
  ORIGINAL_EVENTS.map((event) => [event.id, event]),
);

/** Id → substituted event. */
const SUBSTITUTED_BY_ID: ReadonlyMap<string, TelemetryEventIngress> = new Map(
  SUBSTITUTED_EVENTS.map((event) => [event.id, event]),
);

/** The browser-tier events: the page agent's share, relayed over the tab's WebSocket. */
const BROWSER_EVENTS: readonly TelemetryEventIngress[] = SUBSTITUTED_EVENTS.filter((event) =>
  TIER_BY_ORIGIN['browser-agent'].includes(event.tier),
);

/** The server- and database-tier events: the preload's share, posted over HTTP. */
const SERVER_EVENTS: readonly TelemetryEventIngress[] = SUBSTITUTED_EVENTS.filter((event) =>
  TIER_BY_ORIGIN['server-agent'].includes(event.tier),
);

/** One place a sentinel token sits in the committed input. */
interface SentinelSlot {
  readonly token: string;
  readonly eventId: string;
  /** The path from the event's root: `['name']` or `['attributes', …]`. */
  readonly path: readonly PathSegment[];
  /** The committed string that held the token. */
  readonly template: string;
}

/** Every string leaf under `value`, with its path. */
function stringSlots(
  value: unknown,
  path: readonly PathSegment[],
): { path: PathSegment[]; text: string }[] {
  if (typeof value === 'string') {
    return [{ path: [...path], text: value }];
  }
  if (Array.isArray(value)) {
    return value.flatMap((element: unknown, index: number) =>
      stringSlots(element, [...path, index]),
    );
  }
  if (isRecord(value)) {
    return Object.entries(value).flatMap(([key, element]) => stringSlots(element, [...path, key]));
  }
  return [];
}

/** Every sentinel slot of the committed input, across the name and the attribute bag. */
const SENTINEL_SLOTS: readonly SentinelSlot[] = ORIGINAL_EVENTS.flatMap((event) =>
  [...stringSlots(event.name, ['name']), ...stringSlots(event.attributes, ['attributes'])].flatMap(
    ({ path, text }) =>
      [...text.matchAll(SENTINEL_TOKEN_PATTERN)].map(([token]) => ({
        token,
        eventId: event.id,
        path,
        template: text,
      })),
  ),
);

/* -------------------------------------------------------------------------------------------------
 * Suite state and service-side helpers
 * ---------------------------------------------------------------------------------------------- */

/** Everything the setup establishes once for the file. */
interface SuiteState {
  readonly harness: Harness;
  readonly projectRoot: string;
  readonly sessionId: string;
  readonly devServerUrl: string;
  readonly devtools: HarnessWsClient;
  /** The credential `devtools` presented: the one every tab of the extension shares. */
  readonly devtoolsCredential: DevtoolsCredential;
  readonly editor: HarnessWsClient;
  readonly serverAgent: HarnessWsClient;
  readonly serverToken: string;
}

let suite: SuiteState | undefined;
let openCaptureId: string | undefined;

/** Every HTTP response body the suite received, verbatim or re-serialised: a leak haystack. */
const httpBodies: string[] = [];

/** Every ingest request body the suite posted: the proof that the material was actually sent. */
const postedBodies: string[] = [];

/** The state, or a failure naming the setup that did not run. */
function current(): SuiteState {
  if (suite === undefined) {
    throw new Error('The suite setup did not complete.');
  }
  return suite;
}

/** The open capture's id, or a failure naming the step that did not run. */
function captureIdOf(): string {
  if (openCaptureId === undefined) {
    throw new Error('The capture window was not opened.');
  }
  return openCaptureId;
}

/** Records a response for the leak search and returns it unchanged. */
function recordResponse<T>(value: T): T {
  httpBodies.push(JSON.stringify(value));
  return value;
}

/** What one `POST /telemetry/ingest` answered. */
interface IngestResponse {
  readonly status: number;
  readonly json: unknown;
}

/**
 * The optional delivery context of an ingest body: the capture the preload was
 * armed for, its loss report and that report's identity. Typed `unknown` so a
 * deliberately malformed value can be sent too.
 */
interface IngestDeliveryContext {
  readonly armedCaptureId?: unknown;
  readonly droppedCount?: unknown;
  readonly lossReportId?: unknown;
}

/**
 * Posts a batch to `POST /telemetry/ingest` as the dev-server preload would —
 * `{ projectRoot, events }`, with the delivery context's fields beside them
 * when given — through the raw transport so the verbatim response body joins
 * the leak haystacks and a deliberately refused body (over-size, out of scope,
 * a malformed field) can be sent at all.
 */
async function postIngest(
  token: string,
  projectRoot: string,
  events: readonly unknown[],
  context: IngestDeliveryContext = {},
): Promise<IngestResponse> {
  const body = { projectRoot, events: [...events], ...context };
  postedBodies.push(JSON.stringify(body));
  const response = await current().harness.rawFetch('telemetry.event', { token, body });
  httpBodies.push(response.text);
  return { status: response.status, json: response.json };
}

/** Relays a batch over the bound tab's DevTools connection and requires the service to have handled it. */
async function relay(events: readonly TelemetryEventIngress[]): Promise<readonly string[]> {
  const outcome = await current().harness.ingestFromAgent(current().devtools, events);
  expect(outcome.sent.ok, 'the telemetry.event frame was written').toBe(true);
  expect(outcome.settled, 'the service processed the frame before the barrier').toBe(true);
  return outcome.errors.map((error) => error.code);
}

/**
 * Relays a batch over `client` under explicit envelope options — the acting
 * `tabId` a multiplexing connection names per frame, a session routing key —
 * and returns the codes of the `error` replies the frame drew, read after the
 * ordering barrier.
 */
async function relayAs(
  client: HarnessWsClient,
  events: readonly TelemetryEventIngress[],
  options: CreateEnvelopeOptions,
): Promise<readonly string[]> {
  const receipt = client.send('telemetry.event', { events: [...events] }, options);
  expect(isErr(receipt.result), 'the telemetry.event frame was written').toBe(false);
  expect(await client.flush(), 'the service processed the frame before the barrier').toBe(true);
  return client.errorsFor(receipt.id).map((error) => error.code);
}

/** How many rows the whole `telemetry_events` table holds, across every session. */
function tableRowCount(): number {
  const row: unknown = current()
    .harness.store.statement('SELECT COUNT(*) AS count FROM telemetry_events')
    .get();
  if (!isRecord(row) || typeof row.count !== 'number') {
    throw new Error('The telemetry_events row count could not be read.');
  }
  return row.count;
}

/** Every column of every `telemetry_events` row as raw text: the stored side of the leak search. */
function tableText(): string {
  const rows: unknown[] = current().harness.store.statement('SELECT * FROM telemetry_events').all();
  return rows
    .map((row) =>
      isRecord(row)
        ? Object.values(row)
            .map((cell) => String(cell))
            .join('\t')
        : '',
    )
    .join('\n');
}

/** The raw columns of one stored event, or `undefined` when the table has no such row. */
interface RawRow {
  readonly ingestSeq: number;
  readonly sessionId: string;
  readonly captureId: string;
  readonly requestKey: string | null;
  readonly event: string;
}

/** Reads one row's raw columns by event id. */
function rawRow(id: string): RawRow | undefined {
  const row: unknown = current()
    .harness.store.statement(
      'SELECT ingest_seq, session_id, capture_id, request_key, event FROM telemetry_events WHERE id = ?',
    )
    .get(id);
  if (row === undefined) {
    return undefined;
  }
  if (
    !isRecord(row) ||
    typeof row.ingest_seq !== 'number' ||
    typeof row.session_id !== 'string' ||
    typeof row.capture_id !== 'string' ||
    typeof row.event !== 'string' ||
    (row.request_key !== null && typeof row.request_key !== 'string')
  ) {
    throw new Error(`The stored row of ${id} has an unexpected shape.`);
  }
  return {
    ingestSeq: row.ingest_seq,
    sessionId: row.session_id,
    captureId: row.capture_id,
    requestKey: row.request_key,
    event: row.event,
  };
}

/** The open capture's events as `TelemetryRepo` reads them back, keyed by id. */
function storedEvents(): ReadonlyMap<string, TelemetryEvent> {
  const { harness, sessionId } = current();
  const page = harness.repos.telemetry.listByCapture(sessionId, captureIdOf(), {
    limit: TELEMETRY_QUERY_MAX_LIMIT,
  });
  if (isErr(page)) {
    throw new Error(`TelemetryRepo refused the capture read: ${page.error.message}`);
  }
  expect(page.value.skipped, 'every stored row reconstructs as an event').toBeUndefined();
  return new Map(page.value.rows.map((event) => [event.id, event]));
}

/** One stored event, required. */
function requireStored(id: string): TelemetryEvent {
  const event = storedEvents().get(id);
  if (event === undefined) {
    throw new Error(`${id} was not persisted in the open capture.`);
  }
  return event;
}

/** Every event the DevTools client received on `telemetry.tail`, in arrival order. */
function tailedEvents(client: HarnessWsClient): TelemetryEvent[] {
  return client.received.flatMap((message) =>
    isMessageOfType(message, 'telemetry.tail') ? message.payload.events : [],
  );
}

/** Whether a message is a `telemetry.tail` frame. */
function isTailFrame(message: ProtocolMessage): boolean {
  return isMessageOfType(message, 'telemetry.tail');
}

/** The service log records the ingest module wrote, from index `from` on. */
function ingestRecords(from = 0): CapturedLogRecord[] {
  return current()
    .harness.logger.records.slice(from)
    .filter((record) => record.fields[SUBSYSTEM_FIELD] === INGEST_SUBSYSTEM);
}

/** The ingest module's batch-level drop records from index `from` on. */
function dropRecords(from = 0): CapturedLogRecord[] {
  return ingestRecords(from).filter((record) => typeof record.fields.reason === 'string');
}

/** The ingest module's per-batch summary records (counts only) from index `from` on. */
function summaryRecords(from = 0): CapturedLogRecord[] {
  return ingestRecords(from).filter(
    (record) =>
      typeof record.fields.inserted === 'number' && typeof record.fields.skipped === 'number',
  );
}

/** The reasons of the drop records from index `from` on. */
function dropReasonsSince(from: number): DropReason[] {
  return dropRecords(from).flatMap((record) => {
    const reason = record.fields.reason;
    return isDropReason(reason) ? [reason] : [];
  });
}

/**
 * Copies events with fresh identities — new event ids, span ids and one new
 * trace id — so a batch can be sent again without colliding with stored rows,
 * while every value the redactor judges stays exactly as substituted.
 */
function freshCopies(events: readonly TelemetryEventIngress[]): TelemetryEventIngress[] {
  const traceId = newTraceId();
  return events.map((event) => {
    // The new trace has no parent span, so the parent link is left out.
    const unparented = Object.fromEntries(
      Object.entries(event).filter(([key]) => key !== 'parentSpanId'),
    );
    return parseIngress(
      { ...unparented, id: newEventId(), spanId: newSpanId(), traceId },
      event.id,
    );
  });
}

/** Every leak haystack the service could have written a value to, labelled. */
function haystacks(): { readonly label: string; readonly text: string }[] {
  const { harness, devtools, editor, serverAgent } = current();
  return [
    { label: 'telemetry_events rows (every column)', text: tableText() },
    { label: 'telemetry.tail frames', text: JSON.stringify(devtools.received.filter(isTailFrame)) },
    {
      label: 'WebSocket frames received by every client, error replies included',
      text: [devtools, editor, serverAgent]
        .map((client) => JSON.stringify(client.received))
        .join('\n'),
    },
    { label: 'service log records', text: harness.logger.text() },
    { label: 'HTTP response bodies', text: httpBodies.join('\n') },
  ];
}

/** Fails naming every haystack a substituted value survived in. */
function expectNoSubstitutedMaterialAnywhere(): void {
  const leaks = haystacks().flatMap(({ label, text }) =>
    leakedTokens(text, SUBSTITUTIONS).map((token) => `${token} survived in ${label}`),
  );
  expect(leaks, 'redaction ran before every sink').toEqual([]);
}

/* -------------------------------------------------------------------------------------------------
 * Setup and teardown — one harness for the file
 * ---------------------------------------------------------------------------------------------- */

beforeAll(async () => {
  const harness = await startHarness();
  const projectRoot = harness.requireProject().root;

  const launched = recordResponse(await harness.launchDevServer(projectRoot));
  if (isErr(launched)) {
    throw new Error(`The stand-in dev server did not launch: ${launched.error.message}`);
  }

  const session = recordResponse(
    await harness.createSession({ projectRoot, question: 'Why is the report slow to load?' }),
  );
  const devServerUrl = session.devServerUrl;

  const { client: devtools, credential: devtoolsCredential } = await harness.connectDevtools({
    tabId: TAB_ID,
  });
  const bound = await harness.bindTab(devtools, {
    tabId: TAB_ID,
    url: devServerUrl,
    origin: new URL(devServerUrl).origin,
  });
  if (isErr(bound)) {
    throw new Error(`The tab was not bound (${bound.error.code}): ${bound.error.message}`);
  }

  // The page agent announces its document through the tab's connection, which
  // is what the readiness gate waits for before "Ready to capture".
  const ready = devtools.send('agent.ready', {
    tabId: TAB_ID,
    documentId: assemble('doc-', randomHex(8)),
    producerId: newProducerId(),
    url: devServerUrl,
    installedBeforeReact: true,
    reactDetected: true,
  });
  if (!(await devtools.flush()) || devtools.errorsFor(ready.id).length > 0) {
    throw new Error(`agent.ready was refused: ${devtools.describe()}`);
  }

  // The preload's credential is scoped to exactly this project; its control
  // connection is the server agent's presence for readiness.
  const serverToken = harness.issueServerAgentCredential(projectRoot).token;
  const serverAgent = await harness.ws({
    client: 'server-agent',
    projectRoot,
    token: serverToken,
  });
  const editor = await harness.editor(projectRoot);

  const settled = await harness.waitForSession(
    session.id,
    (record: SessionRecord) => record.status === 'ready' || record.status === 'failed',
  );
  if (settled.status !== 'ready') {
    throw new Error(`The session settled in "${settled.status}" instead of "ready".`);
  }

  suite = {
    harness,
    projectRoot,
    sessionId: session.id,
    devServerUrl,
    devtools,
    devtoolsCredential,
    editor,
    serverAgent,
    serverToken,
  };
});

afterAll(async () => {
  try {
    await suite?.harness.assertNoLeaks();
  } finally {
    // Substitution happened in memory only: the committed fixtures are unchanged.
    for (const [name, digest] of FIXTURE_DIGESTS) {
      expect(fixtureDigest(name), `${name} is byte-identical after the run`).toBe(digest);
    }
  }
});

/* -------------------------------------------------------------------------------------------------
 * The fixture contract
 * ---------------------------------------------------------------------------------------------- */

describe('the fixture contract', () => {
  it('pins the marker, the mask and the preview bound to the constants that own them', () => {
    expect(EXPECTED.markers).toEqual({
      redacted: REDACTION_MARKER,
      mask: REDACTION_MASK,
      maxPreviewLength: MAX_PREVIEW_LENGTH,
    });
  });

  it('declares every sentinel token of the input exactly once, each with at least one slot', () => {
    const declared = EXPECTED.sentinels.map((sentinel) => sentinel.token);
    const used = [...new Set(JSON.stringify(RAW_INPUT).match(SENTINEL_TOKEN_PATTERN) ?? [])].sort();

    expect(new Set(declared).size, 'no token is declared twice').toBe(declared.length);
    expect([...declared].sort()).toEqual(used);
    for (const token of declared) {
      expect(
        SENTINEL_SLOTS.some((slot) => slot.token === token),
        `${token} occupies a name or attribute slot`,
      ).toBe(true);
    }
  });

  it('has one expectation entry per input event, and no entry for an event it does not hold', () => {
    const expectedIds = EXPECTED.events.map((event) => event.id).sort();
    const inputIds = ORIGINAL_EVENTS.map((event) => event.id).sort();

    expect(expectedIds).toEqual(inputIds);
    expect(new Set(inputIds).size, 'input event ids are unique').toBe(inputIds.length);
  });

  it('references only input events in its request-key groups', () => {
    for (const tuple of [...EXPECTED.mustGroup, ...EXPECTED.mustNotGroup]) {
      for (const id of tuple) {
        expect(ORIGINAL_BY_ID.has(id), `${id} is an input event`).toBe(true);
      }
    }
  });

  it.each(SUBSTITUTIONS.map((substitution) => [substitution.spec.token, substitution] as const))(
    'substitutes run-time material for %s that matches its declared deny-list rule',
    (_token, substitution) => {
      const { spec, value, fingerprints } = substitution;

      if (spec.ruleId === null) {
        // Positional: removal holds for any material, so only its neutrality is checked.
        expect(findDeniedRules(value)).toEqual([]);
      } else if (POSITIONAL_RULES.has(spec.ruleId)) {
        expect(REDACTION_RULE_IDS).toContain(spec.ruleId);
      } else if (spec.ruleId === 'entropy') {
        expect(isHighEntropySecret(value), 'the material clears the entropy threshold').toBe(true);
      } else {
        expect(findDeniedRules(value), `the material matches ${spec.ruleId}`).toContain(
          spec.ruleId,
        );
      }

      expect(value).not.toMatch(SENTINEL_TOKEN_PATTERN);
      for (const fingerprint of fingerprints) {
        expect(
          fingerprint.length,
          'a fingerprint long enough to be unambiguous',
        ).toBeGreaterThanOrEqual(MIN_FINGERPRINT_LENGTH);
      }
      // Fresh per run: the committed fixture never holds the material.
      expect(JSON.stringify(RAW_INPUT)).not.toContain(value);
    },
  );

  it('validates the substituted batch through the strict ingress schema, which refuses service-assigned fields', () => {
    expect(SUBSTITUTED_EVENTS).toHaveLength(ORIGINAL_EVENTS.length);
    expect(JSON.stringify(SUBSTITUTED_EVENTS)).not.toMatch(SENTINEL_TOKEN_PATTERN);
    expect(BROWSER_EVENTS.length + SERVER_EVENTS.length).toBe(SUBSTITUTED_EVENTS.length);
    expect(BROWSER_EVENTS.length).toBeGreaterThan(0);
    expect(SERVER_EVENTS.length).toBeGreaterThan(0);

    for (const event of SUBSTITUTED_EVENTS) {
      for (const field of ['sessionId', 'captureId', 'ingestSeq']) {
        expect(Object.hasOwn(event, field), `${event.id} carries no ${field}`).toBe(false);
      }
      // A producer cannot supply the store's arrival number: the schema is strict.
      expect(isErr(parseTelemetryEventIngress({ ...event, ingestSeq: 1 }))).toBe(true);
    }
  });
});

/* -------------------------------------------------------------------------------------------------
 * Outside a capture window
 * ---------------------------------------------------------------------------------------------- */

describe('outside a capture window', () => {
  it('drops a bound tab batch and a scoped server batch under no-active-capture, storing nothing', async () => {
    const { harness, projectRoot, serverToken } = current();
    const rowsBefore = tableRowCount();
    const mark = harness.logger.records.length;

    const browserErrors = await relay(BROWSER_EVENTS);
    expect(browserErrors, 'a drop is an honest report, never an error').toEqual([]);

    const posted = await postIngest(serverToken, projectRoot, SERVER_EVENTS);
    expect(posted.status).toBe(202);
    expect(posted.json).toEqual({ accepted: 0, rejected: SERVER_EVENTS.length });

    expect(tableRowCount(), 'nothing was stored outside the capture window').toBe(rowsBefore);
    expect(dropReasonsSince(mark)).toEqual(['no-active-capture', 'no-active-capture']);
    expect(dropRecords(mark).map((record) => record.fields.received)).toEqual([
      BROWSER_EVENTS.length,
      SERVER_EVENTS.length,
    ]);
    expect(tailedEvents(current().devtools), 'nothing was tailed either').toEqual([]);
  });
});

/* -------------------------------------------------------------------------------------------------
 * Inside the capture window
 * ---------------------------------------------------------------------------------------------- */

/** Every id of the substituted batch. */
const BATCH_IDS: readonly string[] = SUBSTITUTED_EVENTS.map((event) => event.id);

/** The substituted batch's events whose kind carries a `request_key`. */
function requestEvents(): TelemetryEventIngress[] {
  return SUBSTITUTED_EVENTS.filter((event) => event.kind === 'fetch' || event.kind === 'xhr');
}

/** A string attribute of an ingress event, required. */
function stringAttribute(event: TelemetryEventIngress, key: string): string {
  const value = event.attributes[key];
  if (typeof value !== 'string') {
    throw new Error(`${event.id} carries no string "${key}" attribute.`);
  }
  return value;
}

/** The persisted `request_key` of one event: the column, which must equal the attribute. */
function storedRequestKey(id: string): string {
  const row = rawRow(id);
  expect(row, `${id} is stored`).toBeDefined();
  const key = row?.requestKey ?? undefined;
  if (key === undefined) {
    throw new Error(`${id} was stored without a request_key.`);
  }
  if (INGEST_REQUEST_KEY_ATTRIBUTE === undefined) {
    throw new Error('Ingest names no request_key attribute.');
  }
  expect(
    requireStored(id).attributes[INGEST_REQUEST_KEY_ATTRIBUTE],
    `${id} attribute = column`,
  ).toBe(key);
  return key;
}

/** The sentinel tokens a committed attribute slot holds. */
function tokensInSlot(eventId: string, key: string): string[] {
  const original = ORIGINAL_BY_ID.get(eventId);
  const resolved = original === undefined ? undefined : resolveAttribute(original.attributes, key);
  const texts = resolved?.found === true ? stringLeaves(resolved.value) : [];
  return [...new Set(texts.flatMap((text) => text.match(SENTINEL_TOKEN_PATTERN) ?? []))];
}

/** The substitutions of `tokens`. */
function substitutionsOf(tokens: readonly string[]): Substitution[] {
  return tokens.flatMap((token) => {
    const substitution = SUBSTITUTION_BY_TOKEN.get(token);
    return substitution === undefined ? [] : [substitution];
  });
}

/**
 * The interpreter of the closed assertion vocabulary: applies one fixture
 * assertion to the **persisted** event.
 */
function applyAttributeExpectation(
  expectation: AttributeExpectation,
  eventId: string,
  persisted: TelemetryEvent,
): void {
  const label = `${eventId} ${expectation.key} (${expectation.kind})`;
  const actual = resolveAttribute(persisted.attributes, expectation.key);
  const input = SUBSTITUTED_BY_ID.get(eventId);
  const sent =
    input === undefined ? undefined : resolveAttribute(input.attributes, expectation.key);

  switch (expectation.kind) {
    case 'absent':
      expect(actual.found, label).toBe(false);
      return;
    case 'equals':
      expect(actual.found, label).toBe(true);
      expect(actual.value, label).toEqual(expectation.argument);
      return;
    case 'marker':
      expect(actual.value, label).toBe(REDACTION_MARKER);
      return;
    case 'mask': {
      const tokens = tokensInSlot(eventId, expectation.key);
      expect(typeof actual.value, label).toBe('string');
      expect(String(actual.value), label).toContain(REDACTION_MASK);
      expect(leakedTokens(JSON.stringify(actual.value), substitutionsOf(tokens)), label).toEqual(
        [],
      );
      return;
    }
    case 'unchanged':
      expect(sent?.found, `${label}: the input holds the key`).toBe(true);
      expect(actual.found, label).toBe(true);
      expect(actual.value, label).toEqual(sent?.value);
      return;
    case 'maxLength': {
      const bound = Number(expectation.argument);
      const strings = stringLeaves(actual.value);
      expect(actual.found, label).toBe(true);
      expect(strings.length, `${label}: the value holds text`).toBeGreaterThan(0);
      for (const text of strings) {
        expect(codePointLength(text), label).toBeLessThanOrEqual(bound);
      }
      return;
    }
    case 'excludesSubstitutedSentinel': {
      const tokens = tokensInSlot(eventId, expectation.key);
      expect(tokens.length, `${label}: the committed slot holds a sentinel`).toBeGreaterThan(0);
      expect(actual.found, label).toBe(true);
      expect(leakedTokens(JSON.stringify(actual.value), substitutionsOf(tokens)), label).toEqual(
        [],
      );
      return;
    }
    case 'elementCount': {
      const count = Number(expectation.argument);
      expect(Array.isArray(sent?.value) ? sent.value.length : -1, `${label}: input length`).toBe(
        count,
      );
      expect(Array.isArray(actual.value), label).toBe(true);
      const elements: unknown[] = Array.isArray(actual.value) ? actual.value : [];
      expect(elements, label).toHaveLength(count);
      for (const element of elements) {
        expect(element, label).toBe(REDACTION_MARKER);
      }
      return;
    }
  }
}

/** The persisted event minus what attribution and the store add, for an unchanged-event comparison. */
function withoutServiceFields(event: TelemetryEvent, keepSource: boolean): unknown {
  // `sessionId` and `captureId` come from attribution and `ingestSeq` from the
  // store; `source` may be placed by the ingest locator when the producer sent none.
  const omitted = new Set([
    'sessionId',
    'captureId',
    'ingestSeq',
    ...(keepSource ? [] : ['source']),
  ]);
  const kept = Object.fromEntries(Object.entries(event).filter(([key]) => !omitted.has(key)));
  const attributes = Object.fromEntries(
    Object.entries(event.attributes).filter(([key]) => key !== INGEST_REQUEST_KEY_ATTRIBUTE),
  );
  return { ...kept, attributes };
}

describe('inside the capture window', () => {
  /** The arrival order of the redaction batch: browser frame first, then the server request. */
  let arrival: readonly string[] = [];

  beforeAll(async () => {
    const { harness, sessionId, projectRoot, serverToken, devtools } = current();

    const started = recordResponse(await harness.startCapture(sessionId));
    if (isErr(started)) {
      throw new Error(
        `The capture did not start (${started.error.code}): ${started.error.message}`,
      );
    }
    openCaptureId = started.value.captureId;

    // The real paths: the page agent's share over the bound tab's WebSocket,
    // the preload's share over HTTP under its scoped credential.
    const browserErrors = await relay(BROWSER_EVENTS);
    if (browserErrors.length > 0) {
      throw new Error(`The browser batch was refused: ${browserErrors.join(', ')}`);
    }
    const posted = await postIngest(serverToken, projectRoot, SERVER_EVENTS);
    if (posted.status !== 202) {
      throw new Error(`The server batch was answered ${String(posted.status)}.`);
    }
    arrival = [...BROWSER_EVENTS, ...SERVER_EVENTS].map((event) => event.id);

    // The tail coalesces; wait until every event of the batch has been delivered.
    await devtools.until(
      () => {
        const tailed = new Set(tailedEvents(devtools).map((event) => event.id));
        return BATCH_IDS.every((id) => tailed.has(id)) ? true : undefined;
      },
      HARNESS_TIMEOUTS.capture,
      () => `The tail did not deliver the whole batch: ${devtools.describe()}`,
    );
  });

  describe('redaction before persistence', () => {
    it('persists every event, attributed to the bound session and its open capture', () => {
      const { sessionId } = current();
      const stored = storedEvents();

      expect([...stored.keys()].sort()).toEqual([...BATCH_IDS].sort());
      for (const id of BATCH_IDS) {
        const row = rawRow(id);
        expect(row?.sessionId, `${id} session_id`).toBe(sessionId);
        expect(row?.captureId, `${id} capture_id`).toBe(captureIdOf());
        expect(stored.get(id)?.sessionId).toBe(sessionId);
        expect(stored.get(id)?.captureId).toBe(captureIdOf());
      }
    });

    it.each(EXPECTED.events.map((expectation) => [expectation.id, expectation] as const))(
      '%s satisfies every fixture assertion as persisted',
      (id, expectation) => {
        const persisted = requireStored(id);
        const input = SUBSTITUTED_BY_ID.get(id);

        if (expectation.redactedMarker) {
          expect(persisted.redacted, `${id} carries a non-empty redacted path list`).toEqual(
            expect.arrayContaining([expect.any(String)]),
          );
        } else {
          expect(persisted.redacted, `${id} was not touched by the redactor`).toBeUndefined();
        }

        for (const key of expectation.absentAttributes) {
          expect(
            input === undefined ? false : resolveAttribute(input.attributes, key).found,
            `${id} ${key} was sent`,
          ).toBe(true);
          expect(resolveAttribute(persisted.attributes, key).found, `${id} ${key} is dropped`).toBe(
            false,
          );
        }

        for (const attributeExpectation of expectation.attributes) {
          applyAttributeExpectation(attributeExpectation, id, persisted);
        }
      },
    );

    it.each(SUBSTITUTIONS.map((substitution) => [substitution.spec.token, substitution] as const))(
      'collapses every slot of %s to its declared fate',
      (token, substitution) => {
        const slots = SENTINEL_SLOTS.filter((slot) => slot.token === token);
        expect(slots.length).toBeGreaterThan(0);

        for (const slot of slots) {
          const label = `${token} at ${slot.eventId} ${describePath(slot.path)}`;
          const dropped =
            EXPECTED.events
              .find((event) => event.id === slot.eventId)
              ?.absentAttributes.includes(String(slot.path[1])) === true;
          const resolved = walk(requireStored(slot.eventId), slot.path);
          if (dropped) {
            expect(resolved.found, `${label} is dropped with its key`).toBe(false);
            continue;
          }

          expect(resolved.found, `${label} still exists`).toBe(true);
          expect(typeof resolved.value, label).toBe('string');
          const text = String(resolved.value);
          expect(leakedTokens(JSON.stringify(text), [substitution]), label).toEqual([]);

          switch (substitution.spec.fate) {
            case 'marker':
              if (slot.template === token) {
                expect(text, label).toBe(REDACTION_MARKER);
              } else {
                expect(text, label).toContain(REDACTION_MARKER);
              }
              break;
            case 'mask':
              expect(text, label).toContain(REDACTION_MASK);
              break;
            case 'scrubbed': {
              // Replaced in place: the text around a lone token survives.
              const tokenCount = slot.template.match(SENTINEL_TOKEN_PATTERN)?.length ?? 0;
              if (tokenCount === 1) {
                for (const fragment of slot.template.split(token)) {
                  if (fragment.trim().length > 0) {
                    expect(text, `${label} keeps its surrounding text`).toContain(fragment);
                  }
                }
              }
              break;
            }
          }
        }
      },
    );

    it('passes an event the redactor has nothing to do for through unchanged', () => {
      const untouched = EXPECTED.events.filter((expectation) => !expectation.redactedMarker);
      expect(untouched.length, 'the fixture declares at least one benign event').toBeGreaterThan(0);

      for (const { id } of untouched) {
        const input = SUBSTITUTED_BY_ID.get(id);
        const persisted = requireStored(id);
        expect(input, `${id} was sent`).toBeDefined();
        expect(withoutServiceFields(persisted, input?.source !== undefined), id).toEqual(input);
      }
    });

    it('round-trips every start time and duration exactly, sub-millisecond part included', () => {
      for (const event of SUBSTITUTED_EVENTS) {
        const persisted = requireStored(event.id);
        expect(Object.is(persisted.startTime, event.startTime), `${event.id} startTime`).toBe(true);
        expect(Object.is(persisted.duration, event.duration), `${event.id} duration`).toBe(true);
      }
      expect(
        SUBSTITUTED_EVENTS.some((event) => !Number.isInteger(event.startTime)),
        'the batch exercises fractional milliseconds',
      ).toBe(true);
    });

    it('proves the order by outcome: no substituted material survives in any row, frame, record or body', () => {
      const { devtools } = current();
      // Non-vacuity: every value really was sent on the transport that carried its event.
      const sent = [JSON.stringify(devtools.sent), ...postedBodies].join('\n');
      expect(leakedTokens(sent, SUBSTITUTIONS).sort()).toEqual(
        SUBSTITUTIONS.map((substitution) => substitution.spec.token).sort(),
      );

      expectNoSubstitutedMaterialAnywhere();
    });

    it('tails to the DevTools client only, every tailed event a persisted event of the session equal to its row', () => {
      const { devtools, editor, serverAgent, sessionId } = current();
      expect(TAIL_CLIENT_KINDS).toEqual(['devtools']);

      const tailed = tailedEvents(devtools);
      const stored = storedEvents();
      expect(tailed.length).toBeGreaterThanOrEqual(BATCH_IDS.length);
      for (const event of tailed) {
        const parsed = parseTelemetryEvent(event);
        expect(isErr(parsed), `${event.id} parses as a persisted event`).toBe(false);
        expect(event.sessionId).toBe(sessionId);
        expect(Number.isSafeInteger(event.ingestSeq) && event.ingestSeq >= 1).toBe(true);
        expect(event, `${event.id} as tailed equals its stored row`).toEqual(stored.get(event.id));
      }
      for (const expectation of EXPECTED.events) {
        const copy = tailed.find((event) => event.id === expectation.id);
        expect(
          (copy?.redacted?.length ?? 0) > 0,
          `${expectation.id} carries its redaction record on the tail`,
        ).toBe(expectation.redactedMarker);
      }

      expect(editor.received.filter(isTailFrame), 'the editor never receives the tail').toEqual([]);
      expect(serverAgent.received.filter(isTailFrame), 'the preload never receives it').toEqual([]);
    });
  });

  describe('request_key from the unredacted URL', () => {
    it('keys every request-kind event and nothing else', () => {
      for (const event of SUBSTITUTED_EVENTS) {
        const row = rawRow(event.id);
        if (event.kind === 'fetch' || event.kind === 'xhr') {
          expect(storedRequestKey(event.id)).toMatch(/^[0-9a-f]{64}$/u);
        } else {
          expect(row?.requestKey, `${event.id} is not a request`).toBeNull();
        }
      }
    });

    it('collides byte-identical requests and separates requests differing only in a query value', () => {
      for (const tuple of EXPECTED.mustGroup) {
        const keys = tuple.map(storedRequestKey);
        expect(new Set(keys).size, `${tuple.join(' + ')} share one key`).toBe(1);
      }
      for (const tuple of EXPECTED.mustNotGroup) {
        const keys = tuple.map(storedRequestKey);
        expect(new Set(keys).size, `${tuple.join(' + ')} keep distinct keys`).toBe(tuple.length);
        // …although they are stored, and would be displayed, identically.
        const urls = tuple.map((id) => requireStored(id).attributes.url);
        expect(new Set(urls).size, `${tuple.join(' + ')} share a masked URL`).toBe(1);
      }
    });

    it('is the digest of the unredacted URL, and never the digest of the masked one', async () => {
      const { harness, sessionId } = current();
      const secret = harness.repos.sessions.getOrCreateRequestKeySecret(sessionId);
      if (isErr(secret)) {
        throw new Error(`The session secret could not be read: ${secret.error.message}`);
      }
      const hasher = createRequestKeyHasher(secret.value);
      if (isErr(hasher)) {
        throw new Error(`The hasher refused the session secret: ${hasher.error.message}`);
      }

      const maskedDigests = new Map<string, string>();
      for (const event of requestEvents()) {
        const method = stringAttribute(event, 'http.method');
        const unredacted = stringAttribute(event, 'url');
        const masked = requireStored(event.id).attributes.url;
        if (typeof masked !== 'string') {
          throw new Error(`${event.id} was stored without a URL.`);
        }
        if (unredacted.includes('?')) {
          expect(masked, `${event.id} was stored with its query values masked`).not.toBe(
            unredacted,
          );
        }

        const fromUnredacted = await hasher.value.compute(method, unredacted);
        const fromMasked = await hasher.value.compute(method, masked);
        if (isErr(fromUnredacted) || isErr(fromMasked)) {
          throw new Error(`${event.id}: a digest could not be computed.`);
        }
        const stored = storedRequestKey(event.id);
        expect(stored, `${event.id} key = HMAC(unredacted)`).toBe(fromUnredacted.value);
        if (masked !== unredacted) {
          // The assertion an inverted pipeline fails: a post-mask key looks plausible but differs.
          expect(stored, `${event.id} key ≠ HMAC(masked)`).not.toBe(fromMasked.value);
        }
        maskedDigests.set(event.id, fromMasked.value);
      }

      // Had the key been taken after masking, the different-parameter controls would have merged.
      for (const tuple of EXPECTED.mustNotGroup) {
        expect(new Set(tuple.map((id) => maskedDigests.get(id))).size).toBe(1);
      }
    });

    it('keeps the per-session secret inside the store: no response, frame, record, row or record field carries it', async () => {
      const { harness, sessionId } = current();
      const secret = harness.repos.sessions.getOrCreateRequestKeySecret(sessionId);
      if (isErr(secret)) {
        throw new Error(`The session secret could not be read: ${secret.error.message}`);
      }
      expect(secret.value).toMatch(REQUEST_KEY_SESSION_KEY_PATTERN);

      const fetched = await harness.rawFetch({
        operation: 'session.get',
        params: { id: sessionId },
      });
      httpBodies.push(fetched.text);
      expect(fetched.status).toBe(200);
      expect(isRecord(fetched.json) ? fetched.json.id : undefined).toBe(sessionId);
      expect(fetched.text, 'the serialized SessionRecord').not.toContain(secret.value);

      for (const { label, text } of haystacks()) {
        expect(text.includes(secret.value), `the session secret is absent from ${label}`).toBe(
          false,
        );
      }
    });

    it('forms the duplicate group end to end through the requests panel-data source', async () => {
      const { harness, sessionId } = current();
      const answered = recordResponse(
        await harness.http().request('panel.data', {
          params: { id: sessionId },
          body: { source: 'requests' },
        }),
      );
      if (isErr(answered)) {
        throw new Error(
          `panel.data was refused (${answered.error.code}): ${answered.error.message}`,
        );
      }
      const result = answered.value;
      if (result.source !== 'requests') {
        throw new Error(`panel.data answered the "${result.source}" source.`);
      }
      const groupOf = (id: string) => {
        const key = storedRequestKey(id);
        const group = result.requests.find((candidate) => candidate.requestKey === key);
        expect(group, `${id} has a request group`).toBeDefined();
        return group;
      };

      for (const tuple of EXPECTED.mustGroup) {
        const [first] = tuple;
        const group = first === undefined ? undefined : groupOf(first);
        expect(group?.count, `${tuple.join(' + ')} form one group`).toBe(tuple.length);
        expect(group?.url).toBe(
          first === undefined ? undefined : requireStored(first).attributes.url,
        );
        const starts = tuple.map((id) => requireStored(id).startTime);
        if (Math.max(...starts) - Math.min(...starts) <= DEFAULT_DUPLICATE_WINDOW_MS) {
          expect(group?.hasDuplicates, 'a burst inside the duplicate window').toBe(true);
          expect(group?.duplicateCount).toBe(tuple.length - 1);
        }
      }
      for (const tuple of EXPECTED.mustNotGroup) {
        const groups = tuple.map(groupOf);
        expect(
          new Set(groups.map((group) => group?.id)).size,
          `${tuple.join(' + ')} are separate`,
        ).toBe(tuple.length);
        expect(new Set(groups.map((group) => group?.url)).size, 'under one displayed URL').toBe(1);
      }
    });
  });

  describe('ingestSeq', () => {
    it('is assigned by the store and strictly increases across batches and across both producers', () => {
      const stored = storedEvents();
      const sequence = arrival.map((id) => stored.get(id)?.ingestSeq ?? Number.NaN);

      expect(sequence.every((value) => Number.isSafeInteger(value) && value >= 1)).toBe(true);
      for (let index = 1; index < sequence.length; index += 1) {
        expect(
          (sequence[index] ?? Number.NaN) > (sequence[index - 1] ?? Number.NaN),
          `${arrival[index] ?? ''} arrived after ${arrival[index - 1] ?? ''}`,
        ).toBe(true);
      }
      for (const id of arrival) {
        expect(rawRow(id)?.ingestSeq, `${id} column = document field`).toBe(
          stored.get(id)?.ingestSeq,
        );
      }
    });

    it('treats a replayed batch as idempotent: no new row, no new arrival number, reported as skipped', async () => {
      const { harness, projectRoot, serverToken } = current();
      const before = new Map([...storedEvents()].map(([id, event]) => [id, event.ingestSeq]));
      const rowsBefore = tableRowCount();
      const mark = harness.logger.records.length;

      expect(await relay(BROWSER_EVENTS), 'the reconnecting agent replay is not an error').toEqual(
        [],
      );
      const posted = await postIngest(serverToken, projectRoot, SERVER_EVENTS);
      expect(posted.status).toBe(202);
      expect(posted.json).toEqual({ accepted: SERVER_EVENTS.length });

      expect(tableRowCount()).toBe(rowsBefore);
      const after = new Map([...storedEvents()].map(([id, event]) => [id, event.ingestSeq]));
      expect(after).toEqual(before);

      const summaries = summaryRecords(mark).map((record) => ({
        inserted: record.fields.inserted,
        skipped: record.fields.skipped,
      }));
      expect(summaries).toEqual([
        { inserted: 0, skipped: BROWSER_EVENTS.length },
        { inserted: 0, skipped: SERVER_EVENTS.length },
      ]);
    });

    it('orders two producers sharing a start time deterministically: startTime, producerId/seq, then ingestSeq', async () => {
      const { harness, projectRoot, serverToken, sessionId } = current();
      const traceId = newTraceId();
      const startTime =
        Math.max(...SUBSTITUTED_EVENTS.map((event) => event.startTime)) + 1_000.123_456_7;
      const duration = 1.000_000_1;
      // Producer ids chosen so the canonical order is NOT the arrival order.
      const pageProducer = assemble('prd_', 'z', randomHex(8));
      const serverProducer = assemble('prd_', 'a', randomHex(8));
      const tieProducer = assemble('prd_', 'm', randomHex(8));

      const pageEvent = parseIngress(
        {
          id: newEventId(),
          traceId,
          spanId: newSpanId(),
          kind: 'perf.longtask',
          name: 'longtask',
          startTime,
          duration,
          tier: 'browser',
          attributes: { attribution: 'window', blockingTime: 0.5 },
          status: 'unset',
          producerId: pageProducer,
          seq: 0,
        },
        'tie probe (page)',
      );
      const serverEvent = (producerId: string, seq: number, message: string) =>
        parseIngress(
          {
            id: newEventId(),
            traceId,
            spanId: newSpanId(),
            kind: 'log',
            name: message,
            startTime,
            duration,
            tier: 'server',
            attributes: { 'log.level': 'info', 'log.message': message, 'logger.name': 'probe' },
            status: 'unset',
            producerId,
            seq,
          },
          `tie probe (${message})`,
        );
      // Sent seq 1 before seq 0, and two events tied on everything but arrival.
      const serverBatch = [
        serverEvent(serverProducer, 1, 'second by seq'),
        serverEvent(serverProducer, 0, 'first by seq'),
        serverEvent(tieProducer, 7, 'tied, arrived first'),
        serverEvent(tieProducer, 7, 'tied, arrived second'),
      ];

      expect(await relay([pageEvent])).toEqual([]);
      const posted = await postIngest(serverToken, projectRoot, serverBatch);
      expect(posted.json).toEqual({ accepted: serverBatch.length });

      const read = () => {
        const page = harness.repos.telemetry.listByTrace(sessionId, traceId, {
          captureId: captureIdOf(),
        });
        if (isErr(page)) {
          throw new Error(`listByTrace refused: ${page.error.message}`);
        }
        return page.value.rows;
      };
      const rows = read();
      const byArrival = [...rows].sort((left, right) => left.ingestSeq - right.ingestSeq);
      expect(byArrival.map((event) => event.id)).toEqual(
        [pageEvent, ...serverBatch].map((e) => e.id),
      );

      const canonical = [...rows].sort(
        (left, right) =>
          left.startTime - right.startTime ||
          (left.producerId < right.producerId ? -1 : left.producerId > right.producerId ? 1 : 0) ||
          left.seq - right.seq ||
          left.ingestSeq - right.ingestSeq,
      );
      expect(
        rows.map((event) => event.id),
        'the store reads the canonical order',
      ).toEqual(canonical.map((event) => event.id));
      expect(rows.map((event) => event.name)).toEqual([
        'first by seq',
        'second by seq',
        'tied, arrived first',
        'tied, arrived second',
        'longtask',
      ]);
      expect(
        read().map((event) => event.id),
        'and reads it again identically',
      ).toEqual(rows.map((event) => event.id));
      for (const event of rows) {
        expect(Object.is(event.startTime, startTime), `${event.id} startTime`).toBe(true);
        expect(Object.is(event.duration, duration), `${event.id} duration`).toBe(true);
      }
    });
  });

  describe('one credential, one multiplexing connection, two tabs', () => {
    /** What the second tab's setup establishes. */
    interface SecondTab {
      /** A connection of the shared credential whose hello names no tab, as the MV3 worker opens it. */
      readonly mux: HarnessWsClient;
      /** The session of another project, bound to {@link SECOND_TAB_ID}. */
      readonly sessionId: string;
      /** That session's open capture. */
      readonly captureId: string;
    }

    let second: SecondTab | undefined;

    /** The second tab's state, or a failure naming the setup that did not run. */
    function secondOf(): SecondTab {
      if (second === undefined) {
        throw new Error('The second tab was not set up.');
      }
      return second;
    }

    /** Requires that none of `batch` was stored, in any session. */
    function expectNoneStored(batch: readonly TelemetryEventIngress[]): void {
      for (const event of batch) {
        expect(rawRow(event.id), `${event.id} was not stored`).toBeUndefined();
      }
    }

    beforeAll(async () => {
      const { harness, devtoolsCredential } = current();
      // Captures are exclusive per project, so the second tab's session belongs
      // to a copy of its own, readied and captured exactly like the first.
      const other = await harness.copyFixtureProject();
      const launched = recordResponse(await harness.launchDevServer(other.root));
      if (isErr(launched)) {
        throw new Error(`The second dev server did not launch: ${launched.error.message}`);
      }
      const session = recordResponse(
        await harness.createSession({
          projectRoot: other.root,
          question: 'Why is the report slow to load?',
        }),
      );

      // Exactly like the MV3 service worker: the credential the first tab's
      // connection presented, a hello naming no tab, every frame naming its own.
      const mux = await harness.ws({
        client: 'devtools',
        token: devtoolsCredential.token,
        origin: devtoolsCredential.origin,
      });
      if (!mux.authenticated || mux.identity.tabId !== undefined) {
        throw new Error(`The multiplexing connection was not accepted: ${mux.describe()}`);
      }
      const bound = await harness.bindTab(mux, {
        tabId: SECOND_TAB_ID,
        url: session.devServerUrl,
        origin: new URL(session.devServerUrl).origin,
      });
      if (isErr(bound)) {
        throw new Error(
          `The second tab was not bound (${bound.error.code}): ${bound.error.message}`,
        );
      }
      const ready = mux.send(
        'agent.ready',
        {
          tabId: SECOND_TAB_ID,
          documentId: assemble('doc-', randomHex(8)),
          producerId: newProducerId(),
          url: session.devServerUrl,
          installedBeforeReact: true,
          reactDetected: true,
        },
        { tabId: SECOND_TAB_ID },
      );
      if (!(await mux.flush()) || mux.errorsFor(ready.id).length > 0) {
        throw new Error(`agent.ready for the second tab was refused: ${mux.describe()}`);
      }
      await harness.ws({
        client: 'server-agent',
        projectRoot: other.root,
        token: harness.issueServerAgentCredential(other.root).token,
      });
      await harness.editor(other.root);

      const settled = await harness.waitForSession(
        session.id,
        (record: SessionRecord) => record.status === 'ready' || record.status === 'failed',
      );
      if (settled.status !== 'ready') {
        throw new Error(`The second session settled in "${settled.status}" instead of "ready".`);
      }
      const started = recordResponse(await harness.startCapture(session.id));
      if (isErr(started)) {
        throw new Error(
          `The second capture did not start (${started.error.code}): ${started.error.message}`,
        );
      }
      second = { mux, sessionId: session.id, captureId: started.value.captureId };
    });

    it('refuses a frame naming no tab on a connection whose hello named none, storing nothing', async () => {
      const { harness } = current();
      const rowsBefore = tableRowCount();
      const mark = harness.logger.records.length;
      const batch = freshCopies(BROWSER_EVENTS);

      expect(
        await relayAs(secondOf().mux, batch, {}),
        'never the connection’s "primary" tab',
      ).toEqual(['TAB_NOT_BOUND']);
      expect(tableRowCount()).toBe(rowsBefore);
      expect(dropRecords(mark), 'refused before ingest: no drop is recorded').toEqual([]);
      expectNoneStored(batch);
    });

    it('stores a frame under the capture of the tab it names, and none of it under the other tab’s', async () => {
      const { sessionId } = current();
      const { mux, sessionId: secondSession, captureId: secondCapture } = secondOf();

      const toSecond = freshCopies(BROWSER_EVENTS);
      expect(await relayAs(mux, toSecond, { tabId: SECOND_TAB_ID })).toEqual([]);
      const firstCapture = storedEvents();
      for (const event of toSecond) {
        expect(rawRow(event.id), `${event.id} belongs to the second tab's capture`).toMatchObject({
          sessionId: secondSession,
          captureId: secondCapture,
        });
        expect(firstCapture.has(event.id), `${event.id} is not in the first tab's capture`).toBe(
          false,
        );
      }

      // The same connection acting for the first tab reaches the first tab's capture.
      const toFirst = freshCopies(BROWSER_EVENTS);
      expect(await relayAs(mux, toFirst, { tabId: TAB_ID })).toEqual([]);
      for (const event of toFirst) {
        expect(rawRow(event.id), `${event.id} belongs to the first tab's capture`).toMatchObject({
          sessionId,
          captureId: captureIdOf(),
        });
      }
    });

    it('refuses a frame whose session routing key is not its tab’s binding, storing nothing', async () => {
      const { sessionId } = current();
      const rowsBefore = tableRowCount();
      const batch = freshCopies(BROWSER_EVENTS);

      expect(
        await relayAs(secondOf().mux, batch, { tabId: SECOND_TAB_ID, sessionId }),
        'a stale key is never re-attributed to the tab’s current session',
      ).toEqual(['TAB_NOT_BOUND']);
      expect(tableRowCount()).toBe(rowsBefore);
      expectNoneStored(batch);
    });

    it('refuses a single-tab connection naming another tab, storing nothing', async () => {
      const { devtools } = current();
      const rowsBefore = tableRowCount();
      const batch = freshCopies(BROWSER_EVENTS);

      expect(
        await relayAs(devtools, batch, { tabId: SECOND_TAB_ID }),
        'a connection that announced a tab acts only for that tab',
      ).toEqual(['TAB_NOT_BOUND']);
      expect(tableRowCount()).toBe(rowsBefore);
      expectNoneStored(batch);
    });

    it('refuses another credential naming a tab this credential bound, storing nothing', async () => {
      const { harness } = current();
      const stranger = harness.issueDevtoolsCredential();
      const foreign = await harness.ws({
        client: 'devtools',
        token: stranger.token,
        origin: stranger.origin,
      });
      const rowsBefore = tableRowCount();
      const batch = freshCopies(BROWSER_EVENTS);

      for (const tabId of [TAB_ID, SECOND_TAB_ID]) {
        expect(await relayAs(foreign, batch, { tabId }), `tab ${String(tabId)}`).toEqual([
          'TAB_NOT_BOUND',
        ]);
      }
      expect(tableRowCount()).toBe(rowsBefore);
      expectNoneStored(batch);
    });
  });

  describe('attribution and refusals', () => {
    it('refuses a batch naming another project, a descendant or a prefix sibling, storing nothing', async () => {
      const { harness, projectRoot, serverToken } = current();
      const other = await harness.copyFixtureProject();
      const rowsBefore = tableRowCount();
      const batch = freshCopies(SERVER_EVENTS);

      for (const claimed of [other.root, `${projectRoot}/src`, `${projectRoot}-sibling`]) {
        const posted = await postIngest(serverToken, claimed, batch);
        expect(posted.status, `a batch claiming ${claimed} is an authorization refusal`).toBe(403);
        expect(isRecord(posted.json) ? posted.json.code : undefined).toBe('PATH_OUTSIDE_PROJECT');
      }
      expect(tableRowCount()).toBe(rowsBefore);
      for (const event of batch) {
        expect(rawRow(event.id), `${event.id} was not stored`).toBeUndefined();
      }
    });

    it('takes the scope from the credential, never the body: another project stores nothing in this capture', async () => {
      const { harness } = current();
      const other = await harness.copyFixtureProject();
      const otherToken = harness.issueServerAgentCredential(other.root).token;
      const rowsBefore = tableRowCount();
      const mark = harness.logger.records.length;
      const batch = freshCopies(SERVER_EVENTS);

      // Self-consistent claim, but that project holds no capture: this session's
      // open window is not reachable through a credential scoped elsewhere.
      const posted = await postIngest(otherToken, other.root, batch);
      expect(posted.status).toBe(202);
      expect(posted.json).toEqual({ accepted: 0, rejected: batch.length });
      expect(dropReasonsSince(mark)).toEqual(['no-active-capture']);
      expect(tableRowCount()).toBe(rowsBefore);
    });

    it('drops, per event, a tier its producer may not report', async () => {
      const { harness, projectRoot, serverToken } = current();
      const rowsBefore = tableRowCount();
      const mark = harness.logger.records.length;
      const [forgedByPage] = freshCopies(SERVER_EVENTS.filter((event) => event.tier === 'db'));
      const [forgedByServer] = freshCopies(BROWSER_EVENTS.slice(0, 1));
      if (forgedByPage === undefined || forgedByServer === undefined) {
        throw new Error('The batch holds no database-tier or browser-tier event to forge.');
      }

      expect(await relay([forgedByPage]), 'a page cannot report a database span').toEqual([]);
      const posted = await postIngest(serverToken, projectRoot, [forgedByServer]);
      expect(posted.json, 'a dev server cannot report a browser event').toEqual({
        accepted: 0,
        rejected: 1,
      });

      expect(tableRowCount()).toBe(rowsBefore);
      expect(
        summaryRecords(mark).map((record) => [record.fields.dropped, record.fields.persisted]),
      ).toEqual([
        [1, 0],
        [1, 0],
      ]);
      expect(DROP_REASONS).toContain('tier-not-permitted');
    });

    it('refuses a batch over the transport ceiling on both transports, storing nothing', async () => {
      const { projectRoot, serverToken } = current();
      expect(MAX_INGEST_BATCH).toBeGreaterThan(0);
      const rowsBefore = tableRowCount();
      const oversize = (template: TelemetryEventIngress): TelemetryEventIngress[] =>
        Array.from({ length: MAX_INGEST_BATCH + 1 }, (_, seq) => ({
          ...template,
          id: newEventId(),
          spanId: newSpanId(),
          seq,
        }));
      const [pageTemplate] = freshCopies(
        BROWSER_EVENTS.filter((event) => event.kind === 'perf.longtask'),
      );
      const [serverTemplate] = freshCopies(
        SERVER_EVENTS.filter((event) => event.kind === 'db.query'),
      );
      if (pageTemplate === undefined || serverTemplate === undefined) {
        throw new Error('The batch holds no template event for the over-size cases.');
      }

      expect(await relay(oversize(pageTemplate)), 'the frame is refused whole').toEqual([
        'PROTOCOL_INVALID_MESSAGE',
      ]);
      const posted = await postIngest(serverToken, projectRoot, oversize(serverTemplate));
      expect(posted.status, 'the request is refused whole').toBe(400);
      expect(isRecord(posted.json) ? posted.json.code : undefined).toBe('PROTOCOL_INVALID_MESSAGE');

      expect(tableRowCount(), 'never truncated, never partially stored').toBe(rowsBefore);
    });

    it('refuses a batch from a tab whose binding ended with TAB_NOT_BOUND, storing nothing', async () => {
      const { harness, devtools } = current();
      const unbind = devtools.send('session.unbind', { tabId: TAB_ID });
      expect(await devtools.flush()).toBe(true);
      expect(devtools.errorsFor(unbind.id)).toEqual([]);
      const binding = harness.repos.sessions.getBindingByTab(TAB_ID);
      expect(isErr(binding) ? 'unreadable' : binding.value, 'the binding is gone').toBeUndefined();

      const rowsBefore = tableRowCount();
      const mark = harness.logger.records.length;
      const batch = freshCopies(BROWSER_EVENTS);

      // No live binding means no session to attribute to: the frame is refused
      // whole before ingest, so no drop record is written for it either.
      expect(await relay(batch)).toEqual(['TAB_NOT_BOUND']);
      expect(dropRecords(mark)).toEqual([]);
      expect(tableRowCount()).toBe(rowsBefore);
      for (const event of batch) {
        expect(rawRow(event.id), `${event.id} was not stored`).toBeUndefined();
      }
    });

    it('reports every drop as a count under the closed DROP_REASONS vocabulary, never as event content', () => {
      const drops = dropRecords();
      const observed = new Set(drops.map((record) => record.fields.reason));
      // A relayed frame whose tab has no live binding is refused by the route
      // before ingest runs, so the only drops this file provokes are the
      // out-of-window and out-of-scope ones.
      expect([...observed].sort()).toEqual(['no-active-capture']);

      // Content a drop record must never carry: names, trace ids and every
      // string value the batches held.
      const content = [
        ...new Set(
          SUBSTITUTED_EVENTS.flatMap((event) => [
            event.name,
            event.traceId,
            ...stringLeaves(event.attributes),
          ]).filter((text) => text.length >= 8),
        ),
      ];
      for (const record of drops) {
        expect(isDropReason(record.fields.reason), record.line).toBe(true);
        expect(DROP_REASONS).toContain(record.fields.reason);
        expect(typeof record.fields.received, 'the drop is a count').toBe('number');
        expect(
          content.filter((text) => record.line.includes(text)),
          'no event content',
        ).toEqual([]);
      }
    });

    it('leaves no substituted material anywhere after every path ran', () => {
      expectNoSubstitutedMaterialAnywhere();
    });
  });
});

/* -------------------------------------------------------------------------------------------------
 * Loss-only reports
 * ---------------------------------------------------------------------------------------------- */

/** The inspected tab of the loss-only suite: its own credential, project and session. */
const LOSS_TAB_ID = 4_219;

/** The loss the page agent reports for the open capture. */
const REPORTED_LOSS = 7;

/** The loss a stale frame claims: a different number, so the capture's total tells them apart. */
const STALE_LOSS = 11;

/** The message ingest logs once the ledger recorded a loss report, with the ledger's total. */
const LOSS_RECORDED_MESSAGE = 'a producer reported discarded events; recorded against the capture';

/**
 * `records` without the trailing summaries an ingest log throttle may write
 * for an earlier suite's held-back records: those report old batches, not
 * the batch under test.
 */
function withoutTrailingSummaries(records: readonly CapturedLogRecord[]): CapturedLogRecord[] {
  return records.filter((record) => record.fields.trailingSummary !== true);
}

/** The ledger totals ingest logged for `captureId` since `from`. */
function recordedLossTotalsFor(from: number, captureId: string): unknown[] {
  return ingestRecords(from)
    .filter(
      (record) => record.message === LOSS_RECORDED_MESSAGE && record.fields.captureId === captureId,
    )
    .map((record) => record.fields.captureDroppedEvents);
}

/**
 * Every loss report ingest handed to its ledger since `from`, whichever
 * capture and whatever the ledger answered: each such attempt is logged once
 * with its `droppedEvents` count.
 */
function recordedLossReports(from: number): CapturedLogRecord[] {
  return ingestRecords(from).filter((record) => typeof record.fields.droppedEvents === 'number');
}

/**
 * Placed after every other suite but the server-tier one on purpose: the
 * stale-capture case below writes a `stale-capture` drop, and the
 * drop-vocabulary case above reads every drop record the file wrote before it
 * ran.
 */
describe('loss-only reports', () => {
  /** What the setup establishes for this suite. */
  interface LossTab {
    /** The DevTools connection that announced {@link LOSS_TAB_ID} in its hello. */
    readonly devtools: HarnessWsClient;
    /** The session bound to that tab, on a project copy of its own. */
    readonly sessionId: string;
    /** That session's open capture. */
    readonly captureId: string;
  }

  let lossTab: LossTab | undefined;

  /** The suite's state, or a failure naming the setup that did not run. */
  function lossTabOf(): LossTab {
    if (lossTab === undefined) {
      throw new Error('The loss-only tab was not set up.');
    }
    return lossTab;
  }

  /** Sends one `telemetry.event` payload on the tab's connection and returns its error codes. */
  async function relayPayload(
    payload: MessagePayload<'telemetry.event'>,
  ): Promise<readonly string[]> {
    const { devtools } = lossTabOf();
    const receipt = devtools.send('telemetry.event', payload);
    expect(isErr(receipt.result), 'the telemetry.event frame was written').toBe(false);
    expect(await devtools.flush(), 'the service processed the frame before the barrier').toBe(true);
    return devtools.errorsFor(receipt.id).map((error) => error.code);
  }

  /** The ledger totals ingest logged for the suite's capture since `from`. */
  function recordedLossTotals(from: number): unknown[] {
    return recordedLossTotalsFor(from, lossTabOf().captureId);
  }

  beforeAll(async () => {
    const { harness } = current();
    // Captures are exclusive per project, so this session gets a copy of its
    // own, readied and captured exactly like the file's first session.
    const project = await harness.copyFixtureProject();
    const launched = recordResponse(await harness.launchDevServer(project.root));
    if (isErr(launched)) {
      throw new Error(`The loss-only dev server did not launch: ${launched.error.message}`);
    }
    const session = recordResponse(
      await harness.createSession({
        projectRoot: project.root,
        question: 'Why is the report slow to load?',
      }),
    );

    const { client: devtools } = await harness.connectDevtools({ tabId: LOSS_TAB_ID });
    const bound = await harness.bindTab(devtools, {
      tabId: LOSS_TAB_ID,
      url: session.devServerUrl,
      origin: new URL(session.devServerUrl).origin,
    });
    if (isErr(bound)) {
      throw new Error(
        `The loss-only tab was not bound (${bound.error.code}): ${bound.error.message}`,
      );
    }
    const ready = devtools.send('agent.ready', {
      tabId: LOSS_TAB_ID,
      documentId: assemble('doc-', randomHex(8)),
      producerId: newProducerId(),
      url: session.devServerUrl,
      installedBeforeReact: true,
      reactDetected: true,
    });
    if (!(await devtools.flush()) || devtools.errorsFor(ready.id).length > 0) {
      throw new Error(`agent.ready for the loss-only tab was refused: ${devtools.describe()}`);
    }
    await harness.ws({
      client: 'server-agent',
      projectRoot: project.root,
      token: harness.issueServerAgentCredential(project.root).token,
    });
    await harness.editor(project.root);

    const settled = await harness.waitForSession(
      session.id,
      (record: SessionRecord) => record.status === 'ready' || record.status === 'failed',
    );
    if (settled.status !== 'ready') {
      throw new Error(`The loss-only session settled in "${settled.status}" instead of "ready".`);
    }
    const started = recordResponse(await harness.startCapture(session.id));
    if (isErr(started)) {
      throw new Error(
        `The loss-only capture did not start (${started.error.code}): ${started.error.message}`,
      );
    }
    lossTab = { devtools, sessionId: session.id, captureId: started.value.captureId };
  });

  it('records a loss-only report against the open capture, storing and tailing nothing', async () => {
    const { harness } = current();
    const { devtools, captureId } = lossTabOf();
    const rowsBefore = tableRowCount();
    const framesBefore = devtools.received.length;
    const mark = harness.logger.records.length;

    const errors = await relayPayload({
      events: [],
      armedCaptureId: captureId,
      droppedCount: REPORTED_LOSS,
    });

    expect(errors, 'a loss-only report is accepted').toEqual([]);
    expect(recordedLossTotals(mark), 'the ledger holds the loss for the capture').toEqual([
      REPORTED_LOSS,
    ]);
    expect(tableRowCount(), 'nothing was persisted').toBe(rowsBefore);
    expect(withoutTrailingSummaries(summaryRecords(mark)), 'no event pipeline ran').toEqual([]);
    expect(withoutTrailingSummaries(dropRecords(mark)), 'nothing was dropped').toEqual([]);
    expect(devtools.received.slice(framesBefore).filter(isTailFrame), 'nothing was tailed').toEqual(
      [],
    );
  });

  it('refuses an empty batch that reports no loss with PROTOCOL_INVALID_MESSAGE, recording nothing', async () => {
    const { harness } = current();
    const { captureId } = lossTabOf();
    const rowsBefore = tableRowCount();
    const mark = harness.logger.records.length;

    expect(await relayPayload({ events: [] }), 'no loss report').toEqual([
      'PROTOCOL_INVALID_MESSAGE',
    ]);
    expect(
      await relayPayload({ events: [], armedCaptureId: captureId, droppedCount: 0 }),
      'a loss report of zero',
    ).toEqual(['PROTOCOL_INVALID_MESSAGE']);

    // Refused at the protocol boundary: ingest never saw either frame.
    expect(recordedLossReports(mark)).toEqual([]);
    expect(withoutTrailingSummaries(dropRecords(mark))).toEqual([]);
    expect(tableRowCount()).toBe(rowsBefore);
  });

  it('drops a loss-only report naming another capture as stale-capture, recording nothing', async () => {
    const { harness } = current();
    const rowsBefore = tableRowCount();
    const mark = harness.logger.records.length;

    const errors = await relayPayload({
      events: [],
      armedCaptureId: newCaptureId(),
      droppedCount: STALE_LOSS,
    });

    expect(errors, 'a drop is an honest report, never an error').toEqual([]);
    const drops = withoutTrailingSummaries(dropRecords(mark));
    expect(drops.map((record) => record.fields.reason)).toEqual(['stale-capture']);
    expect(drops.map((record) => record.fields.received)).toEqual([0]);
    expect(recordedLossReports(mark), 'the loss belongs to no established capture').toEqual([]);
    expect(tableRowCount()).toBe(rowsBefore);
  });

  it('persists the recorded loss in the stopped capture’s coverage, which is not complete', async () => {
    const { harness } = current();
    const { devtools, sessionId, captureId } = lossTabOf();

    const stopped = recordResponse(await harness.stopCapture(sessionId));
    if (isErr(stopped)) {
      throw new Error(`capture.stop was refused (${stopped.error.code}): ${stopped.error.message}`);
    }

    // Only the accepted report counts: neither the refused frames nor the stale one reached it.
    const expected = { producerDroppedEvents: REPORTED_LOSS, complete: false };
    expect(stopped.value.summary.eventCount).toBe(0);
    expect(stopped.value.summary.coverage).toMatchObject(expected);

    const stored = harness.repos.sessions.getCapture(captureId);
    if (isErr(stored)) {
      throw new Error(`The stopped capture could not be read: ${stored.error.message}`);
    }
    expect(stored.value?.sessionId).toBe(sessionId);
    expect(stored.value?.capture.stoppedAt, 'the window is closed').toBeDefined();
    expect(stored.value?.capture.summary?.coverage, 'the persisted summary').toMatchObject(
      expected,
    );
    // The connection speaks only for this tab, whose capture stored nothing:
    // no tail frame ever reached it, the stop barrier's wait included.
    expect(devtools.received.filter(isTailFrame), 'nothing was ever tailed').toEqual([]);
  });
});

/* -------------------------------------------------------------------------------------------------
 * Server-tier capture identity and loss
 * ---------------------------------------------------------------------------------------------- */

/** The inspected tab of the server-tier suite's first session. */
const SERVER_FIRST_TAB_ID = 4_220;

/** The inspected tab of the server-tier suite's second session, opened once the first ended. */
const SERVER_SECOND_TAB_ID = 4_221;

/** The loss the preload reports beside a batch for the open capture. */
const SERVER_BATCH_LOSS = 5;

/** The loss the preload reports alone, as a loss-only body for the open capture. */
const SERVER_LOSS_ONLY = 2;

/** The loss a retried stale batch claims: a different number, so the ledger total tells them apart. */
const SERVER_STALE_LOSS = 13;

/** The inspected tab of the replay session, opened on a project of its own. */
const SERVER_REPLAY_TAB_ID = 4_222;

/** The loss a loss-carrying body reports, sent again as the retry of a lost acknowledgement. */
const REPLAYED_BATCH_LOSS = 3;

/** The loss a loss-only body reports, sent again the same way. */
const REPLAYED_LOSS_ONLY = 2;

/** The loss each of two distinct reports claims: one count under two ids. */
const DISTINCT_REPORT_LOSS = 4;

/** The loss a report naming no `lossReportId` claims, sent twice. */
const UNNAMED_REPORT_LOSS = 1;

/**
 * Placed last on purpose, like the loss-only suite: its stale-capture case
 * writes a `stale-capture` drop, and the drop-vocabulary case above reads
 * every drop record the file wrote before it ran.
 *
 * The narrative runs in declaration order, as a preload's life does. Capture
 * A of one session is open and a batch naming it is stored under it. A is then
 * stopped and its session ended — captures are exclusive per project, and a
 * capture that holds evidence moves its session on to analysis, so the next
 * capture on the project belongs to a second session — and capture B of that
 * second session opens on the same project, under the same server-agent
 * credential. A batch the preload recorded for A and retried now is refused
 * rather than landing in B. Everything after that is posted while B is open.
 */
describe('server-tier capture identity and loss', () => {
  /** One readied session of the suite and its open capture. */
  interface ServerCapture {
    readonly sessionId: string;
    readonly captureId: string;
  }

  /** What the setup and the narrative establish, in order. */
  interface ServerTier {
    /** The project copy both sessions are opened on. */
    readonly projectRoot: string;
    /** The preload's server-agent credential, scoped to that project. */
    readonly token: string;
    /** The first session and its capture A, stopped by the stale-capture case. */
    readonly first: ServerCapture;
  }

  let tier: ServerTier | undefined;
  let second: ServerCapture | undefined;

  /** The events stored under capture B by the narrative, in the order they were posted. */
  const storedUnderSecond: string[] = [];

  /** The suite's state, or a failure naming the setup that did not run. */
  function tierOf(): ServerTier {
    if (tier === undefined) {
      throw new Error('The server-tier project was not set up.');
    }
    return tier;
  }

  /** The second session and its capture B, or a failure naming the case that opens it. */
  function secondOf(): ServerCapture {
    if (second === undefined) {
      throw new Error('The second capture was not opened by the stale-capture case.');
    }
    return second;
  }

  /** Fails unless every event of `events` is stored under `capture`'s session and capture. */
  function expectStoredUnder(
    events: readonly TelemetryEventIngress[],
    capture: ServerCapture,
  ): void {
    for (const event of events) {
      const row = rawRow(event.id);
      expect(row, `${event.id} was stored`).toBeDefined();
      expect(row?.sessionId, `${event.id} belongs to the capture's session`).toBe(
        capture.sessionId,
      );
      expect(row?.captureId, `${event.id} belongs to the capture`).toBe(capture.captureId);
    }
  }

  /**
   * Creates a session on the suite's project and brings it to `ready` the way
   * the product does — a tab bound to it whose page agent reported a document
   * hooked before React, with the preload's control connection already
   * present — then opens its capture.
   */
  async function openCapture(projectRoot: string, tabId: number): Promise<ServerCapture> {
    const { harness } = current();
    const session = recordResponse(
      await harness.createSession({ projectRoot, question: 'Why is the report slow to load?' }),
    );

    const { client: devtools } = await harness.connectDevtools({ tabId });
    const bound = await harness.bindTab(devtools, {
      tabId,
      url: session.devServerUrl,
      origin: new URL(session.devServerUrl).origin,
      sessionId: session.id,
    });
    if (isErr(bound)) {
      throw new Error(
        `The server-tier tab was not bound (${bound.error.code}): ${bound.error.message}`,
      );
    }
    const ready = devtools.send('agent.ready', {
      tabId,
      documentId: assemble('doc-', randomHex(8)),
      producerId: newProducerId(),
      url: session.devServerUrl,
      installedBeforeReact: true,
      reactDetected: true,
    });
    if (!(await devtools.flush()) || devtools.errorsFor(ready.id).length > 0) {
      throw new Error(`agent.ready for the server-tier tab was refused: ${devtools.describe()}`);
    }

    const settled = await harness.waitForSession(
      session.id,
      (record: SessionRecord) => record.status === 'ready' || record.status === 'failed',
    );
    if (settled.status !== 'ready') {
      throw new Error(`The server-tier session settled in "${settled.status}" instead of "ready".`);
    }
    const started = recordResponse(await harness.startCapture(session.id));
    if (isErr(started)) {
      throw new Error(
        `The server-tier capture did not start (${started.error.code}): ${started.error.message}`,
      );
    }
    return { sessionId: session.id, captureId: started.value.captureId };
  }

  beforeAll(async () => {
    const { harness } = current();
    // Captures are exclusive per project, so this suite gets a copy of its own.
    const project = await harness.copyFixtureProject();
    const launched = recordResponse(await harness.launchDevServer(project.root));
    if (isErr(launched)) {
      throw new Error(`The server-tier dev server did not launch: ${launched.error.message}`);
    }
    // One preload for the project's lifetime: one credential, one control connection.
    const token = harness.issueServerAgentCredential(project.root).token;
    await harness.ws({ client: 'server-agent', projectRoot: project.root, token });
    await harness.editor(project.root);

    const first = await openCapture(project.root, SERVER_FIRST_TAB_ID);
    tier = { projectRoot: project.root, token, first };
  });

  it('stores a batch naming the open capture under that capture', async () => {
    const { projectRoot, token, first } = tierOf();
    const batch = freshCopies(SERVER_EVENTS);

    const posted = await postIngest(token, projectRoot, batch, {
      armedCaptureId: first.captureId,
    });

    expect(posted.status).toBe(202);
    expect(posted.json).toEqual({ accepted: batch.length });
    expectStoredUnder(batch, first);
  });

  it('drops a batch retried across a stop and a start as stale-capture, storing and recording nothing', async () => {
    const { harness } = current();
    const { projectRoot, token, first } = tierOf();
    // Recorded while A was open, before the stop: the batch whose POST is retried.
    const retried = freshCopies(SERVER_EVENTS);

    const stopped = recordResponse(await harness.stopCapture(first.sessionId));
    if (isErr(stopped)) {
      throw new Error(
        `capture.stop of A was refused (${stopped.error.code}): ${stopped.error.message}`,
      );
    }
    const analysed = await harness.waitForSession(
      first.sessionId,
      (record: SessionRecord) => record.status === 'generated' || record.status === 'failed',
    );
    expect(analysed.status, 'capture A held evidence, so its session was analysed').toBe(
      'generated',
    );
    const ended = recordResponse(await harness.endSession(first.sessionId));
    if (isErr(ended)) {
      throw new Error(`session.end of the first session was refused (${ended.error.code})`);
    }
    second = await openCapture(projectRoot, SERVER_SECOND_TAB_ID);
    expect(second.captureId, 'B is a new capture').not.toBe(first.captureId);

    const rowsBefore = tableRowCount();
    const mark = harness.logger.records.length;
    const posted = await postIngest(token, projectRoot, retried, {
      armedCaptureId: first.captureId,
      droppedCount: SERVER_STALE_LOSS,
    });

    expect(posted.status, 'a drop is an honest report, never a refusal').toBe(202);
    expect(posted.json).toEqual({ accepted: 0, rejected: retried.length });
    expect(tableRowCount(), 'nothing was stored, under B or anywhere').toBe(rowsBefore);
    for (const event of retried) {
      expect(rawRow(event.id), `${event.id} was not stored`).toBeUndefined();
    }
    const drops = withoutTrailingSummaries(dropRecords(mark));
    expect(drops.map((record) => record.fields.reason)).toEqual(['stale-capture']);
    expect(drops.map((record) => record.fields.received)).toEqual([retried.length]);
    expect(recordedLossReports(mark), 'the loss belongs to no established capture').toEqual([]);
    // `postIngest` kept the verbatim response body last; the drop record is the
    // one line ingest wrote about the batch.
    const responseText = httpBodies.at(-1) ?? '';
    for (const text of [responseText, ...drops.map((record) => record.line)]) {
      expect(text, 'the producer-named capture is never echoed').not.toContain(first.captureId);
    }
  });

  it('stores a batch naming the new capture under it and adds its loss to that capture’s ledger', async () => {
    const { harness } = current();
    const { projectRoot, token } = tierOf();
    const capture = secondOf();
    const batch = freshCopies(SERVER_EVENTS);
    const mark = harness.logger.records.length;

    const posted = await postIngest(token, projectRoot, batch, {
      armedCaptureId: capture.captureId,
      droppedCount: SERVER_BATCH_LOSS,
    });

    expect(posted.status).toBe(202);
    expect(posted.json).toEqual({ accepted: batch.length });
    expectStoredUnder(batch, capture);
    storedUnderSecond.push(...batch.map((event) => event.id));
    expect(
      recordedLossTotalsFor(mark, capture.captureId),
      'the ledger holds the loss for B',
    ).toEqual([SERVER_BATCH_LOSS]);
  });

  it('records a loss-only body naming the open capture, storing nothing', async () => {
    const { harness } = current();
    const { projectRoot, token } = tierOf();
    const capture = secondOf();
    const rowsBefore = tableRowCount();
    const mark = harness.logger.records.length;

    const posted = await postIngest(token, projectRoot, [], {
      armedCaptureId: capture.captureId,
      droppedCount: SERVER_LOSS_ONLY,
    });

    expect(posted.status).toBe(202);
    expect(posted.json).toEqual({ accepted: 0 });
    expect(tableRowCount(), 'nothing was persisted').toBe(rowsBefore);
    expect(recordedLossTotalsFor(mark, capture.captureId), 'the ledger total grew').toEqual([
      SERVER_BATCH_LOSS + SERVER_LOSS_ONLY,
    ]);
    expect(withoutTrailingSummaries(summaryRecords(mark)), 'no event pipeline ran').toEqual([]);
    expect(withoutTrailingSummaries(dropRecords(mark)), 'nothing was dropped').toEqual([]);
  });

  it('refuses an event-less body that reports no loss with PROTOCOL_INVALID_MESSAGE, recording nothing', async () => {
    const { harness } = current();
    const { projectRoot, token } = tierOf();
    const capture = secondOf();
    const mark = harness.logger.records.length;

    for (const context of [{ armedCaptureId: capture.captureId }, { droppedCount: 0 }]) {
      const posted = await postIngest(token, projectRoot, [], context);
      expect(posted.status).toBe(400);
      expect(isRecord(posted.json) ? posted.json.code : undefined).toBe('PROTOCOL_INVALID_MESSAGE');
    }
    expect(recordedLossReports(mark), 'refused at the protocol boundary').toEqual([]);
  });

  it('still attributes a batch naming no capture to the open one', async () => {
    const { projectRoot, token } = tierOf();
    const capture = secondOf();
    const batch = freshCopies(SERVER_EVENTS);

    const posted = await postIngest(token, projectRoot, batch);

    expect(posted.status).toBe(202);
    expect(posted.json).toEqual({ accepted: batch.length });
    expectStoredUnder(batch, capture);
    storedUnderSecond.push(...batch.map((event) => event.id));
  });

  it('refuses a malformed armedCaptureId or droppedCount whole with PROTOCOL_INVALID_MESSAGE, storing nothing', async () => {
    const { harness } = current();
    const { projectRoot, token } = tierOf();
    const padded = ` ${newCaptureId()} `;
    const rowsBefore = tableRowCount();
    const mark = harness.logger.records.length;

    for (const context of [
      { armedCaptureId: padded },
      { armedCaptureId: 42 },
      { armedCaptureId: secondOf().captureId, droppedCount: -1 },
      { armedCaptureId: secondOf().captureId, droppedCount: 2.5 },
    ]) {
      const batch = freshCopies(SERVER_EVENTS);
      const posted = await postIngest(token, projectRoot, batch, context);

      expect(posted.status, JSON.stringify(context)).toBe(400);
      expect(isRecord(posted.json) ? posted.json.code : undefined).toBe('PROTOCOL_INVALID_MESSAGE');
      for (const event of batch) {
        expect(rawRow(event.id), `${event.id} was not stored`).toBeUndefined();
      }
    }
    expect(tableRowCount()).toBe(rowsBefore);
    expect(recordedLossReports(mark), 'no loss was recorded').toEqual([]);
    expect(httpBodies.join('\n'), 'the refused value is never echoed').not.toContain(padded.trim());
    expect(harness.logger.text(), 'nor logged').not.toContain(padded.trim());
  });

  it('persists the server-tier loss in the stopped capture’s coverage, and none of the stale loss anywhere', async () => {
    const { harness } = current();
    const { first } = tierOf();
    const capture = secondOf();

    const stopped = recordResponse(await harness.stopCapture(capture.sessionId));
    if (isErr(stopped)) {
      throw new Error(
        `capture.stop of B was refused (${stopped.error.code}): ${stopped.error.message}`,
      );
    }

    // Only the accepted reports count: the stale batch's loss reached no ledger.
    const expected = {
      producerDroppedEvents: SERVER_BATCH_LOSS + SERVER_LOSS_ONLY,
      complete: false,
    };
    expect(stopped.value.summary.captureId).toBe(capture.captureId);
    expect(stopped.value.summary.eventCount).toBe(storedUnderSecond.length);
    expect(stopped.value.summary.coverage).toMatchObject(expected);

    const storedB = harness.repos.sessions.getCapture(capture.captureId);
    if (isErr(storedB)) {
      throw new Error(`Capture B could not be read: ${storedB.error.message}`);
    }
    expect(storedB.value?.sessionId).toBe(capture.sessionId);
    expect(storedB.value?.capture.summary?.coverage, 'the persisted summary').toMatchObject(
      expected,
    );

    const storedA = harness.repos.sessions.getCapture(first.captureId);
    if (isErr(storedA)) {
      throw new Error(`Capture A could not be read: ${storedA.error.message}`);
    }
    expect(storedA.value?.capture.summary?.eventCount, 'A kept exactly its own batch').toBe(
      SERVER_EVENTS.length,
    );
    expect(
      storedA.value?.capture.summary?.coverage,
      'the stale loss never reached A',
    ).toMatchObject({ producerDroppedEvents: 0, complete: true });

    // The analysis of B's evidence runs on; let it settle before the harness is torn down.
    const settled = await harness.waitForSession(
      capture.sessionId,
      (record: SessionRecord) => record.status === 'generated' || record.status === 'failed',
    );
    expect(settled.status).toBe('generated');
  });

  /**
   * The preload's exporter sends the same serialized body again after a
   * timeout or a retryable failure, so a loss report the service recorded but
   * whose acknowledgement was lost arrives a second time. Its `lossReportId`,
   * stable across those sends, is what makes ingest count it once.
   *
   * Run on a project, session and capture of their own, so every ledger total
   * above stays exact and this suite's final coverage is its own sum. The
   * cases run in declaration order and each reads the capture's running
   * ledger total, which ingest logs whenever the ledger accepts a report.
   */
  describe('loss report replays', () => {
    /** What the setup establishes for this suite. */
    interface ReplayTier {
      /** The project copy the replay session is opened on. */
      readonly projectRoot: string;
      /** The preload's server-agent credential, scoped to that project. */
      readonly token: string;
      /** The replay session and its open capture. */
      readonly capture: ServerCapture;
    }

    let replay: ReplayTier | undefined;

    /** The events stored under the replay capture, in the order they were posted. */
    const storedUnderReplay: string[] = [];

    /** Every loss-report id the suite sent: none may reach a response body or a record. */
    const sentReportIds: string[] = [];

    /** The suite's state, or a failure naming the setup that did not run. */
    function replayOf(): ReplayTier {
      if (replay === undefined) {
        throw new Error('The replay project was not set up.');
      }
      return replay;
    }

    /** A fresh loss-report id, shaped as the exporter mints one: 16 random lowercase hex characters. */
    function newLossReportId(): string {
      const id = randomHex(8);
      sentReportIds.push(id);
      return id;
    }

    /** The ledger totals ingest logged for the replay capture since `from`. */
    function replayLossTotals(from: number): unknown[] {
      return recordedLossTotalsFor(from, replayOf().capture.captureId);
    }

    /**
     * Posts one body twice, as the preload retries a post whose reply it never
     * read, and requires the two requests to be byte-identical.
     */
    async function postTwice(
      events: readonly unknown[],
      context: IngestDeliveryContext,
    ): Promise<readonly [IngestResponse, IngestResponse]> {
      const { projectRoot, token } = replayOf();
      const first = await postIngest(token, projectRoot, events, context);
      const retry = await postIngest(token, projectRoot, events, context);
      expect(postedBodies.at(-1), 'the retry is the same body').toBe(postedBodies.at(-2));
      return [first, retry];
    }

    beforeAll(async () => {
      const { harness } = current();
      // Captures are exclusive per project, so the replays get a copy of their own.
      const project = await harness.copyFixtureProject();
      const launched = recordResponse(await harness.launchDevServer(project.root));
      if (isErr(launched)) {
        throw new Error(`The replay dev server did not launch: ${launched.error.message}`);
      }
      const token = harness.issueServerAgentCredential(project.root).token;
      await harness.ws({ client: 'server-agent', projectRoot: project.root, token });
      await harness.editor(project.root);

      const capture = await openCapture(project.root, SERVER_REPLAY_TAB_ID);
      replay = { projectRoot: project.root, token, capture };
    });

    it('stores a retried loss-carrying body’s events once and adds its loss to the ledger once', async () => {
      const { harness } = current();
      const { capture } = replayOf();
      const batch = freshCopies(SERVER_EVENTS);
      const rowsBefore = tableRowCount();
      const mark = harness.logger.records.length;

      const [first, retry] = await postTwice(batch, {
        armedCaptureId: capture.captureId,
        droppedCount: REPLAYED_BATCH_LOSS,
        lossReportId: newLossReportId(),
      });

      expect(first.status).toBe(202);
      expect(first.json).toEqual({ accepted: batch.length });
      // The store keeps the first delivery's rows (`ON CONFLICT(id) DO NOTHING`),
      // so the retry is answered as accepted, its events skipped.
      expect(retry.status, 'a retry is answered, never refused').toBe(202);
      expect(retry.json).toEqual({ accepted: batch.length });
      expect(tableRowCount(), 'the events were stored once').toBe(rowsBefore + batch.length);
      expectStoredUnder(batch, capture);
      storedUnderReplay.push(...batch.map((event) => event.id));

      const summaries = withoutTrailingSummaries(summaryRecords(mark)).map((record) => ({
        inserted: record.fields.inserted,
        skipped: record.fields.skipped,
        producerDropped: record.fields.producerDropped,
      }));
      expect(
        summaries,
        'both deliveries ran the pipeline; only the first carried new loss',
      ).toEqual([
        { inserted: batch.length, skipped: 0, producerDropped: REPLAYED_BATCH_LOSS },
        { inserted: 0, skipped: batch.length, producerDropped: undefined },
      ]);
      expect(replayLossTotals(mark), 'the ledger took the report once').toEqual([
        REPLAYED_BATCH_LOSS,
      ]);
    });

    it('adds a retried loss-only body’s loss to the ledger once, storing nothing', async () => {
      const { harness } = current();
      const { capture } = replayOf();
      const rowsBefore = tableRowCount();
      const mark = harness.logger.records.length;

      const [first, retry] = await postTwice([], {
        armedCaptureId: capture.captureId,
        droppedCount: REPLAYED_LOSS_ONLY,
        lossReportId: newLossReportId(),
      });

      for (const posted of [first, retry]) {
        expect(posted.status).toBe(202);
        expect(posted.json).toEqual({ accepted: 0 });
      }
      expect(tableRowCount(), 'nothing was persisted').toBe(rowsBefore);
      expect(replayLossTotals(mark), 'the ledger took the report once').toEqual([
        REPLAYED_BATCH_LOSS + REPLAYED_LOSS_ONLY,
      ]);
    });

    it('counts two reports of the same loss under different ids as two reports', async () => {
      const { harness } = current();
      const { projectRoot, token, capture } = replayOf();
      const mark = harness.logger.records.length;

      for (const lossReportId of [newLossReportId(), newLossReportId()]) {
        const posted = await postIngest(token, projectRoot, [], {
          armedCaptureId: capture.captureId,
          droppedCount: DISTINCT_REPORT_LOSS,
          lossReportId,
        });
        expect(posted.status).toBe(202);
        expect(posted.json).toEqual({ accepted: 0 });
      }

      const before = REPLAYED_BATCH_LOSS + REPLAYED_LOSS_ONLY;
      expect(replayLossTotals(mark), 'each id is its own report').toEqual([
        before + DISTINCT_REPORT_LOSS,
        before + 2 * DISTINCT_REPORT_LOSS,
      ]);
    });

    it('counts a report naming no lossReportId on every delivery: only a named report is applied once', async () => {
      const { harness } = current();
      const { capture } = replayOf();
      const mark = harness.logger.records.length;

      const [first, retry] = await postTwice([], {
        armedCaptureId: capture.captureId,
        droppedCount: UNNAMED_REPORT_LOSS,
      });

      for (const posted of [first, retry]) {
        expect(posted.status).toBe(202);
        expect(posted.json).toEqual({ accepted: 0 });
      }
      const before = REPLAYED_BATCH_LOSS + REPLAYED_LOSS_ONLY + 2 * DISTINCT_REPORT_LOSS;
      expect(replayLossTotals(mark), 'without an id, a repeat is indistinguishable').toEqual([
        before + UNNAMED_REPORT_LOSS,
        before + 2 * UNNAMED_REPORT_LOSS,
      ]);
    });

    it('refuses a lossReportId beside no positive droppedCount with PROTOCOL_INVALID_MESSAGE, storing and recording nothing', async () => {
      const { harness } = current();
      const { projectRoot, token, capture } = replayOf();
      const rowsBefore = tableRowCount();
      const mark = harness.logger.records.length;

      for (const [label, context] of [
        ['no droppedCount', { armedCaptureId: capture.captureId, lossReportId: newLossReportId() }],
        [
          'a droppedCount of zero',
          { armedCaptureId: capture.captureId, droppedCount: 0, lossReportId: newLossReportId() },
        ],
      ] as const) {
        // A sound batch; one whose only other fault is a malformed element,
        // which would otherwise be recovered element by element; and none.
        const sound = freshCopies(SERVER_EVENTS);
        const besideFault = freshCopies(SERVER_EVENTS);
        const withFault: readonly unknown[] = [...besideFault, { kind: 'not-a-span' }];
        for (const batch of [sound, withFault, []]) {
          const posted = await postIngest(token, projectRoot, batch, context);

          expect(posted.status, `${label}, ${String(batch.length)} events`).toBe(400);
          expect(isRecord(posted.json) ? posted.json.code : undefined).toBe(
            'PROTOCOL_INVALID_MESSAGE',
          );
        }
        for (const event of [...sound, ...besideFault]) {
          expect(rawRow(event.id), `${event.id} was not stored`).toBeUndefined();
        }
      }

      expect(tableRowCount(), 'nothing was stored').toBe(rowsBefore);
      expect(recordedLossReports(mark), 'no loss was recorded').toEqual([]);
      expect(withoutTrailingSummaries(summaryRecords(mark)), 'no event pipeline ran').toEqual([]);
    });

    it('persists the single-counted loss in the stopped capture’s coverage, and never echoes or logs a report id', async () => {
      const { harness } = current();
      const { capture } = replayOf();

      const stopped = recordResponse(await harness.stopCapture(capture.sessionId));
      if (isErr(stopped)) {
        throw new Error(
          `capture.stop of the replay capture was refused (${stopped.error.code}): ${stopped.error.message}`,
        );
      }

      // Each named report once, the unnamed report on both deliveries.
      const expected = {
        producerDroppedEvents:
          REPLAYED_BATCH_LOSS +
          REPLAYED_LOSS_ONLY +
          2 * DISTINCT_REPORT_LOSS +
          2 * UNNAMED_REPORT_LOSS,
        complete: false,
      };
      expect(stopped.value.summary.captureId).toBe(capture.captureId);
      expect(stopped.value.summary.eventCount).toBe(storedUnderReplay.length);
      expect(stopped.value.summary.coverage).toMatchObject(expected);

      const stored = harness.repos.sessions.getCapture(capture.captureId);
      if (isErr(stored)) {
        throw new Error(`The replay capture could not be read: ${stored.error.message}`);
      }
      expect(stored.value?.sessionId).toBe(capture.sessionId);
      expect(stored.value?.capture.summary?.coverage, 'the persisted summary').toMatchObject(
        expected,
      );

      // Every id went out in a posted body, and none came back or was written.
      const posted = postedBodies.join('\n');
      const answered = httpBodies.join('\n');
      const logged = harness.logger.text();
      expect(sentReportIds.length).toBeGreaterThan(0);
      for (const id of sentReportIds) {
        expect(posted, 'the id was sent').toContain(id);
        expect(answered, 'the id is never echoed').not.toContain(id);
        expect(logged, 'nor logged').not.toContain(id);
      }

      // The analysis of the capture's evidence runs on; let it settle before teardown.
      const settled = await harness.waitForSession(
        capture.sessionId,
        (record: SessionRecord) => record.status === 'generated' || record.status === 'failed',
      );
      expect(settled.status).toBe('generated');
    });
  });
});

/* -------------------------------------------------------------------------------------------------
 * The page's replayed lifecycle entries (pre-capture)
 * ---------------------------------------------------------------------------------------------- */

/** The inspected tab of the lifecycle suite: its own credential, project and session. */
const LIFECYCLE_TAB_ID = 4_223;

/**
 * AAP §0.5.5, "Capture yielded nothing": the developer-facing sentence, quoted
 * from the specification rather than from the implementation it tests.
 */
const EMPTY_CAPTURE_MESSAGE =
  'No telemetry was captured. Interact with the page while capture is running, then Capture again.';

/** The `perf.entry` attribute naming the `PerformanceEntry` type, as the page agent writes it. */
const ENTRY_TYPE_KEY = 'entry.type';

/**
 * The page agent observes `navigation` and `paint` with `buffered: true`, so
 * the first batch after it is armed replays the load and first paints of a
 * document that loaded before Start. This suite sends exactly that batch over
 * the real relay path and proves, by what the store kept, that those entries
 * are dropped per event as `pre-capture` — so a capture in which nothing else
 * happened is empty (AAP §0.5.5) and the window of one that holds evidence
 * starts no earlier than the capture — while a reload during the capture keeps
 * its own navigation and paint, and the relay answers every such batch as an
 * accepted one: no error frame, no batch-level drop, no refusal.
 */
describe('the page’s replayed lifecycle entries', () => {
  /** What the setup establishes for this suite. */
  interface LifecycleTab {
    /** The DevTools connection that announced {@link LIFECYCLE_TAB_ID} in its hello. */
    readonly devtools: HarnessWsClient;
    /** The editor connection of the suite's project: where progress is announced. */
    readonly editor: HarnessWsClient;
    /** The session bound to that tab, on a project copy of its own. */
    readonly sessionId: string;
    /** The page agent's producer id for the tab's document. */
    readonly producerId: string;
  }

  /** One open capture of the suite's session, with the start its store row records. */
  interface OpenCapture {
    readonly captureId: string;
    readonly startedAt: number;
  }

  let lifecycle: LifecycleTab | undefined;
  let emptyCapture: OpenCapture | undefined;
  let evidenceCapture: OpenCapture | undefined;
  let seq = 0;

  /** The suite's state, or a failure naming the setup that did not run. */
  function lifecycleOf(): LifecycleTab {
    if (lifecycle === undefined) {
      throw new Error('The lifecycle tab was not set up.');
    }
    return lifecycle;
  }

  /** An open capture, or a failure naming the step that did not open it. */
  function required(capture: OpenCapture | undefined, name: string): OpenCapture {
    if (capture === undefined) {
      throw new Error(`The ${name} capture was not opened.`);
    }
    return capture;
  }

  /** Opens a capture of the suite's session and reads its recorded start back from the store. */
  async function openCapture(): Promise<OpenCapture> {
    const { harness } = current();
    const { sessionId } = lifecycleOf();
    const started = recordResponse(await harness.startCapture(sessionId));
    if (isErr(started)) {
      throw new Error(
        `The lifecycle capture did not start (${started.error.code}): ${started.error.message}`,
      );
    }
    const captureId = started.value.captureId;
    const stored = harness.repos.sessions.getCapture(captureId);
    if (isErr(stored) || stored.value === undefined) {
      throw new Error('The lifecycle capture row could not be read back.');
    }
    return { captureId, startedAt: stored.value.capture.startedAt };
  }

  /** A strictly valid browser ingress event of the tab's producer, one trace per event. */
  function browserEvent(
    kind: 'navigation' | 'perf.entry' | 'render',
    name: string,
    startTime: number,
    duration: number,
    attributes: Readonly<Record<string, unknown>>,
  ): TelemetryEventIngress {
    seq += 1;
    const parsed = parseTelemetryEventIngress({
      id: newEventId(),
      traceId: newTraceId(),
      spanId: newSpanId(),
      kind,
      name,
      startTime,
      duration,
      tier: 'browser',
      attributes: { ...attributes },
      status: 'ok',
      producerId: lifecycleOf().producerId,
      seq,
    });
    if (isErr(parsed)) {
      throw new Error(`The ${kind} event does not parse as ingress: ${parsed.error.message}`);
    }
    return parsed.value;
  }

  /**
   * The batch the page agent sends first after it is armed on a document that
   * loaded before Start: its navigation, then its two paint marks — all of
   * them over before `startedAt`.
   */
  function replayedPageLoad(startedAt: number): TelemetryEventIngress[] {
    return [
      browserEvent('navigation', 'navigation', startedAt - 2_446.5, 342.5, {
        'navigation.type': 'navigate',
      }),
      browserEvent('perf.entry', 'first-paint', startedAt - 2_010.25, 0, {
        [ENTRY_TYPE_KEY]: 'paint',
      }),
      browserEvent('perf.entry', 'first-contentful-paint', startedAt - 2_010.25, 0, {
        [ENTRY_TYPE_KEY]: 'paint',
      }),
    ];
  }

  /** Relays one `telemetry.event` payload on the tab's connection and returns its error codes. */
  async function relayLifecycle(
    events: readonly TelemetryEventIngress[],
    armedCaptureId: string,
  ): Promise<readonly string[]> {
    const { devtools } = lifecycleOf();
    const receipt = devtools.send('telemetry.event', { events: [...events], armedCaptureId });
    expect(isErr(receipt.result), 'the telemetry.event frame was written').toBe(false);
    expect(await devtools.flush(), 'the service processed the frame before the barrier').toBe(true);
    return devtools.errorsFor(receipt.id).map((error) => error.code);
  }

  /** The route's refusal records since `from`: a relayed frame answered as a failure. */
  function frameRefusals(from: number): CapturedLogRecord[] {
    return current()
      .harness.logger.records.slice(from)
      .filter((record) => record.message === 'telemetry ingest refused a relayed frame');
  }

  /** Every event id the tab's connection received on `telemetry.tail`. */
  function tailedIds(): Set<string> {
    return new Set(tailedEvents(lifecycleOf().devtools).map((event) => event.id));
  }

  beforeAll(async () => {
    const { harness } = current();
    // Captures are exclusive per project, so this session gets a copy of its
    // own, readied exactly like the file's first session.
    const project = await harness.copyFixtureProject();
    const launched = recordResponse(await harness.launchDevServer(project.root));
    if (isErr(launched)) {
      throw new Error(`The lifecycle dev server did not launch: ${launched.error.message}`);
    }
    const session = recordResponse(
      await harness.createSession({
        projectRoot: project.root,
        question: 'Why is the report slow to load?',
      }),
    );

    const { client: devtools } = await harness.connectDevtools({ tabId: LIFECYCLE_TAB_ID });
    const bound = await harness.bindTab(devtools, {
      tabId: LIFECYCLE_TAB_ID,
      url: session.devServerUrl,
      origin: new URL(session.devServerUrl).origin,
    });
    if (isErr(bound)) {
      throw new Error(
        `The lifecycle tab was not bound (${bound.error.code}): ${bound.error.message}`,
      );
    }
    const producerId = newProducerId();
    const ready = devtools.send('agent.ready', {
      tabId: LIFECYCLE_TAB_ID,
      documentId: assemble('doc-', randomHex(8)),
      producerId,
      url: session.devServerUrl,
      installedBeforeReact: true,
      reactDetected: true,
    });
    if (!(await devtools.flush()) || devtools.errorsFor(ready.id).length > 0) {
      throw new Error(`agent.ready for the lifecycle tab was refused: ${devtools.describe()}`);
    }
    await harness.ws({
      client: 'server-agent',
      projectRoot: project.root,
      token: harness.issueServerAgentCredential(project.root).token,
    });
    const editor = await harness.editor(project.root);

    const settled = await harness.waitForSession(
      session.id,
      (record: SessionRecord) => record.status === 'ready' || record.status === 'failed',
    );
    if (settled.status !== 'ready') {
      throw new Error(`The lifecycle session settled in "${settled.status}" instead of "ready".`);
    }
    lifecycle = { devtools, editor, sessionId: session.id, producerId };
    emptyCapture = await openCapture();
  });

  it('drops a batch made up only of the replayed page load, answering it as accepted', async () => {
    const { harness } = current();
    const { captureId, startedAt } = required(emptyCapture, 'empty');
    const rowsBefore = tableRowCount();
    const mark = harness.logger.records.length;
    const batch = replayedPageLoad(startedAt);

    const errors = await relayLifecycle(batch, captureId);

    // Benign on the relay: no error frame, no batch-level drop, no refusal —
    // the agent working as designed is never answered as a producer failure.
    expect(errors, 'the page agent is not told its batch failed').toEqual([]);
    expect(withoutTrailingSummaries(dropRecords(mark)), 'the batch itself resolved').toEqual([]);
    expect(frameRefusals(mark), 'the route did not refuse the frame').toEqual([]);
    expect(tableRowCount(), 'no replayed entry was stored').toBe(rowsBefore);
    for (const event of batch) {
      expect(rawRow(event.id), `${event.kind} ${event.name} was not stored`).toBeUndefined();
    }
  });

  it('leaves a capture that holds only that replay empty: analysis is skipped and the session returns to ready', async () => {
    const { harness } = current();
    const { sessionId, editor } = lifecycleOf();
    const { captureId } = required(emptyCapture, 'empty');
    const framesBefore = editor.received.length;

    const stopped = recordResponse(await harness.stopCapture(sessionId));
    if (isErr(stopped)) {
      throw new Error(`capture.stop was refused (${stopped.error.code}): ${stopped.error.message}`);
    }
    expect(stopped.value.summary.eventCount, 'the capture holds no event').toBe(0);

    const record = await harness.waitForSession(
      sessionId,
      (candidate: SessionRecord) =>
        candidate.status === 'ready' &&
        candidate.captures.some(
          (capture) => capture.id === captureId && capture.stoppedAt !== undefined,
        ),
    );
    expect(record.status).toBe('ready');
    expect(record.analyses, 'no analysis ran').toEqual([]);
    expect(record.panelIds, 'no panel was generated').toEqual([]);

    // The developer is told, in AAP §0.5.5's words.
    expect(await editor.flush()).toBe(true);
    const messages = editor.received
      .slice(framesBefore)
      .flatMap((message) =>
        isMessageOfType(message, 'session.progress') && message.payload.sessionId === sessionId
          ? [message.payload.message]
          : [],
      );
    expect(messages).toContain(EMPTY_CAPTURE_MESSAGE);
  });

  it('stores only the capture’s own evidence from a batch that opens with the replayed page load', async () => {
    const { harness, sessionId: firstSessionId } = current();
    const { sessionId } = lifecycleOf();
    evidenceCapture = await openCapture();
    const { captureId, startedAt } = evidenceCapture;
    const mark = harness.logger.records.length;
    const render = browserEvent('render', 'Widget', startedAt + 850.125, 18.5, {
      component: 'Widget',
      phase: 'update',
    });
    const batch = [...replayedPageLoad(startedAt), render];

    const errors = await relayLifecycle(batch, captureId);

    expect(errors, 'the batch was accepted').toEqual([]);
    expect(frameRefusals(mark)).toEqual([]);
    expect(withoutTrailingSummaries(dropRecords(mark)), 'the batch itself resolved').toEqual([]);
    const row = rawRow(render.id);
    expect(row?.sessionId, 'the render belongs to the lifecycle session').toBe(sessionId);
    expect(row?.sessionId).not.toBe(firstSessionId);
    expect(row?.captureId, 'the render belongs to the open capture').toBe(captureId);
    for (const event of batch.slice(0, -1)) {
      expect(rawRow(event.id), `${event.kind} ${event.name} was not stored`).toBeUndefined();
    }
    expect(
      summaryRecords(mark)
        .filter((record) => record.fields.captureId === captureId)
        .map((record) => [record.fields.received, record.fields.dropped, record.fields.persisted]),
      'three replayed entries dropped per event, one event persisted',
    ).toEqual([[batch.length, 3, 1]]);

    // Only what was stored is tailed.
    await lifecycleOf().devtools.until(
      () => (tailedIds().has(render.id) ? true : undefined),
      HARNESS_TIMEOUTS.capture,
      () => `The tail did not deliver the render: ${lifecycleOf().devtools.describe()}`,
    );
    for (const event of batch.slice(0, -1)) {
      expect(tailedIds().has(event.id), `${event.kind} ${event.name} was not tailed`).toBe(false);
    }
  });

  it('keeps a reload during the capture: the fresh document’s navigation and paint are stored', async () => {
    const { captureId, startedAt } = required(evidenceCapture, 'evidence');
    const reload = browserEvent('navigation', 'navigation', startedAt + 1_500.5, 480.25, {
      'navigation.type': 'reload',
    });
    const paint = browserEvent('perf.entry', 'first-contentful-paint', startedAt + 1_720.75, 0, {
      [ENTRY_TYPE_KEY]: 'paint',
    });

    const errors = await relayLifecycle([reload, paint], captureId);

    expect(errors).toEqual([]);
    for (const event of [reload, paint]) {
      expect(rawRow(event.id)?.captureId, `${event.kind} ${event.name} was stored`).toBe(captureId);
    }
  });

  it('bounds the stopped capture’s summary by the capture window', async () => {
    const { harness } = current();
    const { sessionId } = lifecycleOf();
    const { captureId, startedAt } = required(evidenceCapture, 'evidence');

    const stopped = recordResponse(await harness.stopCapture(sessionId));
    if (isErr(stopped)) {
      throw new Error(`capture.stop was refused (${stopped.error.code}): ${stopped.error.message}`);
    }
    const summary = stopped.value.summary;

    // The render, the reload's navigation and its paint — none of the replay.
    expect(summary.captureId).toBe(captureId);
    expect(summary.eventCount).toBe(3);
    expect(summary.kindCounts.navigation, 'only the reload’s navigation').toBe(1);
    expect(summary.kindCounts['perf.entry'], 'only the reload’s paint').toBe(1);
    expect(
      summary.startTime,
      'the window opens no earlier than the capture',
    ).toBeGreaterThanOrEqual(startedAt);

    // The pipeline runs on the capture's evidence; let it settle before
    // teardown, whichever way the analysis of this small capture ends.
    await harness.waitForSession(
      sessionId,
      (record: SessionRecord) =>
        record.status === 'generated' || record.status === 'ready' || record.status === 'failed',
    );
  });
});
