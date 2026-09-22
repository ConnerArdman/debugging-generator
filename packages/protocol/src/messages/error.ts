/**
 * The single definition of this product's **wire error payload**, and the leaf
 * module of `packages/protocol/src/messages`.
 *
 * ## The contract
 *
 * AAP §0.4.2 names one message for reporting a failure across a process
 * boundary:
 *
 * ```text
 * `error` · WS · service → any client · { code, message, ref? }
 * ```
 *
 * {@link errorPayloadSchema} is that payload, and it is the *only* definition of
 * it. AAP §0.9.1 lists `packages/protocol/src/messages/**` among the
 * single-definition schema sources, so a second declaration of this shape — in
 * the service, in either extension, in the panel or in a test helper — is a
 * defect rather than a convenience. Three modules in this package consume it
 * instead of restating it:
 *
 * - `envelope.ts` reaches it through `./index.js`, which spreads
 *   {@link ERROR_MESSAGE_PAYLOADS} into its type-keyed payload registry, so the
 *   `error` frame validates through the same discriminated union as every other
 *   message.
 * - `../http.ts` reuses it verbatim as the body of an HTTP error response: a
 *   route that refuses a request answers with exactly the object a WebSocket
 *   client would have received, which is why a client needs one error renderer
 *   rather than two.
 * - `./instrumentation.ts` nests it inside the `instrumentation.failed` payload
 *   (`{ sessionId, error: { code, message, hint } }`), the one place AAP §0.4.2
 *   embeds this shape in a larger message.
 *
 * ## Why this module imports nothing from its own folder
 *
 * This file is the folder's leaf. Every sibling may import it; it imports no
 * sibling, and it must not: `../envelope.ts` imports `./index.js`, which
 * imports every module in this folder, so a single upward or sideways import
 * from here would close a cycle through the envelope and leave the payload the
 * envelope needs first unreachable. Its whole import block is therefore `zod`,
 * `@debuggen/shared` (the package that *owns* the error vocabulary) and
 * `../version.js` (the package's cycle-breaker, which nothing in the package
 * may import from). `eslint.config.js` enforces the package-level half of that
 * edge list with `no-restricted-imports`; the folder-level half is this
 * paragraph and the review that reads it.
 *
 * The same layering explains what is *not* here. The WebSocket close code a
 * refused handshake uses — 4401 for an unauthenticated connection (AAP §0.5.6)
 * — is a transport constant that lives with the handshake message in
 * `./agent.ts`. A connection that is closed never receives a frame, so it never
 * receives this payload either, and the two concerns stay apart.
 *
 * ## Why the schema, and not `DebuggenError`, is the wire contract
 *
 * The shape below is {@link DebuggenError.toPayload}'s return value plus one
 * field, `ref`. That is deliberate: `DebuggenError` is a class, and the four
 * cooperating processes — the local service, the VS Code extension host and its
 * webview, the Chrome service worker and its DevTools panel, and the Node
 * preload inside the target project's dev server — each bundle their own copy of
 * it. An `instanceof` check cannot cross that boundary (which is why the class
 * carries a string-keyed brand at all), so what crosses is a plain JSON object
 * validated against this schema at the receiving end. The compile-time drift
 * guard below ({@link ErrorPayloadDriftAssertions}) ties the two together, so a
 * field added to the class without being added here fails the build instead of
 * being dropped silently by the parser.
 *
 * ## Two product guarantees this file is part of
 *
 * - **No rejected value in a failure message** (AAP §0.5.2).
 *   {@link parseErrorPayload} builds its rejection through
 *   `protocolParseError`, whose message comes from Zod issue paths, issue codes
 *   and schema-declared metadata only. A validation error is raised below the
 *   redaction layer and below the outbound model guard, so neither can rescue a
 *   value that leaked into an error string; nothing here echoes its input.
 * - **A failure is never presented as a success** (AAP §0.5.5). This payload is
 *   the machine-readable carrier of the developer-facing failures that section
 *   tabulates — an instrumentation signal that could not be installed, a model
 *   provider that is unavailable, a capture that yielded nothing — and `code` is
 *   what a user interface switches on to say so. The converse matters just as
 *   much and is *not* implemented here because it must not be: a **fallback
 *   panel** (`PanelSpec.meta.fallback === true`) is a *success*. The
 *   panel-generation path validated the model's output, rejected it, and
 *   assembled a deterministic panel from the captured data instead; the client
 *   receives `panel.generated` with the fallback banner, never an `error`
 *   frame. Sending one for a fallback would report a failure the developer does
 *   not have.
 *
 * ## House rules this module observes
 *
 * - **Environment-neutral.** `packages/protocol/tsconfig.json` declares
 *   `types: []` and `tsup.config.ts` builds with `platform: 'neutral'`: no
 *   `node:*` builtin, no `@debuggen/shared/node` entry and no `ws` import
 *   appears anywhere in this package, because this bundle is loaded by a Node
 *   process and by three page-side bundles alike.
 * - **No import-time side effects.** Every export is a declaration.
 *   `package.json` declares `sideEffects: false`.
 * - **Byte-faithful parsing.** No `.transform()`, no `.coerce`, no `.default()`
 *   and no `.catch()`. A schema validates; it never rewrites. What a producer
 *   sent is what a consumer reads, so a payload survives a JSON round trip
 *   unchanged and an omitted optional stays omitted rather than becoming a key
 *   whose value is `undefined`.
 *
 * Every export is named; there is no default export.
 */

