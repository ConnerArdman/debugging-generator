/**
 * `SelectedTarget` and `ProblemUnderstanding` — the descriptor of the element a
 * developer selected, and the validated output of the pipeline's
 * problem-understanding stage. Both are defined here, once.
 *
 * AAP §0.9.1 lists `packages/instrumentation/src/schema/**` among the schema
 * sources that have a **single** definition, and these two shapes have readers
 * in three of the four cooperating processes:
 *
 * - `@debuggen/protocol` embeds {@link SelectedTarget} in the `target.selected`
 *   payload — `{ sessionId, target }` (AAP §0.4.2) — and embeds both shapes in
 *   its `SessionRecord`, which carries `target?` and `understanding?`
 *   (AAP §0.2.3).
 * - `apps/local-service` produces the understanding in
 *   `src/pipeline/stages/understand.ts` from the question, the selected target,
 *   the current URL (the bound tab's, when no element is selected) and the
 *   project summary, then consumes it in `stages/investigate.ts` and
 *   `stages/plan.ts`.
 * - the DevTools panel sends the descriptor after reading `$0`, and replays its
 *   `selector` to re-highlight the element in picker mode.
 *
 * ## Why these two live in *this* package
 *
 * Neither is an instrumentation artifact, so the choice deserves stating.
 * `@debuggen/protocol` sits **above** this package in the layering of AAP
 * §0.2.2 — its messages embed plans, actions, modification records and these
 * two shapes — so defining them there would put the definition above one of its
 * own producers and force an upward import. `@debuggen/model-provider`
 * deliberately owns no stage-artifact schema at all: the provider boundary
 * stays free of product types so nothing can be sent to a model implicitly
 * (AAP §0.5.3). That leaves this package, which is already where the *other*
 * side of the understanding lives: {@link ProblemUnderstanding} is the second
 * argument of `InstrumentationAdapter.createPlan(context, understanding)` in
 * `../adapter.ts`, and its `signalsNeeded` is spelled in the capture-signal
 * vocabulary of `./readiness.js`.
 *
 * Protocol and the service therefore **import** these; a second declaration of
 * either shape anywhere in the monorepo is a defect.
 *
 * ## `SelectedTarget` is a wire shape fixed by a producer that cannot import it
 *
 * `packages/telemetry/src/browser/dom-target.ts` builds the object
 * structurally, inside the developer's page, as `TargetDescriptor`: exactly
 * `selector`, `tagName`, optional `text`, `componentChain` and `url`, and
 * nothing else. That module cannot import this one — it is bundled into the
 * IIFE the Chrome extension injects at `document_start`, and its build refuses
 * a cross-package runtime dependency — so a field added or renamed here is a
 * field that will never arrive. The bounds below are consequently written from
 * what that producer can emit, generously, so that **no descriptor it produces
 * is ever rejected**; `./target.test.ts` is where the two halves meet.
 *
 * The descriptor also travels through `chrome.devtools.inspectedWindow.eval`
 * and a `window.postMessage` structured clone, which is why every shape here is
 * JSON-only: strings, arrays of strings and plain objects, with an absent
 * optional key rather than an explicit `undefined`.
 *
 * ## Privacy (AAP §0.5.2)
 *
 * This module adds **no** redaction of its own, and that is deliberate: both
 * values arrive already handled by the layer that owns the rule, and a second
 * redaction point would be a second thing to keep correct.
 *
 * - `text` is whitespace-collapsed, scrubbed of credential material and
 *   truncated by the producer, through `packages/telemetry/src/redaction/`.
 * - `url` reaches the service unredacted (the service needs the raw query to
 *   redact it and to map the URL onto a route) and is query-redacted before it
 *   is stored, displayed or sent anywhere — so the validator below must accept
 *   a URL whose parameter values have been replaced per key.
 * - a validation failure reports the *shape* of the problem — field paths, the
 *   issue kind, the rule that was broken — and never the value that caused it.
 *   An error raised this deep passes through neither the redaction layer nor
 *   the outbound model guard, and it is logged, persisted with the session and
 *   rendered in two user interfaces.
 *
 * ## Vocabulary (AAP §0.5.4)
 *
 * The category and entity vocabularies are closed and **generic**: not one
 * member names anything from a specific application or framework. They are
 * embedded in a versioned prompt file and scanned by
 * `scripts/check-no-hardcoding.mjs`, and nothing in this module branches on the
 * text of a developer's question.
 *
 * ## Shape rules
 *
 * No `.transform()`, no `.default()`, no `z.coerce`: the value that comes out
 * is the value that went in, so a repair re-prompt can quote the field it is
 * complaining about and a stored artifact round-trips through JSON unchanged.
 * The stage prompts embed these schemas as JSON Schema through the **caller's**
 * `z.toJSONSchema` call — this module renders nothing and reads no prompt file.
 * It imports no Node builtin, touches no filesystem, reads no environment
 * variable and has no module-load side effect beyond declaring its constants.
 *
 * @module packages/instrumentation/src/schema/target
 */

import { z } from 'zod';

import {
  DebuggenError,
  err,
  isSafeRelativePath,
  normalizePosix,
  ok,
  toPosix,
} from '@debuggen/shared';
import type { Result } from '@debuggen/shared';

import { CAPTURE_SIGNALS, captureSignalSchema } from './readiness.js';

