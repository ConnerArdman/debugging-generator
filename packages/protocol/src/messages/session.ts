/**
 * The session itself: the frames that tell every surface what a session *is* and
 * how far it has got, and the three HTTP bodies that drive its life cycle.
 *
 * A *session* is one debugging question and everything the product did about it —
 * the developer's question, the element they pointed at, the files the
 * investigation selected, the instrumentation plan, the captures, the analyses
 * and the generated panels. It is created from the editor, it is bound to an
 * inspected Chrome tab, it survives a restart of every process that observes it,
 * and it ends with the developer's working tree restored (AAP §0.2.3, §0.4.2).
 * This module owns the shapes that carry it across a process boundary; the
 * record it carries is owned by `../session-record.ts`.
 *
 * ## Four broadcasts and three requests
 *
 * ```text
 * session.created      WS    service → every client of the session
 *                                                  { session: SessionRecord }
 * session.updated      WS    service → every client of the session
 *                                                  { session: SessionRecord }
 * session.progress     WS    service → every client of the session
 *                            { sessionId, stage, status, message, detail? }
 * analysis.completed   WS    service → every client of the session
 *                                          { sessionId, analysis: AnalysisResult }
 *
 * session.create       HTTP  VS Code → service
 *         { projectRoot, question, target?, devServerUrl? } → SessionRecord
 * session.question     HTTP  VS Code → service
 *                                  { question, attemptId? } → SessionRecord
 * session.end          HTTP  VS Code → service     {} → { cleanup: … }
 * ```
 *
 * The four WebSocket frames go to **every** client of the session — the editor's
 * webview, the bound tab's DevTools panel, and any further surface that reopened
 * it — including the client whose HTTP request caused them. A client therefore
 * never polls to discover a change it did not make, and never has to reconcile
 * two descriptions of the same session arriving by two routes: the HTTP response
 * and the broadcast carry the *same* record.
 *
 * ## Why `session.created` and `session.updated` both carry the whole record
 *
 * Neither frame is a patch. A session accumulates plans, modification records,
 * captures, analyses and panel ids as it runs, and a surface that applied deltas
 * would hold a reconstruction whose divergence from the store is invisible until
 * something renders wrongly. Sending the record whole makes the service's stored
 * row the single source of truth for every surface, which is also what makes
 * *reopening* a session work with no extra machinery: the service replays
 * `session.updated` and the latest `panel.generated` from stored data, and both
 * user interfaces re-render from them exactly as they did live (AAP §0.4.2).
 *
 * The two names are kept distinct because the *occasion* differs — one session
 * is created once and updated many times — and a surface legitimately treats
 * them differently: the editor reveals its view on creation and refreshes it on
 * an update. The payload shape being identical today is not a reason to collapse
 * them; see {@link sessionUpdatedPayloadSchema}.
 *
 * ## `analysis.completed` — where the wrapper lives, and why
 *
 * AAP §0.4.2 names `analysis.ts` as the file that defines the **analysis
 * payload type**, while the AAP §0.2.5 file list gives this folder exactly an
 * `index` plus eleven domain modules and **no `analysis` module**. Both
 * statements hold at once under this split, which is binding and should not be
 * revisited:
 *
 * - the **artifact** — `AnalysisResult`, its findings, its assembler and its
 *   parser — stays in `../analysis.ts`, its single definition (AAP §0.9.1);
 * - the **message wrapper** — {@link analysisCompletedPayloadSchema} — lives
 *   here, and embeds `analysisResultSchema` by import.
 *
 * The reason is mechanical rather than stylistic: `messages/index.ts` merges the
 * frozen per-module maps into the one registry `../envelope.ts` derives
 * `MESSAGE_TYPES` and the discriminated union from. A wrapper declared outside
 * `messages/**` would be a message type that registry could not see, so the
 * envelope would need a second source — and the union would silently omit a
 * frame the service sends. Keeping every wrapper under `messages/**` is what
 * keeps that enumeration complete. Do not "fix" this by adding a twelfth module.
 *
 * ## The progress frame carries no wording of this package's invention
 *
 * {@link sessionProgressPayloadSchema} is the transport for the editor's
 * progress view, and the view is rendered from **real pipeline events**: the
 * service composes each `message` from what the stage actually found — a file it
 * resolved, a symbol it traced, a signal it armed (AAP §0.7.1 Group 2). No such
 * sentence is authored in this package, and none may be: a string here would be
 * output that did not come from the run, which is the pattern AAP §0.5.4
 * forbids and `scripts/check-no-hardcoding.mjs` fails the build over. This
 * module therefore declares that `message` is bounded non-empty text and says
 * nothing whatsoever about its content. For the same reason nothing here
 * branches on the developer's question; the question is data that reaches a
 * prompt, never a condition.
 *
 * ## Semantics this module documents and does not implement
 *
 * Shapes are all this file owns. The behaviour below belongs to the service's
 * session manager, state machine and cleanup, and is recorded here because a
 * reader of these schemas needs it to use them correctly:
 *
 * - **The status vocabulary lives on the record.** A session's eleven statuses
 *   are `../session-record.ts`'s `SESSION_STATUSES`, read off
 *   `session.status`; {@link PROGRESS_STAGES} is a different vocabulary
 *   answering a different question — *which stage is reporting* — and the two
 *   are deliberately not unified.
 * - **`session.progress` is emitted per stage transition**, with `running` when
 *   a stage starts, `done` when it finishes and `failed` when it does not. A
 *   stage may report several times while `running`; the frames are cumulative
 *   rows in a view, not a state machine of their own.
 * - **A follow-up takes one of two paths** (AAP §0.4.2). The existing-evidence
 *   path re-derives an answer from the stored capture and moves
 *   `generated → analyzing → generated`; the new-capture path installs the
 *   additive delta of a new plan version and moves
 *   `generated → planning → instrumenting → ready`, which is when the developer
 *   is asked to reproduce the issue again. Both paths store *new* analysis and
 *   panel versions linked to their predecessors by `supersedes`, rather than
 *   overwriting them, so every `analysis.completed` frame of a session names a
 *   distinct analysis.
 * - **`generated` is gated on validated artifacts.** The state machine admits
 *   that status only once a validated `AnalysisResult` *and* a validated
 *   `PanelSpec` exist, and `failed` is a distinct status both user interfaces
 *   render together with the stage that failed — a failure is never presented as
 *   a successful analysis (AAP §0.5.5).
 * - **Route paths, methods, status codes and authentication are `../http.ts`'s
 *   business.** `POST /sessions`, `POST /sessions/:id/question`,
 *   `POST /sessions/:id/end`, the bearer credential and role scoping of AAP
 *   §0.5.6, and the `session.end` **response** body (`{ cleanup: CleanupStatus }`,
 *   over `../session-record.ts`'s cleanup vocabulary) are declared there,
 *   against the schemas below. None of them is defined here.
 *
 * ## `session.create`, `session.question` and `session.end` are HTTP operations
 *
 * Five names in this folder are **HTTP-only**: `session.create`,
 * `session.question`, `session.end`, `capture.start` and `capture.stop`. They
 * are the user's own names for these operations (prompt §16) and are preserved
 * character for character, but they must never enter `MESSAGE_TYPES`, never key
 * `MESSAGE_PAYLOAD_SCHEMAS`, and never appear as a `type` in the envelope's
 * discriminated union — a client that sent `{ type: 'session.create' }` over the
 * WebSocket would be rejected by `parseMessage`, which is the intended answer.
 * This module keeps the two families in separate frozen maps,
 * {@link SESSION_MESSAGE_PAYLOADS} and {@link SESSION_HTTP_PAYLOADS}, so
 * `./index.ts` can merge each into the right registry without having to know
 * which name belongs where.
 *
 * ## Constraints this file inherits from the package
 *
 * - **Nothing in `packages/protocol/src` may be imported except `../version.ts`,
 *   `../session-record.ts` and `../analysis.ts`.** `../envelope.js`,
 *   `../http.js`, `../client/**` and every sibling in this folder sit *above*
 *   the payload modules; importing one would close a cycle through the envelope.
 *   `../http.ts` imports this file, not the reverse: the three request schemas
 *   below are **defined here once and re-exported there**, and a second
 *   declaration of any of them is the duplicated definition AAP §0.9.1 forbids.
 * - **Environment-neutral.** No `node:*` builtin, no `@debuggen/shared/node`
 *   entry, no `ws`: this bundle is loaded by the service, by the MV3 service
 *   worker, by the DevTools panel and by the editor webview alike.
 * - **Byte-faithful parsing.** No `.transform()`, no `.coerce`, no `.default()`
 *   and no `.catch()`. A schema here validates and never rewrites, so what a
 *   producer sent is what a consumer reads.
 * - **Leak-free failures.** Every parse helper reports through
 *   {@link protocolParseError}, which renders only issue paths, issue codes and
 *   schema-declared metadata. The values these payloads carry are the most
 *   sensitive in the protocol — a developer's own question, an absolute project
 *   path, and a `SessionRecord` holding file paths, plans, unified diffs and
 *   analysis text — and none of it may reach a log line or a user-interface
 *   banner through an error message (AAP §0.5.2).
 *
 * Every export is named; there is no default export, and importing this module
 * has no side effect.
 */