import { z } from 'zod';

import { DEBUGGEN_ERROR_CODES, err, ok } from '@debuggen/shared';
import type { DebuggenError, Result } from '@debuggen/shared';

import { protocolParseError } from '../version.js';

// ---------------------------------------------------------------------------
// Field bounds
//
// The canonical bounds of this folder, stated once each as a named constant so
// that the schema, the message text a rejection carries and this comment cannot
// drift apart. Every sibling message module uses the same three numbers for the
// same three kinds of field, which is what keeps a payload assembled by one
// module and re-validated by another from being refused on a length rule the
// sender never knew about.
//
// They exist at all because a bound is the cheapest defence a parser has: a
// frame that arrived with a megabyte in its `message` field is refused on a
// length check, before that megabyte reaches a log line, a persisted session
// row or a user-interface banner.
// ---------------------------------------------------------------------------

/**
 * The ceiling on {@link ErrorPayload.message}.
 *
 * Two thousand characters is generous for the sentence a developer reads and
 * bounded enough to log: the longest message this product produces is a
 * validation rejection rendered by `describeZodIssues`, which is itself capped
 * at ten issues with bounded path segments and fragments.
 */
const MAX_MESSAGE_LENGTH = 2000;

/**
 * The ceiling on {@link ErrorPayload.hint}.
 *
 * A hint is one actionable instruction ("Reload the page and start capture
 * again"), not prose, so half the message budget is ample. Anything longer is a
 * sign the sender put a diagnostic dump where a next step belongs.
 */
const MAX_HINT_LENGTH = 1000;

/**
 * The ceiling on {@link ErrorPayload.ref}.
 *
 * Sixty-four characters covers every identifier this product mints — the
 * prefixed session, capture, panel, analysis, modification, action, event and
 * message ids of `@debuggen/shared` are a short prefix plus sixteen random
 * characters, and a 32-character hexadecimal trace id is the longest of them —
 * with room for a compound reference and none for a payload smuggled through a
 * correlation field.
 */
const MAX_ID_LENGTH = 64;

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

/**
 * The closed error-code vocabulary, as a payload field.
 *
 * Built from `DEBUGGEN_ERROR_CODES` — the thirty-five-member readonly tuple
 * `packages/shared/src/errors.ts` declares, spanning configuration, the access
 * boundary and pairing, the session and capture lifecycle, project paths, dev
 * server and agent readiness, instrumentation and cleanup, code indexing, the
 * model and the artifacts it proposes, the store, the transports and the two
 * last-resort codes. Not one of those strings is typed out here: the tuple is
 * imported and spread, so the literal union survives, a code added there widens
 * this schema in the same edit, and the wire vocabulary can never be a superset
 * or a subset of the vocabulary the processes actually use.
 *
 * The spread is required rather than stylistic — Zod's enum signature takes a
 * mutable array — and it is safe: the copy is read once, at module load, and
 * the literal types come from the tuple's `as const`, not from the copy.
 *
 * `code` is what a user interface switches on, which is why it is a closed
 * enumeration and not a free string: an unrecognised code has no rendering, no
 * recovery action and no place in the graceful-failure table of AAP §0.5.5, so
 * it is refused at the boundary instead of being displayed raw.
 */