// ---------------------------------------------------------------------------
// Bounds
//
// Every string and array below is bounded, and each bound answers one of two
// different questions.
//
// For `SelectedTarget` the question is "what can the producer emit?", and the
// answer is always *more* than it does today: the bound exists to refuse a
// runaway or hostile payload from a page this product does not control, never
// to second-guess `dom-target.ts`. Each constant records the producer's own cap
// beside it, so the headroom is visible rather than implied.
//
// For `ProblemUnderstanding` the question is "how much can one stage output
// spend?", and the producer is a language model, whose output length is not
// something this product gets to assume. The bounds keep a single artifact from
// flooding the investigation stage that consumes it, the session record that
// stores it and the two user interfaces that render it.
// ---------------------------------------------------------------------------

/**
 * Longest accepted CSS selector, in characters.
 *
 * `dom-target.ts`'s `buildSelector()` builds at most six path segments of a tag
 * name, up to two legible class names and an `:nth-of-type` index, or a single
 * `#id` shortcut — comfortably inside this — but a page controls its own class
 * and id names, so the value is bounded rather than trusted.
 */
const MAX_SELECTOR_LENGTH = 1024;

/**
 * Longest accepted tag name, in characters.
 *
 * Generous for a reason: alongside the HTML element names this is nearly always
 * spelled with, a custom element's name is whatever its author registered.
 */
const MAX_TAG_NAME_LENGTH = 64;

/**
 * Longest accepted element text, in characters.
 *
 * Deliberately well above the producer's truncation: `dom-target.ts` caps the
 * collapsed text at 80 characters and the redaction primitives bound a preview
 * at 120 (AAP §0.5.2), so 256 leaves headroom for either of those to grow
 * without this schema starting to reject a perfectly ordinary descriptor. It is
 * still a label rather than a document — the whole point of the producer's cap
 * is that a panel row shows what was clicked and never a copy of the page.
 */
const MAX_TEXT_LENGTH = 256;

/**
 * Longest accepted component display name, in characters.
 *
 * Twice the producer's per-name cap of 64, which it applies after resolving a
 * display name through the fiber walk.
 */
const MAX_COMPONENT_NAME_LENGTH = 128;

/**
 * Most component names one chain may carry.
 *
 * Twice the producer's cap of eight. The headroom is not hypothetical: the cap
 * is applied nearest-first, so raising it upstream would add *outer* shell
 * components, and a schema that refused them would reject a richer descriptor
 * rather than merely ignore the extra entries.
 */
const MAX_COMPONENT_CHAIN = 16;

/**
 * Longest accepted document URL, in characters.
 *
 * Two kilobytes is the long-standing practical ceiling for a URL a browser will
 * navigate to, and a query-redacted URL is never longer than the original.
 */
const MAX_URL_LENGTH = 2048;

/** Longest accepted entity name, in characters. Mirrors `./plan.ts`'s symbol bound. */
const MAX_ENTITY_NAME_LENGTH = 200;

/** Longest accepted project-relative file path, in characters. Mirrors `./plan.ts`. */
const MAX_FILE_LENGTH = 1024;

/**
 * Most entities one understanding may name.
 *
 * Stage 2 turns each entity into read-only code-graph queries, so this is also
 * a bound on the work one stage output can ask the next one to do. Two dozen is
 * far more than a question about one interaction points at.
 */
const MAX_ENTITIES = 24;

/** Longest accepted search hint, in characters. */
const MAX_SEARCH_HINT_LENGTH = 120;

/** Most search hints one understanding may carry. Matched to {@link MAX_ENTITIES}. */
const MAX_SEARCH_HINTS = 24;

/**
 * How many validation issues an error carries at most.
 *
 * A rejected understanding can produce an issue for every field of every
 * entity, and the resulting error is logged, persisted and shown; the first
 * twenty identify the problem, and the total count is reported separately so a
 * truncated list never looks complete.
 */
const MAX_REPORTED_ISSUES = 20;

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

/** Highest code point of the C0 control block, `NUL` included. */
const C0_CONTROL_MAX = 0x1f;

/** Lowest code point of the `DEL`/C1 control block. */
const C1_CONTROL_MIN = 0x7f;

/** Highest code point of the C1 control block. */
const C1_CONTROL_MAX = 0x9f;

/**
 * Whether a string contains a C0 control character, `DEL` or a C1 control
 * character.
 *
 * Written as a character-code scan rather than a regular expression for the
 * same reason `./modification.ts` writes it that way: a literal control range
 * in a regular expression trips ESLint's `no-control-regex`, and the intent
 * reads better as a predicate.
 *
 * Load-bearing in three places here. A `NUL` truncates a string at the C
 * boundary of any later filesystem call, so the path acted on is not the path
 * that was validated. An `ESC` begins a terminal escape sequence, and every one
 * of these values is rendered as text in a panel row, a VS Code view and a log
 * line. And a line feed inside a `url` survives the URL parser — which strips
 * tabs and newlines while parsing but hands back the original string — so
 * without this scan a selected target could carry a two-line "URL".
 *
 * @param value The string to scan.
 * @returns `true` when at least one control character is present.
 */
function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);

    if (code <= C0_CONTROL_MAX || (code >= C1_CONTROL_MIN && code <= C1_CONTROL_MAX)) {
      return true;
    }
  }

  return false;
}

/**
 * Whether `value` is usable as a single line of display text: at least one
 * non-whitespace character, and no control character at all.
 *
 * Applied to every string in this module. Blank rejection keeps an empty chip
 * out of a panel row and an empty badge out of the VS Code target view, and it
 * refuses the values that are guaranteed downstream failures reported far from
 * their cause — a blank selector matches nothing, a blank entity name resolves
 * to nothing in the code graph, a blank search hint matches everything.
 */
function isSingleLineText(value: string): boolean {
  return value.trim().length > 0 && !hasControlCharacter(value);
}

