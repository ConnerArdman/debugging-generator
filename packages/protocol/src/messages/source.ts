/**
 * The source-navigation messages: `source.open`, the seam that makes every
 * runtime item in a generated panel clickable, and `source.result`, the answer
 * that tells the sender whether the click actually opened anything.
 *
 * `source.open` carries one thing — an already-resolved location in the
 * developer's project — from the DevTools panel to the editor. Everything a
 * panel shows is a runtime item that came from somewhere in the code: a span
 * produced by a function, a request started by a component, a query issued by a
 * service layer. A location attached to such an item is what turns "this took
 * 640 ms" into "this took 640 ms, and here is the line", which is why this is
 * the message with the shortest payload and one of the longest paths.
 *
 * ## The hop sequence
 *
 * A source chip in a rendered panel becomes an editor selection through a fixed
 * chain. Every hop passes the same object through unchanged; this module
 * defines what that object looks like on the hops that cross a process
 * boundary, in both directions:
 *
 * ```text
 * a SourceLink node in the rendered panel
 *   → PanelActions.openSource, the callback the renderer is handed
 *   → the Chrome extension's panel actions module
 *   → a runtime port to the MV3 background service worker
 *   → this WebSocket message, `source.open`, whose envelope `id` the sender keeps
 *   → the local service's source-open handler, which refuses any path outside
 *     the session's projectRoot
 *   → a new `source.open` frame on the WebSocket connection of the VS Code client
 *   → the editor, which opens the document with a selection at the location's
 *     line and column and reveals it with a transient highlight
 *   → `source.result` from the editor, `ref` = the id of the frame it received
 *   → the service, which relays the outcome as `source.result` to the original
 *     sender, `ref` = the id of the DevTools' own `source.open`
 *   → the service worker, which settles the panel's pending request by `ref`
 * ```
 *
 * The direction matters for who may send what: the DevTools panel is the origin
 * of `source.open` and the editor its destination, so the service forwards
 * rather than opens, and it accepts the message only from the connection bound
 * to the session named in the payload. The answer runs the other
 * way, and it is correlated by `ref` alone — the `id` of the `source.open`
 * envelope it answers — because that is the one value both ends of each hop
 * already hold: the sender minted it, and the receiver read it off the frame.
 * Nothing in either payload names a connection, a tab or a window.
 *
 * ## Three outcomes, and a failure is never presented as a success
 *
 * A `source.open` is answered exactly once, by one of the three statuses of
 * {@link SOURCE_RESULT_STATUSES}:
 *
 * - `opened` — an editor for the session's project opened the location. This is
 *   the only status a panel may render as done.
 * - `no-editor` — the location passed every check the service makes, but no
 *   VS Code window for the project is connected. The receiver falls back to the
 *   editor-open URI of {@link buildEditorOpenUri}: the DevTools panel opens
 *   `vscode://debuggen.debug-generator/open?file=…&line=…&col=…`, the operating
 *   system hands it to VS Code, and the extension's URI handler validates it
 *   **independently** — a realpath that must stay inside an open workspace
 *   folder, range checks, and an explicit confirmation from the developer,
 *   because any web page can trigger such a URI.
 * - `failed` — the service refused the location, the editor could not open it,
 *   or no editor answered within {@link SOURCE_OPEN_EDITOR_TIMEOUT_MS}. The
 *   payload carries the failure as `{ code, message, hint? }`, the shape
 *   `DebuggenError.toPayload()` returns, so a user interface renders it with the
 *   renderer it already has for every other failure.
 *
 * A request that receives no `source.result` at all — a dropped socket, a
 * suspended worker — is closed by the sender's own deadline,
 * {@link SOURCE_OPEN_RESULT_TIMEOUT_MS}, and shown as a failure rather than left
 * pending. The service's refusals that happen before the request is understood
 * at all (a frame that does not parse, a connection that may not send it) keep
 * using the generic `error` frame with the same `ref`, which is why the sender
 * settles on whichever of the two arrives first.
 *
 * ## These schemas validate shape, and deliberately nothing else
 *
 * There are two enforcement points for the question "may this path be opened",
 * and neither of them is this file:
 *
 * 1. the service, which has the session's `projectRoot` and the filesystem, and
 *    refuses a location that resolves outside it;
 * 2. the editor, which re-derives the same answer without trusting the
 *    service: against the session's `projectRoot` for a forwarded frame, whose
 *    `pinned` file and identity must match what it resolves itself, and
 *    against the workspace folders for the fallback URI.
 *
 * Containment cannot be decided here: this package has no project root, no
 * filesystem and no environment — `packages/protocol/tsconfig.json` declares
 * `types: []` and the build is `platform: "neutral"`, because the bundle is
 * loaded by a Node service, an MV3 service worker, a DevTools panel page and a
 * VS Code webview alike. Adding a third, weaker copy of the path rules would put
 * a contract this package does not own in a place that cannot enforce it, and
 * the location shape has exactly one definition. What this module does is
 * check that each payload *is* what it claims — a session id and a location, a
 * correlation reference and an outcome — and reject everything else before it
 * can reach a handler. {@link buildEditorOpenUri} follows the same rule: it
 * refuses a location the shared schema refuses, and leaves containment to the
 * handler that receives the URI.
 *
 * ## Where the location itself comes from
 *
 * The `location` field embeds `sourceLocationSchema` from `@debuggen/shared` —
 * the single definition of that shape — so this payload inherits its
 * refinements (the project-relative POSIX rule on the file, the ordering rule on
 * a multi-line range), its bounds and its resolver vocabulary without restating
 * any of them. Two consequences are worth knowing at this boundary:
 *
 * - **`line` and `column` are 1-based**, on the wire and in the store. Editors
 *   disagree about this — the VS Code API is 0-based on both axes — so the
 *   conversion happens once, in the editor-side handler, and every producer and
 *   every consumer in between speaks the 1-based convention that stack frames,
 *   compiler diagnostics and source-map output already use. The editor-open URI
 *   carries the same 1-based numbers.
 * - **Provenance travels with the location.** Five mechanisms can produce one:
 *   metadata recorded by the patcher when it installed a timing wrapper, a route
 *   map from a request path to its handler module, a symbol looked up in the
 *   indexed code graph, a stack frame in a generated dev-server chunk mapped
 *   back through its source map, and the React owner chain of a selected
 *   element. They differ in how much they can promise, which is why the location
 *   carries both the mechanism that found it and a confidence — and why a user
 *   interface can badge a weak pointer instead of presenting every location as
 *   equally certain.
 *
 * ## Module rules
 *
 * Named exports only, no default export, and no import-time side effect: the
 * manifest declares `sideEffects: false`, so everything below is a declaration.
 * No `.transform()`, `.coerce`, `.default()` or `.catch()` appears anywhere in
 * this package — a schema validates, it never rewrites, so what the panel sent
 * is what the editor opens. This module imports no sibling in this folder —
 * not even `./error.js`, which is why the failure vocabulary below is built from
 * `@debuggen/shared` directly; `messages/index.ts` merges
 * {@link SOURCE_MESSAGE_PAYLOADS} into the folder's registry, and `envelope.ts`
 * — which nothing in this folder may import — builds the discriminated union
 * from that registry. Only language globals are used (`encodeURIComponent`),
 * never a platform API, so the URI builder runs unchanged in every bundle that
 * loads this package.
 *
 * @example
 * ```ts
 * // Service: answer the DevTools sender once the editor has spoken.
 * const parsed = parseSourceResultPayload(editorFrame.payload);
 *
 * if (parsed.ok) {
 *   send(devtoolsConnection, createEnvelope('source.result', {
 *     ...parsed.value,
 *     ref: pending.devtoolsFrameId,
 *   }));
 * }
 *
 * // DevTools panel: fall back to the URI when no editor is connected.
 * if (result.status === 'no-editor') {
 *   const uri = buildEditorOpenUri(location);
 *   if (uri.ok) {
 *     openExternally(uri.value);
 *   }
 * }
 * ```
 */