export const errorCodeSchema = z.enum([...DEBUGGEN_ERROR_CODES], {
  error: 'expected one of the error codes declared by @debuggen/shared',
});

/**
 * The `error` message payload: `{ code, message, ref? }` plus the optional
 * developer-facing `hint` that `DebuggenError.toPayload()` forwards.
 *
 * Strict by construction. `z.strictObject` refuses an unrecognised key rather
 * than stripping it, for the reason the whole package parses strictly: a sender
 * that put `sessionID` where `sessionId` belongs, or attached a field this
 * version of the protocol does not know, has a version or a code mistake worth
 * a loud failure — and an unrecognised key is the one thing a rejection is
 * allowed to *name*, since `describeZodIssues` renders key names while never
 * rendering values.
 *
 * Each bound below has its own reason, and none of the fields is repaired: a
 * missing `message` is a rejection, never an empty string supplied on the
 * sender's behalf.
 */
export const errorPayloadSchema = z.strictObject({
  /**
   * The failure being reported, from {@link errorCodeSchema}.
   *
   * Required: this is the field both user interfaces switch on, and the field a
   * client logs when it can do nothing else.
   */
  code: errorCodeSchema,

  /**
   * What went wrong, in one sentence, for a developer to read.
   *
   * Non-empty, because an error with nothing to say is indistinguishable from a
   * dropped field, and bounded by {@link MAX_MESSAGE_LENGTH}. When the sender
   * is a validation failure this string was produced by
   * `describeZodIssues`, so it carries issue paths and codes and no rejected
   * value (AAP §0.5.2).
   */
  message: z
    .string({ error: 'expected an error message string' })
    .min(1, { error: 'expected a non-empty error message' })
    .max(MAX_MESSAGE_LENGTH, {
      error: `expected an error message of at most ${MAX_MESSAGE_LENGTH} characters`,
    }),

  /**
   * The developer-facing recovery hint: the next step, not a restatement of the
   * failure.
   *
   * This is the field the graceful-failure table of AAP §0.5.5 fills — "Check
   * ANTHROPIC_API_KEY or switch DEBUGGEN_PROVIDER", "Interact with the page
   * while capture is running, then Capture again", the exact relaunch command
   * when a dev server was started without the telemetry preload — and it is
   * what both user interfaces render beneath the message.
   *
   * Optional because many failures have no useful next step, and absent rather
   * than empty when they do not: `DebuggenError.toPayload()` omits the key
   * instead of sending `undefined`, and this schema neither requires nor
   * invents it. Bounded by {@link MAX_HINT_LENGTH}.
   */
  hint: z
    .string({ error: 'expected a hint string' })
    .max(MAX_HINT_LENGTH, {
      error: `expected a hint of at most ${MAX_HINT_LENGTH} characters`,
    })
    .optional(),

  /**
   * The correlation reference: what this error is *about*.
   *
   * It lets a client tie the failure back to something it already holds — the
   * `id` of the request envelope that provoked it, or the id of a session
   * artifact such as a capture, a plan version or a panel — so a panel can mark
   * the right row, and the editor view the right stage, instead of showing a
   * banner with no anchor.
   *
   * Optional, because the service also reports failures that belong to no prior
   * request (a store failure surfaced on connect, a dev server that went away),
   * and non-empty when present: an empty reference correlates with nothing and
   * is a producer bug worth reporting. Bounded by {@link MAX_ID_LENGTH}.
   */
  ref: z
    .string({ error: 'expected a ref string' })
    .min(1, { error: 'expected a non-empty ref' })
    .max(MAX_ID_LENGTH, {
      error: `expected a ref of at most ${MAX_ID_LENGTH} characters`,
    })
    .optional(),
});