/**
 * Lexically normalise an authored path: separators converted, `'.'` segments
 * and duplicate separators dropped, interior `'..'` resolved.
 *
 * "Lexically" is the whole contract — no filesystem is touched and no current
 * directory is consulted — so this is safe to run on a value that has not been
 * validated yet. It deliberately does not *repair* an unsafe path: a leading
 * `'..'` survives (there is no base to resolve it against) and an absolute path
 * stays absolute, which is what lets {@link isSafeRelativePath} refuse both
 * afterwards.
 *
 * Spelled exactly as `./plan.ts` spells it, because the two schemas accept
 * paths from the same producer and must not disagree about which ones are
 * tolerable.
 */
function lexicallyNormalizePath(value: string): string {
  return normalizePosix(toPosix(value));
}

/**
 * Whether an *authored* path can be accepted: lenient about form, strict about
 * safety.
 *
 * The value is normalised lexically first, so the cosmetic output a model
 * routinely produces — a `'./'` prefix it copied from an import specifier, a
 * backslash-flavoured separator — is tolerated rather than failing a whole
 * stage over punctuation. The result must then satisfy
 * {@link isSafeRelativePath}, which refuses an absolute POSIX path, a
 * drive-letter or UNC path, any surviving `'..'` segment, a control character
 * and a blank string.
 *
 * Being tolerant here and strict there is the point of having a repair loop at
 * all: a path this predicate rejects is one no amount of normalisation could
 * make safe, so the model is told while there is still a chance to fix it.
 */
function isAuthoredProjectRelativePath(value: string): boolean {
  return isSafeRelativePath(lexicallyNormalizePath(value));
}

/**
 * Whether `value` is an absolute `http:` or `https:` URL with a host.
 *
 * **Why the URL constructor and not `z.url()`.** zod 4.6.5's URL format check
 * does not merely validate: its implementation ends with
 * `payload.value = def.normalize ? url.href : stripTabAndNewline(trimmed)`, so
 * a parsed value comes back *trimmed and with ASCII tabs and line breaks
 * removed*. That is a transform, and it costs this module both of its
 * guarantees. Byte-faithfulness would go first — a descriptor would no longer
 * equal what the producer sent, so a stored target could not round-trip and a
 * repair prompt could not quote the field as written. Worse, the control
 * characters {@link hasControlCharacter} exists to refuse would be silently
 * removed *before* that refinement ran, turning a rejection into a quiet
 * rewrite of a developer's URL. Parsing here and keeping the original string
 * gives the same validation with neither effect.
 *
 * The three rules are the ones every consumer depends on: parseable at all (so
 * a route lookup and an origin comparison cannot throw), a scheme a browser
 * navigates with (which refuses `javascript:`, `data:`, `file:` and a bare
 * host), and a non-empty host (which is what a session binds an origin to).
 *
 * A query-redacted URL (AAP §0.5.2) satisfies all three: replacing parameter
 * *values* leaves the scheme, host, path and keys intact.
 *
 * @param value The candidate URL, exactly as it arrived.
 * @returns `true` only when the value is an absolute http(s) URL with a host.
 */
function isAbsoluteHttpUrl(value: string): boolean {
  let parsed: URL;

  try {
    parsed = new URL(value);
  } catch {
    // A malformed URL is a validation outcome, not an exception: the caller
    // gets a field-level rejection like any other.
    return false;
  }

  return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.hostname !== '';
}

// ---------------------------------------------------------------------------
// Validation failures
// ---------------------------------------------------------------------------

/** One reported issue: where the problem is, which rule it broke, and how. */
interface ReportedIssue {
  /** Dotted property path, or `'(root)'` for an issue on the value itself. */
  readonly path: string;
  /** The machine-readable issue kind, for example `'too_big'` or `'custom'`. */
  readonly code: string;
  /** The statement of the rule that was broken. */
  readonly message: string;
}

/**
 * Turns a rejection into an error message and diagnostic details that carry the
 * *shape* of the failure and never the data that caused it.
 *
 * **Privacy, not brevity** (AAP §0.5.2). What goes in is the field path, the
 * issue kind and the statement of the rule — everything a producer needs in
 * order to be fixed, and nothing the rejected value could leak. Zod's own
 * messages pass that test everywhere but one: an `unrecognized_keys` message
 * quotes the offending key. A key is shape rather than data, so `./plan.ts`
 * reports it as written; here it is **substituted** for a sentence enumerating
 * the permitted keys, because these two shapes come from a page this product
 * does not control and from a model, and a rule that holds absolutely is worth
 * more than an echo the reader can derive from the enumeration anyway.
 *
 * @param error The error from a failed `safeParse`.
 * @param unrecognizedKeyRule Given the issue's property path, the sentence to
 * report in place of an `unrecognized_keys` message. A path rather than a fixed
 * string because a nested object has its own key set: an unrecognised key
 * inside an entity must be answered with the entity's keys, not its parent's.
 * @returns A `summary` of `path (code)` pairs for the error message, the first
 * {@link MAX_REPORTED_ISSUES} issues in full, and the total count so a
 * truncated list never looks complete.
 */