import { z } from 'zod';

import { selectedTargetSchema } from '@debuggen/instrumentation/schema';
import type { SelectedTarget } from '@debuggen/instrumentation/schema';
import { err, ok } from '@debuggen/shared';
import type { DebuggenError, Result, SessionId } from '@debuggen/shared';

import { analysisResultSchema } from '../analysis.js';
import type { AnalysisResult } from '../analysis.js';
import { followUpAttemptIdSchema, sessionRecordSchema } from '../session-record.js';
import type { SessionRecord } from '../session-record.js';
import { protocolParseError } from '../version.js';

// ---------------------------------------------------------------------------
// Section A — module-local primitives
// ---------------------------------------------------------------------------

/**
 * The longest identifier any payload in this module will consider.
 *
 * The folder-canonical bound, repeated as a module-local constant in each
 * `messages/*.ts` file rather than exported from one of them: a payload module
 * is re-exported wholesale by `./index.ts`, and a name exported from several of
 * them would be an ambiguous re-export rather than a shared constant.
 *
 * The ids this product mints are twenty characters — a three-letter kind prefix,
 * an underscore and sixteen random characters (`@debuggen/shared`'s `newId`) —
 * so sixty-four is generous room for an id from an older build or a longer
 * prefix, while still refusing a frame that arrived with a megabyte where a
 * session id belonged, on a length check rather than on a pattern match.
 */
const MAX_ID_LENGTH = 64;

/**
 * The longest project root this module will accept, in characters.
 *
 * Linux's `PATH_MAX` is 4096 bytes including the terminator and macOS's is
 * 1024, so this bound cannot reject a path an operating system would accept
 * while still refusing a field that is plainly not a path. It is a transport
 * sanity check and nothing more: whether the directory exists, whether it is the
 * project the credential's scope covers and whether a requested file resolves
 * inside it are the service's questions, answered where the path is used.
 *
 * Module-local for the reason {@link MAX_ID_LENGTH} is.
 */
const MAX_PATH_LENGTH = 4096;

/**
 * The longest single-field text this module will accept, in characters: a
 * developer's question, or a progress message the service composed.
 *
 * Two thousand characters is several paragraphs — room for a question that
 * quotes an error and for a progress line that names what a stage found — and
 * far below the point where a field becomes a way to push a payload into the
 * store or a prompt. The bound is on the *transport*; a stage that needs to say
 * more says it in {@link MAX_DETAIL_LENGTH} characters of `detail`.
 */
const MAX_TEXT_LENGTH = 2000;

/**
 * The longest `detail` a progress frame may carry, in characters.
 *
 * Twice {@link MAX_TEXT_LENGTH}: `detail` is the secondary, optional line a
 * surface shows under a progress row — an expanded list, a reason, a hint — and
 * it is read by a human rather than parsed, so it is given room without being
 * given a free hand.
 */
const MAX_DETAIL_LENGTH = 4000;

/**
 * An opaque identifier as a payload field: a non-empty string of at most
 * {@link MAX_ID_LENGTH} characters.
 *
 * Deliberately **not** the `ses_` prefix pattern. The prefix vocabulary and the
 * id grammar belong to `@debuggen/shared`'s `ids` module, which mints every id
 * in the product and guards the ones read back out of the store; re-deriving
 * either here would be a second definition of a shape this package does not own,
 * and it would reject a stored session from a build whose prefixes differed. The
 * transport's job is the one check the transport can make — that the field is a
 * string of plausible length — and identity is resolved where the id is looked
 * up.
 *
 * `SessionId` is an unbranded string alias, so a field validated by this schema
 * is assignable to it with no cast; {@link SessionIdEdgePreserved} states that
 * as a compile-time assertion.
 *
 * Module-local for the same reason {@link MAX_ID_LENGTH} is.
 */
