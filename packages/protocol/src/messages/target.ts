/**
 * The two messages of element selection: `target.request` and `target.selected`
 * (AAP §0.4.2).
 *
 * A debugging question is usually about a *thing on the screen* — a button that
 * feels slow, a card that repaints while nothing is happening — and the fastest
 * way for a developer to say which thing is to point at it. These two payloads
 * are that gesture's wire form, one per direction:
 *
 * ```text
 * service  →  DevTools panel   target.request   { sessionId }
 * DevTools →  service          target.selected  { sessionId, target }
 * ```
 *
 * The service asks, the panel answers, and the answer is a descriptor of the
 * element the developer chose. Nothing else travels: no acknowledgement, no
 * cancellation, no progress. A request that goes unanswered costs the session
 * nothing, because a target is an *input* to the first pipeline stage and never
 * a precondition for it — when no element was selected, problem understanding
 * reads the bound tab's current URL instead, so a session is never blocked
 * waiting for a click (AAP §0.4.2).
 *
 * ## Who receives a request, and why the payload can be this small
 *
 * `target.request` names a session and nothing else. It does not name a tab,
 * a connection or a panel, because it does not have to: a session has at most
 * one bound tab at a time, the binding is recorded against the connection that
 * established it, and that binding is the deterministic recipient for every
 * frame the service addresses to "the panel of this session" — the agent
 * configuration, the live tail, a generated panel and this request alike
 * (AAP §0.2.3, and `./binding.ts`, which owns the four messages that maintain
 * it). A payload that restated the destination would be a second, weaker
 * routing rule that could disagree with the first.
 *
 * ## Picker mode is a user-interface state, not a protocol state
 *
 * What the panel does on receipt is enter element-picker mode; how it does so is
 * entirely its own business. There is deliberately no option, mode flag,
 * timeout, highlight colour or cancellation token on this payload. The panel
 * offers two routes to the same descriptor — a picker the developer clicks
 * with, and a "use the element already selected in the Elements panel" action
 * that reads DevTools' `$0` helper — and it may add a third without any change
 * here, because the protocol's interest ends at *which session wants a target*
 * and resumes at *which element was chosen*. Encoding picker policy in the
 * contract would make every future interaction change a wire change, and would
 * oblige the service to have an opinion about a surface it cannot see.
 *
 * ## Where a descriptor comes from
 *
 * The answer is produced page-side and marshalled through a chain of
 * boundaries, each of which can carry only JSON-compliant values
 * (AAP §0.2.3, §0.7.1):
 *
 * ```text
 * the element the developer clicked, or DevTools' $0
 *   → an expression the DevTools page evaluates with
 *     chrome.devtools.inspectedWindow.eval, which asks the MAIN-world agent for
 *     the element's descriptor and its React component chain
 *   → window.postMessage to the isolated-world bridge
 *   → a chrome.runtime port to the MV3 service worker
 *   → this WebSocket message, `target.selected`
 *   → the service, which records it on the session and hands it to the
 *     problem-understanding stage
 * ```
 *
 * Two consequences of that route are the reason this module is as plain as it
 * is. First, `inspectedWindow.eval` resolves **JSON-compliant values only**: a
 * node reference, a `DOMRect`, a function or a fiber cannot survive it, which is
 * why the descriptor is five scalar-or-string-array fields and why no schema
 * here transforms, coerces, defaults or catches its input — a schema that
 * rewrote what it validated would make the object on the wire and the object in
 * the store two different things, and a JSON round trip would stop being the
 * identity. Second, the page is not trusted: the descriptor passed
 * through a document that may have interfered with it, so it is validated
 * strictly at this boundary rather than after it has reached a store row or a
 * user interface.
 *
 * ## The descriptor is imported, never restated
 *
 * `selectedTargetSchema` from `@debuggen/instrumentation` is the single
 * definition of that shape (AAP §0.9.1), and this module embeds it as a field
 * with no wrapper and no second pass over its members. Zod 4 keeps refinements
 * inside the schema, so nesting it here runs the owner's own rules — the
 * single-line rules, the length bounds, the absolute-URL rule, the cap on the
 * component chain — and reports their issues under the full path
 * (`target.selector`, `target.componentChain[2]`), which is exactly what a
 * producer needs to fix its side. Three places hold that one descriptor and all
 * three reach for the same import: this payload, the optional `target` of the
 * HTTP `session.create` body in `./session.ts`, and `SessionRecord.target?`
 * in `../session-record.ts`. A second spelling of it in any of them is the
 * defect AAP §0.4.2 calls out by name.
 *
 * Two properties of the imported shape are worth knowing at this boundary,
 * because a consumer that assumes otherwise will misread a valid descriptor:
 *
 * - **The component chain is ordered nearest-first.** Index 0 is the closest
 *   composite component above the element, which is the producer's convention
 *   and the order the first pipeline stage reads as "what this question is most
 *   likely about". An **empty chain is valid** and is the honest answer for a
 *   page with no React, a node React never rendered, or a build whose fibers the
 *   hook cannot reach — never a malformed descriptor.
 * - **No source location travels with the descriptor.** Resolving a selected
 *   element to a file and a line is the React-owner-chain route of the service's
 *   source resolver, which has the code graph and the dev server's source maps;
 *   a location minted in the page would be a generated-chunk coordinate wearing
 *   a project path.
 *
 * ## What this module validates, and what it refuses to police
 *
 * Shape, and only shape. The visible text arrives already scrubbed of
 * credential material and truncated by the producer, and the URL may arrive
 * query-redacted, its parameter values replaced while its keys and path remain
 * (AAP §0.5.2) — both forms are legitimate values from legitimate producers, so
 * the owner's schema accepts both and nothing here second-guesses content
 * policy. Redaction happens where the data is produced and again at ingest; a
 * transport schema that tried to re-derive it would reject a session's own
 * stored target when it is read back on reopen.
 *
 * ## Module rules
 *
 * Named exports only, no default export, and no import-time side effect: the
 * manifest declares `sideEffects: false`, so everything below is a declaration.
 * This module imports no sibling in this folder and never the envelope;
 * `messages/index.ts` merges {@link TARGET_MESSAGE_PAYLOADS} into the folder's
 * registry, and `envelope.ts` builds the discriminated union from that registry,
 * which is what keeps the dependency one-directional.
 *
 * @example
 * ```ts
 * // Service side: ask the panel of a session to pick an element.
 * send({ type: 'target.request', payload: { sessionId } });
 *
 * // Service side: accept what came back.
 * const parsed = parseTargetSelectedPayload(frame.payload);
 * if (parsed.ok) {
 *   recordTarget(parsed.value.sessionId, parsed.value.target);
 * }
 * ```
 */

