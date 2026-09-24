/**
 * The `cleanup.completed` message: the product's central promise, stated on the
 * wire.
 *
 * One payload lives here, and it answers the only question a developer really
 * needs answered when a debugging session ends: **is my working tree back the
 * way I left it?** Everything else this protocol carries is evidence about a
 * running program. This message is about the developer's own files — the ones
 * the tool copied, hashed and rewrote in place so that a named function could be
 * timed, and the ones it has now put back.
 *
 * It is a broadcast, not a request: the local service sends it to the VS Code
 * client and to the DevTools panel when a cleanup pass finishes (AAP §0.4.2).
 * Neither surface answers it; both render it — VS Code in its modifications list
 * beside each record's status badge, DevTools in its session summary — and a
 * conflict entry is what puts an "Open diff" action in front of the developer
 * (AAP §0.5.5).
 *
 * ## What each status means to someone looking at their git status
 *
 * The vocabulary is imported from `../session-record.ts`, which owns it, and its
 * four members are the whole answer this message can give. They are listed here
 * because this is the module a reader reaches for when they want to know what
 * one of them *means*, and because the difference between the last three is the
 * difference between "nothing to do" and "read this carefully":
 *
 * | status     | what happened                                                  | what the developer should do |
 * | ---------- | -------------------------------------------------------------- | ---------------------------- |
 * | `pending`  | cleanup has not run. The state a session is in from creation until a pass completes, and the one status this message rarely carries — a finished pass has a verdict. | wait, or end the session |
 * | `clean`    | every non-reverted record was restored, and each restored file's bytes were hashed and matched the `originalHash` recorded before the patch was written. The backups of those files are then deleted. | nothing. The tree is as it was |
 * | `partial`  | some records were restored and some could not be attempted — a pass that was interrupted, or a record whose file the pass could not reach. Nothing was overwritten; what was not restored is still recorded in the journal and is reported again on the next service start. | re-run cleanup, or end the session again |
 * | `conflict` | at least one instrumented file had been edited after the patch was applied, so its current hash matched neither the instrumented content nor anything the tool may overwrite. **That file was left exactly as the developer left it**, its pristine original is retained in the backup directory, and the conflict entry names both. | open the diff, keep or discard the tool's wrapper by hand, then delete the backup |
 *
 * The asymmetry in the last row is the safety property, and it is worth being
 * explicit about: a restore is authorised **only** when the file on disk still
 * hashes to the `instrumentedHash` the journal recorded before the write. Any
 * other hash — the developer's edit, a formatter's pass, a merge — withdraws that
 * authorisation, and the tool reports rather than writes (AAP §0.5.1). A
 * `conflict` is therefore not a failure of the promise; it is the promise being
 * kept in the one case where restoring would destroy work.
 *
 * ## When a pass runs, and what it acts on
 *
 * Three triggers, all of which can produce this message (AAP §0.5.1):
 *
 * 1. **session end** — the developer ends the session from the editor;
 * 2. **extension deactivation** — the editor is closing, so the extension host
 *    ends the active session on its way out;
 * 3. **service start** — a reconciliation pass over every record left behind by
 *    a process that did not get to finish, which is why a crash mid-patch is a
 *    reported conflict on the next start rather than a file nobody remembers.
 *
 * What a pass walks is the **modification journal**, not the session list: every
 * non-reverted record, whatever status its owning session is in — instrumenting,
 * ready, capturing, analyzing, generated, failed or mid-cleanup. A session whose
 * status says nothing about cleanup can still own a patched file, and a record is
 * closed only by being restored or by being reported. That is also why the
 * status carried here is a *session's* cleanup state and has four members, while
 * `@debuggen/instrumentation` names one pass's verdict with three: a pass that
 * has run is never `pending`. A consumer that needs both imports each from its
 * own owner; this module imports the session vocabulary, because this message
 * reports a session's state.
 *
 * ## What this message does not cover: the runtime hooks
 *
 * Cleanup has a second half that travels on a different message. The runtime
 * signals — the browser agent's listeners, its fetch and XHR patches, its React
 * commit subscription, and the Node preload's Prisma, `pg` and tracer-provider
 * instrumentations — are **disabled, not idled**: the agent detaches its
 * listeners, restores the original `fetch`/XHR functions and unsubscribes from
 * the commit hook, and the preload unwraps its instrumentations and removes the
 * global tracer provider, so the dev server's own spans become no-ops rather
 * than spans nobody reads. What remains is an inert preload module with no
 * active patches, no provider and no file changes; removing the module itself
 * means restarting the dev server without the tool, which the security
 * documentation states.
 *
 * That teardown is **arming**, and arming is carried by `./agent.ts` — an
 * `agent.config` with every hook false, and a `server-agent.config` with no
 * capture. This message reports **file restoration**, which is the half that
 * touches the developer's tree and therefore the half that needs a verdict, a
 * conflict list and a place in the session record.
 *
 * The same `CleanupStatus` value is also the body of the session-end HTTP
 * response, `{ cleanup: CleanupStatus }`. That body is defined in `../http.ts`,
 * which owns the route contracts; nothing here defines an HTTP shape, so the two
 * cannot disagree — they read the one vocabulary from the one owner.
 *
 * ## Module rules
 *
 * Both halves of the payload are imported, which is why this file is short by
 * design: the status vocabulary from `../session-record.ts` and the conflict
 * report from `@debuggen/instrumentation`, each with one definition in the whole
 * product (AAP §0.9.1). Named exports only, no default export, and no
 * import-time side effect — the manifest declares `sideEffects: false`, so every
 * export below is a declaration. No `.transform()`, `.coerce`, `.default()` or
 * `.catch()` appears anywhere in this package: a schema validates, it never
 * rewrites, so the verdict a developer reads is the verdict the pass reached.
 * This module imports no sibling in this folder; the folder's registry module
 * merges {@link CLEANUP_MESSAGE_PAYLOADS} into the one payload table, and the
 * envelope — which nothing in this folder may import — builds the discriminated
 * union from that table.
 *
 * @example
 * ```ts
 * const parsed = parseCleanupCompletedPayload(frame.payload);
 *
 * if (parsed.ok) {
 *   const { status, conflicts } = parsed.value;
 *
 *   // `conflicts` is always an array, so no surface has to distinguish absent
 *   // from empty before it can render "no conflicts".
 *   showCleanupResult(status, conflicts);
 * }
 * ```
 */

