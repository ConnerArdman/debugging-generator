/**
 * The `source.open` message: the seam that makes every runtime item in a
 * generated panel clickable.
 *
 * One payload lives here, and it carries one thing — an already-resolved
 * location in the developer's project — from the DevTools panel to the editor.
 * Everything a panel shows is a runtime item that came from somewhere in the
 * code: a span produced by a function, a request started by a component, a
 * query issued by a service layer. A location attached to such an item is what
 * turns "this took 640 ms" into "this took 640 ms, and here is the line", which
 * is why this is the message with the shortest payload and one of the longest
 * paths.
 *
 * ## The hop sequence
 *
 * A source chip in a rendered panel becomes an editor selection through a fixed
 * chain (AAP §0.2.3, §0.4.2). Every hop passes the same object through
 * unchanged; this module defines what that object looks like on the one hop that
 * crosses a process boundary:
 *
 * ```text
 * a SourceLink node in the rendered panel
 *   → PanelActions.openSource, the callback the renderer is handed
 *   → the Chrome extension's panel actions module
 *   → a runtime port to the MV3 background service worker
 *   → this WebSocket message, `source.open`
 *   → the local service's source-open handler, which refuses any path outside
 *     the session's projectRoot
 *   → the WebSocket connection of the VS Code client
 *   → the editor, which opens the document with a selection at the location's
 *     line and column and reveals it with a transient highlight
 * ```
 *
 * The direction matters for who may send it: the DevTools panel is the origin
 * and the editor is the destination, so the service forwards rather than
 * answers, and it accepts the message only from the connection bound to the
 * session named in the payload (AAP §0.5.6). When no editor client is connected
 * the service falls back to a `vscode://` URI, which the extension's URI handler
 * validates **independently** — a realpath that must stay inside an open
 * workspace folder, range checks, and an explicit confirmation from the
 * developer, because any web page can trigger such a URI.
 *
 * ## This schema validates shape, and deliberately nothing else
 *
 * There are two enforcement points for the question "may this path be opened",
 * and neither of them is this file:
 *
 * 1. the service, which has the session's `projectRoot` and the filesystem, and
 *    refuses a location that resolves outside it;
 * 2. the editor's URI handler, which re-derives the same answer from the
 *    workspace folders without trusting the service.
 *
 * Containment cannot be decided here: this package has no project root, no
 * filesystem and no environment — `packages/protocol/tsconfig.json` declares
 * `types: []` and the build is `platform: "neutral"`, because the bundle is
 * loaded by a Node service, an MV3 service worker, a DevTools panel page and a
 * VS Code webview alike. Adding a third, weaker copy of the path rules would put
 * a contract this package does not own in a place that cannot enforce it, and
 * AAP §0.9.1 allows the shape exactly one definition. What this module does is
 * check that the payload *is* a session id and a location, and reject everything
 * else before it can reach a handler.
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
 *   compiler diagnostics and source-map output already use.
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
 * is what the editor opens. This module imports no sibling in this folder;
 * `messages/index.ts` merges {@link SOURCE_MESSAGE_PAYLOADS} into the folder's
 * registry, and `envelope.ts` — which nothing in this folder may import — builds
 * the discriminated union from that registry.
 *
 * @example
 * ```ts
 * const parsed = parseSourceOpenPayload(message.payload);
 *
 * if (parsed.ok) {
 *   // The service checks containment against the session's project root before
 *   // forwarding this to the editor client.
 *   forwardToEditor(parsed.value.sessionId, parsed.value.location);
 * }
 * ```
 */

import { z } from 'zod';

import { err, ok, sourceLocationSchema } from '@debuggen/shared';
import type { DebuggenError, Result } from '@debuggen/shared';

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
      'A source.open payload carries exactly two fields: the session the click came from, and a location that satisfies the shared source-location schema of @debuggen/shared.',
    ),
  );
}

/**
 * This module's contribution to the folder registry: the payload schema of
 * `source.open`, under its wire name.
 *
 * `messages/index.ts` merges this map with the other domain modules' maps into
 * `MESSAGE_PAYLOAD_SCHEMAS`, and `envelope.ts` maps over that to build the
 * discriminated union every frame is validated against. The key is verbatim from
 * AAP §0.4.2 and is one of the message names the product's requirements fix
 * character for character, so it is written once, here, and referenced
 * everywhere else.
 *
 * Frozen because it is a module-level table the envelope reads on every parse: a
 * mutation would redefine what the whole process accepts on the wire.
 */
export const SOURCE_MESSAGE_PAYLOADS = Object.freeze({
  'source.open': sourceOpenPayloadSchema,
} as const);