function summarizeIssues(
  error: z.ZodError,
  unrecognizedKeyRule: (path: readonly PropertyKey[]) => string,
): {
  readonly summary: string;
  readonly issues: readonly ReportedIssue[];
  readonly issueCount: number;
} {
  const reported: ReportedIssue[] = error.issues.slice(0, MAX_REPORTED_ISSUES).map((issue) => ({
    // `issue.path` segments may be array indices as well as keys, so each is
    // stringified before joining.
    path: issue.path.length > 0 ? issue.path.map((segment) => String(segment)).join('.') : '(root)',
    code: issue.code,
    message: issue.code === 'unrecognized_keys' ? unrecognizedKeyRule(issue.path) : issue.message,
  }));

  const summary = reported.map((issue) => `${issue.path} (${issue.code})`).join(', ');
  const hidden = error.issues.length - reported.length;

  return {
    summary: hidden > 0 ? `${summary}, and ${String(hidden)} more` : summary,
    issues: reported,
    issueCount: error.issues.length,
  };
}

/**
 * Builds the error a schema rejection in this module is reported as.
 *
 * One function so that both rejections have the same anatomy: a code from the
 * closed vocabulary of `@debuggen/shared`, a sentence naming what failed and
 * the offending field paths, a hint saying what to do about it, and
 * `details.issues` for a log.
 *
 * @param code The failure being reported. Only the two codes these shapes can
 * legitimately fail under are accepted, so a caller cannot report a rejection
 * as something a user interface would render with the wrong recovery path:
 * `'PROTOCOL_INVALID_MESSAGE'` for a descriptor that arrived over a transport,
 * `'MODEL_OUTPUT_INVALID'` for a stage artifact a model produced. A caller
 * validating a value no transport delivered — a row read back from the session
 * store, an artifact constructed in process — should `mapErr` it to the code
 * that describes *its* operation (`'STORE_ERROR'`, `'INTERNAL'`); the field
 * paths are the part that matters either way.
 * @param subject What failed, as a sentence fragment that reads after "did not
 * match".
 * @param hint The producer's, or the developer's, next step.
 * @param error The error from a failed `safeParse`.
 * @param unrecognizedKeyRule The permitted-key resolver for
 * {@link summarizeIssues}.
 */
function rejection(
  code: 'PROTOCOL_INVALID_MESSAGE' | 'MODEL_OUTPUT_INVALID',
  subject: string,
  hint: string,
  error: z.ZodError,
  unrecognizedKeyRule: (path: readonly PropertyKey[]) => string,
): DebuggenError {
  const described = summarizeIssues(error, unrecognizedKeyRule);

  return new DebuggenError(code, `A value did not match ${subject}: ${described.summary}.`, {
    hint,
    details: {
      issueCount: described.issueCount,
      issues: described.issues,
    },
  });
}

// ---------------------------------------------------------------------------
// SelectedTarget — what the developer selected
// ---------------------------------------------------------------------------

/** The single-line rule stated once, because five fields quote it. */
const SINGLE_LINE_RULE =
  'must be a single line with at least one non-whitespace character and no control character';

/**
 * The permitted-key sentence for {@link selectedTargetSchema}.
 *
 * A function because {@link summarizeIssues} resolves the sentence from the
 * issue's path; a descriptor has no nested object, so every path gets the same
 * answer.
 */
const selectedTargetKeyRule = (): string =>
  'Unrecognized key: a selected target carries exactly selector, tagName, text (optional), componentChain and url.';

/**
 * The element a developer selected in the Elements panel, or asked the picker
 * for — the `target` field of the `target.selected` payload (AAP §0.4.2) and
 * the `target?` recorded on a session (AAP §0.2.3).
 *
 * `z.strictObject`: exactly the five keys the producer builds, and an
 * unrecognised key is a rejection rather than a silent strip. The descriptor
 * crosses two boundaries this product does not control — an expression
 * evaluated in the page, then a structured clone through the isolated-world
 * bridge — so a sixth key means either that a page interfered with the value or
 * that the two halves of the contract have drifted, and both are worth failing
 * for rather than quietly discarding.
 *
 * **What this object deliberately does not carry: a `SourceLocation`.** The
 * React-owner resolution route runs service-side (AAP §0.4.2), where the code
 * graph and the dev server's source maps are, and `dom-target.ts` supplies only
 * raw owner hints — React's own recorded position, a filtered owner stack —
 * separately from the descriptor. A file and line minted in the page would be a
 * generated-chunk coordinate presented as a project path, which is precisely
 * the mistake the service's resolver exists to avoid.
 *
 * @example
 * ```ts
 * const parsed = parseSelectedTarget(message.payload.target);
 * if (parsed.ok) {
 *   // parsed.value.componentChain[0] is the nearest composite component.
 * }
 * ```
 */
