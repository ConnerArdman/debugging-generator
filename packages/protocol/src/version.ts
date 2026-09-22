/**
 * The foundation module of `@debuggen/protocol`: the wire version, the canonical
 * timestamp primitive, leak-free validation reporting and the sanctioned wrapper
 * for embedding an upstream type that owns no Zod schema.
 *
 * ## This module is the package's cycle-breaker — keep it that way
 *
 * `@debuggen/protocol` is the single cross-process contract of this product
 * (AAP §0.4.2): four processes — the local service, the VS Code extension host
 * and its webview, the Chrome MV3 service worker and its DevTools panel, and the
 * Node preload inside the target project's dev server — speak to each other
 * exclusively through the schemas this package defines. Its module graph runs
 * strictly one way, and this file is at the top of it:
 *
 * ```text
 * @debuggen/{shared,telemetry,instrumentation,panel-schema}
 *   → version.ts
 *   → analysis.ts → session-record.ts
 *   → messages/*.ts → messages/index.ts
 *   → envelope.ts → http.ts → client/*.ts → index.ts
 * ```
 *
 * **Nothing in `packages/protocol/src` may be imported from here.** That is not
 * a stylistic preference: every other module in the package imports this one, so
 * a single upward import would close a cycle through the envelope, and the
 * primitives below — the version the handshake compares, the timestamp every
 * message carries, the issue renderer every parse helper calls — would become
 * unreachable from the modules that need them first. Only `zod` and the four
 * packages that sit *below* protocol in the layering (AAP §0.2.2) may appear in
 * the import block, and `eslint.config.js` enforces exactly that edge list with
 * `no-restricted-imports`.
 *
 * Three further constraints shape the code below and are worth stating where a
 * reader will meet them:
 *
 * - **Environment-neutral.** `packages/protocol/tsconfig.json` declares
 *   `types: []` and `tsup.config.ts` builds with `platform: 'neutral'`, so no
 *   `node:*` builtin, no `@debuggen/shared/node` entry and no `ws` import can
 *   exist anywhere in this package — this bundle is loaded by a Node process and
 *   by three page-side bundles alike.
 * - **No import-time side effects.** `package.json` declares
 *   `sideEffects: false`. Every export here is a declaration; nothing reads an
 *   environment variable, mutates a global or performs I/O when the module
 *   loads.
 * - **Byte-faithful parsing.** No `.transform()`, no `.coerce`, no `.default()`
 *   and no `.catch()` appears in this package. A schema validates; it never
 *   rewrites. Defaults are the service's business, applied where the value is
 *   used rather than where it is checked, so what a producer sent is what a
 *   consumer reads.
 *
 * ## What lives here, and why each piece is here rather than elsewhere
 *
 * - {@link PROTOCOL_VERSION} is the value every client puts in the
 *   `client.hello` frame's `version` field (AAP §0.4.2) and the value
 *   `GET /health` reports as `protocolVersion`. It describes **the protocol**,
 *   never an npm package version: bumping its major is what invalidates existing
 *   clients, and {@link isCompatibleProtocolVersion} is the predicate the
 *   service's handshake applies.
 * - {@link epochMsSchema} is the one timestamp primitive of this package, over
 *   the product's fixed time base (AAP §0.2.3): Unix epoch **milliseconds** as a
 *   double, sub-millisecond precision preserved. Its bounds are *imported* from
 *   `@debuggen/telemetry` rather than restated, so a producer's unit mistake is
 *   rejected identically at both layers.
 * - {@link describeZodIssues} is the **only** sanctioned way to render a
 *   validation failure in this package. A message is assembled from issue paths,
 *   issue codes and schema-declared metadata — never from a rejected value. The
 *   privacy model (AAP §0.5.2) is the reason: a telemetry event, a SQL
 *   statement, a URL with query parameters or a model's output must not reach a
 *   log line, a persisted session or a user-interface banner through the back
 *   door of an error message, and an error raised this deep in a call stack is
 *   never seen by the redaction layer. It lives here, once, so that the six
 *   places that report a rejection cannot each re-invent it:
 *   `analysis.ts`, `session-record.ts`, `envelope.ts` (`parseMessage`),
 *   `http.ts`, every `messages/*.ts` parse helper and `client/http-client.ts`.
 * - {@link opaqueSchema} and {@link opaqueArraySchema} exist so a message can
 *   embed an upstream **type** that its owner never gave a Zod schema — the
 *   aggregate result shapes of `@debuggen/telemetry`, for instance. The type
 *   still comes from its owner, so no definition is duplicated, which is the
 *   rule AAP §0.2.3 states: "Types that cross a process boundary are defined
 *   exactly once… Any second definition of these shapes in an app is a defect."
 *
 * Every export is named; there is no default export.
 */

import { z } from 'zod';

import { DebuggenError, err, ok } from '@debuggen/shared';
import type { DebuggenErrorCode, Result } from '@debuggen/shared';
import { MAX_EPOCH_MS, MIN_EPOCH_MS } from '@debuggen/telemetry';

// ---------------------------------------------------------------------------
// Section A — the wire-version contract
// ---------------------------------------------------------------------------

