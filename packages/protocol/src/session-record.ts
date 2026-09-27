/**
 * `SessionRecord` — the state of one debugging session, defined here and
 * nowhere else (AAP §0.9.1).
 *
 * A session is the product's unit of work: a developer's question about a
 * running application, everything the tool learned while investigating it,
 * everything it did to the working tree, everything it captured, and everything
 * it concluded. This module is the one definition of that state, and four
 * processes read it:
 *
 * ```text
 * apps/local-service   persists it as the `record` JSON column of `sessions`
 *                      (node:sqlite), and is the only writer
 *                      → src/store/sessions-repo.ts, src/sessions/{manager,
 *                        state-machine,reopen}.ts
 * the wire             `session.created` / `session.updated` carry it as
 *                      `{ session: SessionRecord }` (./messages/session.ts), and
 *                      `POST /sessions`, `GET /sessions`, `GET /sessions/:id`
 *                      return it (./http.ts)
 * VS Code              the webview renders the question, progress, relevant
 *                      files, modifications, analysis and cleanup state from it;
 *                      the Sessions tree lists past sessions from it
 *                      → apps/vscode-extension/src/views/sessions-tree.ts
 * DevTools             the panel's session store holds it and renders the
 *                      header, summary and capture controls from it
 *                      → apps/chrome-extension/src/panel/state/session-store.ts
 * ```
 *
 * A second definition of this shape in an app is the defect AAP §0.9.1 names by
 * name. There is no adapter, no view model and no "wire variant": what the
 * service stores is what the sockets carry and what both user interfaces render.
 *
 * ## Why the record has to be self-sufficient
 *
 * Reopening a session is `GET /sessions/:id`, after which the service replays
 * `session.updated` and the latest `panel.generated` so the panel re-renders
 * from stored data (AAP §0.4.2). Neither user interface keeps anything else: a
 * reopened session's entire view — which question was asked, which element it
 * was about, which files the investigation found, which files were modified and
 * whether they were restored, how many captures there were, what the analysis
 * concluded — is rebuilt from this one object. Hence two properties that every
 * field below is chosen for:
 *
 * - **Everything survives a JSON round trip.** `JSON.parse(JSON.stringify(r))`
 *   deep-equals `r`. No `Date`, no `Map`, no `Set`, no class instance, no
 *   `NaN`/`Infinity` (the epoch and count bounds refuse them), and no `null`
 *   standing in for "not yet known" — an absent optional key is the single
 *   spelling of that, so the object a consumer parses is the object the producer
 *   built. Timestamps are Unix epoch milliseconds through `epochMsSchema`, the
 *   product's one time base (AAP §0.2.3).
 * - **Every field is bounded.** Strings have a maximum length and arrays a
 *   maximum count, because this record is serialised into a single SQLite column
 *   and broadcast to every connected client on each update. An unbounded
 *   `modifications` or `analyses` list would make one long session's row, and
 *   every frame carrying it, grow without limit. The bounds are stated as
 *   deliberate decisions beside each field.
 *
 * ## What is *not* here, and why
 *
 * - **No panel specifications.** `panelIds` holds ids; a panel is fetched with
 *   `GET /sessions/:id/panels/:panelId` (AAP §0.4.2). Embedding `PanelSpec[]`
 *   would duplicate the `panels` table and make a record that a status update
 *   broadcasts on every change enormous.
 * - **No telemetry events.** They live in their own table behind the
 *   `panel-data` route, bounded by `limit`/`offset`; a capture contributes only
 *   its identity and its aggregate `CaptureSummary` here.
 * - **No transition table.** The eleven statuses below are a *vocabulary*;
 *   which transitions are legal belongs to
 *   `apps/local-service/src/sessions/state-machine.ts`, which is the only place
 *   that may decide them. Two of its rules are worth stating where the
 *   vocabulary is defined, because every consumer of this record depends on them
 *   (AAP §0.5.5): the transition to `generated` is permitted **only** after a
 *   validated `AnalysisResult` *and* a validated `PanelSpec` exist, and `failed`
 *   is a distinct status that both user interfaces render together with the
 *   stage that failed — a failure is never presented as a successful analysis.
 * - **No `FollowUpDecision`.** The `{ needsNewCapture, additionalActions }`
 *   artifact is a pipeline-internal stage output owned by
 *   `apps/local-service/src/pipeline/stages/followup.ts`. What reaches the wire
 *   is {@link FollowUpRecord}: what the follow-up *did*.
 *
 * ## Upstream shapes are imported, never restated
 *
 * Five of this record's members are owned by packages below this one, and each
 * is embedded as its own schema so that the owner's rules run unchanged and a
 * rejection is reported under the full field path (AAP §0.2.3):
 *
 * | Member | Single definition |
 * | --- | --- |
 * | `plans[]` | `instrumentationPlanSchema` — `@debuggen/instrumentation` |
 * | `modifications[]`, `cleanup.conflicts[]` | `modificationRecordSchema`, `modificationConflictSchema` — `@debuggen/instrumentation` |
 * | `target?` | `selectedTargetSchema` — `@debuggen/instrumentation` |
 * | `understanding?` | `problemUnderstandingSchema` — `@debuggen/instrumentation` |
 * | `analyses[]` | `analysisResultSchema` — `./analysis.js` |
 * | `captures[].summary?` | the `CaptureSummary` **type** of `@debuggen/telemetry`, which owns no Zod schema, wrapped by {@link opaqueSchema} |
 *
 * {@link SessionRecordEmbeddedShapesPreserved} is the compile-time proof that
 * every one of those edges still holds.
 *
 * The one shape defined *here* rather than imported is {@link RelevantFile}.
 * `@debuggen/code-analysis` is outside this package's edge list — protocol may
 * import only `@debuggen/telemetry`, `@debuggen/instrumentation`,
 * `@debuggen/panel-schema` and `@debuggen/shared` (AAP §0.2.2, enforced by the
 * layering block of `eslint.config.js`) — so the shape the code-investigation
 * stage produces *for the wire* is declared below. Adding a code-analysis
 * dependency to "fix" that would close a cycle and fail the lint gate; the
 * indexer's own richer graph types stay in the indexer.
 *
 * ## Privacy
 *
 * A `SessionRecord` is among the most sensitive values this protocol carries: an
 * absolute path to the developer's project, the question they typed, the paths
 * and symbols of their source files, a dev-server URL and a selected element's
 * visible text. So every rejection path here goes through `protocolParseError`,
 * which names field paths and issue codes and never a rejected value
 * (AAP §0.5.2), and no schema below transforms, coerces, defaults or catches its
 * input — what was validated is exactly what is stored.
 *
 * The `question` field is plain text and stays plain text: nothing in this
 * package inspects it, matches against it or switches on it (AAP §0.5.4, checked
 * by `scripts/check-no-hardcoding.mjs`, which scans this folder).
 *
 * ## Module rules
 *
 * Named exports only, no default export, and no import-time side effect — the
 * manifest declares `sideEffects: false` and everything below is a declaration.
 * This module sits between `./analysis.js` and the message layer: it may import
 * `./version.js`, `./analysis.js` and the packages above, and it imports no
 * message module, no envelope and no client (`./index.ts` states the graph).
 *
 * @example
 * ```ts
 * // Service side: read a row back from the session store.
 * const parsed = parseSessionRecord(JSON.parse(row.record));
 * if (!parsed.ok) {
 *   logger.warn('unreadable session row', { id: row.id, reason: parsed.error.message });
 *   return;
 * }
 * broadcast({ type: 'session.updated', payload: { session: parsed.value } });
 *
 * // User-interface side: render without branching on `undefined`.
 * for (const conflict of session.cleanup.conflicts) {
 *   showConflict(conflict.file, conflict.backupPath);
 * }
 * ```
 */

import { z } from 'zod';

import { err, isAbsolutePosix, isSafeRelativePath, isWindowsAbsolute, ok } from '@debuggen/shared';
import type {
  AnalysisId,
  CaptureId,
  DebuggenError,
  PanelId,
  Result,
  SessionId,
} from '@debuggen/shared';
import type { CaptureSummary } from '@debuggen/telemetry';
import {
  instrumentationPlanSchema,
  modificationConflictSchema,
  modificationRecordSchema,
  problemUnderstandingSchema,
  selectedTargetSchema,
} from '@debuggen/instrumentation/schema';
import type {
  InstrumentationPlan,
  ModificationConflict,
  ModificationRecord,
  ProblemUnderstanding,
  SelectedTarget,
} from '@debuggen/instrumentation/schema';

import { analysisResultSchema } from './analysis.js';
import type { AnalysisResult } from './analysis.js';
import { epochMsSchema, opaqueSchema, protocolParseError, recordWithKeys } from './version.js';

// ---------------------------------------------------------------------------
// Section A — bounds
//
// Every string and every array in this module is bounded, for the reason the
// module documentation gives: one record is one SQLite column and one broadcast
// frame. The numbers are deliberate rather than defensive — each is large enough
// that no honest session reaches it, and small enough that a producer with a
// runaway loop is refused here rather than after the row is written.
// ---------------------------------------------------------------------------

/**
 * The longest identifier any field here accepts: **64** characters.
 *
 * Folder-canonical — every message module in this package bounds an id the same
 * way. The ids this product mints are twenty characters (a three-letter kind
 * prefix, an underscore and sixteen random characters, from `@debuggen/shared`'s
 * `newId`), so this is headroom for a longer prefix or an id from an older
 * build, not a measured limit. The prefix grammar itself is deliberately *not*
 * re-derived here; `packages/shared/src/ids.ts` owns it, and a transport schema
 * that demanded the `ses_` spelling would refuse a stored row from a build whose
 * prefixes differed.
 */
const MAX_ID_LENGTH = 64;