import { z } from 'zod';

import { DEBUGGEN_ERROR_CODES, err, ok, sourceLocationSchema } from '@debuggen/shared';
import type { DebuggenError, Result, SourceLocation } from '@debuggen/shared';

import { protocolParseError } from '../version.js';

/**
 * The longest id this folder accepts in a payload field.
 *
 * Folder-canonical: every message module bounds an id the same way, so a frame
 * that arrived with a megabyte where a session id belongs is refused on a length
 * check rather than carried into a lookup, a log line or a user interface. The
 * ids this product mints — the prefixed, random-suffixed ids of
 * `@debuggen/shared` — are far shorter than this, and the ceiling exists for the
 * values that are *not* one of those.
 */
const MAX_ID_LENGTH = 64;

/**
 * The ceiling on the `message` of a `failed` result's error.
 *
 * The folder's canonical bound for a developer-facing sentence, identical to
 * the generic `error` frame's, so a failure a producer already reports through
 * one frame fits the other: generous for a sentence, bounded enough to log, and
 * wider than the longest validation rejection `describeZodIssues` can render.
 */
const MAX_MESSAGE_LENGTH = 2000;

/**
 * The ceiling on the optional `hint` of a `failed` result's error.
 *
 * The same bound as the message, because a hint is sometimes a command or a
 * setting name with its value spelled out, and a hint that is refused for its
 * length would take the failure it explains down with it.
 */
const MAX_HINT_LENGTH = 2000;