/**
 * The `error` message payload.
 *
 * Inferred from {@link errorPayloadSchema} rather than declared beside it, so
 * the validator and the type can never disagree about a field, a bound's
 * presence or an optional marker.
 */
export type ErrorPayload = z.infer<typeof errorPayloadSchema>;

// ---------------------------------------------------------------------------
// Compile-time drift guard
//
// `DebuggenError.toPayload()` is the producer of this payload in every process:
// the service, the extension host, the DevTools panel and the browser agent all
// send what that method returns. The method and this schema are declared in
// different packages, so nothing but the assertion below stops them from
// drifting — and the failure mode of drift is silent, because a strict parser
// at the receiving end drops an added field by refusing the frame, and a
// removed field by rejecting a payload the sender believed was complete.
//
// Everything here is type-level: four helper aliases, no runtime code, no new
// dependency, nothing emitted into the bundle.
// ---------------------------------------------------------------------------

/**
 * Fails to compile unless its argument is exactly `true`.
 *
 * The whole mechanism of an assertion below: a helper that computed `false`
 * violates the `extends true` constraint, which TypeScript reports at the
 * declaration site (`TS2344: Type 'false' does not satisfy the constraint
 * 'true'`) whether or not anything reads the result.
 */
type Expect<TAssertion extends true> = TAssertion;

/**
 * Restates every property of `T` as required-and-possibly-`undefined`.
 *
 * This normalisation exists because the repository compiles with
 * `exactOptionalPropertyTypes`, under which `{ hint?: string }` — what the
 * hand-written class returns — and `{ hint?: string | undefined }` — what Zod
 * infers for `.optional()` — are *not* mutually assignable even though they
 * describe the same wire bytes. Comparing the normalised forms asks the question that
 * actually matters (are these the same fields carrying the same value types?)
 * instead of the question the exactness flag answers (may this property be
 * present holding `undefined`?), and {@link OptionalKeysOf} covers the second
 * question separately so neither is lost.
 */
type WithExplicitUndefined<T> = { [K in keyof T]-?: T[K] | undefined };

/**
 * `true` when `A` and `B` describe the same fields with the same value types,
 * compared through {@link WithExplicitUndefined}.
 *
 * Each side is wrapped in a one-element tuple so a union on either side is
 * compared as a whole rather than distributed over its members.
 */
type MutuallyAssignable<A, B> = [WithExplicitUndefined<A>] extends [WithExplicitUndefined<B>]
  ? [WithExplicitUndefined<B>] extends [WithExplicitUndefined<A>]
    ? true
    : false
  : false;

/**
 * The keys of `T` that are declared optional.
 *
 * `Pick<T, K>` is a one-property object type that the empty `object` type
 * satisfies exactly when that property may be absent, which is what
 * distinguishes an optional key from a required one whose type happens to
 * include `undefined`.
 */
type OptionalKeysOf<T> = { [K in keyof T]-?: object extends Pick<T, K> ? K : never }[keyof T];

/**
 * `true` when `A` and `B` are the same type, by the usual invariant-position
 * comparison — stricter than mutual assignability, and used here for key
 * unions, where that strictness is what catches a key that moved between
 * required and optional.
 */
type Identical<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

/** What `DebuggenError.toPayload()` returns: `{ code, message, hint? }`. */
type DebuggenErrorWirePayload = ReturnType<DebuggenError['toPayload']>;

/**
 * {@link ErrorPayload} as `DebuggenError.toPayload()` produces it — that is,
 * without the `ref` this protocol adds on top of the class's own fields.
 */
type ErrorPayloadWithoutRef = Omit<ErrorPayload, 'ref'>;