export const selectedTargetSchema = z.strictObject({
  /**
   * A CSS selector that resolves to this element.
   *
   * The bounded, uniqueness-checked path `dom-target.ts`'s `buildSelector()`
   * produces: an `#id` shortcut where the id is unique, otherwise at most six
   * segments of tag name, up to two legible class names and an `:nth-of-type`
   * index, verified to match exactly one node at the time it was built.
   *
   * Kept because it is *replayed*: the DevTools panel re-resolves it to
   * re-highlight the element in picker mode, and the service uses it to
   * recognise the same target across a follow-up question. It is a locator
   * rather than a promise — a page that re-renders may leave it matching
   * nothing — so every consumer treats a miss as "not found" rather than an
   * error.
   *
   * No control character may appear in it: a selector is interpolated into an
   * expression evaluated in the page and rendered as text in both user
   * interfaces.
   */
  selector: z
    .string()
    .min(1)
    .max(MAX_SELECTOR_LENGTH)
    .refine(isSingleLineText, { error: `selector ${SINGLE_LINE_RULE}.` }),

  /**
   * The element's tag name.
   *
   * **Case is not normalised, and not required.** `Element.tagName` reports an
   * uppercase name for an HTML element in an HTML document, a lowercase one for
   * XML and SVG content, and the producer lowercases what it reads — so both
   * forms are legitimate values from legitimate producers, and a schema that
   * insisted on one would reject a descriptor built by a different path through
   * the same module. Consumers that compare it do so case-insensitively.
   */
  tagName: z
    .string()
    .min(1)
    .max(MAX_TAG_NAME_LENGTH)
    .refine(isSingleLineText, { error: `tagName ${SINGLE_LINE_RULE}.` }),

  /**
   * The element's visible text: a label such as a button's caption.
   *
   * Absent — the key omitted, never `undefined` — when the element has no text,
   * which is the common case for an icon button or an input. Omission is what
   * the producer emits and what JSON can represent, so the schema treats
   * absence as the normal answer rather than an error.
   *
   * It arrives **already scrubbed of credential material, whitespace-collapsed
   * and truncated** by the producer through
   * `packages/telemetry/src/redaction/rules.ts` (AAP §0.5.2). This schema adds
   * no redaction of its own and only bounds the length, generously
   * ({@link MAX_TEXT_LENGTH}), so a producer-side bound that moves cannot turn
   * a valid descriptor into a rejected one.
   */
  text: z
    .string()
    .min(1)
    .max(MAX_TEXT_LENGTH)
    .refine(isSingleLineText, { error: `text ${SINGLE_LINE_RULE}.` })
    .optional(),

  /**
   * The React component chain above this element, **nearest-first**.
   *
   * Entries are display names resolved through bippy's fiber walk — the
   * composite components only, host elements skipped — with the nearest
   * ancestor at index 0. The order is the contract: Stage 1 reads the first
   * entries as the components a question is most likely about, and the
   * producer's own cap is applied nearest-first for the same reason.
   *
   * An **empty array is valid and is the honest answer** in three situations:
   * a page with no React on it, a node React never rendered, and a production
   * build whose fibers the hook cannot reach. A consumer must therefore treat
   * an empty chain as "no component information", never as a malformed
   * descriptor.
   */
  componentChain: z
    .array(
      z
        .string()
        .min(1)
        .max(MAX_COMPONENT_NAME_LENGTH)
        .refine(isSingleLineText, { error: `each component name ${SINGLE_LINE_RULE}.` }),
    )
    .max(MAX_COMPONENT_CHAIN),

  /**
   * The document's URL at the moment of selection.
   *
   * Must be an absolute `http:` or `https:` URL: it is the origin a session
   * binds to, the input the service maps onto a route in the code graph, and a
   * value a user interface renders, so a relative path, a `javascript:` or
   * `data:` URL and a bare host are all refused.
   *
   * **It may be query-redacted** (AAP §0.5.2). The producer sends the raw URL —
   * the service needs the unredacted query to redact it per key and to compute
   * a request key — and everything downstream of ingest sees a form whose
   * parameter *values* have been replaced while the keys and the path remain.
   * Both forms parse as URLs, which is what this validator checks and what
   * `./target.test.ts` pins: a schema that only accepted the raw form would
   * reject a session's own stored target on reopen.
   *
   * Two refinements rather than one, because they answer different questions
   * and a producer deserves to be told which one it failed. The text rule comes
   * first and is not redundant with URL parsing: the URL parser *ignores* tabs
   * and line breaks, so a URL carrying one would parse happily and then break a
   * log line or a panel row. The `.meta()` annotation is there so a rendered
   * JSON Schema still tells a model the field is a URI — the rules themselves
   * belong to refinements, which JSON Schema cannot carry, and are restated in
   * the stage prompt.
   */
  url: z
    .string()
    .min(1)
    .max(MAX_URL_LENGTH)
    .refine((value) => isSingleLineText(value) && value.trim() === value, {
      error: `url ${SINGLE_LINE_RULE}, and no leading or trailing whitespace.`,
    })
    .refine(isAbsoluteHttpUrl, {
      error: 'url must be an absolute http: or https: URL with a host.',
    })
    .meta({ format: 'uri' }),
});

/**
 * The element a developer selected.
 *
 * Structurally identical to `TargetDescriptor` in
 * `packages/telemetry/src/browser/dom-target.ts`, which is the producer that
 * cannot import this type. The two are kept in step by `./target.test.ts`,
 * which validates descriptors built to that module's documented bounds.
 */
export type SelectedTarget = z.infer<typeof selectedTargetSchema>;

/**
 * Validates an unknown value as a {@link SelectedTarget}, without throwing.
 *
 * This is how a descriptor that arrived from somewhere else becomes a typed
 * value: a `target.selected` payload received by the service, a stored target
 * read back when a session is reopened, a value the DevTools page obtained from
 * `chrome.devtools.inspectedWindow.eval`.
 *
 * See {@link rejection} for the error's anatomy and for when to re-code it.
 *
 * @param value Any value believed to describe a selected element.
 * @returns `ok(target)` with the parsed descriptor, or `err(error)` naming
 * every field that failed and the rule it broke — never the rejected value.
 */
export function parseSelectedTarget(value: unknown): Result<SelectedTarget> {
  const parsed = selectedTargetSchema.safeParse(value);

  if (parsed.success) {
    return ok(parsed.data);
  }

  return err(
    rejection(
      'PROTOCOL_INVALID_MESSAGE',
      'the selected target schema',
      'A selected target needs a non-empty selector and tagName, a componentChain array (empty is valid), an absolute http(s) url, and optionally a short text label.',
      parsed.error,
      selectedTargetKeyRule,
    ),
  );
}