/**
 * The version of **the protocol**, in `major.minor.patch` form.
 *
 * This is the value a client sends in the `client.hello` frame's `version` field
 * (AAP §0.4.2) and the value `GET /health` reports as `protocolVersion`. It is
 * deliberately independent of any npm package version in this monorepo: the
 * workspaces are versioned together for release convenience, while this string
 * describes what the four cooperating processes have agreed to say to one
 * another.
 *
 * The three components carry different weight, and only one of them is a
 * compatibility signal:
 *
 * - **major** — bumping it invalidates existing clients. It is the component
 *   {@link isCompatibleProtocolVersion} compares, so it changes only for a
 *   breaking edit: a removed message type, a renamed field, a narrowed payload
 *   schema, or a changed meaning for an existing field.
 * - **minor** — an additive, backward-compatible change: a new message type, a
 *   new optional field. An older client keeps working because the schemas it
 *   validates against still accept what it receives.
 * - **patch** — documentation, an error message, a corrected description; no
 *   observable change on the wire.
 *
 * @see {@link PROTOCOL_VERSION_MAJOR} for the parsed major component.
 * @see {@link isCompatibleProtocolVersion} for the handshake predicate that
 * `apps/local-service/src/server/auth.ts` applies to a `client.hello` frame.
 */
export const PROTOCOL_VERSION = '1.0.0' as const;

/**
 * The major component of {@link PROTOCOL_VERSION}, extracted at compile time.
 *
 * Nothing here can drift: the `satisfies` clause checks the literal `1` against
 * the major component the compiler reads out of {@link PROTOCOL_VERSION}'s
 * literal type, so changing the version string to `'2.0.0'` without changing
 * this line is a type error rather than a silent disagreement between two
 * constants. {@link isCompatibleProtocolVersion} additionally fails closed at
 * runtime if the two ever disagree, which covers a hand-edited build.
 *
 * Consumers: `GET /health`'s response, which reports the major alongside the
 * full version so a client can explain a refusal, and any client that wants to
 * describe its own expectations without re-parsing a string.
 */
export const PROTOCOL_VERSION_MAJOR = 1 satisfies MajorComponentOf<typeof PROTOCOL_VERSION>;

/**
 * The major component of a `major.minor.patch` literal type, as a numeric
 * literal type.
 *
 * Module-private and used once, in the `satisfies` clause of
 * {@link PROTOCOL_VERSION_MAJOR}. `infer M extends number` is what turns the
 * matched digits into a numeric literal rather than a string, which is what
 * makes the check above a real comparison.
 */
type MajorComponentOf<V extends string> = V extends `${infer M extends number}.${string}.${string}`
  ? M
  : never;

/**
 * The shape a protocol version must have: three dot-separated non-negative
 * integers, none of them zero-padded.
 *
 * Deliberately **not** the full SemVer grammar. A pre-release suffix or build
 * metadata (`1.0.0-beta.1+sha`) has no meaning for a handshake that compares
 * major components, and accepting one would invite two clients to disagree about
 * whether they match. Three integers is the whole vocabulary, and a version that
 * cannot be written in it is a producer bug rather than a value to interpret.
 *
 * Leading zeros are rejected (`01.0.0` fails) so that one version has exactly
 * one spelling: `GET /health` responses, stored session records and log lines
 * are compared as strings in places this package does not control.
 *
 * The expression has no `g` flag, so {@link RegExp.test} is stateless and this
 * constant can be shared freely — a global regular expression would carry
 * `lastIndex` between calls and answer differently on alternate invocations.
 *
 * @see {@link protocolVersionSchema} for the Zod form used inside payload
 * schemas.
 */
export const PROTOCOL_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/**
 * The longest string {@link protocolVersionSchema} will consider.
 *
 * A version of `major.minor.patch` integers needs nothing like this much room,
 * and the ceiling means a frame that arrived with a megabyte in its `version`
 * field is refused on a length check rather than matched against a pattern. The
 * pattern itself is linear and has no backtracking behaviour to exploit; this is
 * about bounding the work and the log line, not about a regular-expression
 * hazard.
 */
const MAX_PROTOCOL_VERSION_LENGTH = 32;

/**
 * The protocol version as a payload field.
 *
 * Used by the `client.hello` message schema in `messages/agent.ts` and by the
 * `GET /health` response schema in `http.ts` — the two places a version crosses
 * a process boundary. Both validate rather than repair: a malformed version is
 * refused, never coerced into something plausible.
 */
export const protocolVersionSchema = z
  .string()
  .max(MAX_PROTOCOL_VERSION_LENGTH, {
    error: 'expected a protocol version of at most 32 characters',
  })
  .regex(PROTOCOL_VERSION_PATTERN, {
    error:
      'expected a protocol version of the form major.minor.patch, with non-negative integers and no leading zeros',
  });

/**
 * A validated protocol version string.
 *
 * Structurally a `string`; the name is what carries the intent into the message
 * and route schemas that embed it, and into the session record that remembers
 * which version a client announced.
 */
export type ProtocolVersion = z.infer<typeof protocolVersionSchema>;