/**
 * The compile-time assertion that this schema still mirrors
 * `DebuggenError.toPayload()`: same fields, same value types, same optionality.
 *
 * Add a field to the class and the first element becomes `false`; change a
 * field from required to optional (or back) and the second does; either way
 * this file stops compiling, which is the intent — the alternative is a field
 * that exists on one side of a process boundary and is discarded at the other.
 * `ref` is excluded because it is this protocol's own addition: a correlation
 * reference is something the *sender of a frame* knows and the class does not.
 *
 * It is exported for a mechanical reason worth stating, since it is otherwise
 * an odd thing to publish: the repository compiles with `noUnusedLocals` and
 * lints with `@typescript-eslint/no-unused-vars`, under which an unreferenced
 * local alias is itself an error, and a JSDoc reference does not count as a use.
 * The export costs nothing at runtime — it is a type, so no value is emitted —
 * and it gives the assertion a name a reader can search for.
 */
export type ErrorPayloadDriftAssertions = [
  Expect<MutuallyAssignable<DebuggenErrorWirePayload, ErrorPayloadWithoutRef>>,
  Expect<
    Identical<OptionalKeysOf<DebuggenErrorWirePayload>, OptionalKeysOf<ErrorPayloadWithoutRef>>
  >,
];

// ---------------------------------------------------------------------------
// Parse helper and payload registry
// ---------------------------------------------------------------------------

/**
 * Validates an unknown value as an {@link ErrorPayload}, without throwing.
 *
 * This is how an `error` frame that arrived from another process becomes a typed
 * value: the DevTools panel reading a frame relayed by its service worker, the
 * extension host reading one off its WebSocket, and `../http.ts`'s client
 * reading an error response body. It never throws — a rejection is a returned
 * value, because a client handling a *failure* message is the last place that
 * should have to catch one.
 *
 * The rejection is a `DebuggenError` with code `'PROTOCOL_INVALID_MESSAGE'`
 * built by `protocolParseError`, which renders the failure through
 * `describeZodIssues`: the message is assembled from issue paths, issue codes
 * and schema-declared metadata — an expected type, a declared bound, an
 * unrecognised key's name — and never from the rejected value (AAP §0.5.2).
 * `describeZodIssues` is not imported here because `protocolParseError` applies
 * it internally; that single call site is what makes the guarantee uniform
 * across the package's parse helpers rather than a rule each of them
 * remembers.
 *
 * One consequence is worth naming: a malformed `error` frame yields *another*
 * error, and the payload that failed to parse is not attached to it. That is
 * the intended trade — the frame's content is unvalidated data from another
 * process, and this product does not put unvalidated data into an error
 * message. The caller still has the frame if it wants to log it under its own
 * redaction rules.
 *
 * @param value Any value believed to be an `error` message payload.
 * @returns `ok(payload)` with the validated payload, or `err(error)` describing
 * the shape of the failure.
 *
 * @example
 * ```ts
 * const parsed = parseErrorPayload(frame.payload);
 * if (!parsed.ok) {
 *   log.warn(parsed.error.message);
 *   return;
 * }
 * showFailure(parsed.value.code, parsed.value.message, parsed.value.hint);
 * ```
 */
export function parseErrorPayload(value: unknown): Result<ErrorPayload, DebuggenError> {
  const parsed = errorPayloadSchema.safeParse(value);

  if (parsed.success) {
    return ok(parsed.data);
  }

  return err(
    protocolParseError(
      'PROTOCOL_INVALID_MESSAGE',
      'Invalid error payload',
      parsed.error.issues,
      'An error payload carries a code from the @debuggen/shared vocabulary, a non-empty message, and optional hint and ref fields.',
    ),
  );
}

/**
 * This module's contribution to the protocol's message registry: the `error`
 * message and the schema that validates its payload.
 *
 * `./index.ts` spreads this object — together with the equivalent map from every
 * sibling module — into `MESSAGE_PAYLOAD_SCHEMAS`, which `../envelope.ts` uses
 * to pick a payload schema by message type. Contributing a map rather than
 * having the barrel name each schema is what keeps the registry complete by
 * construction: a message defined here without being registered is impossible,
 * because the definition and the registration are the same edit.
 *
 * The key is the message type name exactly as AAP §0.4.2 writes it, `error`;
 * frozen so a consumer cannot mutate the shared registry of a loaded module.
 */
export const ERROR_MESSAGE_PAYLOADS = Object.freeze({ error: errorPayloadSchema } as const);