import { z } from 'zod';

import { selectedTargetSchema } from '@debuggen/instrumentation';
import { err, ok } from '@debuggen/shared';
import type { DebuggenError, Result } from '@debuggen/shared';

import { protocolParseError } from '../version.js';

// ---------------------------------------------------------------------------
// Section A — module-local bounds and field primitives
// ---------------------------------------------------------------------------

/**
 * The longest identifier these payloads accept.
 *
 * Folder-canonical: every message module in this directory bounds an id the same
 * way, so a frame that arrived with a document where a session id belongs is
 * refused on a length check rather than carried into a store lookup, a log line
 * or a status banner. A session id minted by `newSessionId()` in
 * `@debuggen/shared` is twenty characters, so sixty-four is deliberate headroom
 * rather than a measured limit.
 */
const MAX_ID_LENGTH = 64;

/**
 * The session a selection belongs to: a bounded, non-empty string.
 *
 * Shape only, and deliberately not pinned to the form `@debuggen/shared` mints.
 * The id aliases in that package are unbranded strings by design, and a
 * transport schema that demanded the prefixed spelling would turn a naming
 * decision in one package into a wire-compatibility break in another — refusing
 * an id read back from an older store row, an id from a fixture, and an id a
 * future prefix admits. What the transport genuinely needs is that the field is
 * a usable key: present, non-empty and short enough to be one.
 *
 * Whether the named session *exists*, and whether the connection that sent the
 * frame may act on it, are the service's answers rather than a schema's: a
 * syntactically valid id for a session that ended is a `SESSION_NOT_FOUND`, and
 * a panel reaching for a session bound to another tab is an authorization
 * failure (AAP §0.5.6) — neither is a `PROTOCOL_INVALID_MESSAGE`.
 *
 * Module-private on purpose: the package barrel re-exports every public name in
 * this folder, so a primitive each domain module needs stays local rather than
 * colliding with its siblings' equivalents.
 */
const sessionIdSchema = z
  .string()
  .min(1, {
    error: 'expected a non-empty id',
  })
  .max(MAX_ID_LENGTH, {
    error: 'expected an id of at most 64 characters',
  });