/**
 * The longest absolute path accepted for `projectRoot`: **4096** characters.
 *
 * `PATH_MAX` on Linux and the practical ceiling on macOS and Windows alike, and
 * the same bound `./messages/agent.ts` applies to the `projectRoot` a client
 * announces in `client.hello`. Sharing it means one developer's deeply nested
 * workspace is accepted or refused identically at both boundaries.
 */
const MAX_PATH_LENGTH = 4096;

/**
 * The longest project-relative file path accepted for a {@link RelevantFile}:
 * **1024** characters.
 *
 * Matches the bound `@debuggen/instrumentation` applies to a plan action's
 * `file` and to a modification record's `file`, so the three file paths a
 * session carries — investigated, instrumented, conflicted — agree about what is
 * too long.
 */
const MAX_FILE_LENGTH = 1024;

/**
 * The longest URL accepted, for `devServerUrl` and a bound tab's `url`: **2048**
 * characters.
 *
 * The folder's URL bound, shared with `./messages/{agent,binding}.ts` and with
 * the selected-target descriptor upstream.
 */
const MAX_URL_LENGTH = 2048;

/**
 * The longest display name accepted for `projectName`: **200** characters.
 *
 * It is a label for a tree item and a panel header — usually the workspace
 * folder's basename — not a path.
 */
const MAX_NAME_LENGTH = 200;

/**
 * The longest symbol name accepted on a {@link RelevantFile}: **200**
 * characters.
 *
 * The same bound `@debuggen/instrumentation` applies to a plan action's
 * `symbol`, because the two describe the same thing: a named function,
 * component, method or route handler in the developer's code.
 */
const MAX_SYMBOL_LENGTH = 200;

/**
 * The longest justification accepted on a {@link RelevantFile}: **500**
 * characters.
 *
 * One or two sentences, rendered in the VS Code `RelevantFiles` list. The same
 * bound the instrumentation plan applies to an action's `rationale`, which is
 * the same kind of sentence one stage later.
 */
const MAX_REASON_LENGTH = 500;

/**
 * The longest question accepted, for the session's question and for a
 * follow-up's: **2000** characters (UTF-16 code units, as `String#length`
 * counts them).
 *
 * A developer's own prose, and deliberately generous: a question may quote an
 * error message or paste a few lines of context, and a truncated question is a
 * worse pipeline input than a long one. It bounds a text area's content, not a
 * document.
 *
 * Exported because it is the product's **one** question limit, and every
 * surface that accepts a question has to agree with it rather than restate it
 * (AAP §0.2.3, "avoid duplicating"):
 *
 * - {@link questionSchema}, below, which applies it to the stored
 *   `SessionRecord.question` and to every `followUps[].question`;
 * - `./messages/session.ts`, whose `sessionCreateRequestSchema` and
 *   `sessionQuestionRequestSchema` embed that schema, so `POST /sessions` and
 *   `POST /sessions/:id/question` refuse exactly what the record would;
 * - the VS Code webview, whose `MAX_WEBVIEW_QUESTION_LENGTH`
 *   (`apps/vscode-extension/src/webview-messages.ts`) is this value: the host
 *   refuses a longer `askQuestion`/`askFollowUp` frame, and the question and
 *   follow-up text areas set it as their native `maxLength` and count against
 *   it, so no question the service would refuse can be typed.
 */
export const MAX_QUESTION_LENGTH = 2000;

/**
 * The longest model identifier recorded on {@link SessionProvider}: **128**
 * characters.
 *
 * The value comes from `DEBUGGEN_MODEL` and is never a literal in this
 * repository (AAP §0.5.3), so the bound has to admit whatever a provider's
 * naming scheme produces — a dated, versioned model id is comfortably inside it.
 */
const MAX_MODEL_ID_LENGTH = 128;

/**
 * The most relevant files a session records: **50**.
 *
 * The investigation stage ranks and selects; a list longer than this is a stage
 * that stopped selecting, and a user interface cannot present it usefully
 * anyway.
 */
const MAX_RELEVANT_FILES = 50;

/**
 * The most follow-up questions a session records: **50**.
 *
 * A long conversation about one capture is the product working as intended
 * (AAP §0.4.2's existing-evidence path), so this is high; a session that reaches
 * it has outlived the reproduction it was built on.
 */
const MAX_FOLLOW_UPS = 50;

/**
 * The most plan versions a session records: **32**.
 *
 * Each follow-up that needs new instrumentation appends version *n + 1*
 * (AAP §0.4.2), and each version carries up to sixty-four actions of its own
 * upstream bound, so thirty-two is already a very long instrumentation history.
 */
const MAX_PLANS = 32;

/**
 * The most modification records a session records: **256**.
 *
 * The journal every cleanup pass walks in reverse, and the list both user
 * interfaces render (VS Code's `ModificationsList` with its `DiffView`,
 * DevTools' `SessionSummary`). It is the highest array bound here on purpose:
 * one record per patched file per plan version, and dropping one would leave a
 * file instrumented with nothing to restore it from.
 */
const MAX_MODIFICATIONS = 256;

/**
 * The most modification conflicts a cleanup result records: **256**.
 *
 * A conflict is one unrestorable modification, so the ceiling is the
 * modification ceiling: a pass where every record conflicted must still be
 * reportable in full, since each conflict names the backup the developer's
 * original is still in.
 */
const MAX_CONFLICTS = MAX_MODIFICATIONS;

/**
 * The most captures a session records: **64**.
 *
 * "Capture again" is a normal action — a capture that collected nothing returns
 * the session to `ready` (AAP §0.5.5) — so a session accumulates attempts.
 */
const MAX_CAPTURES = 64;

/**
 * The most panel ids a session records: **128**.
 *
 * Ids only, by the design note in the module documentation, so the bound is
 * about the history's length rather than its weight: every follow-up may add a
 * panel version that supersedes its predecessor, and both remain reachable.
 */
const MAX_PANEL_IDS = 128;

/**
 * The most analyses a session records: **64**.
 *
 * Unlike `panelIds`, this list holds whole artifacts, because a reopened session
 * renders the latest analysis without a second request. Each one is itself
 * bounded upstream (at most twenty facts and ten hypotheses), which is what
 * keeps the aggregate reasonable.
 */
const MAX_ANALYSES = 64;

// ---------------------------------------------------------------------------
// Section B — field primitives
// ---------------------------------------------------------------------------

/**
 * Whether a code point is a control character: C0 (NUL through US), DELETE or
 * C1.
 *
 * NUL terminates a path early in every C string API — so `'a\u0000.ts'` can open
 * `'a'` — ESC begins a terminal escape sequence, and a line break in a field a
 * user interface renders on one line turns a label into a spoof. A character
 * scan rather than a regular expression, matching the equivalents in
 * `@debuggen/shared` and `@debuggen/instrumentation`: a literal control
 * character inside a pattern is what `no-control-regex` refuses, and the loop
 * also has no `lastIndex` to carry between calls.
 */
function isControlCode(code: number): boolean {
  return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
}

/**
 * Whether a code point is one of the three control characters prose may carry:
 * tab, line feed and carriage return.
 *
 * A developer's question may legitimately span lines; it may not carry a NUL or
 * an escape sequence.
 */
function isProseWhitespaceCode(code: number): boolean {
  return code === 0x09 || code === 0x0a || code === 0x0d;
}

/**
 * Whether a string is usable as a single-line label: it carries at least one
 * non-whitespace character and no control character at all.
 *
 * Module-local, like its counterparts in the message modules. The equivalents in
 * `@debuggen/instrumentation` are private to that package, and a shared
 * "text rules" module would be a dependency in the wrong direction for a
 * predicate this small.
 */
function isSingleLineText(value: string): boolean {
  if (value.trim().length === 0) {
    return false;
  }

  for (let index = 0; index < value.length; index += 1) {
    if (isControlCode(value.charCodeAt(index))) {
      return false;
    }
  }

  return true;
}

/**
 * Whether a string is usable as prose: at least one non-whitespace character,
 * and no control character other than tab, line feed or carriage return.
 */
function isProseText(value: string): boolean {
  if (value.trim().length === 0) {
    return false;
  }

  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);

    if (isControlCode(code) && !isProseWhitespaceCode(code)) {
      return false;
    }
  }

  return true;
}

/**
 * Whether a string is an absolute **POSIX** path, with no Windows root and no
 * control character.
 *
 * Built from `@debuggen/shared`'s two root predicates rather than from a local
 * regular expression, so this module cannot disagree with the package that owns
 * path semantics. Both are needed: `isAbsolutePosix` accepts a UNC path
 * (`//server/share`) because it begins with a separator, and
 * `isWindowsAbsolute` is what recognises and refuses it — the product's paths
 * are POSIX, and a backslash is refused as a separator *and* as a file-name
 * character for the reason `isSafeRelativePath` refuses it.
 *
 * This is a **string-level** check on a path on the developer's own machine, so
 * there is deliberately nothing to contain it against: `projectRoot` *is* the
 * containment boundary that `apps/local-service/src/source/open.ts` and
 * `apps/vscode-extension/src/uri-handler.ts` resolve every other path against
 * (AAP §0.2.3, §0.5.6).
 */
function isAbsolutePosixPath(value: string): boolean {
  if (!isAbsolutePosix(value) || isWindowsAbsolute(value) || value.includes('\\')) {
    return false;
  }

  for (let index = 0; index < value.length; index += 1) {
    if (isControlCode(value.charCodeAt(index))) {
      return false;
    }
  }

  return true;
}

/**
 * An opaque identifier as a field: a non-empty, bounded, single-line string.
 *
 * Shape only, for the reason {@link MAX_ID_LENGTH} states. Whether the named
 * session, capture, analysis or panel *exists* is a service answer
 * (`SESSION_NOT_FOUND`), never a schema's.
 */