// ---------------------------------------------------------------------------
// Problem-understanding vocabularies
//
// Two closed, generic vocabularies. Closed, because Stage 1's output is
// *machine-usable*: the category routes a question to an evidence shape and the
// entity kinds decide which code-graph query a seed becomes, and neither
// decision can be made from prose. Generic, because these members are embedded
// in a versioned prompt file and scanned by scripts/check-no-hardcoding.mjs
// (AAP §0.5.4) — not one of them names an application, a framework or a
// library.
// ---------------------------------------------------------------------------

/**
 * The kinds of problem a question can be about.
 *
 * Eight members, each naming a *class of behaviour* rather than a symptom
 * someone reported, so that a question phrased three different ways classifies
 * to the same value:
 *
 * - `'performance'` — something takes longer than the developer expected,
 *   wherever the time is spent.
 * - `'rendering'` — work repeated more often than expected in the view layer.
 * - `'network'` — requests: how many, in what order, how long, duplicated.
 * - `'data'` — what the data layer was asked for and what it returned.
 * - `'state'` — a value changing when, or how, it should not.
 * - `'error'` — something failed outright.
 * - `'correctness'` — nothing failed and nothing was slow; the result is wrong.
 * - `'other'` — a question that fits none of the above, kept so that
 *   classification never has to lie. A stage that reaches for it still produces
 *   a usable artifact, because `signalsNeeded` and `entities` carry the
 *   actionable part.
 *
 * Why a closed vocabulary is the right engineering decision here, and not
 * merely tidier: it makes the stage output routable without string matching, it
 * lets the rules-based deterministic provider emit a guaranteed-valid value
 * from the structured context it is given rather than inventing prose (AAP
 * §0.5.3), and it is small enough to state in full inside a prompt, which is
 * what keeps the model's answer inside the set the schema accepts.
 *
 * The trade-off is stated rather than hidden: a closed set cannot describe
 * every question, which is why `'other'` exists and why nothing downstream may
 * treat the category as the *only* input to a decision — `signalsNeeded` is the
 * field Stage 3 and the readiness gate actually consume.
 */
export const PROBLEM_CATEGORIES = [
  'performance',
  'rendering',
  'network',
  'data',
  'state',
  'error',
  'correctness',
  'other',
] as const;

/**
 * One member of the closed problem-category vocabulary.
 *
 * Derived from {@link PROBLEM_CATEGORIES} rather than declared beside it, so
 * the runtime list and the static type cannot drift.
 */
export type ProblemCategory = (typeof PROBLEM_CATEGORIES)[number];

/**
 * Validator for a single category, built from the tuple directly so the eight
 * strings are never repeated.
 *
 * A rejection names the whole accepted vocabulary, which is what a producer —
 * or a repair re-prompt — needs in order to be fixed.
 */
export const problemCategorySchema = z.enum(PROBLEM_CATEGORIES);

/**
 * Widened view of {@link PROBLEM_CATEGORIES} used by {@link isProblemCategory}.
 *
 * The annotation is the point: it lets an arbitrary `string` be tested for
 * membership without the predicate asserting anything about the value under
 * test.
 */
const PROBLEM_CATEGORY_VALUES: readonly string[] = PROBLEM_CATEGORIES;

/**
 * Whether a value is one of the eight problem categories.
 *
 * The boolean form, for paths that classify a value where no schema is in play:
 * a stored session record being triaged before it is parsed, a provider
 * deciding whether a category it was handed is one it has wording for. Where
 * the answer has to explain itself, parse instead.
 *
 * @param value Any value.
 * @returns `true` when `value` is a member of {@link PROBLEM_CATEGORIES},
 * narrowing it to {@link ProblemCategory}.
 */
export function isProblemCategory(value: unknown): value is ProblemCategory {
  return typeof value === 'string' && PROBLEM_CATEGORY_VALUES.includes(value);
}

/**
 * The kinds of thing a question can point at.
 *
 * These mirror the node kinds of the code graph rather than inventing a
 * parallel taxonomy, because that is what consumes them: Stage 2 turns each
 * entity into one of the **read-only** graph queries in
 * `apps/local-service/src/pipeline/tools/code-tools.ts` — `findByName` for a
 * component, function, hook or symbol, `routeForUrl` and `handlersFor` for a
 * route or URL, `whoCalls` and `pathBetween` to connect two of them — and a
 * kind with no query behind it would be a seed the next stage could not use.
 *
 * - `'component'`, `'function'`, `'hook'`, `'symbol'` — named declarations, in
 *   descending order of how specifically the graph can resolve them.
 * - `'route'` — a request path served by the project.
 * - `'file'` — a module named as a whole, when the question is about a file
 *   rather than a symbol inside it.
 * - `'selector'` — a DOM locator, which is how a selected element enters the
 *   understanding when no component chain was available.
 * - `'url'` — an absolute URL, resolved to a route by the graph.
 * - `'query'` — a data-layer operation.
 * - `'other'` — a concrete noun the question is about that none of the above
 *   describes; it still contributes a search hint.
 */
export const PROBLEM_ENTITY_KINDS = [
  'component',
  'function',
  'hook',
  'route',
  'file',
  'symbol',
  'selector',
  'url',
  'query',
  'other',
] as const;

/** One member of the closed problem-entity-kind vocabulary. */
export type ProblemEntityKind = (typeof PROBLEM_ENTITY_KINDS)[number];

/** Validator for a single entity kind, built from the tuple directly. */
export const problemEntityKindSchema = z.enum(PROBLEM_ENTITY_KINDS);

/**
 * The permitted-key sentence for {@link problemEntitySchema}.
 *
 * Read by {@link problemUnderstandingKeyRule}, which is what an entity's
 * rejection travels through: entities are only ever parsed as part of an
 * understanding.
 */