const sessionIdSchema = z
  .string()
  .min(1, { error: 'expected a non-empty session identifier' })
  .max(MAX_ID_LENGTH, {
    error: `expected a session identifier of at most ${String(MAX_ID_LENGTH)} characters`,
  });

// ---------------------------------------------------------------------------
// Section B — the progress vocabularies
// ---------------------------------------------------------------------------

/**
 * The stages a `session.progress` frame may report, in the order a session runs
 * them.
 *
 * **Nine members, and the count is the point.** Six are the model-driven
 * pipeline stages of AAP §0.4.2 — `understand`, `investigate`, `plan`,
 * `analyze`, `generate-panel` and the follow-up decision — and three more are
 * deterministic phases that also take observable time and can also fail, so a
 * surface that could not name them would leave the developer watching nothing
 * happen:
 *
 * - `instrument` — the installer applying the plan's runtime hooks and patches
 *   to the developer's working tree, which is the phase whose failures matter
 *   most and the one the editor lists modifications under;
 * - `capture` — the window in which the developer reproduces the issue;
 * - `cleanup` — the end-of-session restoration, whose outcome a surface reports
 *   whether it was clean, partial or conflicted (AAP §0.5.1).
 *
 * The six spellings shared with `../session-record.ts`'s `PROMPT_STAGE_KEYS`
 * are written the same way here as the prompt directories on disk are named, so
 * that a progress row, a prompt version recorded on a session and a directory
 * under `apps/local-service/prompts/` all refer to a stage by one string and no
 * translation table exists to drift.
 *
 * This vocabulary is **not** the session status vocabulary. A status says what
 * the session *is* (`../session-record.ts`'s eleven `SESSION_STATUSES`); a
 * stage says who is *reporting*. Several stages run while one status holds, and
 * the editor groups progress rows by stage while badging the session by status.
 *
 * Declared `as const` so {@link ProgressStage} is the exact union and
 * {@link progressStageSchema} validates against this tuple without repeating
 * the nine strings.
 */
export const PROGRESS_STAGES = [
  'understand',
  'investigate',
  'plan',
  'instrument',
  'capture',
  'analyze',
  'generate-panel',
  'followup',
  'cleanup',
] as const;

/**
 * One of {@link PROGRESS_STAGES}.
 *
 * Derived from the tuple, so a stage added there widens this union in the same
 * edit and every exhaustive `switch` over it — the editor's progress grouping,
 * the panel's session summary — stops compiling until it says something about
 * the new case.
 */
export type ProgressStage = (typeof PROGRESS_STAGES)[number];

/**
 * Validates a progress stage.
 *
 * Embedded as {@link sessionProgressPayloadSchema}'s `stage`, and usable on its
 * own where a stage name arrives from outside the type system — a stored
 * progress row, or a frame from a process built at a different commit. An
 * unknown stage is refused rather than rendered: a surface that displayed it
 * would be inventing a phase of the pipeline.
 */
export const progressStageSchema = z.enum(PROGRESS_STAGES);

/**
 * How a stage is doing: it is working, it finished, or it failed.
 *
 * Exactly the three values AAP §0.4.2 specifies, and exactly the three states
 * the editor's progress view can draw — a spinner, a check, a cross. There is
 * deliberately no `skipped` or `pending`: a stage that never ran sends no frame,
 * and absence is how a surface knows it has not started.
 */
export const PROGRESS_STATUSES = ['running', 'done', 'failed'] as const;

/** One of {@link PROGRESS_STATUSES}. */
export type ProgressStatus = (typeof PROGRESS_STATUSES)[number];

/**
 * Validates a progress status.
 *
 * Embedded as {@link sessionProgressPayloadSchema}'s `status`. A `failed` frame
 * is a legitimate, expected value on this contract rather than an error of it:
 * the service reports the failing stage and the session's own status becomes
 * `failed`, which both user interfaces render as such (AAP §0.5.5).
 */
export const progressStatusSchema = z.enum(PROGRESS_STATUSES);

// ---------------------------------------------------------------------------
// Section C — the WebSocket broadcasts
// ---------------------------------------------------------------------------

/**
 * `session.created` — the service tells every client that a session now exists.
 *
 * Sent once, when `POST /sessions` succeeds, to the editor client that asked for
 * it and to every other client the new session concerns. The caller also has the
 * record in its own HTTP response; receiving it twice is the design of AAP
 * §0.4.2's request/broadcast split and costs nothing, because both copies are
 * the same stored row.
 *
 * `session` is the imported {@link sessionRecordSchema} itself — the single
 * definition of that record (AAP §0.9.1) — used as a field with no wrapper and
 * with none of its members restated. Its own strictness therefore applies
 * unchanged: a record carrying an unrecognised key is refused here, which turns
 * two halves of the contract that have drifted apart into a rejected frame
 * rather than a half-trusted store row.
 *
 * `strictObject`, like every payload in this folder: an unrecognised key at the
 * *payload* level is a producer that disagrees with this contract, and refusing
 * it is how that disagreement is found in development rather than inferred from
 * a missing value in production.
 */
export const sessionCreatedPayloadSchema = z.strictObject({
  /** The session that was created, whole. */
  session: sessionRecordSchema,
});

/** The validated payload of a `session.created` broadcast. */
export type SessionCreatedPayload = z.infer<typeof sessionCreatedPayloadSchema>;

