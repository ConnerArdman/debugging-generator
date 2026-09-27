/**
 * The two messages of element selection: `target.request` and
 * `target.selected`.
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
 * element the developer chose. No payload here carries an acknowledgement, a
 * cancellation or progress, and none needs to: the service's verdict on an
 * answer travels on two messages every client already handles (see "The
 * verdict on a `target.selected` frame" below). A request that goes unanswered
 * costs the session nothing, because a target is an *input* to the first
 * pipeline stage and never a precondition for it — when no element was
 * selected, problem understanding reads the bound tab's current URL instead, so
 * a session is never blocked waiting for a click.
 *
 * ## Who asks: the editor's request, never a client's frame
 *
 * `target.request` is a **service-only push**. The service emits it in answer
 * to exactly one thing — the editor's `POST /sessions/:id/target/request`, the
 * `target.request` operation of `../http.ts` — and sends it to that session's
 * bound tab alone. The one name on both transports is deliberate, as it is for
 * `telemetry.event`: the HTTP operation is the editor→service leg of the same
 * instruction and the WebSocket message is the service→panel leg, so the
 * editor, which has no DevTools connection, reaches the panel through the one
 * process that knows which tab is bound (conventional requests use HTTP; the
 * WebSocket vocabulary stays at its twenty-eight types). Only the
 * editor credential may call the route. It answers `{ sessionId, tabId }` once
 * the frame has been handed to the bound tab's live connection, or an error the
 * editor can act on — `TAB_NOT_BOUND` when the session has no bound tab,
 * `TRANSPORT_DISCONNECTED` when that tab's connection is offline; the full
 * error contract is documented on the route. A `target.request` frame a client
 * sends is refused with an `error` (`PROTOCOL_INVALID_MESSAGE`): no client may
 * put another client's panel into picker mode.
 *
 * ## Who receives a request, and why the payload can be this small
 *
 * `target.request` names a session and nothing else. It does not name a tab,
 * a connection or a panel, because it does not have to: a session has at most
 * one bound tab at a time, the binding is recorded against the connection that
 * established it, and that binding is the deterministic recipient for every
 * frame the service addresses to "the panel of this session" — the agent
 * configuration, the live tail, a generated panel and this request alike
 * (see `./binding.ts`, which owns the four messages that maintain it). A
 * payload that restated the destination would be a second, weaker
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
 * boundaries, each of which can carry only JSON-compliant values:
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
 * definition of that shape, and this module embeds it as a field
 * with no wrapper and no second pass over its members. Zod 4 keeps refinements
 * inside the schema, so nesting it here runs the owner's own rules — the
 * single-line rules, the length bounds, the absolute-URL rule, the cap on the
 * component chain — and reports their issues under the full path
 * (`target.selector`, `target.componentChain[2]`), which is exactly what a
 * producer needs to fix its side. Three places hold that one descriptor and all
 * three reach for the same import: this payload, the optional `target` of the
 * HTTP `session.create` body in `./session.ts`, and `SessionRecord.target?`
 * in `../session-record.ts`. A second spelling of it in any of them is a
 * defect: a duplicate definition of one shape, free to drift from the first.
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
 * ## The verdict on a `target.selected` frame
 *
 * A frame that has been sent — or merely queued behind a reconnecting socket —
 * is **pending**, never accepted. The service settles it in one of two ways,
 * and a sender shows the selection as the session's target only after the
 * second:
 *
 * - **Refused.** The service answers with the existing `error` message
 *   (`./error.ts`) whose `ref` is the refused frame's envelope `id`, so the
 *   sender correlates the refusal with the selection it made. `TAB_NOT_BOUND`
 *   is the answer both when the sending connection's tab is not the one bound
 *   to that session (a panel selects targets only for the session bound to its
 *   tab) and when the descriptor is not of the bound tab's current
 *   document — {@link compareSelectionDocument} answering anything but
 *   `'same-document'` for the descriptor's `url` against the binding's URL.
 *   The descriptor was assembled in a page, so a stale selection from a
 *   document the tab has left, or one forged to name another origin, is
 *   refused rather than handed to the pipeline. `SESSION_NOT_FOUND`,
 *   `SESSION_INVALID_STATE` and `PROTOCOL_INVALID_MESSAGE` keep their usual
 *   meanings.
 * - **Accepted.** The service records the descriptor on the session, and the
 *   session manager announces every accepted target: acceptance is the
 *   `session.updated` whose `session.target` satisfies
 *   {@link sameSelectedTarget} with the descriptor that was sent. An update
 *   carrying some other target means a later selection superseded this one.
 *
 * A frame the transport dropped — evicted from a full queue, lost with a
 * closed socket — receives neither answer, so a sender that loses the frame
 * retracts the pending selection instead of waiting for a verdict that cannot
 * come. None of this adds a field to either payload or a message type to the
 * vocabulary: the correlation key is the envelope id every frame already
 * carries, and both answers are messages every client already handles.
 *
 * Why the document comparison reads only the origin and the path: the tab
 * binding's URL is refreshed from `tab.navigated`, which the service worker
 * reports on every committed navigation — cross-document, history API and
 * reload alike — so it names the tab's current document; but it is stored
 * query-redacted, each parameter's value replaced, while a descriptor's URL may
 * not be, and a fragment never changes the document. Comparing the query or
 * the fragment would therefore refuse honest selections without refusing a
 * single stale one.
 *
 * ## What this module validates, and what it refuses to police
 *
 * The schemas validate shape, and only shape. The visible text arrives already
 * scrubbed of credential material and truncated by the producer, and the URL
 * may arrive query-redacted, its parameter values replaced while its keys and
 * path remain — both forms are legitimate values from legitimate
 * producers, so the owner's schema accepts both and nothing here second-guesses
 * content policy. Redaction happens where the data is produced and again at
 * ingest; a transport schema that tried to re-derive it would reject a
 * session's own stored target when it is read back on reopen.
 *
 * The two semantic questions a schema cannot answer are answered once, here,
 * as pure functions both halves of the verdict call: is this the same
 * descriptor ({@link sameSelectedTarget}), and is it of this document
 * ({@link compareSelectionDocument}). Neither inspects content, and neither
 * can fail loudly: a URL that does not parse is a verdict (`'unreadable'`),
 * never an exception.
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
 * // Service side, answering the editor's POST /sessions/:id/target/request:
 * // ask the bound panel of that session, and only that panel, to pick.
 * sendToBoundTab(sessionId, { type: 'target.request', payload: { sessionId } });
 *
 * // Service side: judge what came back, then accept or refuse it.
 * const parsed = parseTargetSelectedPayload(frame.payload);
 * if (parsed.ok) {
 *   const verdict = compareSelectionDocument(parsed.value.target.url, binding.url);
 *   if (verdict !== 'same-document') {
 *     replyError('TAB_NOT_BOUND', { ref: frame.id });
 *   } else {
 *     recordTarget(parsed.value.sessionId, parsed.value.target); // → session.updated
 *   }
 * }
 *
 * // Panel side: the selection is pending until the session carries it.
 * onSessionUpdated(({ session }) => {
 *   if (sameSelectedTarget(session.target, pending.target)) {
 *     markAccepted(pending);
 *   }
 * });
 * ```
 */