/**
 * The session a click belongs to: a bounded, non-empty string.
 *
 * Deliberately not pinned to the shape `@debuggen/shared` mints. The id aliases
 * in that package are unbranded strings by design, and this module is a
 * transport contract rather than an arbiter of a vocabulary it does not own:
 * restating the prefix pattern here would make a future change to id generation
 * a wire-breaking change, and it would buy nothing, because the only check that
 * can establish that a session *exists* is the service's lookup against the
 * store. What this schema rules out is the class of value that cannot be a
 * session id at all — absent, empty, or unbounded.
 *
 * Module-private on purpose: `messages/index.ts` re-exports every public name in
 * this folder, so a primitive each domain module needs stays local rather than
 * colliding with its siblings' equivalents.
 */
const sessionIdSchema = z.string().min(1).max(MAX_ID_LENGTH);

/**
 * The most digits a device or inode number is written with. 2^128 − 1 has 39
 * digits, so every 64-bit `st_dev` and `st_ino` fits with room to spare.
 */
const MAX_FILE_ID_DIGITS = 39;

/**
 * A device or inode number in canonical decimal: digits only, no sign and no
 * leading zero.
 *
 * A string, because JSON has no `bigint` and a `number` rounds an inode above
 * 2^53 — and a rounded inode can make two different files compare equal, the
 * one outcome the pin exists to refuse. The canonical form is what makes
 * string equality the same test as numeric equality, so `String(stats.ino)` of
 * a `bigint` `lstat` is compared as written.
 */
const fileIdNumberSchema = z
  .string({ error: 'expected a decimal string' })
  .regex(new RegExp(`^(?:0|[1-9][0-9]{0,${String(MAX_FILE_ID_DIGITS - 1)}})$`), {
    error: `expected a canonical decimal of at most ${String(MAX_FILE_ID_DIGITS)} digits`,
  });

/**
 * The file the service proved a forwarded `source.open` names.
 *
 * - `file` — the target's path relative to the canonical project root with
 *   every symbolic link resolved, final component included. It differs from
 *   `location.file` when the location reaches the file through a link that
 *   stays inside the project.
 * - `dev`, `ino` — the device and inode a non-following `lstat` of that
 *   canonical path reported, as {@link fileIdNumberSchema} writes them.
 *
 * Set by the service on the frame it forwards to the editor and by no other
 * sender: the service refuses an inbound `source.open` that carries it, so a
 * page can never nominate the file it wants trusted. A canonical path is true
 * only at the instant it was computed, and this frame crosses a socket before
 * the editor acts on it, so the editor resolves the location again and opens
 * nothing unless its own canonical path and identity equal these. A link
 * re-pointed or a file replaced while the frame was in flight is refused
 * rather than opened.
 */
const sourceOpenPinSchema = z.strictObject({
  file: sourceLocationSchema.shape.file,
  dev: fileIdNumberSchema,
  ino: fileIdNumberSchema,
});

/**
 * The payload of `source.open`: which session the click came from, and where in
 * the project to go.
 *
 * `z.strictObject`, so an unrecognised key is a rejection rather than a silently
 * stripped field. This payload ends in a filesystem call and an editor command,
 * and the two enforcement points downstream validate the fields they know about;
 * a field they do not know about is a producer that disagrees with this contract,
 * and the honest answer to that is to refuse the message rather than to act on
 * the half of it that parsed.
 *
 * `location` is the imported `sourceLocationSchema` itself, used as a field with
 * no wrapper and no second pass over its members. Zod 4 keeps refinements inside
 * the schema, so nesting it here runs the owner's own checks and reports their
 * issues under the full path (`location.file`, `location.endLine`), which is
 * exactly what a producer needs to fix its side.
 *
 * `pinned` is optional because only one hop carries it: absent from the
 * DevTools panel to the service, present from the service to the editor. The
 * schema cannot tell the hops apart, so each receiver enforces its own rule —
 * the service refuses a frame that carries it, the editor one that lacks it.
 */
export const sourceOpenPayloadSchema = z.strictObject({
  /** The session whose panel the developer clicked in. */
  sessionId: sessionIdSchema,

  /**
   * Where to open, as the single shared source-location shape.
   *
   * Already resolved: by the time a location reaches a panel it has been
   * produced by one of the five resolution mechanisms, so nothing in this hop
   * searches, guesses or falls back — this message says "open this", not "find
   * something like this".
   */
  location: sourceLocationSchema,

  /**
   * The canonical file and identity the service proved for `location`, on the
   * service-to-editor hop only. See {@link sourceOpenPinSchema}.
   */
  pinned: sourceOpenPinSchema.optional(),
});

/**
 * The `source.open` payload.
 *
 * Inferred from {@link sourceOpenPayloadSchema} rather than declared beside it,
 * so the validator and the type are one statement. `location` is the
 * `SourceLocation` type of `@debuggen/shared` by construction, which is what
 * lets the service and the editor pass the object straight into the resolvers
 * and the editor command that already speak it.
 */