import { z } from 'zod';

import { err, ok } from '@debuggen/shared';
import type { DebuggenError, Result } from '@debuggen/shared';
import { modificationConflictSchema } from '@debuggen/instrumentation/schema';
import type { ModificationConflict } from '@debuggen/instrumentation/schema';

import { cleanupStatusSchema } from '../session-record.js';
import type { CleanupStatus } from '../session-record.js';
import { protocolParseError } from '../version.js';

// ---------------------------------------------------------------------------
// Section A — module-local bounds and primitives
// ---------------------------------------------------------------------------

/**
 * The longest id this folder accepts in a payload field.
 *
 * Folder-canonical: every message module bounds an id the same way, so a frame
 * that arrived with a megabyte where a session id belongs is refused on a length
 * check rather than carried into a store lookup, a log line or a user interface.
 * The ids this product mints are far shorter than this; the ceiling exists for
 * the values that are not one of them.
 *
 * Module-private, like its equivalents in the sibling modules: `../version.ts`
 * exports no id primitive, and this folder's registry re-exports every public
 * name in it, so a constant each domain module needs stays local rather than
 * colliding with a sibling's copy under one exported name.
 */
const MAX_ID_LENGTH = 64;

/**
 * The most array members this folder accepts in a payload field.
 *
 * Folder-canonical, and deliberately looser than the ceiling the session record
 * applies to the same list when it stores it. The two bounds answer different
 * questions: the record's is a product decision about how much history one
 * session keeps, while this one only refuses the class of frame that cannot be a
 * conflict list at all — a producer that lost a loop bound, or a decoder that
 * handed the parser something enormous. The tighter rule still applies where the
 * value is persisted, because the record validates its own field with its own
 * schema; restating that number here would put a second, competing bound on one
 * shape.
 */
const MAX_ARRAY_LENGTH = 1000;