import { z } from 'zod';

import { selectedTargetSchema } from '@debuggen/instrumentation/schema';
import type { SelectedTarget } from '@debuggen/instrumentation/schema';
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
 * the other, so the service treats an arriving descriptor that passes its
 * binding and document checks as the current target of the named session
 * regardless of whether it asked for one. A later selection replaces an earlier
 * one; the payload carries no sequence number and no acknowledgement field,
 * because the last thing the developer pointed at is the only interesting one
 * and the verdict on it is observed rather than carried (see the module
 * documentation: an `error` whose `ref` is this frame's id, or the
 * `session.updated` that carries the descriptor).
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

// ---------------------------------------------------------------------------
// Section F — the verdict helpers: the same descriptor, the same document
//
// The two questions the verdict on a `target.selected` frame turns on (see the
// module documentation), answered once so the service that refuses or records
// a selection and the panel that waits for the outcome cannot disagree about
// them. Pure functions over values the schemas above have already validated:
// no I/O, no clock, no state, and no error — every input has an answer.
// ---------------------------------------------------------------------------

/**
 * The schemes whose URLs name a web document a selection can belong to.
 *
 * The descriptor's own schema admits only these two (`selectedTargetSchema`'s
 * absolute-URL rule), and a tab binding's URL may be anything the tab navigated
 * to — `about:blank`, `chrome://newtab`, `file:///…`. Those have no origin a
 * selection can share: an opaque origin is equal to nothing but itself, and the
 * `file:` origin is left to the implementation by the URL standard (Node answers
 * `"null"`, Chrome `"file://"`), so comparing it would give the service and the
 * panel different verdicts for the same pair.
 */