/**
 * Validates an unknown value as a {@link ProtocolVersion}, without throwing.
 *
 * This is how a version that arrived from somewhere else — the first frame of a
 * WebSocket connection, a `GET /health` response read by a client deciding
 * whether to talk to this service — becomes a typed value. The failure is a
 * {@link DebuggenError} with code `'PROTOCOL_INVALID_MESSAGE'`, built by
 * {@link protocolParseError}, so the rejected string never appears in the
 * message, the hint, the details or the payload that crosses the wire
 * (AAP §0.5.2).
 *
 * Consumers: `apps/local-service/src/server/auth.ts` on the handshake path, and
 * `client/http-client.ts` when it reads a health response.
 *
 * @param value Any value believed to be a protocol version.
 * @returns `ok(version)` with the validated string, or `err(error)` describing
 * the shape of the failure.
 *
 * @example
 * ```ts
 * const parsed = parseProtocolVersion(frame.payload.version);
 * if (!parsed.ok) {
 *   socket.close(4401, parsed.error.code);
 *   return;
 * }
 * ```
 */
export function parseProtocolVersion(value: unknown): Result<ProtocolVersion, DebuggenError> {
  const parsed = protocolVersionSchema.safeParse(value);

  if (parsed.success) {
    return ok(parsed.data);
  }

  return err(
    protocolParseError(
      'PROTOCOL_INVALID_MESSAGE',
      'Invalid protocol version',
      parsed.error.issues,
      'A protocol version is three dot-separated non-negative integers, for example 1.0.0.',
    ),
  );
}

/**
 * Whether a client claiming `claimed` can talk to a peer speaking `current`.
 *
 * True when both strings parse against {@link PROTOCOL_VERSION_PATTERN} **and**
 * their major components are equal; false otherwise, and never a throw — a
 * malformed, empty or absurdly long `claimed` is simply incompatible, which is
 * the only answer a handshake can act on.
 *
 * This is the predicate `apps/local-service/src/server/auth.ts` applies to a
 * `client.hello` frame. A refusal closes the socket with code 4401, the constant
 * for which lives with the handshake message in `messages/agent.ts` rather than
 * here: this module decides *whether* a version matches and says nothing about
 * how a transport reports that it did not.
 *
 * The guard on the second line is the drift check {@link PROTOCOL_VERSION_MAJOR}
 * refers to. If this build's own version string and its parsed major ever
 * disagree — a hand-edited bundle, a patch applied to the published
 * JavaScript — the function fails closed and refuses every client rather than
 * silently accepting a major it cannot name.
 *
 * @param claimed The version the other side announced.
 * @param current The version this side speaks. Defaults to
 * {@link PROTOCOL_VERSION} and is a parameter so that a test, and a client
 * checking a peer against a version other than its own, need no module mock.
 * @returns `true` when the two majors match, `false` in every other case.
 *
 * @example
 * ```ts
 * isCompatibleProtocolVersion('1.4.2'); // true  — same major
 * isCompatibleProtocolVersion('2.0.0'); // false — breaking major
 * isCompatibleProtocolVersion('nope');  // false — not a version at all
 * ```
 */
export function isCompatibleProtocolVersion(
  claimed: string,
  current: string = PROTOCOL_VERSION,
): boolean {
  const claimedMajor = majorComponentOf(claimed);
  const currentMajor = majorComponentOf(current);

  if (claimedMajor === undefined || currentMajor === undefined) {
    return false;
  }

  if (current === PROTOCOL_VERSION && currentMajor !== PROTOCOL_VERSION_MAJOR) {
    return false;
  }

  return claimedMajor === currentMajor;
}

/**
 * The major component of a version string, or `undefined` when the string is not
 * a version this protocol recognises.
 *
 * Module-private: the public question is {@link isCompatibleProtocolVersion},
 * and a caller that wants the number for this build already has
 * {@link PROTOCOL_VERSION_MAJOR}. The safe-integer check refuses a major with
 * more digits than a `number` can represent exactly, which the pattern alone
 * would admit.
 */