/**
 * The session this cleanup result belongs to: a bounded, non-empty string.
 *
 * Deliberately **not** pinned to the prefixed form `@debuggen/shared`'s id
 * module mints. That module owns the id grammar, and re-deriving its prefix
 * pattern at a transport boundary would make a future change to id generation a
 * wire-breaking change while buying nothing: the only check that can establish
 * that a session *exists* is the service's lookup against the store, and this
 * message is routed to the clients of exactly that session. What this schema
 * rules out is the class of value that cannot be a session id at all — absent,
 * empty, or unbounded.
 *
 * Note what it does not re-check: each conflict entry carries its own
 * `sessionId`, bounded and shaped by the schema that owns the conflict report.
 * This schema does not reach into the entries to compare them; a mismatch
 * between a conflict's session and the envelope's is a service-side routing
 * question, decided where the journal is read rather than where the frame is
 * parsed.
 */
const sessionIdSchema = z
  .string()
  .min(1, { error: 'expected a non-empty session identifier' })
  .max(MAX_ID_LENGTH, {
    error: `expected a session identifier of at most ${String(MAX_ID_LENGTH)} characters`,
  });

// ---------------------------------------------------------------------------
// Section B — the payload
// ---------------------------------------------------------------------------

/**
 * The payload of `cleanup.completed`: which session was cleaned up, what the
 * pass concluded, and every modification it refused to overwrite.
 *
 * `z.strictObject`, so an unrecognised key is a rejection rather than a silently
 * stripped field. The producer this turns away is a plausible one — a pass that
 * attached its own extra summary, a count, a duration, a list of restored paths
 * — and refusing it is the honest answer, because a receiver that accepted the
 * frame would render the three fields it knows and quietly drop whatever the
 * producer thought it was also saying. On a message whose entire job is to
 * account for writes to the developer's files, a silently dropped field is the
 * one failure mode worth being strict about.
 *
 * Three fields, and the shape is fixed by AAP §0.4.2. The session record stores
 * the same information under its `cleanup` field, alongside a `completedAt`
 * timestamp the record keeps and this frame does not: the broadcast is the
 * announcement that a pass finished, so its own arrival is the time, and a
 * receiver that wants the stamped value reads the record it also receives.
 */
export const cleanupCompletedPayloadSchema = z.strictObject({
  /** The session whose modification journal the pass walked. */
  sessionId: sessionIdSchema,

  /**
   * The verdict, over the four values the session vocabulary defines.
   *
   * The imported `cleanupStatusSchema` itself, used as a field with no wrapper
   * and no local copy of the enumeration: the four strings are written once, in
   * the module that owns them, so a fifth state cannot be introduced on the wire
   * without being introduced in the record and the editor's status badge at the
   * same time. See this module's header for what each one means to a developer.
   */
  status: cleanupStatusSchema,

  /**
   * The modifications the pass refused to overwrite, each naming the file, the
   * hash it expected, the hash it found, the backup the developer's original is
   * still in, and the three-way view behind the "Open diff" action.
   *
   * **Required, and empty rather than absent** when there are none. That choice
   * is for the two user interfaces: an empty array renders "no conflicts"
   * directly, while an optional field would force every surface to distinguish
   * "the pass reported no conflicts" from "the pass said nothing about
   * conflicts" — a distinction with no meaning here, written correctly in two
   * surfaces and forgotten in the third.
   *
   * The element schema is the imported `modificationConflictSchema`, so the
   * owner's rules run unchanged and unrestated: the hashes must be 64 lowercase
   * hexadecimal characters, the file must be project-relative POSIX, the reason
   * must be one of the four branches of the reconciliation table, the
   * developer-facing message must be non-empty, and each diff is bounded. Zod
   * keeps refinements inside the schema, so nesting it here reports the owner's
   * issues under the full path — `conflicts[0].expectedHash` — which is exactly
   * what a producer needs to fix its side.
   *
   * A non-empty array does not imply `status` is the conflict value: a pass that
   * restored some files and hit one edited file reports that mixture, and the
   * status is the pass's own conclusion rather than a function of this array's
   * length. Consumers read the status for the headline and the array for the
   * detail.
   */
  conflicts: z.array(modificationConflictSchema).max(MAX_ARRAY_LENGTH, {
    error: `expected at most ${String(MAX_ARRAY_LENGTH)} modification conflicts`,
  }),
});