const WEB_DOCUMENT_PROTOCOLS: ReadonlySet<string> = new Set(['http:', 'https:']);

/**
 * Folds the ASCII letters of a string to lowercase and leaves every other
 * character untouched.
 *
 * HTML compares tag names ASCII case-insensitively, which is narrower than
 * `String.prototype.toLowerCase` — that also folds non-ASCII letters such as
 * `İ`, and a custom element's name may contain them.
 *
 * @param value The text to fold.
 * @returns The same text with `A`–`Z` replaced by `a`–`z`.
 */
function asciiLowerCase(value: string): string {
  return value.replace(/[A-Z]/g, (letter) => String.fromCharCode(letter.charCodeAt(0) + 0x20));
}

/**
 * Whether two component chains name the same components in the same order.
 *
 * Order-sensitive on purpose: the chain is nearest-first, so the same names in
 * another order describe a different position in the tree.
 *
 * @param left One chain.
 * @param right The other chain.
 * @returns `true` when both have the same length and equal names at every index.
 */
function sameComponentChain(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((name, index) => name === right[index]);
}

/**
 * Whether two selected-target descriptors describe the same selection.
 *
 * The acceptance half of the verdict: a panel that sent a `target.selected`
 * frame holds its selection as pending until a `session.updated` arrives whose
 * `session.target` satisfies this predicate with the descriptor it sent. The
 * service stores the descriptor exactly as validated — no schema here or
 * upstream transforms it — so the stored copy compares equal to the sent one
 * field for field.
 *
 * Structural equality over all five fields of the one descriptor shape:
 *
 * - `selector`, `url` — exact string equality.
 * - `tagName` — ASCII case-insensitive, the comparison the descriptor's owner
 *   (`@debuggen/instrumentation`) prescribes, because the producer's case
 *   depends on the document type rather than on the element.
 * - `text` — exact string equality, and both absent counts as equal: the key is
 *   omitted for an element with no visible text.
 * - `componentChain` — element-wise and order-sensitive.
 *
 * **Both descriptors must be present.** `undefined` on either side answers
 * `false`, including `undefined` against `undefined`: a session with no target
 * does not confirm a selection, and a sender with nothing pending has nothing
 * to confirm.
 *
 * @param a One descriptor, or `undefined` when there is none.
 * @param b The other descriptor, or `undefined` when there is none.
 * @returns `true` only when both are defined and describe the same selection.
 *
 * @example
 * ```ts
 * if (sameSelectedTarget(message.payload.session.target, pending.target)) {
 *   // The service recorded the selection this panel sent.
 * }
 * ```
 */
export function sameSelectedTarget(
  a: SelectedTarget | undefined,
  b: SelectedTarget | undefined,
): boolean {
  if (a === undefined || b === undefined) {
    return false;
  }

  return (
    a.selector === b.selector &&
    asciiLowerCase(a.tagName) === asciiLowerCase(b.tagName) &&
    a.text === b.text &&
    a.url === b.url &&
    sameComponentChain(a.componentChain, b.componentChain)
  );
}