const PROBLEM_ENTITY_KEY_RULE =
  'Unrecognized key: an entity carries exactly kind, name and file (optional).';

/**
 * One concrete thing the question points at.
 *
 * `z.strictObject`, for the reason `./plan.ts` gives about a model's structured
 * output: a key the model invented is information — either it misunderstood the
 * schema, in which case the repair loop should tell it so, or the artifact
 * carries an instruction this product would silently ignore.
 */
export const problemEntitySchema = z.strictObject({
  /** Which kind of thing this is, and therefore which graph query it seeds. */
  kind: problemEntityKindSchema,

  /**
   * What it is called, as the question or the project summary names it.
   *
   * Matched against the code graph later — a display name, an exported symbol,
   * a route path, a selector — so a blank value is a guaranteed miss reported
   * far from its cause, and the bound mirrors `./plan.ts`'s symbol bound so a
   * name a plan would accept is a name an understanding accepts.
   */
  name: z
    .string()
    .min(1)
    .max(MAX_ENTITY_NAME_LENGTH)
    .refine(isSingleLineText, { error: `entity name ${SINGLE_LINE_RULE}.` }),

  /**
   * Where it lives, when the producer knows: **project-relative, POSIX**.
   *
   * Optional because an entity is frequently a name the question supplied with
   * no file attached — resolving it is Stage 2's job, not Stage 1's — and
   * absent rather than empty because the artifact is transported and persisted
   * as JSON, where an absent key is the one representation every layer agrees
   * on.
   *
   * Validated leniently on form and strictly on safety by
   * {@link isAuthoredProjectRelativePath}: a cosmetic `'./'` prefix a model
   * copied out of an import specifier must not fail a whole stage, while an
   * absolute path, a drive-letter or UNC path and any `'..'` escape are refused
   * outright. The value is **not** rewritten here; parsing stays byte-faithful
   * so a repair prompt can quote the field as written, exactly as the plan's
   * authoring schema does.
   */
  file: z
    .string()
    .min(1)
    .max(MAX_FILE_LENGTH)
    .refine(isAuthoredProjectRelativePath, {
      error:
        'file must be a project-relative POSIX path: no absolute or drive-letter path, no UNC prefix, no ".." segment and no control character.',
    })
    .optional(),
});

/** One concrete thing a question points at. */
export type ProblemEntity = z.infer<typeof problemEntitySchema>;

// ---------------------------------------------------------------------------
// ProblemUnderstanding — the Stage 1 artifact
// ---------------------------------------------------------------------------

/** The permitted-key sentence for the understanding object itself. */
const PROBLEM_UNDERSTANDING_KEY_RULE =
  'Unrecognized key: a problem understanding carries exactly category, signalsNeeded, entities and searchHints.';

/**
 * Resolves which permitted-key sentence an `unrecognized_keys` issue gets.
 *
 * An understanding is the only shape here with a nested object, so the path's
 * first segment is all it takes: an issue under `entities` is about an entity's
 * keys, anything else is about the understanding's own.
 *
 * @param path The issue's property path, outermost first.
 * @returns The sentence naming the keys the offending object permits.
 */
function problemUnderstandingKeyRule(path: readonly PropertyKey[]): string {
  return path[0] === 'entities' ? PROBLEM_ENTITY_KEY_RULE : PROBLEM_UNDERSTANDING_KEY_RULE;
}

/**
 * The statement of the no-duplicate rule, kept beside the check so the message
 * and the reason live together.
 *
 * It names no signal, by design: the duplicated member is a vocabulary value
 * rather than captured data, but the failure policy of this module is absolute
 * (AAP §0.5.2) and the enumeration a producer needs is already in the field's
 * own rejection message.
 */
const SIGNALS_UNIQUE_RULE =
  'signalsNeeded must not repeat a signal: each capture signal may appear at most once.';

/**
 * Rejects an understanding whose `signalsNeeded` repeats a signal.
 *
 * A duplicate is not harmless. The list is read as a *set* — Stage 3 asks each
 * adapter which of these signals it claims, and the readiness gate reports one
 * row per signal — so a repeat produces a duplicated readiness row, a
 * duplicated "Could not enable ‹signal›" sentence, or a second install attempt
 * for a hook already armed. Refusing it here, where a repair re-prompt can
 * still fix it, costs a retry; de-duplicating silently would hide a producer
 * that does not understand the field.
 *
 * The issue is reported on the **`signalsNeeded`** path rather than on the
 * offending index: the rule is a property of the list, `path.join('.')` stays
 * stable for a caller that groups issues by field, and one repeat produces one
 * issue rather than one per occurrence.
 *
 * Zod runs an object's checks only once its fields have parsed, so by the time
 * this runs every member is a vocabulary value and the comparison is total.
 */
function checkSignalsAreUnique(
  payload: z.core.ParsePayload<{ signalsNeeded: readonly string[] }>,
): void {
  const seen = new Set<string>();

  for (const signal of payload.value.signalsNeeded) {
    if (seen.has(signal)) {
      payload.issues.push({
        code: 'custom',
        path: ['signalsNeeded'],
        message: SIGNALS_UNIQUE_RULE,
        // Left empty on purpose: zod strips a finalized issue's `input` unless
        // a parse context asks for it, and this module's failures never carry
        // the value that caused them (AAP §0.5.2).
        input: undefined,
      });

      return;
    }

    seen.add(signal);
  }
}