/**
 * `session.updated` — the service tells every client that a session changed.
 *
 * Sent on every transition a surface can see: a status change, a question
 * answered, an understanding or a plan recorded, modifications applied, a
 * capture opened or closed, an analysis or a panel stored, a tab bound or
 * unbound, a cleanup completed. It is also the frame that *replays* a session:
 * reopening one from the editor's Sessions tree sends this payload and the
 * latest `panel.generated` from stored data, and both surfaces re-render from
 * them exactly as they did while the session ran (AAP §0.4.2).
 *
 * ## Two names, one shape, and why that is deliberate
 *
 * This payload is structurally identical to {@link sessionCreatedPayloadSchema}
 * and is declared separately rather than aliased. Three reasons, in order of
 * how much they would cost to get wrong:
 *
 * 1. `messages/index.ts` needs **two registry entries**, because
 *    `session.created` and `session.updated` are two message types in AAP
 *    §0.4.2 and the envelope's union enumerates types, not shapes.
 * 2. Consumers react differently — the editor reveals its view on creation and
 *    refreshes in place on an update — and two named types keep that difference
 *    expressible without a flag inside the payload.
 * 3. If either frame ever gains a field the other does not need, the change is
 *    one line here instead of an unpicking of a shared alias at every call site.
 *
 * The *shape* is written once all the same: this schema is built from
 * {@link sessionCreatedPayloadSchema}'s `shape`, so the two cannot drift while
 * they are meant to agree.
 *
 * ## Whole records, not deltas
 *
 * Every frame carries the complete record, as AAP §0.4.2 specifies, and that is
 * what makes each frame self-sufficient: a client that missed frames — an MV3
 * service worker the browser suspended, an editor that reconnected after a
 * service restart — is fully current again on the next one, with no base
 * version to reconcile and no gap to detect. The cost of repeating the record is
 * bounded where it is paid instead of by splitting the frame: the service
 * encodes each frame once and sends it only to the session's own editors and
 * its bound tab (`apps/local-service/src/server/clients.ts`); receivers drop a
 * record older than the one they hold and keep only list rows, never whole
 * records, for sessions they merely list (`SessionListItem`, `../http.ts`); and
 * the record's heavy collections have their own paged reads —
 * `GET /sessions/:id/modifications` under a diff budget, `panel-data` for
 * telemetry.
 */
export const sessionUpdatedPayloadSchema = z.strictObject({
  ...sessionCreatedPayloadSchema.shape,
});

/** The validated payload of a `session.updated` broadcast. */
export type SessionUpdatedPayload = z.infer<typeof sessionUpdatedPayloadSchema>;

/**
 * `session.progress` — one line of what the pipeline is doing, as it happens.
 *
 * The transport for the editor's progress view and the DevTools panel's session
 * summary. A stage sends `running` when it starts, may send further `running`
 * frames as it learns things, and closes with `done` or `failed`; the frames are
 * appended rows rather than a state machine, and a surface groups them by
 * {@link PROGRESS_STAGES}.
 *
 * `sessionId` is required and is what makes the frame routable by a client
 * holding several sessions open. Nothing else about the session is repeated: a
 * client that wants the status reads it off the record the last
 * `session.updated` carried.
 */
export const sessionProgressPayloadSchema = z.strictObject({
  /** The session this progress line belongs to. */
  sessionId: sessionIdSchema,

  /** Which stage is reporting. */
  stage: progressStageSchema,

  /** Whether that stage is working, finished or failed. */
  status: progressStatusSchema,

  /**
   * The line a surface shows, composed by the **service** from what the stage
   * actually found (AAP §0.7.1 Group 2).
   *
   * Free text to this schema, and that is a deliberate limit on what this
   * package may know. The progress view is rendered from real pipeline events:
   * the service builds each sentence from a file it resolved, a symbol it
   * traced, a signal it armed. **No such sentence may be authored in this
   * package** — a string here would be output that did not come from the run,
   * which is the pattern AAP §0.5.4 forbids and `scripts/check-no-hardcoding.mjs`
   * fails the build over. So the contract is exactly two properties, both of
   * them about size: non-empty, because an empty row is a row a surface cannot
   * draw, and bounded by {@link MAX_TEXT_LENGTH}, because a progress line is a
   * line.
   */
  message: z
    .string()
    .min(1, { error: 'expected a non-empty progress message' })
    .max(MAX_TEXT_LENGTH, {
      error: `expected a progress message of at most ${String(MAX_TEXT_LENGTH)} characters`,
    }),

  /**
   * An optional second line, shown under the first when a surface has room.
   *
   * **A string, and it stays a string.** A stage that needs structure — a list
   * of applied modifications, a plan, a set of unavailable signals — has its own
   * message type for it (`instrumentation.ready`, `instrumentation.plan`,
   * `analysis.completed`), and widening this field into a record would make
   * `session.progress` a second, weaker channel for the same facts, with no
   * schema for a consumer to rely on. It may be empty: a stage that has nothing
   * further to say omits the key, and one that produced an empty string has said
   * the same thing in a way a surface can still render.
   *
   * **Optional, not nullable.** An absent key is how a frame says there is no
   * detail; a `null` would be a second spelling of the same fact that every
   * consumer would have to handle.
   */
  detail: z
    .string()
    .max(MAX_DETAIL_LENGTH, {
      error: `expected a progress detail of at most ${String(MAX_DETAIL_LENGTH)} characters`,
    })
    .optional(),
});

/** The validated payload of a `session.progress` broadcast. */
export type SessionProgressPayload = z.infer<typeof sessionProgressPayloadSchema>;

/**
 * `analysis.completed` — the service hands every client of a session the
 * analysis it just produced.
 *
 * Sent when the analyze stage has produced an artifact that **passed
 * validation**, before or alongside the panel generated from it. A client
 * renders the observed facts and the likely causes from this frame directly —
 * the editor in its analysis summary, the panel in its summary header — which is
 * why the whole artifact travels rather than an id to fetch.
 *
 * One frame per analysis *version*. A follow-up stores a new analysis linked to
 * its predecessor by `supersedes` rather than overwriting it (AAP §0.4.2), so a
 * session emits this frame once per version and a surface keys what it holds by
 * the analysis's own `id`.
 *
 * ## The wrapper is here; the artifact is not
 *
 * `analysis` is the imported {@link analysisResultSchema} — defined once in
 * `../analysis.ts`, which owns the findings, the assembler and the parser. This
 * module owns only the envelope-level shape, and it owns it *because* it is a
 * message: `messages/index.ts` merges the frozen maps in this folder into the
 * registry `../envelope.ts` derives `MESSAGE_TYPES` from, so a wrapper declared
 * outside `messages/**` would be a message type that registry could not see.
 * The module header states this at length; it is binding, and the alternative —
 * a twelfth module in this folder, or an `analysisCompleted` wrapper imported
 * from `../analysis.ts` — would cost the envelope its single source.
 *
 * Embedding the real schema also means the frame is validated as deeply as the
 * artifact is: an analysis whose observed fact cites no evidence cannot pass
 * here, because `analysisResultSchema` refuses it (AAP §0.8.4).
 */
export const analysisCompletedPayloadSchema = z.strictObject({
  /** The session the analysis belongs to; what makes the frame routable. */
  sessionId: sessionIdSchema,

  /** The validated analysis, exactly as `../analysis.ts` defines it. */
  analysis: analysisResultSchema,
});

/** The validated payload of an `analysis.completed` broadcast. */
export type AnalysisCompletedPayload = z.infer<typeof analysisCompletedPayloadSchema>;