export type SourceOpenPayload = z.infer<typeof sourceOpenPayloadSchema>;

/**
 * Validates an unknown value as a {@link SourceOpenPayload}, without throwing.
 *
 * This is how a frame that arrived over the WebSocket becomes a typed payload.
 * The failure is a `DebuggenError` with code `'PROTOCOL_INVALID_MESSAGE'`, built
 * by `protocolParseError`, which renders the issue list through this package's
 * one sanctioned issue formatter (`describeZodIssues`): field paths, issue codes
 * and schema-declared metadata, and **never a rejected value**.
 *
 * That rule earns its keep precisely here. The rejected value in the interesting
 * case *is* a path — an absolute path that would leak the machine's layout, or a
 * traversal that an attacker-controlled page put on the wire hoping to see it
 * echoed into a log, a persisted session or a status banner. A validation error
 * is raised far below the redaction layer, which therefore cannot rescue
 * anything that leaked into it (AAP §0.5.2), so the rejected path never enters
 * the message in the first place.
 *
 * @param value Any value believed to be a `source.open` payload.
 * @returns `ok(payload)` with the validated payload, or `err(error)` describing
 * the shape of the failure.
 *
 * @example
 * ```ts
 * const parsed = parseSourceOpenPayload(frame.payload);
 * if (!parsed.ok) {
 *   logger.warn('refused source.open', { reason: parsed.error.message });
 *   return;
 * }
 * ```
 */
export function parseSourceOpenPayload(value: unknown): Result<SourceOpenPayload, DebuggenError> {
  const parsed = sourceOpenPayloadSchema.safeParse(value);

  if (parsed.success) {
    return ok(parsed.data);
  }

  return err(
    protocolParseError(
      'PROTOCOL_INVALID_MESSAGE',
      'Invalid source.open payload',
      parsed.error.issues,
      'A source.open payload carries the session the click came from and a location that satisfies the shared source-location schema of @debuggen/shared; the frame the service forwards to the editor also carries pinned: { file, dev, ino }, and nothing else.',
    ),
  );
}

// ---------------------------------------------------------------------------
// `source.result` — the answer to a `source.open`
// ---------------------------------------------------------------------------

/**
 * The three outcomes a `source.open` can have, in the order the payload union
 * declares them: the location opened, no editor was there to open it, or
 * opening it failed.
 *
 * `as const` so {@link SourceResultStatus} is derived from this tuple rather
 * than written beside it, and so a user interface can iterate the vocabulary —
 * a status legend, an exhaustive `switch` — without restating it.
 * {@link SourceResultDriftAssertions} proves at compile time that the payload
 * schema's discriminants are exactly these three strings.
 */
export const SOURCE_RESULT_STATUSES = ['opened', 'no-editor', 'failed'] as const;

/** One of the three outcomes in {@link SOURCE_RESULT_STATUSES}. */
export type SourceResultStatus = (typeof SOURCE_RESULT_STATUSES)[number];

/**
 * How long the service waits for an editor's `source.result` to a forwarded
 * `source.open` before it answers the DevTools sender `failed` itself.
 *
 * Ten seconds covers what an editor legitimately does before it can answer —
 * activate the extension on first use, read a large file from disk, bring a
 * window to the front — and is short enough that a developer who clicked a
 * source chip learns that nothing happened while they are still looking at the
 * panel. The service starts this deadline when it hands the frame to the
 * editor's connection and cancels it on the editor's first answer; an answer
 * that arrives after the deadline is dropped, because the sender has already
 * been told.
 */
export const SOURCE_OPEN_EDITOR_TIMEOUT_MS = 10_000;

/**
 * How long the DevTools side — the MV3 service worker holding the panel's
 * request — waits for the service's `source.result` (or an `error` frame with
 * the same `ref`) before it reports the request as failed.
 *
 * Two constraints fix the value, and both are why it lives here rather than in
 * either app. It must **exceed** {@link SOURCE_OPEN_EDITOR_TIMEOUT_MS}, so that
 * the service's own `failed` answer for a silent editor always arrives before
 * the worker gives up and the developer sees the specific reason rather than a
 * generic timeout; five seconds of margin absorb a reconnect and the relay hop.
 * And it must stay **below** the twenty-second ceiling the service worker puts
 * on any request a panel port makes, so the worker answers the panel with a
 * `source.open` outcome rather than having the port request itself time out.
 */
export const SOURCE_OPEN_RESULT_TIMEOUT_MS = 15_000;

/**
 * The correlation reference of a `source.result`: the `id` of the `source.open`
 * envelope it answers.
 *
 * Required, because a result that cannot be tied to a request settles nothing,
 * and non-empty and bounded exactly as the generic `error` frame's `ref` is, so
 * one correlation rule serves both answers a sender may receive. Every id
 * `newMessageId()` mints fits comfortably; a sender that wants an answer uses
 * one of those.
 */