/**
 * What the pipeline understood the developer's question to be about — the
 * validated output of Stage 1 (AAP §0.4.2), produced from the question, the
 * selected target, the current URL and the project summary, and recorded on the
 * session as `understanding?` (AAP §0.2.3).
 *
 * `z.strictObject` for the same reason the plan's authoring schema is strict:
 * this is a model's structured output, and an invented key is either a
 * misunderstanding the repair loop should report or an instruction the product
 * would silently ignore.
 *
 * Every bound below is documented rather than magic, because the producer's
 * output length is not something this product gets to assume: an artifact that
 * named two hundred entities would turn Stage 2 into a repository dump, which
 * is exactly what its query-proposal design exists to prevent.
 *
 * It is a plain, readonly-friendly data object with no methods:
 * `InstrumentationAdapter.createPlan(context, understanding)` in
 * `../adapter.ts` takes it as its second argument, it is persisted as JSON on
 * the session record, and it is rendered in both user interfaces.
 */
export const problemUnderstandingSchema = z
  .strictObject({
    /**
     * Which class of behaviour the question is about.
     *
     * Routes the question to the right evidence shape — which aggregates the
     * analysis stage computes, which nodes the panel generator is told about —
     * and is recorded on the session so a reopened session renders the same
     * way. Required: a stage that cannot classify a question has
     * {@link PROBLEM_CATEGORIES}'s `'other'` to say so honestly, which is more
     * useful to every consumer than an absent field.
     */
    category: problemCategorySchema,

    /**
     * What has to be observed in order to answer the question.
     *
     * **Typed as the closed {@link CaptureSignal} vocabulary on purpose.** This
     * is the single intra-folder dependency of this module —
     * `target.ts → readiness.ts` — and it is load-bearing: Stage 3's planning
     * asks each adapter which of these signals it claims, and the readiness
     * gate of `./readiness.js` reports one row per signal and computes
     * "Ready to capture" from them. Both consume machine-readable names.
     *
     * Widening this field to `string[]` would reintroduce free-text matching
     * into a decision path — the AAP §0.5.4 forbidden pattern in disguise — and
     * would silently disarm a signal whose prose no adapter recognised. Anyone
     * tempted to "simplify" it should change the vocabulary in
     * `./readiness.ts` instead, where every producer and consumer of a signal
     * name is listed.
     *
     * At least one, at most one of each (see {@link checkSignalsAreUnique}): an
     * understanding that asks for nothing describes no capture, and a capture
     * with no signal produces the empty result of AAP §0.5.5 rather than an
     * answer.
     */
    signalsNeeded: z.array(captureSignalSchema).min(1).max(CAPTURE_SIGNALS.length),

    /**
     * The concrete things the question points at — the seeds for Stage 2's
     * query proposals.
     *
     * Ordered most-relevant-first by the producer, and consumed as an ordered
     * list: Stage 2 proposes its bounded set of code-graph queries from the
     * head of it. An empty array is valid — a question can be entirely about
     * runtime behaviour with nothing named — and is why Stage 2 also has the
     * project summary and {@link searchHints} to work from.
     */
    entities: z.array(problemEntitySchema).max(MAX_ENTITIES),

    /**
     * Bounded terms for the text search of
     * `packages/code-analysis/src/search/text-search.ts`, used where the graph
     * has no declaration to match a name against.
     *
     * Terms, not sentences: {@link MAX_SEARCH_HINT_LENGTH} is generous for an
     * identifier, a route fragment or a two-word phrase, and short enough that
     * a hint stays a search term rather than becoming a restatement of the
     * question. Blank hints are refused because a blank term matches
     * everything.
     */
    searchHints: z
      .array(
        z
          .string()
          .min(1)
          .max(MAX_SEARCH_HINT_LENGTH)
          .refine(isSingleLineText, { error: `each search hint ${SINGLE_LINE_RULE}.` }),
      )
      .max(MAX_SEARCH_HINTS),
  })
  .check(checkSignalsAreUnique);

/**
 * What the pipeline understood the question to be about.
 *
 * The second argument of every adapter's `createPlan`, the input of Stage 2 and
 * Stage 3, and the `understanding?` field of a session record.
 */
export type ProblemUnderstanding = z.infer<typeof problemUnderstandingSchema>;

/**
 * Validates an unknown value as a {@link ProblemUnderstanding}, without
 * throwing.
 *
 * This is the boundary between a model's structured output and everything that
 * acts on it: `apps/local-service/src/pipeline/stages/understand.ts` parses
 * here, re-prompts with the field paths this reports when it fails, and only a
 * value that came back `ok` reaches the investigation stage, the planner or the
 * session record. The same function validates an understanding read back from
 * the store when a session is reopened.
 *
 * The error's code is `'MODEL_OUTPUT_INVALID'`, which is what a caller matches
 * on to decide between a repair retry and a fallback; see {@link rejection} for
 * the anatomy and for when to re-code it.
 *
 * @param value Any value believed to be a problem understanding.
 * @returns `ok(understanding)` with the parsed artifact, or `err(error)` naming
 * every field that failed and the rule it broke — never the rejected value.
 */
export function parseProblemUnderstanding(value: unknown): Result<ProblemUnderstanding> {
  const parsed = problemUnderstandingSchema.safeParse(value);

  if (parsed.success) {
    return ok(parsed.data);
  }

  return err(
    rejection(
      'MODEL_OUTPUT_INVALID',
      'the problem understanding schema',
      'A problem understanding needs one known category, at least one distinct capture signal, an entities array of { kind, name, file? } and an array of short search hints.',
      parsed.error,
      problemUnderstandingKeyRule,
    ),
  );
}