/**
 * The WebSocket message types this module contributes, with their payload
 * schemas.
 *
 * Merged by `./index.ts` into `MESSAGE_PAYLOAD_SCHEMAS`, from which
 * `MESSAGE_TYPES` and the envelope's discriminated union are derived. **Exactly
 * four keys**, and none of them is `session.create`, `session.question` or
 * `session.end`: those are HTTP operations and live in
 * {@link SESSION_HTTP_PAYLOADS} instead, for the reason the module header
 * states.
 *
 * The keys are the protocol's own names, verbatim from AAP §0.4.2. They are the
 * strings on the wire, so they are written out here rather than assembled from
 * parts, and one `grep` finds every producer and consumer of each across all
 * four processes.
 *
 * Frozen so a consumer cannot add a type to the protocol at runtime, and
 * `as const` so the keys survive as literal types — which is what lets the
 * envelope's union be derived from this object rather than declared beside it.
 */
export const SESSION_MESSAGE_PAYLOADS = Object.freeze({
  'session.created': sessionCreatedPayloadSchema,
  'session.updated': sessionUpdatedPayloadSchema,
  'session.progress': sessionProgressPayloadSchema,
  'analysis.completed': analysisCompletedPayloadSchema,
} as const);

// ---------------------------------------------------------------------------
// Section D — the HTTP operations
//
// `session.create`, `session.question` and `session.end` are the user's own
// operation names (prompt §16), preserved character for character. They are
// **HTTP operations, not WebSocket message types**: nothing below may enter
// `MESSAGE_TYPES`, `MESSAGE_PAYLOAD_SCHEMAS` or the envelope's discriminated
// union, and the same holds for the other two HTTP-only names of this folder —
// `capture.start` and `capture.stop`.
//
// The three schemas below are the SINGLE definition of these request bodies.
// `../http.ts` binds them to `POST /sessions`, `POST /sessions/:id/question`
// and `POST /sessions/:id/end`, adds each route's method, status codes and
// authentication, declares the responses — the created and updated
// `SessionRecord`, and `session.end`'s `{ cleanup: CleanupStatus }` over
// `../session-record.ts`'s cleanup vocabulary — and re-exports
// `sessionCreateRequestSchema` under that exact name. It must not redeclare any
// of them, and none of the route metadata or the response shapes belongs here.
// ---------------------------------------------------------------------------

/**
 * The longest dev-server URL a `session.create` body may carry: **2048**, the
 * bound `../session-record.ts` applies to the `devServerUrl` it stores, so any
 * URL this body accepts can be recorded on the session it creates.
 *
 * Module-local for the same reason {@link MAX_ID_LENGTH} is.
 */
const MAX_DEV_SERVER_URL_LENGTH = 2048;

/**
 * Whether an absolute URL is free of user information (`user@host`,
 * `user:password@host`).
 *
 * A dev-server URL is stored on the session record and shown in both user
 * interfaces, so one that carried a credential would copy it into the store and
 * onto the screen (AAP §0.5.2). A value the URL parser refuses is reported as
 * free of user information here, because the preceding `z.url` check already
 * refuses it with its own, more precise issue.
 *
 * @param value A string that has passed the absolute-URL check.
 * @returns `false` only when the parsed URL carries a user name or password.
 */
function hasNoUserInfo(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.username === '' && parsed.password === '';
  } catch {
    return true;
  }
}

/**
 * A dev-server URL a client sends for the service to verify: an absolute
 * `http:`/`https:` URL within {@link MAX_DEV_SERVER_URL_LENGTH} characters that
 * embeds no user name or password.
 *
 * What a transport can check, and nothing more: whether the URL names this
 * machine, answers, and belongs to a dev server carrying the telemetry preload
 * are the service's questions, answered by its own loopback probe before the
 * value is used. Shared by `session.create` (below) and `devServer.launch`
 * (`../http.ts`), so both bodies accept exactly the same URLs.
 */
export const devServerUrlSchema = z
  .url({ protocol: /^https?$/, error: 'expected an absolute http: or https: URL' })
  .max(MAX_DEV_SERVER_URL_LENGTH, {
    error: `expected a dev-server URL of at most ${String(MAX_DEV_SERVER_URL_LENGTH)} characters`,
  })
  .refine(hasNoUserInfo, { error: 'expected a dev-server URL without embedded credentials' });

/**
 * The `session.create` request body: which project, which question, and
 * optionally what the developer had already pointed at.
 *
 * This is where a session begins, and it is the only body in this module that
 * carries anything the service cannot derive: the project root fixes the
 * containment boundary for every path the session will later resolve, the
 * question is what the whole pipeline is about, and the target — when present —
 * spares a developer who already selected an element from pointing at it twice.
 *
 * Nothing here is a condition. The question reaches the first pipeline stage as
 * data and is never compared, matched or branched on in this package or any
 * other (AAP §0.5.4).
 *
 * `strictObject`: a body carrying a fifth key is a client working from a
 * contract this one replaced — a `sessionId` it hoped to choose, a `provider`
 * that is configuration rather than a request — and a silent acceptance would
 * leave it believing the field had an effect.
 */