const refSchema = z
  .string({ error: 'expected a ref string' })
  .min(1, { error: 'expected a non-empty ref' })
  .max(MAX_ID_LENGTH, {
    error: `expected a ref of at most ${MAX_ID_LENGTH} characters`,
  });

/**
 * The closed error-code vocabulary, as the `code` of a `failed` result.
 *
 * Built here from `DEBUGGEN_ERROR_CODES` rather than imported from `./error.js`,
 * because this module imports no sibling (see the module rules). The effect is
 * the same as reusing that schema: the tuple is spread, not retyped, so a code
 * added to `@debuggen/shared` widens this enumeration in the same edit, and an
 * unrecognised code — which no user interface has a rendering for — is refused
 * at the boundary instead of being displayed raw. The spread is required by
 * Zod's enum signature, which takes a mutable array; the literal types come from
 * the tuple's `as const`.
 */
const sourceResultErrorCodeSchema = z.enum([...DEBUGGEN_ERROR_CODES], {
  error: 'expected one of the error codes declared by @debuggen/shared',
});

/**
 * Why a `source.open` failed: `{ code, message, hint? }`.
 *
 * Exactly the shape `DebuggenError.toPayload()` returns, so the service and the
 * editor report a failure by placing that object here unchanged, and a
 * DevTools panel renders it through the same path as every other
 * `DebuggenError` it shows. {@link SourceResultDriftAssertions} ties the two
 * together at compile time. Unlike the generic `error` frame this nest keeps the
 * optional `hint`: the next step for a refused source link — reopen the
 * project's folder, pair the editor, start the service from VS Code — is the
 * part of the failure a developer acts on.
 *
 * Strict, and every string bounded with the folder's canonical bounds, for the
 * reason every payload here is: a field this contract does not name is a
 * producer mistake worth a loud refusal, and a megabyte in a message is refused
 * before it reaches a banner or a log line. Never repaired: a missing `message`
 * is a rejection, not an empty string supplied on the sender's behalf.
 */
const sourceResultErrorSchema = z.strictObject({
  /** The failure being reported; what a user interface switches on. */
  code: sourceResultErrorCodeSchema,

  /**
   * What went wrong, in one sentence, for a developer to read.
   *
   * Never a path the service refused: the service reports a containment
   * refusal by its code and a constant sentence, because the refused value is
   * attacker-controllable and a user interface is no place to echo it.
   */
  message: z
    .string({ error: 'expected an error message string' })
    .min(1, { error: 'expected a non-empty error message' })
    .max(MAX_MESSAGE_LENGTH, {
      error: `expected an error message of at most ${MAX_MESSAGE_LENGTH} characters`,
    }),

  /** The one concrete action that makes the failure recoverable, when there is one. */
  hint: z
    .string({ error: 'expected a hint string' })
    .min(1, { error: 'expected a non-empty hint' })
    .max(MAX_HINT_LENGTH, {
      error: `expected a hint of at most ${MAX_HINT_LENGTH} characters`,
    })
    .optional(),
});

/**
 * `opened` — an editor for the session's project opened the location.
 *
 * The only status that may be shown as success, and it means the editor has
 * *opened* the document, not merely that a frame was queued for it.
 */
const sourceOpenedResultSchema = z.strictObject({
  /** The session the answered `source.open` named. */
  sessionId: sessionIdSchema,
  /** The `id` of the `source.open` envelope this answers. */
  ref: refSchema,
  /** The discriminant. */
  status: z.literal('opened'),
});

/**
 * `no-editor` — the location passed every check the service makes, but no
 * VS Code window for the project is connected.
 *
 * Sent by the service only, and only after its own validation succeeded, so a
 * receiver may treat it as permission to try the editor-open URI of
 * {@link buildEditorOpenUri} — never as proof the location is safe, which is why
 * the extension's URI handler validates it again and asks the developer first.
 */
const sourceNoEditorResultSchema = z.strictObject({
  /** The session the answered `source.open` named. */
  sessionId: sessionIdSchema,
  /** The `id` of the `source.open` envelope this answers. */
  ref: refSchema,
  /** The discriminant. */
  status: z.literal('no-editor'),
});

/**
 * `failed` — the service refused the location, the editor could not open it, or
 * no editor answered in time. The `error` says which, and it is required: a
 * failure with nothing to say is indistinguishable from a dropped field.
 */
const sourceFailedResultSchema = z.strictObject({
  /** The session the answered `source.open` named. */
  sessionId: sessionIdSchema,
  /** The `id` of the `source.open` envelope this answers. */
  ref: refSchema,
  /** The discriminant. */
  status: z.literal('failed'),
  /** Why, as `DebuggenError.toPayload()` shapes it. */
  error: sourceResultErrorSchema,
});