function majorComponentOf(version: string): number | undefined {
  if (version.length > MAX_PROTOCOL_VERSION_LENGTH) {
    return undefined;
  }

  const match = PROTOCOL_VERSION_PATTERN.exec(version);
  const major = match?.[1];

  if (major === undefined) {
    return undefined;
  }

  const parsed = Number.parseInt(major, 10);

  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

// ---------------------------------------------------------------------------
// Section B — the canonical timestamp primitive
// ---------------------------------------------------------------------------

/**
 * A point in time on the product's one time base: Unix epoch **milliseconds** as
 * a double, with sub-millisecond precision preserved (AAP §0.2.3).
 *
 * This is the primitive behind the envelope's `ts` field and behind every
 * `createdAt`, `updatedAt`, `appliedAt`, `startedAt`, `stoppedAt` and
 * `expiresAt` field in this package. Using one schema for all of them is what
 * lets a browser interaction, a server span and a session row be ordered against
 * each other without a caller having to know which producer wrote which field.
 *
 * Three decisions are visible in the schema and all three matter:
 *
 * - **Not integer-constrained.** A browser producer computes
 *   `performance.timeOrigin + entry.startTime` and a Node producer converts an
 *   OpenTelemetry high-resolution tuple; both carry a fraction, and rounding it
 *   away here would flatten the sub-millisecond ordering the correlator relies
 *   on. `z.int()` is therefore deliberately not used.
 * - **Finite.** `NaN`, `Infinity` and `-Infinity` are refused. Zod 4's
 *   `z.number()` already rejects all three on its own, and the bounds below
 *   refuse the infinities a second time, so neither can reach a timeline and
 *   turn every relative offset into nothing.
 * - **Bounded by the telemetry package's own constants.** {@link MIN_EPOCH_MS}
 *   and {@link MAX_EPOCH_MS} are *imported* from `@debuggen/telemetry`, never
 *   restated: they are the numbers `packages/telemetry/src/schema/event.ts`
 *   validates a span's `startTime` against, and sharing them is what makes a
 *   producer's unit mistake fail identically at both layers. A relative
 *   `performance.now()` value (order 1e3–1e7), a seconds-precision epoch value
 *   (order 1.7e9) and a microsecond- or nanosecond-scale value (order 1e15,
 *   1e18) are all rejected here for the same reason they are rejected there.
 *
 * Durations elsewhere in the product are milliseconds too — `duration` on a
 * telemetry event, every metric in a capture summary — and `nowEpochMs()` from
 * `@debuggen/shared` is the canonical producer of a value for this schema. It is
 * not re-exported here: a module that needs to *stamp* a message imports it
 * directly from `@debuggen/shared`, while this package's business is checking
 * what arrived.
 */
export const epochMsSchema = z
  .number()
  .min(MIN_EPOCH_MS, {
    error:
      'expected a Unix epoch timestamp in milliseconds (a relative performance timestamp or a seconds-precision epoch value is too small)',
  })
  .max(MAX_EPOCH_MS, {
    error:
      'expected a Unix epoch timestamp in milliseconds (a microsecond- or nanosecond-scale timestamp is too large)',
  });

/**
 * A validated epoch-millisecond timestamp.
 *
 * Structurally a `number`. Exported so a hand-written type in this package or in
 * a consuming app can name the intent — `readonly createdAt: EpochMs` says what
 * `readonly createdAt: number` does not — without restating the schema.
 */
export type EpochMs = z.infer<typeof epochMsSchema>;

// ---------------------------------------------------------------------------
// Section C — leak-free error construction
// ---------------------------------------------------------------------------

/**
 * How many issues {@link describeZodIssues} renders before it summarises the
 * rest.
 *
 * A rejected message can carry hundreds of issues — one per element of a
 * telemetry batch, for instance — and the string this function returns ends up
 * in a pino log line, in the DevTools panel's connection status and in the VS
 * Code output channel. Ten is enough to identify the producer's mistake and
 * bounded enough that none of the three is flooded.
 */
const MAX_RENDERED_ISSUES = 10;

/** How many path segments are rendered before the path is elided. */
const MAX_RENDERED_PATH_SEGMENTS = 8;

/** How many unrecognised key names are listed before the list is summarised. */
const MAX_RENDERED_KEYS = 5;

/** How many permitted literal values are listed before the list is elided. */
const MAX_RENDERED_VALUES = 8;

/**
 * The longest a single rendered fragment — one path segment, one key name, one
 * permitted literal — may be before it is truncated.
 *
 * Field names in this product are short. A long one is either a record key from
 * the rejected payload or a producer bug, and in both cases forty characters is
 * plenty to recognise it by while keeping any single fragment bounded.
 */
const MAX_RENDERED_FRAGMENT_LENGTH = 40;

/** What an issue on the value itself, rather than on one of its fields, is called. */
const ROOT_PATH_LABEL = '<root>';

/** What {@link describeZodIssues} answers for an empty issue list. */
const NO_ISSUES_DESCRIPTION = 'no issues reported';

/** Appended to anything this module shortened, so a reader knows it was shortened. */
const ELISION_MARKER = '…';

/** Stands in for a name this module declined to echo. See {@link renderName}. */
const REDACTED_NAME = '<name>';

/**
 * The shape a name must have to be rendered verbatim: a plain identifier-ish
 * token of at most sixty-four characters.
 *
 * Applied to every *name* a rendered issue can contain — an expected type, a
 * string format, a discriminator key, an unrecognised key, a `z.custom` label —
 * so that a name which does not look like a field name is replaced by
 * {@link REDACTED_NAME} rather than echoed. The AAP treats key names as schema
 * domain rather than user data (§0.5.2 excludes *values*, and the redaction
 * layer itself keeps header names while redacting header values), and this
 * pattern is what keeps that distinction honest when the "key" came from a
 * record-typed payload instead of a schema declaration.
 */
const SAFE_NAME_PATTERN = /^[A-Za-z0-9_$.-]{1,64}$/;

/**
 * Renders a validation failure as a single, bounded, **leak-free** line.
 *
 * This is the only sanctioned way to describe a Zod rejection in this package,
 * and it is why the helper lives in the module nothing else in the package
 * imports from. Its consumers are `analysis.ts`, `session-record.ts`,
 * `envelope.ts` (`parseMessage`), `http.ts`, every `messages/*.ts` parse helper
 * and `client/http-client.ts`; {@link protocolParseError} is the wrapper most of
 * them actually call.
 *
 * ## What it renders
 *
 * One entry per issue, in the order Zod reported them — which is the order the
 * schema declares its fields, so a producer can read the output against its own
 * code — joined with `'; '`:
 *
 * ```text
 * payload.events[3].startTime (too_small origin=number min=1577836800000)
 * payload.session (invalid_type expected=object)
 * <root> (unrecognized_keys keys=sessionID, tabID)
 * ```
 *
 * Beyond the path and the code, only **schema-declared metadata** is added, per
 * issue code: the expected type of an `invalid_type`; the permitted literals of
 * an `invalid_value`, which are by definition the schema's own; the string
 * format of an `invalid_format`; the declared bound of a `too_small` or
 * `too_big`; the divisor of a `not_multiple_of`; the number of failed branches
 * and the discriminator key of an `invalid_union`; the number of nested issues
 * of an `invalid_key` or `invalid_element`; the label of a `custom` issue, which
 * for this package's {@link opaqueSchema} is the upstream type's name.
 *
 * ## What it never renders, and why
 *
 * **No rejected value, by any route.** Not `issue.message`, not `issue.input`,
 * not a `received` value, and no other property that echoes the data. A
 * validation error is raised far below the redaction layer
 * (`packages/telemetry/src/redaction/`) and far below the outbound guard
 * (`packages/model-provider/src/redact-guard.ts`), so neither can rescue a value
 * that leaked into an error message — and the values flowing through these
 * schemas are exactly the ones the privacy model protects (AAP §0.5.2):
 * telemetry attributes, redacted SQL, URLs with query parameters, React prop and
 * state summaries, and model output. Zod's default messages are helpful but do
 * quote received values for several codes, which is why the message is rebuilt
 * here instead of forwarded.
 *
 * The one datum taken from the payload rather than from the schema is a **field
 * name**: the segments of a record-typed path, and the key names of an
 * `unrecognized_keys` issue, which AAP §0.5.2 directs this function to include.
 * That is the same line the redaction layer itself draws — a header's name is
 * kept and only its value is replaced — and it is what makes the common producer
 * mistake (`sessionID` for `sessionId`) diagnosable at all. Even there,
 * {@link renderName} refuses a name that does not look like a field name, and
 * every name is length-bounded, so a record key carrying something other than an
 * identifier is replaced rather than echoed.
 *
 * The result is bounded on every axis: at most {@link MAX_RENDERED_ISSUES}
 * entries, each with at most {@link MAX_RENDERED_PATH_SEGMENTS} path segments,
 * each fragment at most {@link MAX_RENDERED_FRAGMENT_LENGTH} characters, so a
 * megabyte of malformed payload cannot become a megabyte of log.
 *
 * Pure and total: it allocates nothing the caller owns, never throws for any
 * input — including a symbol-keyed path, a nested union or an issue code this
 * version of Zod added after this code was written — and answers
 * `'no issues reported'` for an empty list, which is a state a well-behaved
 * caller never reaches but a defensive one may.
 *
 * @param issues The issues from a `ZodError`. Accepted as a `readonly` array so
 * `error.issues` can be passed without a copy.
 * @returns A single line describing every rendered issue.
 */
export function describeZodIssues(issues: readonly z.core.$ZodIssue[]): string {
  if (issues.length === 0) {
    return NO_ISSUES_DESCRIPTION;
  }

  const rendered = issues
    .slice(0, MAX_RENDERED_ISSUES)
    .map((issue) => `${formatIssuePath(issue.path)} (${issue.code}${describeIssueMetadata(issue)})`)
    .join('; ');

  const omitted = issues.length - MAX_RENDERED_ISSUES;

  return omitted > 0 ? `${rendered}; ${ELISION_MARKER}and ${String(omitted)} more` : rendered;
}

/**
 * Builds the {@link DebuggenError} a parse helper in this package returns.
 *
 * The one constructor for a protocol-level validation failure, so that all six
 * reporting sites produce the same shape and obey the same privacy rule without
 * each remembering to. The message is `` `${prefix}: ${describeZodIssues(issues)}` ``
 * — a caller's short statement of what it was parsing, then the leak-free issue
 * description — and `details` carries the same information in structured form,
 * as `{ path, code }` records built by the same rules, for a log consumer that
 * would rather not parse a sentence.
 *
 * What is **not** attached: the `ZodError` itself, the rejected value, and any
 * issue message. `DebuggenError.toPayload()` is what crosses the wire as the
 * `error` message payload and it returns exactly `{ code, message, hint? }`, so
 * everything a remote client can see has passed through
 * {@link describeZodIssues} first.
 *
 * @param code The failure being reported, from the closed error-code vocabulary
 * of `@debuggen/shared`. A transport-level rejection is
 * `'PROTOCOL_INVALID_MESSAGE'`, which is what the envelope, message, HTTP and
 * client helpers pass; a caller at a stage boundary may pass the code that
 * describes its own operation instead — `'MODEL_OUTPUT_INVALID'` for a
 * model-authored artifact, `'STORE_ERROR'` for a row read back from the session
 * store — because the code is what a user interface switches on.
 * @param prefix A short statement of what failed to validate, without trailing
 * punctuation: `'Invalid session record'`, `'Invalid telemetry batch'`.
 * @param issues The issues from the `ZodError`.
 * @param hint An optional developer-facing next step. Forwarded verbatim by
 * `DebuggenError.toPayload()`, so it must be as free of rejected data as the
 * message is.
 * @returns A `DebuggenError` safe to log, to persist with a session and to send
 * to another process.
 *
 * @example
 * ```ts
 * const parsed = messageEnvelopeSchema.safeParse(frame);
 * if (!parsed.success) {
 *   return err(
 *     protocolParseError('PROTOCOL_INVALID_MESSAGE', 'Invalid message envelope', parsed.error.issues),
 *   );
 * }
 * ```
 */
export function protocolParseError(
  code: DebuggenErrorCode,
  prefix: string,
  issues: readonly z.core.$ZodIssue[],
  hint?: string,
): DebuggenError {
  const message = `${prefix}: ${describeZodIssues(issues)}`;

  const details = {
    issueCount: issues.length,
    issues: issues.slice(0, MAX_RENDERED_ISSUES).map((issue) => ({
      path: formatIssuePath(issue.path),
      code: issue.code,
    })),
  };

  // `hint` is spread in only when present: `exactOptionalPropertyTypes` is on
  // and `DebuggenErrorOptions.hint` is declared `hint?: string`, so an explicit
  // `undefined` is a type error rather than an absent hint.
  return new DebuggenError(code, message, hint === undefined ? { details } : { details, hint });
}

/**
 * Renders an issue's path as a dotted, bracketed field path.
 *
 * `['payload', 'events', 3, 'startTime']` becomes `payload.events[3].startTime`,
 * an empty path becomes {@link ROOT_PATH_LABEL}, and a symbol segment becomes
 * `[symbol]` — a symbol cannot be interpolated without throwing, and its
 * description is not worth the risk on a failure path.
 *
 * Segments are field names: for an object schema they come from the schema's own
 * declaration, and for a record-typed payload they are the payload's keys, which
 * the privacy model treats the way it treats a header name rather than a header
 * value. {@link renderName} still applies, so a segment that does not look like
 * a field name is replaced rather than echoed, and both the segment count and
 * each segment's length are bounded.
 */
function formatIssuePath(path: readonly PropertyKey[]): string {
  if (path.length === 0) {
    return ROOT_PATH_LABEL;
  }

  const rendered = path
    .slice(0, MAX_RENDERED_PATH_SEGMENTS)
    .map((segment) => formatPathSegment(segment))
    .join('');

  // The first segment is rendered with a leading separator like every other, so
  // that one function handles both positions; the separator is dropped here.
  const withoutLeadingDot = rendered.startsWith('.') ? rendered.slice(1) : rendered;

  return path.length > MAX_RENDERED_PATH_SEGMENTS
    ? `${withoutLeadingDot}${ELISION_MARKER}`
    : withoutLeadingDot;
}

/** Renders one path segment: `[0]` for an index, `.field` for a key. */
function formatPathSegment(segment: PropertyKey): string {
  if (typeof segment === 'number') {
    return `[${String(segment)}]`;
  }

  if (typeof segment === 'symbol') {
    return '[symbol]';
  }

  return `.${renderName(segment)}`;
}

/**
 * The per-code metadata appended to an issue's path and code, or an empty string
 * for a code with nothing schema-declared to add.
 *
 * Every branch reads only fields the *schema* put on the issue. The `default`
 * branch is what keeps this total across Zod versions: an issue code added later
 * is described by its path and code alone rather than by whatever unknown fields
 * it carries.
 */
function describeIssueMetadata(issue: z.core.$ZodIssue): string {
  switch (issue.code) {
    case 'invalid_type':
      return ` expected=${renderName(issue.expected)}`;

    case 'invalid_value':
      return ` allowed=${renderLiteralList(issue.values)}`;

    case 'invalid_format':
      return ` format=${renderName(issue.format)}`;

    case 'unrecognized_keys':
      return ` keys=${renderKeyList(issue.keys)}`;

    case 'too_small':
      return ` origin=${renderName(issue.origin)} min=${String(issue.minimum)}`;

    case 'too_big':
      return ` origin=${renderName(issue.origin)} max=${String(issue.maximum)}`;

    case 'not_multiple_of':
      return ` divisor=${String(issue.divisor)}`;

    case 'invalid_union':
      return ` branches=${String(issue.errors.length)}${
        issue.discriminator === undefined ? '' : ` discriminator=${renderName(issue.discriminator)}`
      }`;

    // A map or record key, and a map or set element, that failed its own
    // schema. The nested issue count locates the failure; the offending key of
    // an `invalid_element` is deliberately not rendered, because unlike an
    // object's field name it is an arbitrary value from the payload.
    case 'invalid_key':
    case 'invalid_element':
      return ` origin=${renderName(issue.origin)} nested=${String(issue.issues.length)}`;

    case 'custom':
      return renderCustomLabel(issue.params);

    default:
      return '';
  }
}

/**
 * Renders a name verbatim when it looks like a field name, and
 * {@link REDACTED_NAME} when it does not.
 *
 * The single gate every name in a rendered issue passes through. A schema's own
 * vocabulary — `'string'`, `'object'`, `'regex'`, `'traceId'` — always passes; a
 * record key carrying something else does not become part of a log line.
 */
function renderName(value: string): string {
  return SAFE_NAME_PATTERN.test(value)
    ? truncateFragment(value)
    : `${REDACTED_NAME}${ELISION_MARKER}`;
}

/**
 * Renders the unrecognised-key list of an `unrecognized_keys` issue.
 *
 * These names come from the payload, not from the schema, and including them is
 * the one payload-derived datum AAP §0.5.2 sanctions here: an extra or
 * misspelled field is otherwise indistinguishable from a schema mismatch, and a
 * key *name* is what the redaction layer keeps when it replaces a header's
 * value. {@link renderName} still gates each one and the list is bounded, so
 * neither a non-identifier key nor a payload with hundreds of extra fields can
 * turn this into an echo of the data.
 */
function renderKeyList(keys: readonly string[]): string {
  const rendered = keys
    .slice(0, MAX_RENDERED_KEYS)
    .map((key) => renderName(key))
    .join(', ');
  const omitted = keys.length - MAX_RENDERED_KEYS;

  return omitted > 0 ? `${rendered} +${String(omitted)} more` : rendered;
}

/**
 * Renders the permitted values of an `invalid_value` issue.
 *
 * These are the schema's declared literals — the members of an enum, the value
 * of a `z.literal`, the discriminant of a union branch — so they are safe by
 * construction: they came from this repository's own source, never from the
 * payload. They are still bounded in count and length, because a large enum
 * would otherwise dominate the line.
 */
function renderLiteralList(values: readonly unknown[]): string {
  const rendered = values
    .slice(0, MAX_RENDERED_VALUES)
    .map((value) => renderLiteral(value))
    .join('|');

  return values.length > MAX_RENDERED_VALUES ? `${rendered}${ELISION_MARKER}` : rendered;
}

/**
 * Renders one schema-declared literal by its runtime type.
 *
 * Branching on `typeof` rather than reaching for `String(value)` wholesale keeps
 * the function total — a symbol would throw when interpolated, and an object
 * would stringify to something meaningless — and keeps the output predictable
 * for the enum and literal values this is actually called with.
 */
function renderLiteral(value: unknown): string {
  switch (typeof value) {
    case 'string':
      return `'${truncateFragment(value)}'`;

    case 'number':
    case 'bigint':
    case 'boolean':
      return String(value);

    case 'undefined':
      return 'undefined';

    case 'object':
      return value === null ? 'null' : 'object';

    default:
      // A symbol or a function: describable by type, never by value.
      return typeof value;
  }
}

/**
 * Renders the label a `custom` issue carries in its `params`, when it has one.
 *
 * {@link opaqueSchema} puts the upstream type's name there deliberately, so a
 * rejected embedded value says which shape it failed to be. The value is read as
 * `unknown` and gated by {@link renderName}, because `params` is an open bag any
 * `z.custom` in any package may fill.
 */
function renderCustomLabel(params: unknown): string {
  if (!isPlainRecord(params)) {
    return '';
  }

  const label = params['label'];

  return typeof label === 'string' ? ` label=${renderName(label)}` : '';
}

/** Shortens a single rendered fragment, marking it when it was shortened. */
function truncateFragment(fragment: string): string {
  return fragment.length <= MAX_RENDERED_FRAGMENT_LENGTH
    ? fragment
    : `${fragment.slice(0, MAX_RENDERED_FRAGMENT_LENGTH)}${ELISION_MARKER}`;
}

// ---------------------------------------------------------------------------
// Section D — embedding an upstream type that owns no Zod schema
// ---------------------------------------------------------------------------

/**
 * Whether a value is a non-null, non-array object.
 *
 * The default check behind {@link opaqueSchema}, and useful on its own wherever
 * this package has to look at an unknown bag before trusting it — reading a
 * `z.custom` issue's `params`, for instance. It rejects `undefined`, `null`, an
 * array and every primitive, which is precisely the set a `z.custom` schema
 * would otherwise admit.
 *
 * @param value Any value.
 * @returns `true` when `value` is a plain object, narrowing it to
 * `Record<string, unknown>`.
 */
export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Builds a guard that accepts a plain object carrying every named key.
 *
 * The intended companion of {@link opaqueSchema}: it turns "this field holds a
 * `MetricValue`" into a check that at least looks at the value, without this
 * package restating a shape whose owner is `@debuggen/telemetry`. Presence only,
 * by own property — no type assertions about what a key holds — so an upstream
 * change that widens a field's type does not break the protocol layer, while a
 * value from the wrong producer entirely still fails.
 *
 * `Object.hasOwn` rather than `in`, so a key inherited from a prototype cannot
 * satisfy the check.
 *
 * @param requiredKeys The keys the value must carry. Naming one or two
 * identifying keys is the intent; naming every key would be the duplicated
 * definition this helper exists to avoid.
 * @returns A shallow guard suitable for {@link opaqueSchema} and
 * {@link opaqueArraySchema}.
 *
 * @example
 * ```ts
 * // In messages/telemetry.ts, for a shape telemetry owns the type of:
 * const metricSchema = opaqueSchema<MetricValue>('MetricValue', recordWithKeys('id', 'available'));
 * const treeSchema = opaqueSchema<ComponentTreeSnapshot>(
 *   'ComponentTreeSnapshot',
 *   recordWithKeys('roots'),
 * );
 * ```
 */
export function recordWithKeys(...requiredKeys: readonly string[]): (value: unknown) => boolean {
  return (value: unknown): boolean =>
    isPlainRecord(value) && requiredKeys.every((key) => Object.hasOwn(value, key));
}

/**
 * A schema that embeds an upstream **type** whose owner never gave it a Zod
 * schema, checking its shape shallowly and naming it in the failure.
 *
 * ## Why this exists
 *
 * Several messages and route responses in this package carry aggregate shapes
 * that `@debuggen/telemetry` defines as TypeScript interfaces only —
 * `CaptureSummary`, `MetricValue`, `RenderStat`, `ComponentTreeSnapshot`,
 * `RequestGroup`, `QueryGroup`, `StateTransition`, `DependencyGraphData`,
 * `TraceTree` and their members. The alternative to this helper is a
 * hand-written Zod schema for each of them here, which is exactly the second
 * definition AAP §0.2.3 forbids: "Types that cross a process boundary are
 * defined exactly once… Any second definition of these shapes in an app is a
 * defect." So the **type** keeps coming from its owner through an
 * `import type`, and this helper supplies the runtime check.
 *
 * Everything that *does* have a schema must be imported as one instead — the
 * telemetry event schemas, the plan, modification-record, target, understanding,
 * hook-config, signals and readiness schemas of `@debuggen/instrumentation`, the
 * panel specification, data query, fact, hypothesis and event-reference schemas
 * of `@debuggen/panel-schema`, and the source-location schema of
 * `@debuggen/shared`. Reaching for `opaqueSchema` where a real schema exists
 * throws away validation the product already owns.
 *
 * ## What it checks, and what it honestly does not
 *
 * A **shallow** structural check: by default {@link isPlainRecord}, or whatever
 * `guard` the caller passes — {@link recordWithKeys} builds the common one. A
 * `CaptureSummary` with a field of the wrong type therefore passes, and that is
 * a deliberate trade rather than an oversight: these values are produced inside
 * this machine's own trusted processes by the package that defines them, their
 * authoritative validation lives with that producer, and the failure mode this
 * check does catch is the one that actually happens at a transport boundary — a
 * missing field, `undefined` where an object was expected, an array where a
 * record was expected, a JSON round-trip that dropped the value.
 *
 * The check is never omitted, and that is load-bearing: `z.custom<T>()` with no
 * check **accepts `undefined`**, so a field declared without one would let an
 * absent value through as a valid `T` and the first property access downstream
 * would throw far from the cause.
 *
 * The failure message is built from `label` alone (`expected CaptureSummary`),
 * never from the rejected value, per the privacy rule this module exists to keep
 * (AAP §0.5.2). The label is also attached to the issue's `params`, which is
 * what lets {@link describeZodIssues} render `label=CaptureSummary` for a
 * rejection — the one place a `custom` issue says anything beyond its path.
 *
 * ## Typing
 *
 * The return annotation is `z.ZodCustom<T, T>`, the type `z.custom<T>()` itself
 * returns under Zod 4.6.5. It is stated rather than inferred so the contract is
 * visible in the emitted declarations, and it is what makes
 * `z.infer<typeof someField>` resolve to exactly `T` — not `unknown`, not `any`.
 * A field declared with `opaqueSchema<CaptureSummary>('CaptureSummary')` gives a
 * parsed message a `CaptureSummary`, which is the whole point: the app code that
 * receives it sees the owner's type.
 *
 * @typeParam T The upstream type being embedded. Always pass it explicitly;
 * there is no argument for the compiler to infer it from.
 * @param label The upstream type's name, for the failure message and the issue
 * params. Use the exact exported name, so a rejection is greppable.
 * @param guard The shape check. Defaults to {@link isPlainRecord}; pass an
 * explicit guard for a shape that is not a plain object (an array, a string
 * identifier) or when a key or two should be required.
 * @returns A schema that validates shallowly and infers as `T`.
 *
 * @example
 * ```ts
 * import type { CaptureSummary } from '@debuggen/telemetry';
 *
 * const captureSummarySchema = opaqueSchema<CaptureSummary>('CaptureSummary');
 * // z.infer<typeof captureSummarySchema> is CaptureSummary
 * ```
 */
export function opaqueSchema<T>(
  label: string,
  guard: (value: unknown) => boolean = isPlainRecord,
): z.ZodCustom<T, T> {
  return z.custom<T>(guard, {
    // A constant string, not a function of the issue: Zod interpolates nothing
    // into it, so the rejected value cannot reach the message by any route.
    error: `expected ${label}`,
    // Read back by `renderCustomLabel` so a rendered issue can name the shape.
    params: { label },
  });
}

/**
 * The array form of {@link opaqueSchema}: a schema for a list of an upstream
 * type that owns no Zod schema.
 *
 * Built as `z.array(opaqueSchema<T>(…))` rather than as one `z.custom` over the
 * whole array, deliberately. Zod then reports a per-index issue path, which
 * {@link describeZodIssues} renders as `metrics[3] (custom label=MetricValue)` —
 * the difference between "the metrics array is wrong" and "the fourth metric is
 * wrong" when a producer has to be fixed. It also rejects a non-array with a
 * plain `invalid_type` issue, which a single custom check would have had to
 * describe for itself.
 *
 * The inferred type is `T[]`, mutable rather than `readonly`, matching the
 * arrays the service's store code and the aggregate producers already hand
 * around; a consumer that wants a `readonly` view can widen at its own boundary,
 * whereas a `readonly` inference here would force a copy at every producer.
 *
 * @typeParam T The upstream element type being embedded.
 * @param label The element type's name, used for each element's failure.
 * @param itemGuard The per-element shape check. Defaults to
 * {@link isPlainRecord}.
 * @returns A schema that validates the array and each element shallowly, and
 * infers as `T[]`.
 *
 * @example
 * ```ts
 * import type { MetricValue } from '@debuggen/telemetry';
 *
 * const metricsSchema = opaqueArraySchema<MetricValue>(
 *   'MetricValue',
 *   recordWithKeys('id', 'available'),
 * );
 * // z.infer<typeof metricsSchema> is MetricValue[]
 * ```
 */
export function opaqueArraySchema<T>(
  label: string,
  itemGuard: (value: unknown) => boolean = isPlainRecord,
): z.ZodArray<z.ZodCustom<T, T>> {
  return z.array(opaqueSchema<T>(label, itemGuard));
}