export const sessionCreateRequestSchema = z.strictObject({
  /**
   * The absolute path of the project to debug — the developer's workspace
   * folder.
   *
   * Checked here for exactly what a transport can check: that it is a non-empty
   * string no longer than {@link MAX_PATH_LENGTH}. **No relative-path
   * refinement and no shape grammar**, deliberately: this is a path on the
   * developer's own machine, written by their own editor, and the questions that
   * matter about it — does it exist, is it a directory, does the requesting
   * credential's scope cover it (AAP §0.5.6), does a later source-open request
   * resolve inside it — are answered by the service, which can resolve a real
   * path, and by `../session-record.ts`, which validates the value it stores.
   * Refusing a plausible path at the transport would only move the failure away
   * from the layer that can explain it.
   */
  projectRoot: z
    .string()
    .min(1, { error: 'expected a non-empty project root path' })
    .max(MAX_PATH_LENGTH, {
      error: `expected a project root path of at most ${String(MAX_PATH_LENGTH)} characters`,
    }),

  /**
   * The developer's question, in their own words.
   *
   * Bounded non-empty prose, and nothing more is asserted about it. It is the
   * input to the problem-understanding stage, which tokenises it generically;
   * no part of this product inspects it for a phrase, and a schema that tried to
   * classify it here would be the first step towards exactly the hardcoded
   * behaviour AAP §0.5.4 forbids.
   */
  question: z
    .string()
    .min(1, { error: 'expected a non-empty question' })
    .max(MAX_TEXT_LENGTH, {
      error: `expected a question of at most ${String(MAX_TEXT_LENGTH)} characters`,
    }),

  /**
   * The element the developer had already selected, when they had.
   *
   * The imported {@link selectedTargetSchema} itself — the same single
   * definition `./target.ts` embeds in `target.selected`. One imported schema
   * used in two places is not a duplicated shape; a second, hand-written
   * descriptor here would be.
   *
   * **Optional, not nullable.** A session may be created with no target at all,
   * in which case the first stage uses the bound tab's current URL instead (AAP
   * §0.2.3), and an absent key is how this body says so.
   */
  target: selectedTargetSchema.optional(),

  /**
   * The dev-server URL the editor found answering, when it found one.
   *
   * A session is created "with a `projectRoot` and the project's dev-server
   * URL (probed or launched)" (AAP §0.2.3). A dev server the service launched is
   * known to the service already; one the developer started themselves is not,
   * and the editor is what knows where it serves — its `debuggen.devServerUrl`
   * setting, probed immediately before this request. So the editor forwards
   * that URL here **only after its own probe got an answer**, and omits the key
   * otherwise.
   *
   * Checked here for what a transport can check: an absolute `http:`/`https:`
   * URL within {@link MAX_DEV_SERVER_URL_LENGTH} characters that embeds no user
   * name or password. Whether it names this machine, whether it answers, and
   * whether the process behind it carries the telemetry preload are the
   * service's questions, answered by its own loopback probe before the value
   * is recorded — a client's word is never stored unverified.
   */
  devServerUrl: devServerUrlSchema.optional(),
});

/** The validated `session.create` request body. */
export type SessionCreateRequest = z.infer<typeof sessionCreateRequestSchema>;

/**
 * The `session.question` request body: a follow-up question on an existing
 * session.
 *
 * The session is named in the route, and everything else the follow-up needs is
 * already stored — the prior understanding, the plan, the latest capture summary,
 * the latest analysis and panel. So the body is what only the asking client can
 * supply: the question, bounded exactly as {@link sessionCreateRequestSchema}'s
 * `question` is, by the same constant, because it is the same kind of value —
 * and the identity of the attempt.
 *
 * What happens next is the service's decision and not this shape's: the
 * follow-up stage either re-derives an answer from the stored capture
 * (`generated → analyzing → generated`) or requires a new one
 * (`generated → planning → instrumenting → ready`), and both paths store new
 * analysis and panel versions rather than overwriting the old (AAP §0.4.2). A
 * client learns which path was taken from the frames that follow, never from
 * this request.
 *
 * ## Idempotency: `attemptId`
 *
 * The request is keyed by `attemptId` (see `../session-record.ts`'s
 * `followUpAttemptIdSchema`), never by its text (AAP §0.5.4):
 *
 * | `attemptId` names … | The service … |
 * | --- | --- |
 * | nothing it recorded (or is absent) | records a new follow-up with `attempt: 1` |
 * | the session's latest follow-up, still unanswered | retries it **in place**: same entry, `attempt + 1`, this request's question and time |
 * | an answered follow-up, or one a later follow-up followed | refuses with `409 SESSION_INVALID_STATE` and runs nothing |
 *
 * A client mints a fresh id (`newId(FOLLOW_UP_ATTEMPT_ID_PREFIX)`) for every
 * new question and resends the same id to retry a failed one. When the key is
 * absent the service mints one, so such a request can never be retried in
 * place — it is always a new follow-up.
 */
export const sessionQuestionRequestSchema = z.strictObject({
  /** The follow-up question, in the developer's own words. */
  question: z
    .string()
    .min(1, { error: 'expected a non-empty question' })
    .max(MAX_TEXT_LENGTH, {
      error: `expected a question of at most ${String(MAX_TEXT_LENGTH)} characters`,
    }),

  /**
   * The identity of this ask: fresh for a new question, the failed attempt's
   * own for a Retry. The imported `followUpAttemptIdSchema` itself, so the id a
   * request carries and the id the stored follow-up records are validated by
   * one definition.
   *
   * **Optional, not nullable**: an absent key asks the service to mint one.
   */
  attemptId: followUpAttemptIdSchema.optional(),
});

/** The validated `session.question` request body. */
export type SessionQuestionRequest = z.infer<typeof sessionQuestionRequestSchema>;

/**
 * The `session.end` request body: empty.
 *
 * Ending a session is not parameterisable, and that is a safety property rather
 * than an omission. Cleanup restores **every** non-reverted modification of the
 * session, in reverse order, verifying each file's hash before it writes
 * (AAP §0.5.1); a body that could name files, skip a step or force a write would
 * be a way for a client to leave a developer's working tree instrumented. The
 * session comes from the route, and the outcome comes back in the response
 * `../http.ts` declares.
 *
 * `strictObject` over an empty shape, so the body is `{}` and *any* key is
 * refused. That strictness is the point of declaring a schema for an empty body
 * at all: a client that sent `{ force: true }`, `{ keepBackups: true }` or
 * `{ sessionId }` is working from a contract this one replaced, and refusing it
 * says so at the boundary.
 */
export const sessionEndRequestSchema = z.strictObject({});

/** The validated `session.end` request body. */
export type SessionEndRequest = z.infer<typeof sessionEndRequestSchema>;

/**
 * The HTTP operations this module contributes, with their request schemas.
 *
 * Merged by `./index.ts` into `HTTP_ONLY_PAYLOAD_SCHEMAS`, the registry that
 * exists precisely so these names have a home that is *not* the message union.
 * The keys are the operation names verbatim — `session.create`,
 * `session.question`, `session.end` — because they are what the user named these
 * operations, what `docs/ARCHITECTURE.md` tabulates and what a session's
 * progress record refers to.
 *
 * Each entry is a `{ request }` object rather than a bare schema, matching
 * `./capture.ts`'s `CAPTURE_HTTP_PAYLOADS` so that `./index.ts` can merge both
 * maps with one spread and no per-module special case. The `response` member
 * that map's entries also carry is **omitted** here, and the omission is
 * meaningful: this folder does not own these responses. `POST /sessions` and
 * `POST /sessions/:id/question` answer with a `SessionRecord`, whose schema is
 * `../session-record.ts`'s, and `POST /sessions/:id/end` answers with
 * `{ cleanup: CleanupStatus }`, assembled in `../http.ts` over the same
 * module's cleanup vocabulary. Restating either here would be the second
 * definition AAP §0.9.1 forbids.
 *
 * Frozen and `as const`, like {@link SESSION_MESSAGE_PAYLOADS}, so the operation
 * names survive as literal types and no consumer can extend the set at runtime.
 */