const idSchema = z
  .string()
  .min(1, { error: 'expected a non-empty identifier' })
  .max(MAX_ID_LENGTH, {
    error: `expected an identifier of at most ${String(MAX_ID_LENGTH)} characters`,
  })
  .refine(isSingleLineText, {
    error: 'expected an identifier with no control characters',
  });

/**
 * A version counter: an integer of at least **1**.
 *
 * Shared by `plans[].planVersion` (through the imported plan schema) and by the
 * plan version a capture or a follow-up names. `z.int()` refuses `1.5` as a type
 * issue and the bound refuses `0`, so a producer that treated the counter as an
 * index fails here rather than storing a version nothing can order.
 */
const versionCounterSchema = z.int().min(1, { error: 'expected a version counter of at least 1' });

/**
 * An absolute URL, bounded in length.
 *
 * Used for the session's dev-server URL and for a bound tab's document URL. Both
 * may arrive **query-redacted** — each parameter's value replaced, its key and
 * the path kept (AAP §0.5.2) — and a redacted URL is still a valid absolute URL,
 * which is why the check is on shape alone. Not narrowed to `http:`/`https:`
 * either: the origin comparison that decides a binding is the service's, and
 * `./messages/binding.ts` explains why refusing other schemes at a transport
 * schema costs more than it buys. Consumers treat the value as text.
 */
const urlSchema = z.url({ error: 'expected an absolute URL' }).max(MAX_URL_LENGTH, {
  error: `expected an absolute URL of at most ${String(MAX_URL_LENGTH)} characters`,
});

/**
 * The label {@link questionSchema}'s prose refinement declares, rendered by
 * `describeZodIssues` as `question (custom label=non-blank-text-without-control-codes)`
 * when a question is blank or carries a control character. A fixed schema name —
 * it passes that function's field-name gate — so the refusal names the rule it
 * broke without repeating any of the question.
 */
const QUESTION_PROSE_RULE = 'non-blank-text-without-control-codes';

/**
 * A developer-authored question: non-empty, bounded prose.
 *
 * Plain text, and nothing in this package looks inside it (AAP §0.5.4): it is
 * at least one character long, at most {@link MAX_QUESTION_LENGTH} characters
 * long, carries at least one non-whitespace character, and carries no control
 * character other than tab, line feed or carriage return. No transform, default
 * or catch — what was validated is exactly what is stored — and every refusal
 * names the rule it broke, never the question itself (AAP §0.5.2).
 *
 * The single definition of a valid question, exported so each boundary applies
 * the same rule:
 *
 * - this module's `SessionRecord.question` and `FollowUpRecord.question`;
 * - `./messages/session.ts`'s `sessionCreateRequestSchema.question` and
 *   `sessionQuestionRequestSchema.question`, so a blank or control-character
 *   question is refused at the route with a precise 400 instead of being
 *   accepted and failing later, when the record is written.
 */
export const questionSchema = z
  .string()
  .min(1, { error: 'expected a non-empty question' })
  .max(MAX_QUESTION_LENGTH, {
    error: `expected a question of at most ${String(MAX_QUESTION_LENGTH)} characters`,
  })
  .refine(isProseText, {
    error: 'expected a question with at least one non-whitespace character and no control codes',
    // Schema-declared, so `describeZodIssues` renders it (`question (custom
    // label=…)`): a refused blank or control-character question then names the
    // rule it broke, where a bare `custom` would not, and still echoes nothing.
    params: { label: QUESTION_PROSE_RULE },
  });

// ---------------------------------------------------------------------------
// Section C — the two status vocabularies
// ---------------------------------------------------------------------------

/**
 * The eleven session statuses, in the order a session moves through them
 * (AAP §0.2.3).
 *
 * This tuple is the **vocabulary** and nothing more. The transition table — which
 * status may follow which, and what has to exist first — belongs to
 * `apps/local-service/src/sessions/state-machine.ts`, and encoding an adjacency
 * map here would duplicate it in a package that cannot see a session's analyses,
 * panels or capture. Two of its rules are recorded in the module documentation
 * because every consumer depends on them: `generated` is reachable only after a
 * validated analysis *and* a validated panel exist, and `failed` is a distinct
 * status rendered with the failing stage (AAP §0.5.5).
 *
 * The order is the AAP's and is load-bearing beyond documentation: a user
 * interface renders pipeline progress in it, so a reordering here would reorder
 * the progress view. `as const` so {@link SessionStatus} can be derived from the
 * tuple and {@link sessionStatusSchema} can validate against it without
 * repeating the eleven strings.
 *
 * Consumed by `./messages/session.ts` (through `SessionRecord`), the store's
 * `sessions.status` column, the VS Code Sessions tree and the DevTools panel's
 * status badge.
 */
export const SESSION_STATUSES = [
  'created',
  'understanding',
  'investigating',
  'planning',
  'instrumenting',
  'ready',
  'capturing',
  'analyzing',
  'generated',
  'ended',
  'failed',
] as const;

/**
 * One of {@link SESSION_STATUSES}.
 *
 * Derived from the tuple, so a status added there widens this union in the same
 * edit and every exhaustive `switch` over it — the state machine's transition
 * table, the progress view, the panel's badge — stops compiling until it says
 * something about the new case.
 */
export type SessionStatus = (typeof SESSION_STATUSES)[number];

/**
 * Validates a session status.
 *
 * Embedded as `SessionRecord.status`, and usable on its own where a status
 * arrives from outside the type system — a store row, a query parameter, a
 * message from a process built at a different commit.
 */
export const sessionStatusSchema = z.enum(SESSION_STATUSES);

/**
 * Narrows an arbitrary value to a {@link SessionStatus}.
 *
 * Deliberately not a wrapper around {@link sessionStatusSchema}: it allocates no
 * result object and builds no issue array, so it is the right check inside a
 * `filter` or a render path where a rejection needs no explanation. Parse with
 * the schema where the *reason* has to reach a developer.
 *
 * This is the only predicate this module offers over the vocabulary. A
 * `canTransition`-style helper would be the service's state machine wearing a
 * protocol package's name.
 *
 * @param value Any value, including `undefined` and a non-string.
 * @returns `true` when `value` is one of the eleven statuses.
 */
export function isSessionStatus(value: unknown): value is SessionStatus {
  return typeof value === 'string' && (SESSION_STATUSES as readonly string[]).includes(value);
}

/**
 * The four cleanup statuses of a session (AAP §0.5.1).
 *
 * `pending` until cleanup runs, then `clean` (every modification restored),
 * `partial` (some restored, some could not be attempted) or `conflict` (a file
 * was edited while instrumented, so the tool refused to overwrite it and the
 * original stays in the backup directory).
 *
 * Not to be confused with the identically named vocabulary of
 * `@debuggen/instrumentation`, which describes **one cleanup pass's verdict** and
 * has three members: a pass never reports `pending`, because a pass that has run
 * has a verdict. This tuple describes a **session's** cleanup state, which
 * begins before any pass exists — and that is why it is defined here rather than
 * imported. A consumer that needs both imports each from its own owner.
 *
 * Carried by `cleanup.completed` (`./messages/cleanup.ts`) and returned by
 * `POST /sessions/:id/end` as `{ cleanup: CleanupStatus }` (`./http.ts`), which
 * is why both of those modules import it from here.
 */
export const CLEANUP_STATUSES = ['pending', 'clean', 'partial', 'conflict'] as const;

/**
 * One of {@link CLEANUP_STATUSES}.
 *
 * Derived from the tuple for the reason {@link SessionStatus} is.
 */
export type CleanupStatus = (typeof CLEANUP_STATUSES)[number];

/** Validates a session cleanup status. Embedded in {@link sessionCleanupSchema}. */
export const cleanupStatusSchema = z.enum(CLEANUP_STATUSES);

/**
 * Narrows an arbitrary value to a {@link CleanupStatus}.
 *
 * @param value Any value, including `undefined` and a non-string.
 * @returns `true` when `value` is one of the four cleanup statuses.
 */