/**
 * The `cleanup.completed` payload.
 *
 * Inferred from {@link cleanupCompletedPayloadSchema} rather than declared
 * beside it, so the validator and the type are one statement. `status` is the
 * `CleanupStatus` of `../session-record.ts` and each member of `conflicts` is
 * the `ModificationConflict` of `@debuggen/instrumentation`, both by
 * construction rather than by convention — which is what lets a receiver pass a
 * parsed payload straight into the editor's modifications view, the DevTools
 * session summary and the session store without a cast or a re-map. Section D
 * proves those two edges at compile time.
 */
export type CleanupCompletedPayload = z.infer<typeof cleanupCompletedPayloadSchema>;

// ---------------------------------------------------------------------------
// Section C — non-throwing parser and the folder registry
// ---------------------------------------------------------------------------

/**
 * The developer-facing next step attached to a rejection.
 *
 * A module-level constant so the sentence is written once and cannot drift from
 * the schema above. It names the three fields and the two owners a producer has
 * to satisfy, and it names no file in anyone's project: a hint is forwarded
 * verbatim to a remote client, so it has to be as free of captured data as the
 * message is.
 */
const CLEANUP_COMPLETED_HINT =
  'A cleanup.completed payload carries exactly three fields: the session id, a status from the session cleanup vocabulary of the session record, and a conflicts array — required, possibly empty — whose members satisfy the modification-conflict schema of @debuggen/instrumentation.';

/**
 * Validates an unknown value as a {@link CleanupCompletedPayload}, without
 * throwing.
 *
 * This is how a frame that arrived over the WebSocket becomes a typed payload in
 * the editor host, the webview, the MV3 service worker and the DevTools panel.
 * Non-throwing is a requirement rather than a preference: a rejected cleanup
 * frame has a defined outcome — the surface keeps the cleanup state it already
 * had and reports that this announcement could not be read — and that outcome is
 * reached by inspecting a result, not by unwinding a message loop that every
 * other session's frames also travel through.
 *
 * **The failure carries the shape of the failure and none of the data that
 * caused it.** `protocolParseError` renders the issue list through this
 * package's one sanctioned formatter, `describeZodIssues`: field paths, issue
 * codes and schema-declared metadata, never a rejected value. The rule is at its
 * most load-bearing here, because a `ModificationConflict` contains up to three
 * unified diffs of the developer's own source — the tool's wrapper, the
 * developer's edit on top of it, and the net divergence — together with an
 * absolute backup path. Echoing a rejected conflict would put the developer's
 * code into a log line, a persisted session and a status banner in one step, and
 * a validation error is raised far below the redaction layer, which therefore
 * cannot rescue anything that leaked into it (AAP §0.5.2). What the caller gets
 * is `conflicts[2].message (invalid_type)` and the hint above.
 *
 * @param value Any value believed to be a `cleanup.completed` payload.
 * @returns `ok(payload)` with the validated payload, or `err(error)` describing
 * the shape of the failure.
 *
 * @example
 * ```ts
 * const parsed = parseCleanupCompletedPayload(frame.payload);
 * if (!parsed.ok) {
 *   logger.warn('refused cleanup.completed', { reason: parsed.error.message });
 *   return;
 * }
 * ```
 */
export function parseCleanupCompletedPayload(
  value: unknown,
): Result<CleanupCompletedPayload, DebuggenError> {
  const parsed = cleanupCompletedPayloadSchema.safeParse(value);

  if (parsed.success) {
    return ok(parsed.data);
  }

  return err(
    protocolParseError(
      'PROTOCOL_INVALID_MESSAGE',
      'Invalid cleanup.completed payload',
      parsed.error.issues,
      CLEANUP_COMPLETED_HINT,
    ),
  );
}

/**
 * This module's contribution to the folder registry: the payload schema of
 * `cleanup.completed`, under its wire name.
 *
 * The folder's registry module merges this map with the other domain modules'
 * maps into the single `type → payload schema` table, and the envelope maps over
 * that table to build the discriminated union every frame is validated against.
 * The key is verbatim from AAP §0.4.2 and is one of the message names the
 * product's requirements fix character for character, so it is written once,
 * here, and referenced everywhere else.
 *
 * Exactly one key. The session-end route that triggers a pass and returns
 * `{ cleanup: CleanupStatus }` is a route rather than a message type and belongs
 * to `../http.ts`; the hook teardown that accompanies a pass is arming and
 * belongs to `./agent.ts`.
 *
 * Frozen because it is a module-level table the envelope reads on every parse: a
 * mutation would redefine what the whole process accepts on the wire.
 */