// ---------------------------------------------------------------------------
// Section B — target.request: the service asks the panel to pick
// ---------------------------------------------------------------------------

/**
 * The payload of `target.request`: which session wants an element.
 *
 * One field, because one field is the whole instruction. The panel that receives
 * it is the one bound to this session, and what it does about it is picker
 * policy rather than protocol (see the module documentation above).
 *
 * `z.strictObject`, so an unrecognised key is a rejection rather than a silently
 * stripped field. That matters more on the small payloads than on the large
 * ones: a producer that believes it can attach a mode, a timeout or a highlight
 * option to this message has misread the contract, and a receiver that quietly
 * dropped the extra key would let that misreading survive until the two halves
 * disagreed about something that mattered.
 */
export const targetRequestPayloadSchema = z.strictObject({
  /** The session whose bound panel should enter element-picker mode. */
  sessionId: sessionIdSchema,
});

/**
 * The `target.request` payload.
 *
 * Inferred from {@link targetRequestPayloadSchema} rather than declared beside
 * it, so the validator and the type are one statement and cannot drift.
 */
export type TargetRequestPayload = z.infer<typeof targetRequestPayloadSchema>;

// ---------------------------------------------------------------------------
// Section C — target.selected: the panel reports what was picked
// ---------------------------------------------------------------------------

/**
 * The payload of `target.selected`: the session, and the element the developer
 * chose.
 *
 * The message name is one of the product's fixed protocol names and is written
 * verbatim, here and in {@link TARGET_MESSAGE_PAYLOADS}, so that a reader can
 * grep one string across all four processes.
 *
 * Unsolicited frames are legitimate. A `target.request` is one way this payload
 * comes about, and a developer selecting an element in the Elements panel — which
 * the DevTools page observes through `panels.elements.onSelectionChanged` — is
 * the other, so the service treats an arriving descriptor as the current target
 * of the named session regardless of whether it asked for one. A later selection
 * replaces an earlier one; there is no sequence number and no acknowledgement,
 * because the last thing the developer pointed at is the only interesting one.
 *
 * `target` is the imported `selectedTargetSchema` itself — the single definition
 * of that descriptor — used as a field with no wrapper and no restatement of its
 * five members. Its own strictness therefore applies unchanged: a sixth key
 * inside the descriptor is refused, which is what turns a page that interfered
 * with the value, or two halves of the contract that have drifted apart, into a
 * rejected frame instead of a half-trusted store row.
 */
export const targetSelectedPayloadSchema = z.strictObject({
  /** The session this selection belongs to. */
  sessionId: sessionIdSchema,

  /**
   * The element the developer selected, as the one shared descriptor shape.
   *
   * Recorded on the session as its current target and read by the first pipeline
   * stage; the same shape is accepted, optionally, by the HTTP body that creates
   * a session, so a developer who already had an element selected never has to
   * point at it twice.
   */
  target: selectedTargetSchema,
});

/**
 * The `target.selected` payload.
 *
 * Inferred from {@link targetSelectedPayloadSchema}, so its `target` member is
 * the `SelectedTarget` type of `@debuggen/instrumentation` by construction —
 * which is what lets the service pass the descriptor straight into the stage
 * input and the session record that already speak it, with no adapter and no
 * cast.
 */
export type TargetSelectedPayload = z.infer<typeof targetSelectedPayloadSchema>;

// ---------------------------------------------------------------------------
// Section D — parse helpers
// ---------------------------------------------------------------------------

/**
 * The hint attached to a rejected `target.request`.
 *
 * A constant sentence about the **schema**, never about the value that failed
 * it, because `DebuggenError.toPayload()` carries `hint` verbatim across the
 * wire and into a persisted session row (AAP §0.5.2).
 */
const REQUEST_HINT =
  'A target.request payload carries exactly one field: the id of the session whose bound panel should enter element-picker mode.';

/**
 * The hint attached to a rejected `target.selected`. See {@link REQUEST_HINT}
 * for why it names no value.
 */
const SELECTED_HINT =
  'A target.selected payload carries exactly two fields: the session id, and a descriptor that satisfies the selected-target schema of @debuggen/instrumentation — a CSS selector, a tag name, the element’s visible text where it has any, the component chain ordered nearest-first, and the absolute document URL at the moment of selection.';