/**
 * The payload of `source.result`: which request it answers, for which session,
 * and how it ended.
 *
 * One message type in both directions — the editor answering the service's
 * forwarded `source.open`, and the service answering the DevTools panel's own —
 * because the question is the same on both hops and only `ref` differs: each
 * hop's answer carries the `id` of the frame *that hop* received. The service
 * accepts one from a `vscode` connection only for a `source.open` it forwarded
 * to that connection, and sends one to a `devtools` connection only for a
 * `source.open` that connection sent.
 *
 * A discriminated union on `status`, each member a strict object, so the
 * `error` of a failure is required exactly when the status is `failed` and
 * forbidden otherwise — an `opened` result that also carried an error would be
 * a contradiction a user interface could only resolve by guessing. Every member
 * carries `sessionId`, so the envelope's routing rule applies to this frame as
 * to every other: a routing key naming a different session is refused.
 */
export const sourceResultPayloadSchema = z.discriminatedUnion('status', [
  sourceOpenedResultSchema,
  sourceNoEditorResultSchema,
  sourceFailedResultSchema,
]);

/**
 * The `source.result` payload.
 *
 * Inferred from {@link sourceResultPayloadSchema}, so narrowing on `status` is
 * what gives a consumer the `error` of a `failed` result, and a `switch` over
 * the three statuses is checked for exhaustiveness by the compiler.
 */
export type SourceResultPayload = z.infer<typeof sourceResultPayloadSchema>;

/**
 * Validates an unknown value as a {@link SourceResultPayload}, without throwing.
 *
 * The service reads an editor's answer through this, and the Chrome service
 * worker reads the service's. The failure is a `DebuggenError` with code
 * `'PROTOCOL_INVALID_MESSAGE'` built by `protocolParseError`, so it names issue
 * paths and codes — an unknown `status` is reported at the discriminator, a
 * missing `error` under its own name — and **never** a rejected value: the
 * `message` of a malformed failure is unvalidated text from another process,
 * and it does not travel into this error.
 *
 * @param value Any value believed to be a `source.result` payload.
 * @returns `ok(payload)` with the validated payload, or `err(error)` describing
 * the shape of the failure.
 *
 * @example
 * ```ts
 * const parsed = parseSourceResultPayload(frame.payload);
 * if (!parsed.ok) {
 *   logger.warn('refused source.result', { reason: parsed.error.message });
 *   return;
 * }
 * settlePending(parsed.value.ref, parsed.value);
 * ```
 */
export function parseSourceResultPayload(
  value: unknown,
): Result<SourceResultPayload, DebuggenError> {
  const parsed = sourceResultPayloadSchema.safeParse(value);

  if (parsed.success) {
    return ok(parsed.data);
  }

  return err(
    protocolParseError(
      'PROTOCOL_INVALID_MESSAGE',
      'Invalid source.result payload',
      parsed.error.issues,
      'A source.result payload carries the session, the ref of the source.open it answers and a status of opened, no-editor or failed; a failed result also carries an error of { code, message, hint? }, and nothing else.',
    ),
  );
}

// ---------------------------------------------------------------------------
// Compile-time drift guard
//
// Two statements above are true only while two declarations elsewhere agree
// with them: that the union's discriminants are exactly SOURCE_RESULT_STATUSES,
// and that a failed result's error is exactly what `DebuggenError.toPayload()`
// returns. Both are proved here, with type-level helpers and nothing emitted.
// ---------------------------------------------------------------------------

/** Fails to compile (TS2344) unless its argument is exactly `true`. */
type Expect<TAssertion extends true> = TAssertion;

/**
 * `true` when two unions have the same members; the tuple wrappers stop either
 * side from distributing.
 */
type SameUnion<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/**
 * Restates every property as required-and-possibly-`undefined`, so a
 * hand-written `hint?: string` and Zod's inferred `hint?: string | undefined` —
 * which `exactOptionalPropertyTypes` keeps apart — compare as the same field.
 */
type WithExplicitUndefined<T> = { [K in keyof T]-?: T[K] | undefined };

/** `true` when two object types carry the same fields with the same value types. */
type SameFields<A, B> = SameUnion<WithExplicitUndefined<A>, WithExplicitUndefined<B>>;

/** The keys of `T` that are declared optional. */
type OptionalKeysOf<T> = { [K in keyof T]-?: object extends Pick<T, K> ? K : never }[keyof T];

/** The error a `failed` result carries. */
type SourceResultError = Extract<SourceResultPayload, { status: 'failed' }>['error'];

/** What `DebuggenError.toPayload()` returns: `{ code, message, hint? }`. */
type DebuggenErrorWirePayload = ReturnType<DebuggenError['toPayload']>;