export const SESSION_HTTP_PAYLOADS = Object.freeze({
  'session.create': {
    request: sessionCreateRequestSchema,
  },
  'session.question': {
    request: sessionQuestionRequestSchema,
  },
  'session.end': {
    request: sessionEndRequestSchema,
  },
} as const);

// ---------------------------------------------------------------------------
// Section E — parse helpers
//
// One per payload, and each one total: a helper validates, never throws, and
// never repairs. A caller inspects `result.ok` and either uses the typed value
// or reports the error, which is what keeps a malformed frame from becoming an
// exception four stack frames above the socket that delivered it.
//
// The failure is always a `DebuggenError` with code 'PROTOCOL_INVALID_MESSAGE',
// built by `protocolParseError` — which renders the issues through
// `describeZodIssues`, so the message holds issue paths, issue codes and
// schema-declared metadata and never the rejected value. Nowhere does that
// matter more than here: these payloads carry a developer's own question, the
// absolute path of their project, and a `SessionRecord` holding file paths,
// plans, unified diffs and analysis prose. A validation error is raised far
// below the redaction layer that would otherwise protect them, so the rejected
// value is not available to be leaked (AAP §0.5.2).
// ---------------------------------------------------------------------------

/**
 * Validates `value` against `schema`, reporting a rejection the way this package
 * always reports one.
 *
 * Module-private, and the single place the `safeParse` → `protocolParseError`
 * sequence is written: the seven exported helpers below differ only in the
 * schema they apply and the sentence they prefix the issues with, and spelling
 * that sequence out seven times would be seven chances for one of them to attach
 * a `ZodError`, forward an issue message or throw.
 *
 * @param value Any value believed to hold the payload.
 * @param schema The payload schema to validate against.
 * @param prefix A short statement of what failed to validate, with no trailing
 * punctuation.
 * @param hint A developer-facing next step, forwarded verbatim by
 * `DebuggenError.toPayload()` and therefore as free of rejected data as the
 * message is.
 * @returns `ok(payload)` with the validated value, or `err(error)` describing
 * the shape of the failure.
 */
function parsePayload<T>(
  value: unknown,
  schema: z.ZodType<T>,
  prefix: string,
  hint: string,
): Result<T, DebuggenError> {
  const parsed = schema.safeParse(value);

  if (parsed.success) {
    return ok(parsed.data);
  }

  return err(protocolParseError('PROTOCOL_INVALID_MESSAGE', prefix, parsed.error.issues, hint));
}

/**
 * The hint attached to a rejected `session.created` or `session.updated`
 * payload.
 *
 * A constant sentence about the **schema**, shared by the two helpers because
 * they enforce one shape. It names the payload's single member and points at the
 * record's own definition rather than listing that record's fields: a hint
 * travels verbatim into a log line and a persisted session row, so it stays a
 * statement about the contract and never about the value that failed it (AAP
 * §0.5.2).
 */
const SESSION_RECORD_PAYLOAD_HINT =
  'A session payload carries exactly one member, session, holding a complete SessionRecord as packages/protocol/src/session-record.ts defines it.';

/**
 * Validates an unknown value as a {@link SessionCreatedPayload}.
 *
 * Applied by every client that receives the broadcast — the editor's service
 * client and the Chrome service worker's WebSocket bridge — before a surface
 * opens on a new session.
 *
 * @param value The `payload` field of a received `session.created` frame.
 * @returns `ok(payload)`, or `err(error)` when the frame does not match.
 *
 * @example
 * ```ts
 * const parsed = parseSessionCreatedPayload(frame.payload);
 * if (parsed.ok) {
 *   store.sessionCreated(parsed.value.session);
 * }
 * ```
 */
export function parseSessionCreatedPayload(
  value: unknown,
): Result<SessionCreatedPayload, DebuggenError> {
  return parsePayload(
    value,
    sessionCreatedPayloadSchema,
    'Invalid session.created payload',
    SESSION_RECORD_PAYLOAD_HINT,
  );
}

/**
 * Validates an unknown value as a {@link SessionUpdatedPayload}.
 *
 * Applied on every update *and* on every replay: reopening a session delivers
 * this payload from stored data, so the same check that guards a live frame
 * guards a row read back out of the store, and a record written by an older
 * build is refused here rather than half-rendered.
 *
 * @param value The `payload` field of a received `session.updated` frame.
 * @returns `ok(payload)`, or `err(error)` when the frame does not match.
 */
export function parseSessionUpdatedPayload(
  value: unknown,
): Result<SessionUpdatedPayload, DebuggenError> {
  return parsePayload(
    value,
    sessionUpdatedPayloadSchema,
    'Invalid session.updated payload',
    SESSION_RECORD_PAYLOAD_HINT,
  );
}

/**
 * Validates an unknown value as a {@link SessionProgressPayload}.
 *
 * Applied by both user interfaces before a progress row is drawn. An unknown
 * `stage` or `status` fails here, which is the intended outcome: a surface that
 * rendered an unrecognised stage would be inventing a phase of the pipeline, and
 * one that rendered an unrecognised status could not choose a spinner, a check or
 * a cross.
 *
 * @param value The `payload` field of a received `session.progress` frame.
 * @returns `ok(payload)`, or `err(error)` when the frame does not match.
 */
export function parseSessionProgressPayload(
  value: unknown,
): Result<SessionProgressPayload, DebuggenError> {
  return parsePayload(
    value,
    sessionProgressPayloadSchema,
    'Invalid session.progress payload',
    `A session.progress payload carries sessionId, one of the ${String(PROGRESS_STAGES.length)} known stages, one of the ${String(PROGRESS_STATUSES.length)} known statuses, a non-empty message and an optional detail.`,
  );
}

/**
 * Validates an unknown value as an {@link AnalysisCompletedPayload}.
 *
 * Applied by both user interfaces before observed facts and likely causes are
 * rendered, and by the service to a row it reads back. The embedded artifact is
 * validated in full, not shallowly, so an analysis whose observed fact cites no
 * evidence is refused here — the structural half of AAP §0.8.4's separation
 * between what was measured and what is merely likely.
 *
 * @param value The `payload` field of a received `analysis.completed` frame.
 * @returns `ok(payload)`, or `err(error)` when the frame does not match.
 */