export const CLEANUP_MESSAGE_PAYLOADS = Object.freeze({
  'cleanup.completed': cleanupCompletedPayloadSchema,
} as const);

// ---------------------------------------------------------------------------
// Section D — the embedded shapes keep their types, proved at compile time
// ---------------------------------------------------------------------------

/**
 * `true` when `A` and `B` are mutually assignable, `false` otherwise.
 *
 * The tuple wrappers stop a naked `never` or a union from distributing, so this
 * answers about the types as written rather than about their members — which
 * matters for `status`, whose type *is* a union of four literals.
 */
type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/**
 * `true` when `A` is assignable to `B`, `false` otherwise, with the same
 * distribution guard.
 */
type AssignableTo<A, B> = [A] extends [B] ? true : false;

/**
 * Accepts `true` and nothing else: instantiating it with `false` is a compile
 * error (TS2344), which is what turns a type comparison into an assertion.
 */
type AssertTrue<T extends true> = T;

/**
 * Compile-time proof that both halves of this payload are the **imported**
 * shapes rather than local copies (AAP §0.2.3, §0.9.1).
 *
 * Four claims, in the order a reader should check them:
 *
 * 1. `status` is exactly the session `CleanupStatus` — not a widened `string`,
 *    which is the edit that would let a typo'd or invented status through the
 *    editor's status badge and the record's own field alike, and not the
 *    three-member verdict vocabulary of `@debuggen/instrumentation`, which names
 *    a single pass's outcome and has no `pending`;
 * 2. each member of `conflicts` is exactly the imported `ModificationConflict`,
 *    so the conflict report was embedded rather than restated — a hand-written
 *    `{ file: string; message: string; … }` would compile, would type-check at
 *    every call site, and would differ only in what it refuses: a hash that is
 *    not 64 hexadecimal characters, an absolute path where a project-relative
 *    one belongs, a reason outside the reconciliation table, a blank message
 *    that reaches a user interface as an empty row;
 * 3. a parsed payload's conflicts can be handed straight to code typed against
 *    that interface, which is the direction consumers actually need;
 * 4. neither field is `unknown` or `any`. Either would be mutually assignable
 *    with `unknown`, so requiring that comparison to be `false` is what rules
 *    out a permissive passthrough — the failure mode this section exists to
 *    prevent, because a cleanup result that parsed as `unknown` would let a
 *    conflicting file be reported as a clean tree.
 *
 * It resolves to `true`, and it is the assertion rather than the value that
 * matters: any edit that breaks an edge instantiates {@link AssertTrue} with
 * `false` and fails `tsc -b` here, in the module that made the mistake, rather
 * than in the four surfaces that trusted it. The runtime half of the same
 * guarantee belongs to the package's message suite, which feeds malformed
 * statuses and malformed conflict entries in and requires a rejection.
 *
 * Exported because a type alias nothing references is a compile error under this
 * repository's `noUnusedLocals`, and because a reader of the emitted
 * declarations can then see the guarantee stated. It has no runtime
 * representation; there is nothing to consume.
 *
 * @internal
 */
export type CleanupCompletedEmbeddedShapesPreserved = AssertTrue<
  MutuallyAssignable<CleanupCompletedPayload['status'], CleanupStatus> extends true
    ? MutuallyAssignable<
        CleanupCompletedPayload['conflicts'][number],
        z.infer<typeof modificationConflictSchema>
      > extends true
      ? AssignableTo<
          CleanupCompletedPayload['conflicts'][number],
          ModificationConflict
        > extends true
        ? MutuallyAssignable<CleanupCompletedPayload['conflicts'], unknown> extends true
          ? false
          : MutuallyAssignable<CleanupCompletedPayload['status'], unknown> extends true
            ? false
            : true
        : false
      : false
    : false
>;