/**
 * The compile-time proof that this module agrees with the two declarations it
 * depends on.
 *
 * The first element fails when a status is added to, removed from or renamed in
 * {@link SOURCE_RESULT_STATUSES} without the same change to the union's members
 * (or the reverse). The second and third fail when `DebuggenError.toPayload()`
 * gains, loses or retypes a field, or moves one between required and optional —
 * the change that would otherwise surface as a `failed` result every strict
 * receiver refuses, produced by a sender that did nothing but report its error.
 *
 * Exported for the mechanical reason `./error.ts` exports its own assertion: an
 * unreferenced local alias is an error under `noUnusedLocals`, and a JSDoc
 * reference is not a use. It is a type, so nothing is emitted.
 */
export type SourceResultDriftAssertions = [
  Expect<SameUnion<SourceResultPayload['status'], SourceResultStatus>>,
  Expect<SameFields<DebuggenErrorWirePayload, SourceResultError>>,
  Expect<SameUnion<OptionalKeysOf<DebuggenErrorWirePayload>, OptionalKeysOf<SourceResultError>>>,
];

// ---------------------------------------------------------------------------
// The editor-open URI — the fallback when no editor is connected
// ---------------------------------------------------------------------------

/**
 * The parts of the editor-open URI, defined once for its two users: the
 * DevTools panel, which opens the URI, and the VS Code extension's URI handler,
 * which receives it.
 *
 * `vscode://debuggen.debug-generator/open?file=…&line=…&col=…`:
 *
 * - `scheme` — the scheme VS Code registers with the operating system;
 * - `authority` — `<publisher>.<name>` of the extension, which is how VS Code
 *   routes the URI to that extension's one registered URI handler;
 * - `path` — the one action the handler performs;
 * - the three query parameter names — the location's `file`, `line` and
 *   `column`, 1-based like everything else on this wire. Nothing else is
 *   carried: the handler needs no symbol, confidence or session to open a
 *   document, and a parameter it does not read is one more thing a page could
 *   put in a URI.
 *
 * Frozen, so a consumer cannot redirect every fallback in its process by
 * mutating a shared table.
 */
export const EDITOR_OPEN_URI = Object.freeze({
  scheme: 'vscode',
  authority: 'debuggen.debug-generator',
  path: '/open',
  fileParameter: 'file',
  lineParameter: 'line',
  columnParameter: 'col',
} as const);

/** The first UTF-16 code unit of a surrogate pair (a high surrogate). */
const FIRST_HIGH_SURROGATE = 0xd800;

/** The last high surrogate. */
const LAST_HIGH_SURROGATE = 0xdbff;

/** The first second-half code unit of a surrogate pair (a low surrogate). */
const FIRST_LOW_SURROGATE = 0xdc00;

/** The last low surrogate. */
const LAST_LOW_SURROGATE = 0xdfff;

/**
 * Whether a string is well-formed UTF-16: every surrogate is half of a pair.
 *
 * `encodeURIComponent` throws a `URIError` on a lone surrogate, and a file name
 * can carry one — the shared schema admits any character but a control code —
 * so the builder below refuses such a file up front rather than throwing out of
 * a function that returns a `Result`. Written as a loop because
 * `String.prototype.isWellFormed` is newer than this package's ES2023 library.
 *
 * @param text The text to check.
 * @returns `true` when every high surrogate is followed by a low one and no low
 * surrogate stands alone.
 */
function isWellFormedText(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);

    if (unit >= FIRST_HIGH_SURROGATE && unit <= LAST_HIGH_SURROGATE) {
      // `charCodeAt` past the end is `NaN`, which fails both comparisons.
      const next = text.charCodeAt(index + 1);

      if (!(next >= FIRST_LOW_SURROGATE && next <= LAST_LOW_SURROGATE)) {
        return false;
      }
      index += 1;
    } else if (unit >= FIRST_LOW_SURROGATE && unit <= LAST_LOW_SURROGATE) {
      return false;
    }
  }

  return true;
}

/**
 * The label a file that cannot be URI-encoded is refused under, rendered by
 * `describeZodIssues` as `file (custom label=well-formed-text)`.
 */
const WELL_FORMED_TEXT_LABEL = 'well-formed-text';

/**
 * The location an editor-open URI may carry: the shared schema's own rules, plus
 * the one thing a URI needs that a WebSocket frame does not — a file name that
 * `encodeURIComponent` can encode.
 *
 * `sourceLocationSchema` itself, with one refinement appended (Zod clones rather
 * than mutates, so the shared schema is unchanged for every other embedder).
 * Every other rule — project-relative POSIX, no `..`, 1-based integers — is the
 * owner's, applied as the owner wrote it.
 */