export function parseAnalysisCompletedPayload(
  value: unknown,
): Result<AnalysisCompletedPayload, DebuggenError> {
  return parsePayload(
    value,
    analysisCompletedPayloadSchema,
    'Invalid analysis.completed payload',
    'An analysis.completed payload carries exactly sessionId and analysis, the latter a complete AnalysisResult whose observed facts each cite at least one piece of evidence.',
  );
}

/**
 * Validates an unknown value as a {@link SessionCreateRequest}.
 *
 * Applied by the service to the request body of `session.create` before a
 * session row exists. A rejection here is the cheapest possible failure: nothing
 * has been created, nothing indexed and nothing written to the developer's
 * working tree.
 *
 * @param value The parsed JSON request body.
 * @returns `ok(request)`, or `err(error)` when the body does not match.
 */
export function parseSessionCreateRequest(
  value: unknown,
): Result<SessionCreateRequest, DebuggenError> {
  return parsePayload(
    value,
    sessionCreateRequestSchema,
    'Invalid session.create request',
    'A session.create request body carries projectRoot, question, an optional target descriptor and an optional http(s) devServerUrl, and nothing else.',
  );
}

/**
 * Validates an unknown value as a {@link SessionQuestionRequest}.
 *
 * Applied by the service to the request body of `session.question`. The session
 * is named in the route, so this check is about the one field the developer
 * supplied.
 *
 * @param value The parsed JSON request body.
 * @returns `ok(request)`, or `err(error)` when the body does not match.
 */
export function parseSessionQuestionRequest(
  value: unknown,
): Result<SessionQuestionRequest, DebuggenError> {
  return parsePayload(
    value,
    sessionQuestionRequestSchema,
    'Invalid session.question request',
    'A session.question request body carries exactly one member, question, and names the session in the route.',
  );
}

/**
 * Validates an unknown value as a {@link SessionEndRequest}.
 *
 * Applied by the service before cleanup runs. The body is empty, so this
 * helper's job is to refuse a client that believed it could parameterise the
 * restoration of a developer's files.
 *
 * @param value The parsed JSON request body.
 * @returns `ok({})`, or `err(error)` when the body carries anything at all.
 */
export function parseSessionEndRequest(value: unknown): Result<SessionEndRequest, DebuggenError> {
  return parsePayload(
    value,
    sessionEndRequestSchema,
    'Invalid session.end request',
    'The session.end request body is empty: send {} and name the session in the route.',
  );
}

// ---------------------------------------------------------------------------
// Section F — the embedded shapes keep their types, proved at compile time
// ---------------------------------------------------------------------------

/**
 * `true` when `A` and `B` are mutually assignable, `false` otherwise.
 *
 * The tuple wrappers stop a naked `never` or a union from distributing, so this
 * answers about the types as written rather than about their members.
 */
type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/**
 * Accepts `true` and nothing else: instantiating it with `false` is a compile
 * error (TS2344), which is what turns a type comparison into an assertion.
 */
type AssertTrue<T extends true> = T;

/**
 * The conjunction of the three upstream shapes this module embeds.
 *
 * Written as nested conditionals rather than as an intersection so that the
 * first broken edge is the one `tsc` reports.
 */
type EmbeddedShapesHold =
  MutuallyAssignable<SessionCreatedPayload['session'], SessionRecord> extends true
    ? MutuallyAssignable<SessionUpdatedPayload['session'], SessionRecord> extends true
      ? MutuallyAssignable<AnalysisCompletedPayload['analysis'], AnalysisResult> extends true
        ? MutuallyAssignable<NonNullable<SessionCreateRequest['target']>, SelectedTarget>
        : false
      : false
    : false;

/**
 * Compile-time proof that every cross-boundary shape these payloads carry is the
 * **imported** one rather than a local copy (AAP §0.2.3, §0.9.1).
 *
 * The risk this guards against is invisible by inspection. A hand-written
 * `{ id: string; status: string; … }` in place of `sessionRecordSchema` would
 * compile, would type-check at every call site, and would differ only in what it
 * refuses — a session whose status is not one of the eleven, a plan action with
 * no adapter, an analysis fact citing nothing. The runtime half of the same
 * guarantee belongs in `src/__tests__/messages.test.ts`, which feeds such values
 * in and requires a rejection.
 *
 * Four edges are checked: the `SessionRecord` of `../session-record.js` on both
 * session payloads, the `AnalysisResult` of `../analysis.js` on
 * `analysis.completed`, and the `SelectedTarget` of `@debuggen/instrumentation`
 * on the create request — the last through `NonNullable`, since that field is
 * optional.
 *
 * It resolves to `true`, and it is the assertion rather than the value that
 * matters: any edit that breaks an edge instantiates {@link AssertTrue} with
 * `false` and fails `tsc -b` here, in the module that made the mistake, instead
 * of at the first consumer that reads a field off a payload.
 *
 * Exported because a type alias nothing references is a compile error under this
 * repository's `noUnusedLocals`, and because a reader of the emitted
 * declarations can then see the guarantee stated. It has no runtime
 * representation; there is nothing to consume.
 *
 * @internal
 */
export type SessionMessageEmbeddedShapesPreserved = AssertTrue<EmbeddedShapesHold>;

/**
 * Whether every `sessionId` this module declares can be handed to code that
 * speaks `@debuggen/shared`'s id alias.
 */
type SessionIdEdgeHolds =
  MutuallyAssignable<SessionProgressPayload['sessionId'], SessionId> extends true
    ? MutuallyAssignable<AnalysisCompletedPayload['sessionId'], SessionId>
    : false;

/**
 * Compile-time proof that the `sessionId` fields of this module's payloads are
 * usable as `SessionId` without a cast.
 *
 * `SessionId` is an unbranded string alias in `packages/shared/src/ids.ts`,
 * which is what lets one bounded string schema serve it — see
 * {@link sessionIdSchema} for why the `ses_` prefix grammar is deliberately not
 * re-derived at a transport boundary. The practical guarantee is that
 * `store.loadSession(payload.sessionId)` typed `(id: SessionId)` compiles, and
 * would stop compiling here if a future edit branded the alias or narrowed the
 * field away from `string` — the edit that would otherwise be discovered in
 * three consumer workspaces at once.
 *
 * Exported for the reason {@link SessionMessageEmbeddedShapesPreserved} is.
 *
 * @internal
 */
export type SessionIdEdgePreserved = AssertTrue<SessionIdEdgeHolds>;