export function isCleanupStatus(value: unknown): value is CleanupStatus {
  return typeof value === 'string' && (CLEANUP_STATUSES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Section D — the sub-records
//
// Each is its own exported schema and inferred type, so the service's
// repositories and both user interfaces can name the shape they are holding
// instead of reaching into `SessionRecord['captures'][number]`.
// ---------------------------------------------------------------------------

/**
 * A file the code-investigation stage judged relevant to the question, with the
 * reason it did.
 *
 * ## Why this shape is defined here
 *
 * It is produced by `apps/local-service/src/pipeline/stages/investigate.ts` from
 * `@debuggen/code-analysis` graph queries — and `@debuggen/code-analysis` is
 * **outside this package's edge list**. Protocol may import only
 * `@debuggen/telemetry`, `@debuggen/instrumentation`, `@debuggen/panel-schema`
 * and `@debuggen/shared` (AAP §0.2.2); the layering block of
 * `eslint.config.js` rejects anything else, and a dependency from here down to
 * the indexer would close a cycle through the service. So the *wire* shape of an
 * investigation result is declared here, deliberately, and the indexer's richer
 * internal graph types stay in the indexer. Nobody should "fix" this by adding a
 * code-analysis dependency.
 *
 * Rendered by the VS Code `RelevantFiles` component, where each entry is
 * clickable: the file path is what `showTextDocument` opens, which is why the
 * path constraint below is the strict one.
 */
export const relevantFileSchema = z.strictObject({
  /**
   * The file, **project-relative** and POSIX, refined with
   * `isSafeRelativePath` from `@debuggen/shared`.
   *
   * That imported predicate is the product's one path gate and it refuses: the
   * empty or whitespace-only string, any control character (NUL included), a
   * backslash anywhere, a POSIX-absolute path, a Windows drive or UNC path, and
   * any `..` segment that survives normalisation. It is the same rule
   * `SourceLocation.file` and every instrumentation target are checked against,
   * so a path this session records can be handed to the source-open path without
   * a second opinion about what "relative" means.
   *
   * Note the deliberate contrast with {@link sessionRecordSchema}'s
   * `projectRoot`, which must be **absolute**: one field is the boundary and the
   * other is measured against it.
   *
   * The refinement message names the field and the rule, never the rejected path
   * (AAP §0.5.2).
   */
  file: z
    .string()
    .min(1, { error: 'expected a non-empty file path' })
    .max(MAX_FILE_LENGTH, {
      error: `expected a file path of at most ${String(MAX_FILE_LENGTH)} characters`,
    })
    .refine(isSafeRelativePath, {
      error:
        'file must be a project-relative POSIX path: no absolute or drive-letter path, no UNC prefix, no backslash, no ".." segment and no control character',
    }),

  /**
   * The symbol within the file the investigation was pointing at — a component,
   * a handler, a service function, a route export — where it resolved one.
   *
   * **Optional, not nullable.** An absent key is how the stage says "the file as
   * a whole", which is the honest answer for a module-level finding; a `null`
   * would be a second spelling of the same fact that every consumer would have
   * to handle and that does not survive a JSON round trip as an absent key.
   */
  symbol: z
    .string()
    .min(1, { error: 'expected a non-empty symbol name' })
    .max(MAX_SYMBOL_LENGTH, {
      error: `expected a symbol name of at most ${String(MAX_SYMBOL_LENGTH)} characters`,
    })
    .refine(isSingleLineText, {
      error: 'symbol must be a single-line name with at least one non-whitespace character',
    })
    .optional(),

  /**
   * Why this file is relevant, in the investigation's own words.
   *
   * Required: a ranked list whose entries do not say why they are on it is a
   * list a developer has to re-derive. It is prose about code, not evidence
   * about a capture — evidence lives on a `Fact` in `./analysis.js`, where it
   * cannot exist without an event reference.
   */
  reason: z
    .string()
    .min(1, { error: 'expected a non-empty reason' })
    .max(MAX_REASON_LENGTH, {
      error: `expected a reason of at most ${String(MAX_REASON_LENGTH)} characters`,
    })
    .refine(isProseText, {
      error: 'reason must contain at least one non-whitespace character',
    }),

  /**
   * How relevant, in the closed range **0..1** inclusive — 0 for "listed but
   * unranked", 1 for "certainly the place".
   *
   * A normalised fraction rather than an open-ended score, so a user interface
   * can render it (a bar, a sort order) without knowing how the stage computed
   * it, and so two stage versions with different internal scales cannot be
   * compared by accident. `z.number()` refuses `NaN` and the bounds refuse both
   * infinities, so a divide-by-zero in a ranking function fails here rather than
   * silently sorting first.
   */
  score: z
    .number()
    .min(0, { error: 'expected a relevance score of at least 0' })
    .max(1, { error: 'expected a relevance score of at most 1' }),
});

/**
 * One entry of `SessionRecord.relevantFiles`.
 *
 * Inferred from {@link relevantFileSchema}, so the validator and the type are
 * one statement. Consumed by `apps/local-service/src/pipeline/stages/
 * investigate.ts` (producer), `apps/local-service/src/store/sessions-repo.ts`
 * and the VS Code `RelevantFiles` component.
 */
export type RelevantFile = z.infer<typeof relevantFileSchema>;

/**
 * The Chrome tab currently bound to the session.
 *
 * Maintained by the four binding messages (`./messages/binding.ts`): the panel
 * announces its inspected tab, the service answers `session.bound`, the service
 * worker reports every committed navigation, and a close or `session.end`
 * unbinds. This field is the *recorded* outcome of that protocol — one tab per
 * session at a time — and it is what makes "the panel of this session" a
 * routable destination for the agent config, the element-picker request, the
 * live tail and a generated panel (AAP §0.2.3).
 *
 * Absent when no tab is bound, which is a session's state before DevTools is
 * opened and again after the tab navigates to a different origin.
 */
export const boundTabSchema = z.strictObject({
  /**
   * Chrome's numeric tab id, as `chrome.devtools.inspectedWindow.tabId` reports
   * it.
   *
   * Non-negative: `chrome.tabs.TAB_ID_NONE` is **-1** and is not a tab, so a
   * producer that forwarded it is refused here rather than recorded as a
   * binding nothing can be delivered to. Bounded by `Number.MAX_SAFE_INTEGER`
   * because beyond it integer identity stops holding, and an id that cannot be
   * compared for equality is not an id. The same rule as
   * `./messages/binding.ts` applies to the tab id on the wire.
   */
  tabId: z
    .number()
    .int()
    .min(0, {
      error: 'expected a non-negative Chrome tab id (-1 is chrome.tabs.TAB_ID_NONE, not a tab)',
    })
    .max(Number.MAX_SAFE_INTEGER, {
      error: 'expected a Chrome tab id within the safe-integer range',
    }),

  /**
   * The tab's document URL at the moment of binding, possibly query-redacted.
   *
   * Shape only, per {@link urlSchema}: the origin comparison that decides
   * whether a navigation keeps or drops the binding is the service's, and this
   * value is text to every consumer — a status line, an event-log entry, the
   * input an origin is parsed out of.
   */
  url: urlSchema,
});

/**
 * The tab bound to a session, or the absence of one.
 *
 * Inferred from {@link boundTabSchema}. Consumed by
 * `apps/local-service/src/sessions/manager.ts`, the DevTools panel's session
 * store and the VS Code status row.
 */
export type BoundTab = z.infer<typeof boundTabSchema>;

/**
 * The capture summary as a field: the upstream `CaptureSummary` **type**, with a
 * shallow runtime check.
 *
 * `CaptureSummary` is owned by `packages/telemetry/src/aggregate/summary.ts` and
 * is a TypeScript interface with no Zod schema, so {@link opaqueSchema} supplies
 * the check while the type keeps coming from its owner through an `import type`
 * (AAP §0.2.3 — a second definition of it here would be the defect). The guard
 * requires a plain object carrying the capture's identity and its measurements,
 * which is what catches the failures that actually happen at a boundary: a
 * missing value, `undefined` where an object was expected, an array where a
 * record was expected, a JSON round trip that dropped the field. A summary whose
 * `topSpans` element has the wrong shape passes — deliberately: these values are
 * produced inside this machine's own trusted processes by the package that
 * defines them, and their authoritative validation lives with that producer.
 *
 * Module-private, and that is not an oversight: `./messages/capture.ts` already
 * exports a schema under the name `captureSummarySchema`, and `./index.ts`
 * re-exports every public name in this package with `export *`, so a second
 * export of that name would collide in the barrel and make the name unusable for
 * every consumer.
 */
const captureSummaryFieldSchema = opaqueSchema<CaptureSummary>(
  'CaptureSummary',
  recordWithKeys('captureId', 'eventCount', 'metrics'),
);

/**
 * One capture window of a session: what was captured, under which plan version,
 * and what it added up to.
 *
 * Mirrors the service's `captures` table — "`captures` (id, session_id,
 * plan_version, started_at, stopped_at, summary JSON)" (AAP §0.4.2) — minus the
 * `session_id` the owning record already supplies.
 *
 * A capture appears here the moment it starts, so an in-flight capture is a
 * record with no `stoppedAt` and no `summary`: that is what lets the DevTools
 * panel and the VS Code view render "capturing…" from the session alone, with no
 * second request and no separate state flag.
 */
export const captureRecordSchema = z.strictObject({
  /** The capture's own id, minted by the service (`newCaptureId()`). */
  id: idSchema,

  /**
   * The plan version that was installed while this capture ran.
   *
   * Load-bearing rather than informational: a follow-up may append plan version
   * *n + 1* and capture again (AAP §0.4.2), so this is what says which
   * instrumentation a capture's evidence came from — and therefore whether a
   * signal is missing because it was not installed or because nothing produced
   * it.
   */
  planVersion: versionCounterSchema,

  /** When capture started, in Unix epoch milliseconds. */
  startedAt: epochMsSchema,

  /**
   * When capture stopped. **Absent while the capture is in flight**, which is
   * the state the user interfaces read rather than a missing value they have to
   * explain.
   */
  stoppedAt: epochMsSchema.optional(),

  /**
   * The aggregate the capture produced, as `@debuggen/telemetry` computed it.
   *
   * Absent until the capture stops, and absent for a capture that collected
   * nothing worth summarising — a legitimate outcome that returns the session to
   * `ready` with "No telemetry was captured." (AAP §0.5.5) rather than a failure.
   *
   * Note what this summary is and is not: bounded top-N sections (`topSpans`,
   * `topRenders`, `topRequests`, `topQueries`, `errors`, each with its own
   * `truncated` flag) and no exhaustive event-id set. So it can never be used to
   * verify that an analysis's evidence ids exist — that is why
   * `packages/panel-schema/src/semantic.ts` has an explicit `unverifiable`
   * outcome, and why nothing here attempts such a cross-check.
   */
  summary: captureSummaryFieldSchema.optional(),

  /**
   * How many events were ingested for this capture.
   *
   * Kept beside the summary rather than only inside it because it is the one
   * number a user interface wants *during* capture, when there is no summary
   * yet: the panel's live event counter reads it from the session as the record
   * is updated. Optional for the same reason — a capture that has just started
   * has not counted anything.
   */
  eventCount: z
    .int()
    .min(0, { error: 'expected a non-negative event count' })
    .max(Number.MAX_SAFE_INTEGER, {
      error: 'expected an event count within the safe-integer range',
    })
    .optional(),
});

/**
 * One capture of a session.
 *
 * Inferred from {@link captureRecordSchema}. Consumed by
 * `apps/local-service/src/store/sessions-repo.ts`, the DevTools
 * `CaptureControls` and `SessionSummary`, and the VS Code `CaptureControls`.
 */
export type CaptureRecord = z.infer<typeof captureRecordSchema>;

/**
 * The three-letter kind prefix of a follow-up attempt id, for
 * `@debuggen/shared`'s `newId`: `newId(FOLLOW_UP_ATTEMPT_ID_PREFIX)` →
 * `fua_4k2p9dq7m1zx0c3v`.
 *
 * Declared here rather than in `@debuggen/shared`'s `ID_PREFIXES` because an
 * attempt id is minted by the two parties of `session.question` — the editor's
 * session view for every new ask, and the service when a request carries none
 * — and this package is the contract both of them read; the id body still comes
 * from the shared CSPRNG-backed generator. The prefix only makes the id
 * recognisable in a log or a store row: {@link followUpAttemptIdSchema} checks
 * shape alone, for the reason {@link MAX_ID_LENGTH} gives.
 */
export const FOLLOW_UP_ATTEMPT_ID_PREFIX = 'fua';

/**
 * The identity of one follow-up **attempt**: an opaque, bounded, single-line id
 * that names one question the developer asked, across every time it is sent.
 *
 * ## Why a follow-up needs an identity of its own
 *
 * A follow-up is recorded when it is asked, before anything answers it, and a
 * follow-up that then fails is retried. Neither the question text nor the time
 * it was asked can tell a retry from a new question: comparing text would be
 * matching on the question, which the product never does, and two asks in
 * the same millisecond share an `askedAt`. So the client mints one id per
 * question it asks and **resends the same id on a Retry**; a new question —
 * reworded or not — always gets a new one. The service keys the idempotency of
 * `session.question` on it: an id it has not recorded is a new follow-up; an
 * id naming the latest, still unanswered follow-up is a retry of that attempt,
 * recorded in place rather than appended; an id naming an answered or an
 * earlier follow-up is refused as the duplicate it is.
 *
 * Shape only, like every identifier in this package: the kind prefix
 * ({@link FOLLOW_UP_ATTEMPT_ID_PREFIX}) is how the product mints it, not a rule
 * a transport enforces.
 */
export const followUpAttemptIdSchema = z
  .string()
  .min(1, { error: 'expected a non-empty follow-up attempt id' })
  .max(MAX_ID_LENGTH, {
    error: `expected a follow-up attempt id of at most ${String(MAX_ID_LENGTH)} characters`,
  })
  .refine(isSingleLineText, {
    error: 'expected a follow-up attempt id with no control characters',
  });

/** A validated follow-up attempt id; see {@link followUpAttemptIdSchema}. */
export type FollowUpAttemptId = z.infer<typeof followUpAttemptIdSchema>;

/**
 * How many times one follow-up attempt has been asked: an integer of at least
 * **1**. `1` when the attempt is first recorded; each retry of it recorded in
 * place adds one, which is what lets a caller tell "this ask was recorded" from
 * "an earlier ask of the same attempt was" without comparing timestamps.
 */
const attemptCounterSchema = z.int().min(1, { error: 'expected an attempt counter of at least 1' });

/**
 * A follow-up question and what came of it — the `followups` table row
 * (AAP §0.4.2).
 *
 * This record is descriptive of **what happened**, which is the distinction that
 * keeps it small: the decision artifact
 * `FollowUpDecision { needsNewCapture, additionalActions }` is a pipeline-internal
 * stage output owned by `apps/local-service/src/pipeline/stages/followup.ts` and
 * is deliberately **not** part of the wire record. What a user interface needs is
 * the question, when it was asked, and which versions answered it.
 *
 * Both of AAP §0.4.2's paths are expressible, and the optional links are how a
 * reader tells them apart:
 *
 * ```text
 * existing evidence   needsNewCapture: false, captureId = the stored capture,
 * (generated →        analysisId / panelId = the regenerated versions
 *  analyzing →
 *  generated)
 *
 * new capture         needsNewCapture: true, planVersion = n + 1,
 * (generated →        captureId = the new capture, then analysisId / panelId
 *  planning →
 *  instrumenting →
 *  ready → …)
 * ```
 *
 * Every outcome link is optional because a follow-up is recorded when it is
 * asked, before any of them exists — and a follow-up that failed keeps the
 * links it reached and no more.
 *
 * `attemptId` and `attempt` identify the ask itself (see
 * {@link followUpAttemptIdSchema}): a Retry of a failed follow-up replaces the
 * entry in place — same position, same `attemptId`, `attempt` one higher, the
 * retry's own `askedAt` — so the ladder and the `followups` table hold one
 * entry per question asked, never one per send.
 */
export const followUpRecordSchema = z.strictObject({
  /** The developer's follow-up question, plain text (see {@link questionSchema}). */
  question: questionSchema,

  /** When it was asked, in Unix epoch milliseconds; a retry records its own time. */
  askedAt: epochMsSchema,

  /**
   * The identity of the attempt this entry records (see
   * {@link followUpAttemptIdSchema}). Unique within one session's ladder.
   *
   * Optional only so a follow-up stored before attempts carried an identity
   * still parses when its session is reopened. The service writes it on every
   * follow-up it records now, together with {@link attempt}: a producer sets
   * both or neither.
   */
  attemptId: followUpAttemptIdSchema.optional(),

  /**
   * How many times this attempt has been asked: `1` when first recorded, one
   * more for each retry recorded in place. Present exactly when `attemptId` is.
   */
  attempt: attemptCounterSchema.optional(),

  /**
   * What the follow-up stage decided: whether answering required a new capture.
   *
   * Absent until the stage has decided, so a consumer distinguishes "not yet
   * decided" from "decided: no" without a third value.
   */
  needsNewCapture: z.boolean().optional(),

  /**
   * The plan version this follow-up installed, on the new-capture path.
   *
   * A follow-up's plan is additive — version *n + 1* is the previous plan plus
   * the delta actions, never the previous plan with actions removed
   * (AAP §0.4.2) — so this names the version, not a separate plan.
   */
  planVersion: versionCounterSchema.optional(),

  /** The capture that answered it: a new one, or the stored one it reused. */
  captureId: idSchema.optional(),

  /** The analysis version produced for it (`analyses[n + 1]`). */
  analysisId: idSchema.optional(),

  /** The panel version produced for it, which supersedes its predecessor. */
  panelId: idSchema.optional(),
});

/**
 * One follow-up of a session.
 *
 * Inferred from {@link followUpRecordSchema}. Consumed by
 * `apps/local-service/src/pipeline/stages/followup.ts` (producer), the store,
 * and the VS Code `FollowUp` component.
 */
export type FollowUpRecord = z.infer<typeof followUpRecordSchema>;

/**
 * The outcome links of a {@link FollowUpRecord}: the members the follow-up
 * stage stamps once it has answered, as opposed to the four that describe the
 * ask (`question`, `askedAt`, `attemptId`, `attempt`).
 *
 * Frozen and `as const`; {@link FollowUpOutcomeKeysExhaustive} proves at
 * compile time that the tuple names every outcome member of the record, so a
 * link added to {@link followUpRecordSchema} without being listed here fails
 * `tsc -b` in this module rather than being ignored by
 * {@link isFollowUpAnswered}.
 */
export const FOLLOW_UP_OUTCOME_KEYS = Object.freeze([
  'needsNewCapture',
  'planVersion',
  'captureId',
  'analysisId',
  'panelId',
] as const satisfies readonly (keyof FollowUpRecord)[]);

/** One of {@link FOLLOW_UP_OUTCOME_KEYS}. */
export type FollowUpOutcomeKey = (typeof FOLLOW_UP_OUTCOME_KEYS)[number];

/**
 * Whether a recorded follow-up has been answered: it carries at least one
 * outcome link ({@link FOLLOW_UP_OUTCOME_KEYS}).
 *
 * Presence is checked, never truth: `needsNewCapture: false` is a decision,
 * and a decided follow-up is answered. An unanswered follow-up is one the
 * stage recorded and then did not finish — the only kind a Retry may resend
 * under its own `attemptId`. Reads no question text.
 *
 * @param followUp A follow-up from a session's ladder.
 * @returns `true` once any outcome link is present.
 *
 * @example
 * ```ts
 * isFollowUpAnswered({ question, askedAt, attemptId, attempt: 1 });        // → false
 * isFollowUpAnswered({ question, askedAt, needsNewCapture: false });       // → true
 * ```
 */
export function isFollowUpAnswered(followUp: FollowUpRecord): boolean {
  return FOLLOW_UP_OUTCOME_KEYS.some((key) => followUp[key] !== undefined);
}

/**
 * Compile-time proof that {@link FOLLOW_UP_OUTCOME_KEYS} and the ask members
 * together are exactly the keys of {@link FollowUpRecord}.
 *
 * Exported for the reason {@link SessionRecordEmbeddedShapesPreserved} is; it
 * has no runtime representation.
 *
 * @internal
 */
export type FollowUpOutcomeKeysExhaustive = AssertTrue<
  MutuallyAssignable<
    Exclude<keyof FollowUpRecord, 'question' | 'askedAt' | 'attemptId' | 'attempt'>,
    FollowUpOutcomeKey
  >
>;

/**
 * The session's cleanup state: whether the developer's working tree has been
 * returned to how it was, and what stood in the way (AAP §0.2.3, §0.5.1).
 *
 * The product's central promise is that instrumentation is temporary and
 * reversible, so this is the field a developer checks before closing the editor.
 * It is broadcast as `cleanup.completed` and returned by
 * `POST /sessions/:id/end`.
 */
export const sessionCleanupSchema = z.strictObject({
  /**
   * The verdict, over the four values of {@link CLEANUP_STATUSES}: `pending`
   * until cleanup runs, then `clean`, `partial` or `conflict`.
   */
  status: cleanupStatusSchema,

  /**
   * When cleanup finished. Absent while `status` is `pending`, which is the one
   * combination a consumer can rely on: a finished pass always stamps its time.
   */
  completedAt: epochMsSchema.optional(),

  /**
   * The modifications cleanup refused to overwrite, each naming the file, the
   * hash it expected, the hash it found and the backup the developer's original
   * is still in.
   *
   * **Required, and empty rather than absent** when there are none, so no user
   * interface has to branch on `undefined` before iterating — the case that
   * would otherwise be written `session.cleanup.conflicts?.length ?? 0` in three
   * surfaces and forgotten in a fourth.
   *
   * The element schema is the imported `modificationConflictSchema`, so the
   * owner's rules run unchanged: the hashes must be 64 lowercase hex characters,
   * the file must be project-relative, and the three-way diffs are bounded.
   */
  conflicts: z.array(modificationConflictSchema).max(MAX_CONFLICTS, {
    error: `expected at most ${String(MAX_CONFLICTS)} modification conflicts`,
  }),
});

/**
 * A session's cleanup state.
 *
 * Inferred from {@link sessionCleanupSchema}. Consumed by
 * `apps/local-service/src/cleanup/cleanup.ts` (producer),
 * `./messages/cleanup.ts`, `./http.ts`, the VS Code `ModificationsList` and the
 * DevTools `SessionSummary`.
 */
export type SessionCleanup = z.infer<typeof sessionCleanupSchema>;

/**
 * The stages that have a versioned prompt directory, spelled exactly as those
 * directories are: `apps/local-service/prompts/<stage>/vNNN.md` (AAP §0.7.1
 * Group 2).
 *
 * The hyphenated `generate-panel` is the directory name, the key in
 * `apps/local-service/prompts/manifest.json` and the stage name the prompt
 * loader looks up, so it is the spelling recorded here too — a camel-cased
 * variant would oblige every reader and writer to translate, and a translation
 * table is a place for the two halves to drift apart.
 *
 * The vocabulary is declared here rather than imported because
 * `@debuggen/model-provider`, which owns the loader's own stage tuple, is
 * **outside this package's edge list** (AAP §0.2.2) and sits beside protocol
 * rather than below it. Keeping the two lists equal is a review obligation, not
 * a compile-time one; what protocol owes its consumers is the recorded fact, in
 * the spelling the files on disk use.
 */
export const PROMPT_STAGE_KEYS = [
  'understand',
  'investigate',
  'plan',
  'analyze',
  'generate-panel',
  'followup',
] as const;

/** One of {@link PROMPT_STAGE_KEYS}: a stage with a versioned prompt directory. */
export type PromptStageKey = (typeof PROMPT_STAGE_KEYS)[number];

/**
 * The shape of a prompt file's version stem: `v` followed by exactly three
 * digits.
 *
 * `'v001'`, `'v042'` — never `'v1'`, `'1.0.0'` or `'latest'`. The fixed width is
 * what makes the files sort lexicographically in the order they were written.
 * Declared deliberately **without** the `g` flag: a global regular expression
 * carries a mutable `lastIndex` across calls, so a shared module-level instance
 * with `g` would answer `true`, then `false`, then `true` for the same input.
 *
 * **A committed prompt file is immutable** (AAP §0.5.3): a change is a new
 * `vNNN+1.md` plus a manifest update, never an edit. That is what makes a
 * version string a permanent identifier and what makes recording it on the
 * session worth doing — a stored analysis or panel can always be read back
 * against the exact instructions that produced it.
 */
export const PROMPT_VERSION_PATTERN = /^v\d{3}$/;

/**
 * Which prompt version each stage of the pipeline used, for the stages that have
 * run.
 *
 * A **partial** record over {@link PROMPT_STAGE_KEYS}, which is the honest shape:
 * a session that is still investigating has used two prompts, and a session that
 * failed at planning will never use the rest. Modelled as a partial record
 * rather than as a strict object with six optional keys for two reasons: the
 * keys stay in the prompt directories' own spelling (`generate-panel` is not a
 * valid identifier-style key), and the vocabulary is enforced *as a vocabulary* —
 * Zod refuses a key outside the six, exactly as a strict object would, so a typo
 * or an invented stage name is a rejection rather than a silently stored field.
 *
 * No version value is hardcoded anywhere in this module: the service records
 * what its manifest resolved (AAP §0.5.3).
 *
 * An empty object is valid and is what a freshly created session carries.
 */
export const promptVersionsSchema = z.partialRecord(
  z.enum(PROMPT_STAGE_KEYS),
  z.string().regex(PROMPT_VERSION_PATTERN, {
    error: 'expected a prompt version of the form vNNN, for example v001',
  }),
);

/**
 * The prompt versions a session used, keyed by stage.
 *
 * Inferred from {@link promptVersionsSchema}. Produced by
 * `apps/local-service/src/pipeline/orchestrator.ts` as each stage runs, stored
 * with the session and shown by the VS Code `StatusBar` alongside the provider.
 */
export type PromptVersions = z.infer<typeof promptVersionsSchema>;

/**
 * The model provider identifiers the product ships (AAP §0.3.4's
 * `DEBUGGEN_PROVIDER`).
 *
 * `anthropic` is the real provider; `deterministic` is the rules-based provider
 * that every automated test uses and that sends nothing off the machine
 * (AAP §0.5.3). The pair is closed on purpose: recording which of the two ran a
 * session is how a reader of a stored analysis knows whether a model was
 * involved at all, and a third value would make that question unanswerable
 * until someone added the provider it named.
 */
export const PROVIDER_IDS = ['anthropic', 'deterministic'] as const;

/** One of {@link PROVIDER_IDS}. */
export type ProviderId = (typeof PROVIDER_IDS)[number];

/**
 * Which model provider ran the session, and which model it was configured with.
 *
 * Provenance, not configuration: it records what *was* used so that a session
 * reopened weeks later can be read in light of it, and it is never a control a
 * consumer writes back.
 */
export const sessionProviderSchema = z.strictObject({
  /** The provider, over the closed pair {@link PROVIDER_IDS}. */
  id: z.enum(PROVIDER_IDS),

  /**
   * The model identifier the provider was configured with, where it has one.
   *
   * **Never a literal in this repository.** AAP §0.5.3 requires the model id to
   * come from `DEBUGGEN_MODEL`, so this field records whatever the service was
   * configured with and this schema only bounds its shape. Absent for the
   * deterministic provider, which has no model — and absent, legitimately, for a
   * run whose provider was configured without one.
   */
  model: z
    .string()
    .min(1, { error: 'expected a non-empty model identifier' })
    .max(MAX_MODEL_ID_LENGTH, {
      error: `expected a model identifier of at most ${String(MAX_MODEL_ID_LENGTH)} characters`,
    })
    .refine(isSingleLineText, {
      error: 'model must be a single-line identifier with at least one non-whitespace character',
    })
    .optional(),
});

/**
 * The provider provenance of a session.
 *
 * Inferred from {@link sessionProviderSchema}. Consumed by
 * `apps/local-service/src/config.ts` (producer of the value), the store, and the
 * VS Code `StatusBar`.
 */
export type SessionProvider = z.infer<typeof sessionProviderSchema>;

// ---------------------------------------------------------------------------
// Section E — SessionRecord
// ---------------------------------------------------------------------------

/**
 * The state of one debugging session: the single definition (AAP §0.2.3,
 * §0.9.1).
 *
 * Exactly the twenty-one fields AAP §0.2.3 specifies, in that order, and
 * `z.strictObject` so a twenty-second is a rejection rather than a silently
 * stored field. That strictness is the guard the module documentation describes:
 * an app that "just needs one more field on the session" must add it here, where
 * the other three processes see it, instead of writing a record only its own
 * half understands.
 *
 * Required versus optional follows one rule, so a consumer never has to guess:
 * a field is **required** when a session has it from the moment it is created (or
 * is a container that starts empty), and **optional** when it genuinely may not
 * exist yet. Hence `relevantFiles`, `plans`, `modifications`, `captures`,
 * `panelIds`, `analyses` and `followUps` are required and start as `[]`,
 * `cleanup` is required and starts as `{ status: 'pending', conflicts: [] }`, and
 * only `boundTab`, `target` and `understanding` are optional.
 *
 * @see {@link parseSessionRecord} for the non-throwing validator the store and
 * both clients use.
 */
export const sessionRecordSchema = z.strictObject({
  /**
   * The session's own id, minted by the service (`newSessionId()`).
   *
   * Shape only — non-empty, bounded, single-line. The `ses_` prefix grammar
   * belongs to `packages/shared/src/ids.ts` and is deliberately not re-derived
   * here, so a row written by a build with a different prefix still reads back.
   */
  id: idSchema,

  /**
   * The **absolute POSIX** path of the project this session debugs — the
   * developer's workspace folder.
   *
   * The deliberate opposite of every other path in this record: this one is the
   * containment boundary, and `relevantFiles[].file`, a modification's `file`
   * and a `SourceLocation.file` are all relative *to it*. Validated as absolute,
   * bounded, POSIX and control-character-free; the checks that matter — does it
   * exist, does a requested file resolve inside it, does the requesting
   * credential's scope cover it — belong to
   * `apps/local-service/src/source/open.ts`, the service's authorization layer
   * and `apps/vscode-extension/src/uri-handler.ts`, each of which resolves real
   * paths against this value (AAP §0.2.3, §0.5.6).
   */
  projectRoot: z
    .string()
    .min(1, { error: 'expected a non-empty absolute project root path' })
    .max(MAX_PATH_LENGTH, {
      error: `expected a project root path of at most ${String(MAX_PATH_LENGTH)} characters`,
    })
    .refine(isAbsolutePosixPath, {
      error:
        'projectRoot must be an absolute POSIX path: it begins with "/", carries no drive letter, UNC prefix, backslash or control character',
    }),

  /**
   * The project's display name — normally the workspace folder's basename.
   *
   * A label for the Sessions tree, the panel header and a status line; never a
   * path and never used to locate anything.
   */
  projectName: z
    .string()
    .min(1, { error: 'expected a non-empty project name' })
    .max(MAX_NAME_LENGTH, {
      error: `expected a project name of at most ${String(MAX_NAME_LENGTH)} characters`,
    })
    .refine(isSingleLineText, {
      error: 'projectName must be a single-line label with at least one non-whitespace character',
    }),

  /**
   * The project's dev-server URL, probed or launched when the session was
   * created (AAP §0.4.2).
   *
   * The tab binding matches on this URL's **origin**: a DevTools panel that
   * announces an inspected tab is bound to the session whose dev-server origin
   * the tab's URL shares, and a navigation to a different origin drops the
   * binding. The comparison is the service's, which is why this is a shape check
   * only (see {@link urlSchema}).
   */
  devServerUrl: urlSchema,

  /**
   * The Chrome tab currently bound to this session, when one is.
   *
   * Absent before DevTools is opened on the application, and again after the tab
   * closes or navigates away from the dev server's origin — both ordinary
   * states, which is why this is an absent key rather than a sentinel.
   */
  boundTab: boundTabSchema.optional(),

  /** When the session was created, in Unix epoch milliseconds. */
  createdAt: epochMsSchema,

  /**
   * When the record last changed, in Unix epoch milliseconds.
   *
   * Every update stamps it, which is what lets the Sessions tree sort by
   * recency and a client tell a replayed `session.updated` from a new one.
   * {@link touchSessionRecord} is the sanctioned way to bump it without
   * mutating.
   */
  updatedAt: epochMsSchema,

  /**
   * Where the session is in the pipeline, over the eleven values of
   * {@link SESSION_STATUSES}.
   *
   * The vocabulary is here; the transition table is the service's
   * (`apps/local-service/src/sessions/state-machine.ts`). Both user interfaces
   * render this field directly, and `failed` is rendered with the failing stage
   * rather than as an absent result (AAP §0.5.5).
   */
  status: sessionStatusSchema,

  /**
   * The developer's original question, as typed.
   *
   * Plain text: nothing in this package inspects it, matches against it or
   * switches on it, and no code path anywhere in the product may branch on its
   * content (AAP §0.5.4, enforced by `scripts/check-no-hardcoding.mjs`). The
   * pipeline's first stage tokenizes it generically; that is the only code that
   * reads it at all.
   */
  question: questionSchema,

  /**
   * The follow-up questions asked after the first answer, oldest first.
   *
   * Required and empty on a new session. Bounded by {@link MAX_FOLLOW_UPS}.
   */
  followUps: z.array(followUpRecordSchema).max(MAX_FOLLOW_UPS, {
    error: `expected at most ${String(MAX_FOLLOW_UPS)} follow-ups`,
  }),

  /**
   * The element the developer selected, when the question was about something on
   * the screen.
   *
   * The imported `selectedTargetSchema` — the single definition of that
   * descriptor (`{ selector, tagName, text?, componentChain[], url }`), whose own
   * rules therefore apply unchanged, including the cap on the component chain and
   * the absolute-URL rule. Absent when no element was selected, in which case
   * problem understanding reads the bound tab's current URL instead: a target is
   * an input to the first stage, never a precondition for it (AAP §0.4.2).
   */
  target: selectedTargetSchema.optional(),

  /**
   * What the problem-understanding stage concluded the question is about.
   *
   * The imported `problemUnderstandingSchema` —
   * `{ category, signalsNeeded[], entities[], searchHints[] }` — validated by the
   * stage before it is stored (AAP §0.4.2). Absent until that stage has run, and
   * absent on a session that failed before it.
   */
  understanding: problemUnderstandingSchema.optional(),

  /**
   * The files the code-investigation stage judged relevant, most relevant first.
   *
   * Required and empty until the stage has run. Bounded by
   * {@link MAX_RELEVANT_FILES}; see {@link relevantFileSchema} for why this one
   * shape is defined in this package rather than imported.
   */
  relevantFiles: z.array(relevantFileSchema).max(MAX_RELEVANT_FILES, {
    error: `expected at most ${String(MAX_RELEVANT_FILES)} relevant files`,
  }),

  /**
   * The instrumentation plans, one per plan version, ordered by `planVersion`.
   *
   * The imported **normalized** `instrumentationPlanSchema`, never the authoring
   * schema: what a session stores is the plan after deterministic normalisation
   * has assigned each action its `adapter`, `mode` and `rationale` and stamped
   * the plan's `version`, `planVersion` and `sessionId` (AAP §0.2.3). A model's
   * `InstrumentationPlanInput` is a stage input and never reaches this record.
   *
   * A follow-up that needs new instrumentation appends version *n + 1* = the
   * previous plan **plus** the additive actions, never the previous plan with
   * actions removed, and the installer applies only the delta (AAP §0.4.2). So
   * this list is an append-only history, index order matching version order, and
   * the last element is the plan currently installed. Bounded by
   * {@link MAX_PLANS}.
   */
  plans: z.array(instrumentationPlanSchema).max(MAX_PLANS, {
    error: `expected at most ${String(MAX_PLANS)} plan versions`,
  }),

  /**
   * The journal of every file modification this session made, in the order they
   * were applied.
   *
   * The imported `modificationRecordSchema`, so each entry carries the original
   * and instrumented SHA-256 hashes, the backup path, the unified diff, its
   * status (`pending` | `applied` | `reverted` | `conflict` | `failed`) and, on a
   * follow-up chain, the `previousRecordId` cleanup restores in strict reverse
   * order.
   *
   * This is the list the product's reversibility promise is made of, and the list
   * both user interfaces render: VS Code's `ModificationsList` with its
   * `DiffView`, and the DevTools `SessionSummary`. Bounded by
   * {@link MAX_MODIFICATIONS} — the highest array bound here, because a dropped
   * record is a file left instrumented with nothing to restore it from.
   */
  modifications: z.array(modificationRecordSchema).max(MAX_MODIFICATIONS, {
    error: `expected at most ${String(MAX_MODIFICATIONS)} modification records`,
  }),

  /**
   * The capture windows, oldest first, including one in flight.
   *
   * Required and empty until the first capture starts. Bounded by
   * {@link MAX_CAPTURES}.
   */
  captures: z.array(captureRecordSchema).max(MAX_CAPTURES, {
    error: `expected at most ${String(MAX_CAPTURES)} captures`,
  }),

  /**
   * The ids of the panels generated for this session, oldest first — **ids, not
   * specifications**.
   *
   * A panel is fetched with `GET /sessions/:id/panels/:panelId` and arrives on
   * `panel.generated` (AAP §0.4.2). Embedding `PanelSpec[]` here would duplicate
   * the `panels` table and make every `session.updated` frame carry every panel
   * the session ever produced. Bounded by {@link MAX_PANEL_IDS}.
   */
  panelIds: z.array(idSchema).max(MAX_PANEL_IDS, {
    error: `expected at most ${String(MAX_PANEL_IDS)} panel ids`,
  }),

  /**
   * The analyses produced for this session, oldest first — whole artifacts
   * rather than ids.
   *
   * The imported `analysisResultSchema` from `./analysis.js`, so every `Fact` in
   * every stored analysis carries at least one `EventRef` by construction: an
   * unevidenced observation cannot exist in this record (AAP §0.8.4). Full
   * artifacts rather than ids because a reopened session renders the latest
   * analysis immediately, without a second request, and because each one is
   * itself bounded upstream (at most twenty facts, ten hypotheses).
   *
   * A follow-up answered from the stored capture appends version *n + 1*, whose
   * `supersedes` names its predecessor (AAP §0.4.2). Bounded by
   * {@link MAX_ANALYSES}.
   */
  analyses: z.array(analysisResultSchema).max(MAX_ANALYSES, {
    error: `expected at most ${String(MAX_ANALYSES)} analyses`,
  }),

  /**
   * Whether the working tree has been returned to how it was, and what stood in
   * the way.
   *
   * **Required.** A session always has a cleanup state — `pending` until cleanup
   * runs — so no consumer has to distinguish "no cleanup information" from "not
   * cleaned up yet" (see {@link sessionCleanupSchema}).
   */
  cleanup: sessionCleanupSchema,

  /**
   * Which prompt version each stage used (see {@link promptVersionsSchema}).
   *
   * Required, and `{}` on a session whose first stage has not run.
   */
  promptVersions: promptVersionsSchema,

  /**
   * Which model provider ran the session (see {@link sessionProviderSchema}).
   *
   * Required: a session always ran under one, and `deterministic` is a real
   * answer rather than the absence of one.
   */
  provider: sessionProviderSchema,
});

/**
 * The state of one debugging session.
 *
 * Inferred from {@link sessionRecordSchema}, so the validator and the type are
 * one statement and cannot drift. Its members are the upstream types by
 * construction — `plans` is `InstrumentationPlan[]`, `modifications` is
 * `ModificationRecord[]`, `target` is a `SelectedTarget`, `understanding` is a
 * `ProblemUnderstanding`, `analyses` is `AnalysisResult[]`, and a capture's
 * `summary` is a `CaptureSummary` — which is what lets the service pass a parsed
 * record straight into the code that already speaks those types, with no adapter
 * and no cast. {@link SessionRecordEmbeddedShapesPreserved} proves it at compile
 * time.
 *
 * Consumed by `./messages/session.ts` (the `session.created` and
 * `session.updated` payloads, `{ session: SessionRecord }`), `./http.ts` (the
 * `POST /sessions` response body and the `GET /sessions`, `GET /sessions/:id`
 * responses), `apps/local-service/src/store/sessions-repo.ts`,
 * `apps/local-service/src/sessions/{manager,state-machine,reopen}.ts`,
 * `apps/vscode-extension/src/views/sessions-tree.ts` and
 * `apps/chrome-extension/src/panel/state/session-store.ts`.
 */
export type SessionRecord = z.infer<typeof sessionRecordSchema>;

// ---------------------------------------------------------------------------
// Section F — the parse helper and the one pure transform
// ---------------------------------------------------------------------------

/**
 * The hint attached to a rejected session record.
 *
 * A constant sentence about the **schema**, never about the value that failed
 * it: `DebuggenError.toPayload()` carries `hint` verbatim across the wire and
 * into a persisted session row, and this record's rejected fields are among the
 * most sensitive values the protocol touches (AAP §0.5.2).
 */
const SESSION_RECORD_HINT =
  'A session record carries exactly the twenty-one fields of the session contract: id, projectRoot (absolute POSIX), projectName, devServerUrl, boundTab?, createdAt, updatedAt, status, question, followUps, target?, understanding?, relevantFiles, plans, modifications, captures, panelIds, analyses, cleanup, promptVersions and provider.';

/**
 * Validates an unknown value as a {@link SessionRecord}, without throwing.
 *
 * Applied at all three boundaries the record crosses:
 *
 * - **the store**, where `apps/local-service/src/store/sessions-repo.ts` parses
 *   the `sessions.record` JSON column after reading it back. This is the reason
 *   the helper is non-throwing: a row written by an older build, or one a crash
 *   left half-written, surfaces as an `Err` the repository can log and skip
 *   rather than as an exception that takes the service down while it lists
 *   sessions;
 * - **the wire**, where a client parses the `session.created` / `session.updated`
 *   payload's `session` before rendering it;
 * - **HTTP**, where a client parses a session-route response body.
 *
 * The failure is a `DebuggenError` with code `'PROTOCOL_INVALID_MESSAGE'` — the
 * package's transport-level code — built by `protocolParseError`, whose message
 * and `details` name field paths and issue codes and **never a rejected value**.
 * A caller that would rather report a store-specific code maps the error at its
 * own boundary (`mapErr` from `@debuggen/shared`); the one code here keeps every
 * rejection of this shape identical wherever it happens.
 *
 * @param value Any value believed to be a session record — a parsed JSON column,
 * a frame's payload field, a response body.
 * @returns `ok(record)` with the validated record, whose members are the
 * upstream types, or `err(error)` describing the shape of every issue found.
 *
 * @example
 * ```ts
 * const parsed = parseSessionRecord(JSON.parse(row.record));
 * if (!parsed.ok) {
 *   logger.warn('unreadable session row', { id: row.id, reason: parsed.error.message });
 *   return undefined;
 * }
 * return parsed.value;
 * ```
 */
export function parseSessionRecord(value: unknown): Result<SessionRecord, DebuggenError> {
  const parsed = sessionRecordSchema.safeParse(value);

  if (parsed.success) {
    return ok(parsed.data);
  }

  return err(
    protocolParseError(
      'PROTOCOL_INVALID_MESSAGE',
      'Invalid session record',
      parsed.error.issues,
      SESSION_RECORD_HINT,
    ),
  );
}

/**
 * Returns a copy of `record` with a new `updatedAt`, leaving the original
 * untouched.
 *
 * The one transform this module offers, and deliberately the only one. Every
 * update to a session stamps `updatedAt` — it is what orders the Sessions tree
 * and what tells a client a replayed `session.updated` from a new one — and a
 * helper that does it in one place keeps the service from spreading
 * `{ ...session, updatedAt: nowEpochMs() }` across its manager, its repositories
 * and its pipeline stages.
 *
 * A **shallow** copy, which is exactly right here: nothing about this record is
 * mutated in place, so the arrays and sub-records are shared rather than copied,
 * and the result is still safe to persist and broadcast. What the helper
 * deliberately does **not** do is touch `status`, append to a list or validate:
 * the state machine lives in `apps/local-service/src/sessions/state-machine.ts`
 * and a status-mutating helper here would be that machine, split in two. The
 * caller supplies the timestamp — `nowEpochMs()` from `@debuggen/shared` in
 * production, a fixed number in a test — so the function stays pure and reads no
 * clock.
 *
 * @param record The record to stamp. Not modified.
 * @param updatedAt The new timestamp, in Unix epoch milliseconds.
 * @returns A new record identical to `record` except for `updatedAt`.
 *
 * @example
 * ```ts
 * const stamped = touchSessionRecord(session, nowEpochMs());
 * await repo.save(stamped);
 * broadcast({ type: 'session.updated', payload: { session: stamped } });
 * ```
 */
export function touchSessionRecord(record: SessionRecord, updatedAt: number): SessionRecord {
  return { ...record, updatedAt };
}

// ---------------------------------------------------------------------------
// Section G — compile-time proof that the embedded shapes are the imported ones
// ---------------------------------------------------------------------------

/**
 * Whether two types are assignable in both directions.
 *
 * Module-local, like its counterparts in `./analysis.ts` and
 * `./messages/{capture,panel}.ts`: a three-line type helper is not a contract
 * worth exporting, and the package barrel re-exports every public name in this
 * folder.
 *
 * Each side is wrapped in a tuple so a union distributes as one type rather than
 * member by member.
 */
type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/** Fails to instantiate unless its argument is exactly `true`. */
type AssertTrue<T extends true> = T;

/**
 * The conjunction of every upstream edge this record embeds.
 *
 * Written as nested conditionals rather than as an intersection so that the
 * first broken edge is the one `tsc` reports.
 */
type EmbeddedShapesHold =
  MutuallyAssignable<SessionRecord['plans'][number], InstrumentationPlan> extends true
    ? MutuallyAssignable<SessionRecord['modifications'][number], ModificationRecord> extends true
      ? MutuallyAssignable<SessionCleanup['conflicts'][number], ModificationConflict> extends true
        ? MutuallyAssignable<SessionRecord['analyses'][number], AnalysisResult> extends true
          ? MutuallyAssignable<NonNullable<SessionRecord['target']>, SelectedTarget> extends true
            ? MutuallyAssignable<
                NonNullable<SessionRecord['understanding']>,
                ProblemUnderstanding
              > extends true
              ? MutuallyAssignable<NonNullable<CaptureRecord['summary']>, CaptureSummary>
              : false
            : false
          : false
        : false
      : false
    : false;

/**
 * Compile-time proof that every cross-boundary shape in a {@link SessionRecord}
 * is the **imported** one rather than a local copy (AAP §0.2.3, §0.9.1).
 *
 * The risk this guards against is invisible by inspection: a hand-written
 * `{ file: string; symbol: string; … }` in place of `modificationRecordSchema`
 * would compile, would type-check at every call site and would differ only in
 * what it refuses — accepting a hash that is not 64 hex characters, a plan
 * action with no `adapter`, an analysis whose fact cites nothing. The runtime
 * half of the same guarantee is asserted in `src/__tests__/messages.test.ts`,
 * which feeds each of those malformed values in and requires a rejection.
 *
 * Seven edges are checked: the plan, modification-record, modification-conflict,
 * selected-target and problem-understanding shapes of
 * `@debuggen/instrumentation`, the analysis result of `./analysis.js`, and the
 * `CaptureSummary` type of `@debuggen/telemetry` — the last of which is the one
 * that could quietly become `unknown`, since it is embedded through
 * `opaqueSchema` rather than through a schema of its own.
 *
 * It resolves to `true`, and it is the assertion rather than the value that
 * matters: any edit that breaks an edge instantiates {@link AssertTrue} with
 * `false` and fails `tsc -b` here, in the module that made the mistake.
 *
 * Exported because a type alias nothing references is a compile error under this
 * repository's `noUnusedLocals`, and because a reader of the emitted
 * declarations can then see the guarantee stated. It has no runtime
 * representation; there is nothing to consume.
 *
 * @internal
 */
export type SessionRecordEmbeddedShapesPreserved = AssertTrue<EmbeddedShapesHold>;

/**
 * The conjunction of the four identifier edges this record owes its consumers.
 *
 * `SessionId`, `CaptureId`, `PanelId` and `AnalysisId` are **unbranded string
 * aliases** in `@debuggen/shared` (`packages/shared/src/ids.ts`), which is what
 * lets one bounded string schema here serve all four — see {@link idSchema} for
 * why the `ses_`/`cap_`/`pan_`/`ana_` prefix grammar is deliberately not
 * re-derived at a transport boundary.
 */
type IdAliasesHold =
  MutuallyAssignable<SessionRecord['id'], SessionId> extends true
    ? MutuallyAssignable<CaptureRecord['id'], CaptureId> extends true
      ? MutuallyAssignable<SessionRecord['panelIds'][number], PanelId> extends true
        ? MutuallyAssignable<NonNullable<FollowUpRecord['analysisId']>, AnalysisId>
        : false
      : false
    : false;

/**
 * Compile-time proof that the identifier fields of this record can be handed
 * straight to code that speaks `@debuggen/shared`'s id aliases.
 *
 * The practical guarantee: `repo.loadCapture(session.captures[0].id)` typed
 * `(id: CaptureId)`, `fetchPanel(session.panelIds.at(-1))` typed
 * `(id: PanelId)` and the analysis lookup a follow-up record points at all
 * compile without a cast, and would stop compiling here if a future edit
 * branded one of those aliases or narrowed a field away from `string` — which
 * is the edit that would otherwise be discovered in four consumer workspaces at
 * once.
 *
 * Exported for the reason {@link SessionRecordEmbeddedShapesPreserved} is: a
 * type alias nothing references is a compile error under `noUnusedLocals`, and
 * the emitted declarations then state the guarantee. It has no runtime
 * representation.
 *
 * @internal
 */
export type SessionRecordIdAliasesPreserved = AssertTrue<IdAliasesHold>;