const editorOpenLocationSchema = sourceLocationSchema.refine(
  (location) => isWellFormedText(location.file),
  {
    error: 'expected a file of well-formed text: a lone surrogate has no URI encoding',
    path: ['file'],
    params: { label: WELL_FORMED_TEXT_LABEL },
  },
);

/**
 * Encodes one query value for the editor-open URI: `encodeURIComponent`, twice.
 *
 * The receiving side decodes twice, and that is the whole reason. VS Code's
 * `Uri.parse` percent-decodes the query once before the URI handler sees it,
 * and the handler then splits `uri.query` with `URLSearchParams`, which decodes
 * each value again — and turns a literal `+` into a space. Encoded once, a file
 * named `a+b.ts` would arrive as `a b.ts`, one containing `&` or `=` would be
 * split into a different set of parameters after the first decode, and one
 * containing `%41` would arrive as `A`. Encoded twice, the first decode leaves
 * a correctly single-encoded query and the second recovers the exact original:
 * `+`, `&`, `=`, `%`, `#`, a space and any non-ASCII character all round-trip
 * unchanged.
 *
 * @param value A validated file, line or column.
 * @returns The value, percent-encoded twice.
 */
function encodeEditorQueryValue(value: string | number): string {
  return encodeURIComponent(encodeURIComponent(String(value)));
}

/**
 * Builds the editor-open URI for a location — the fallback a DevTools panel
 * opens when its `source.open` was answered `no-editor`.
 *
 * `vscode://debuggen.debug-generator/open?file=<file>&line=<line>&col=<column>`,
 * with each value encoded twice (see {@link encodeEditorQueryValue} for why).
 * Only `file`, `line` and `column` are carried.
 *
 * The argument is validated rather than trusted, because a panel builds it from
 * data that crossed two process boundaries and a URI is the one output of this
 * package that leaves the product entirely: a location the shared source-location
 * schema refuses — an absolute path, a `..` traversal, a zero line — or a file
 * that cannot be URI-encoded is answered with a `DebuggenError` of code
 * `'PROTOCOL_INVALID_MESSAGE'` from `protocolParseError`, which names the field
 * and **never** the rejected value. Passing validation is not
 * permission to open anything: the extension's URI handler resolves the file
 * against the open workspace folders itself, refuses whatever escapes them, and
 * asks the developer to confirm before opening.
 *
 * Pure and platform-neutral: string operations and `encodeURIComponent` only,
 * no `URL`, no `window` and no Node builtin, so the Node service, the MV3 worker
 * and both panels build the same string.
 *
 * @param location The location the `source.open` carried.
 * @returns `ok(uri)`, or `err(error)` when the location is not a valid shared
 * source location.
 *
 * @example
 * ```ts
 * buildEditorOpenUri({ file: 'src/a+b.ts', line: 3, column: 1, resolvedBy: 'patch', confidence: 1 });
 * // → ok('vscode://debuggen.debug-generator/open?file=src%252Fa%252Bb.ts&line=3&col=1')
 * ```
 */
export function buildEditorOpenUri(location: SourceLocation): Result<string, DebuggenError> {
  const parsed = editorOpenLocationSchema.safeParse(location);

  if (!parsed.success) {
    return err(
      protocolParseError(
        'PROTOCOL_INVALID_MESSAGE',
        'Invalid source location for the editor-open URI',
        parsed.error.issues,
        'The editor-open URI carries a location that satisfies the shared source-location schema of @debuggen/shared: a project-relative POSIX file of well-formed text, and a 1-based line and column.',
      ),
    );
  }

  const { file, line, column } = parsed.data;
  const query = [
    `${EDITOR_OPEN_URI.fileParameter}=${encodeEditorQueryValue(file)}`,
    `${EDITOR_OPEN_URI.lineParameter}=${encodeEditorQueryValue(line)}`,
    `${EDITOR_OPEN_URI.columnParameter}=${encodeEditorQueryValue(column)}`,
  ].join('&');

  return ok(
    `${EDITOR_OPEN_URI.scheme}://${EDITOR_OPEN_URI.authority}${EDITOR_OPEN_URI.path}?${query}`,
  );
}

/**
 * This module's contribution to the folder registry: the payload schemas of
 * `source.open` and `source.result`, under their wire names.
 *
 * `messages/index.ts` merges this map with the other domain modules' maps into
 * `MESSAGE_PAYLOAD_SCHEMAS`, and `envelope.ts` maps over that to build the
 * discriminated union every frame is validated against. `source.open` is the
 * documented message name, spelled exactly; `source.result` is its answer.
 * Both are written once, here, and referenced everywhere else.
 *
 * Frozen because it is a module-level table the envelope reads on every parse: a
 * mutation would redefine what the whole process accepts on the wire.
 */
export const SOURCE_MESSAGE_PAYLOADS = Object.freeze({
  'source.open': sourceOpenPayloadSchema,
  'source.result': sourceResultPayloadSchema,
} as const);