/**
 * How a selection's document relates to a tab's current document: the closed
 * vocabulary {@link compareSelectionDocument} answers in.
 *
 * - **`same-document`** — same origin and same path: the selection is of the
 *   document the tab shows, and is the only verdict under which the service
 *   records it.
 * - **`other-origin`** — a different scheme, host or port, or a URL with no web
 *   origin at all (anything but `http:` and `https:`).
 * - **`other-document`** — the same origin but another path: a selection made
 *   before the tab navigated within the application.
 * - **`unreadable`** — either value does not parse as a URL.
 *
 * Frozen for the reason every vocabulary in this folder is: it is a module-level
 * table, and mutating it would change what every consumer's exhaustive switch
 * believes the answers are.
 */
export const SELECTION_DOCUMENT_VERDICTS = Object.freeze([
  'same-document',
  'other-origin',
  'other-document',
  'unreadable',
] as const);

/** One member of the closed {@link SELECTION_DOCUMENT_VERDICTS} vocabulary. */
export type SelectionDocumentVerdict = (typeof SELECTION_DOCUMENT_VERDICTS)[number];

/**
 * Parses a URL without throwing.
 *
 * @param value The text to parse.
 * @returns The parsed URL, or `undefined` when the text is not an absolute URL.
 */
function readUrl(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    // The URL constructor throws a TypeError for anything that is not an
    // absolute URL; that is an answer (`unreadable`), not a fault to report.
    return undefined;
  }
}

/**
 * Compares the document a selection was made in with the document a tab shows.
 *
 * The refusal half of the verdict on a `target.selected` frame: the service
 * calls this with the descriptor's `url` and the bound tab's binding URL, and
 * refuses the frame with `TAB_NOT_BOUND` unless the answer is
 * `'same-document'`. The binding URL is refreshed on every committed
 * navigation — cross-document, history API and reload — so it names the tab's
 * current document, and a selection from a document the tab has since left, or
 * one forged to name another origin, is caught here.
 *
 * The rules, in the order they are applied:
 *
 * 1. Either value that does not parse as an absolute URL → `'unreadable'`.
 * 2. Either URL whose scheme is not `http:` or `https:` → `'other-origin'`: no
 *    web origin exists to share (see {@link WEB_DOCUMENT_PROTOCOLS}).
 * 3. Different serialized origins → `'other-origin'`. The origin is the
 *    parser's normalised scheme, host and port, so `localhost:3000` and
 *    `localhost:30001`, or `localhost` and `localhost.example.test`, never
 *    match on a shared prefix, while a default port written out (`:80`) and an
 *    upper-case host still match.
 * 4. The same origin but a different `pathname` → `'other-document'`.
 * 5. Otherwise → `'same-document'`.
 *
 * **The query string and the fragment are ignored on purpose.** The binding URL
 * is stored query-redacted — each parameter's value replaced — while a
 * descriptor's URL may not be, so comparing queries would refuse honest
 * selections; and a fragment never changes the document. User information in
 * either URL is ignored for the same reason: it is not part of the origin.
 *
 * @param targetUrl The selected element's document URL, `SelectedTarget.url`.
 * @param documentUrl The URL of the document the tab currently shows.
 * @returns One of {@link SELECTION_DOCUMENT_VERDICTS}; never throws.
 *
 * @example
 * ```ts
 * compareSelectionDocument(
 *   'http://localhost:3000/list?page=2#top',
 *   'http://localhost:3000/list?page=%3F',
 * );
 * // → 'same-document'
 * compareSelectionDocument('http://localhost:3000/list', 'http://localhost:3000/cart');
 * // → 'other-document'
 * compareSelectionDocument('http://localhost:3000/list', 'http://localhost:30001/list');
 * // → 'other-origin'
 * ```
 */
export function compareSelectionDocument(
  targetUrl: string,
  documentUrl: string,
): SelectionDocumentVerdict {
  const selection = readUrl(targetUrl);
  const shown = readUrl(documentUrl);

  if (selection === undefined || shown === undefined) {
    return 'unreadable';
  }

  if (
    !WEB_DOCUMENT_PROTOCOLS.has(selection.protocol) ||
    !WEB_DOCUMENT_PROTOCOLS.has(shown.protocol) ||
    selection.origin !== shown.origin
  ) {
    return 'other-origin';
  }

  return selection.pathname === shown.pathname ? 'same-document' : 'other-document';
}