/**
 * Validates an unknown value as a {@link TargetRequestPayload}, without
 * throwing.
 *
 * Used on the receiving side: the DevTools panel validates what arrived before
 * it changes its own mode, so a service that regressed cannot put the panel into
 * a picker state for a session it does not hold. The failure is a
 * `DebuggenError` with code `'PROTOCOL_INVALID_MESSAGE'`, built by
 * {@link protocolParseError}, whose message names field paths and issue codes
 * and **never a rejected value**.
 *
 * @param value Any value believed to be a `target.request` payload.
 * @returns `ok(payload)` with the validated payload, or `err(error)` describing
 * the shape of every issue found.
 *
 * @example
 * ```ts
 * const parsed = parseTargetRequestPayload(frame.payload);
 * if (!parsed.ok) {
 *   logger.warn('refused target.request', { reason: parsed.error.message });
 *   return;
 * }
 * enterPickerMode(parsed.value.sessionId);
 * ```
 */
export function parseTargetRequestPayload(
  value: unknown,
): Result<TargetRequestPayload, DebuggenError> {
  const parsed = targetRequestPayloadSchema.safeParse(value);

  if (parsed.success) {
    return ok(parsed.data);
  }

  return err(
    protocolParseError(
      'PROTOCOL_INVALID_MESSAGE',
      'Invalid target.request payload',
      parsed.error.issues,
      REQUEST_HINT,
    ),
  );
}

/**
 * Validates an unknown value as a {@link TargetSelectedPayload}, without
 * throwing.
 *
 * This is the boundary where a descriptor built inside a page becomes a typed
 * value in the service. Everything about the frame is unvalidated until it
 * returns: the value was assembled by an expression evaluated in a document the
 * product does not control, relayed through two extension boundaries, and may
 * have been tampered with at any of them.
 *
 * The privacy rule earns its keep precisely here. The descriptor carries a CSS
 * selector, a caption a page rendered and a URL — the three fields most likely
 * to hold something a developer would not want echoed — and a validation failure
 * is raised far below the redaction layer, which therefore cannot rescue
 * anything that leaked into it (AAP §0.5.2). So the rejected value never enters
 * the error in the first place: the message reports the failing field paths and
 * issue codes, and the hint is a fixed sentence about the schema.
 *
 * @param value Any value believed to be a `target.selected` payload.
 * @returns `ok(payload)` with the validated payload, whose `target` is a
 * `SelectedTarget`, or `err(error)` naming every field that failed and the kind
 * of rule it broke — never the rejected value.
 *
 * @example
 * ```ts
 * const parsed = parseTargetSelectedPayload(frame.payload);
 * if (!parsed.ok) {
 *   send(errorMessage(parsed.error));
 *   return;
 * }
 * // parsed.value.target.componentChain[0] is the nearest composite component,
 * // and an empty chain means "no component information", not a bad descriptor.
 * recordTarget(parsed.value.sessionId, parsed.value.target);
 * ```
 */
export function parseTargetSelectedPayload(
  value: unknown,
): Result<TargetSelectedPayload, DebuggenError> {
  const parsed = targetSelectedPayloadSchema.safeParse(value);

  if (parsed.success) {
    return ok(parsed.data);
  }

  return err(
    protocolParseError(
      'PROTOCOL_INVALID_MESSAGE',
      'Invalid target.selected payload',
      parsed.error.issues,
      SELECTED_HINT,
    ),
  );
}

// ---------------------------------------------------------------------------
// Section E — the registry this module contributes to the envelope
// ---------------------------------------------------------------------------

/**
 * The element-selection messages, keyed by the message `type` that carries each
 * payload.
 *
 * The keys are the protocol's own names, verbatim from AAP §0.4.2:
 * `target.request` and `target.selected`. They are the strings on the wire, so
 * they are written out here rather than assembled from parts.
 *
 * `messages/index.ts` merges this map with the equivalent registry from every
 * other module in this folder, and `../envelope.ts` maps over the result to
 * build the discriminated union every frame is validated against. Nothing here
 * knows how that composition works, which is what keeps the dependency
 * one-directional; a consumer that already knows which message it holds reaches
 * for the schema or the parse helper directly.
 *
 * Frozen, and `as const` so each key maps to its own schema type rather than to
 * a union of the two: a lookup on a literal key gives the exact schema, and the
 * table the whole process accepts on the wire cannot be extended at runtime by a
 * consumer that would rather add a message than declare one.
 */
export const TARGET_MESSAGE_PAYLOADS = Object.freeze({
  'target.request': targetRequestPayloadSchema,
  'target.selected': targetSelectedPayloadSchema,
} as const);
