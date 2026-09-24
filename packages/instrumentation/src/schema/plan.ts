/**
 * The instrumentation plan contract — the one definition in this monorepo.
 *
 * A plan is the artifact that stands between "a model proposed something" and
 * "this product touched a developer's working tree". AAP §0.9.1 lists
 * `packages/instrumentation/src/schema/**` among the schema sources that have a
 * **single** definition: `@debuggen/protocol` embeds these shapes in its
 * `instrumentation.plan` message, `apps/local-service` persists them on the
 * session record and drives the installer from them, and both extensions render
 * them. A second declaration of any shape below — even a structurally identical
 * one in an app — is a defect, because the three processes would then agree only
 * by coincidence.
 *
 * ## Two schemas, one artifact
 *
 * There are deliberately *two* of everything here, and the split is what makes
 * the pipeline of AAP §0.5.3 work:
 *
 * ```text
 * model output
 *   → instrumentationPlanInputSchema        (authoring schema; ≤ 2 repair re-prompts)
 *   → normalizePlan(...)                    (deterministic; no model involved)
 *   → instrumentationPlanSchema             (internal schema)
 *   → feasibility check → installer
 * ```
 *
 * - The **authoring** schema ({@link instrumentationPlanInputSchema}) is what a
 *   model — or a human writing a plan by hand — produces: an objective, a list
 *   of prose capture phrases, and targets naming a file, a symbol and an action
 *   type. It is prose-friendly on purpose, and it is the only schema a repair
 *   re-prompt is ever run against.
 * - The **internal** schema ({@link instrumentationPlanSchema}) is what the rest
 *   of the product consumes: every action resolved to an adapter and an install
 *   mode, every action carrying a stable id and a rationale, every path already
 *   normalised.
 *
 * Between them sits {@link normalizePlan}, which is deterministic and
 * **returns** its failures. That is a direct consequence of AAP §0.5.3: a
 * failure *after* the authoring schema has accepted the input is a product
 * defect rather than a model mistake, so it is logged with the input and never
 * retried against the model. An exception thrown from a normaliser would be an
 * unretryable failure expressed as control flow; a `Result` is the only
 * acceptable shape, and the one thing every caller can log, surface and act on.
 *
 * ## What this module deliberately does not do
 *
 * - **It does not know about adapters.** An action's `adapter` is a plain
 *   string and the resolution is supplied by the caller through
 *   {@link PlanAdapterResolver}. Adapter identity belongs to the registry, and
 *   a third-party adapter may register at runtime, so an enumeration here would
 *   be wrong the moment someone did what AAP §0.4.2 invites them to do.
 * - **It does not render JSON Schema.** The plan prompt embeds the authoring
 *   schema, and the caller produces that with
 *   `z.toJSONSchema(instrumentationPlanInputSchema)` where the prompt is
 *   assembled. Keeping the conversion out of here keeps prompt concerns in the
 *   service and leaves this module free of anything a bundler cannot drop. Note
 *   that a rendered JSON Schema keeps the field types, bounds and enumerations
 *   but **drops the custom refinements** below, so a prompt that shows the
 *   schema has to state the path rule in prose.
 * - **It does not deduplicate, reorder or merge.** Target order is contract,
 *   duplicate targets survive normalisation so that the feasibility gate can
 *   see and reject them, and merging a follow-up plan version onto its
 *   predecessor is the service's job.
 * - **It does not read free text for meaning.** `capture` phrases are for
 *   display. Deriving behaviour from them by substring matching is the
 *   hardcoded-behaviour pattern AAP §0.5.4 forbids, wearing a different hat.
 *
 * ## Module constraints
 *
 * This is the foundational module of its folder: `./readiness.ts`,
 * `../adapter.ts`, `../registry.ts`, `../feasibility.ts` and `../installer.ts`
 * build on it, and it imports no sibling — which is what keeps this package's
 * module graph acyclic. Its only imports are `zod` and `@debuggen/shared`.
 *
 * It is also load-time inert and platform-neutral, which matters more than the
 * package's Node-only home suggests: `@debuggen/protocol` embeds these schemas
 * as **values**, and protocol is bundled into the DevTools panel and the VS
 * Code webview. So there is no `node:*` import, no environment read, no
 * filesystem or network access, no timer and no mutable module state here.
 * Every validated shape is JSON-only for the same reason — no `Date`, `Map`,
 * `Set`, `bigint`, class instance or function survives a WebSocket frame.
 *
 * @example
 * ```ts
 * const normalized = normalizePlan(modelOutput, {
 *   sessionId: session.id,
 *   planVersion: 1,
 *   resolver: adapterRegistry,
 * });
 *
 * if (!normalized.ok) {
 *   logger.error('plan normalisation failed', { code: normalized.error.code });
 *   return usePlanFallback();
 * }
 *
 * await installer.install(normalized.value, context);
 * ```
 */

import { z } from 'zod';

import {
  DebuggenError,
  err,
  isSafeRelativePath,
  newActionId,
  normalizePosix,
  ok,
  toPosix,
} from '@debuggen/shared';
import type { Result } from '@debuggen/shared';

// ---------------------------------------------------------------------------
// Bounds
//
// Every string and array in both schemas is bounded. Two reasons, and neither
// is tidiness: a plan is persisted on the session record and shown in two user
// interfaces, so an unbounded field is a way to make a row or a panel
// unreadable; and the authoring schema's producer is a language model, whose
// output length is not something this product gets to assume. The numbers come
// from AAP §0.2.3's field descriptions.
// ---------------------------------------------------------------------------

/** Longest accepted project-relative file path, in characters. */
const MAX_FILE_LENGTH = 1024;

/** Longest accepted symbol name, in characters. */
const MAX_SYMBOL_LENGTH = 200;

/** Longest accepted objective, in characters. */
const MAX_OBJECTIVE_LENGTH = 500;

/** Longest accepted per-action rationale, in characters. */
const MAX_RATIONALE_LENGTH = 500;

/** Longest accepted capture phrase, in characters. */
const MAX_CAPTURE_LENGTH = 160;

/** Most capture phrases one plan may carry. */
const MAX_CAPTURE_ENTRIES = 24;

/** Most targets one plan may carry. */
const MAX_TARGETS = 64;

/** Longest accepted hypothesis, in characters. */
const MAX_HYPOTHESIS_LENGTH = 500;

/** Most hypotheses one plan may carry. */
const MAX_HYPOTHESES = 16;

/** Longest accepted adapter id, in characters. */
const MAX_ADAPTER_ID_LENGTH = 64;

/** Longest accepted opaque id (action id, session id), in characters. */
const MAX_ID_LENGTH = 64;

/**
 * How many validation issues an error carries at most.
 *
 * A rejected plan can produce an issue for every field of every target, and the
 * resulting error is logged, persisted and shown; the first twenty identify the
 * problem, and the total count is reported separately so a truncated list never
 * looks complete.
 */
const MAX_REPORTED_ISSUES = 20;

/**
 * The shape of an action id, as minted by `newActionId()` in
 * `@debuggen/shared`: a three-letter kind prefix, an underscore, then sixteen
 * characters of digits and lowercase letters.
 *
 * Pinned rather than left as "some non-empty string" because an action id is an
 * addressing key: AAP §0.4.2's follow-up delta installs name the actions they
 * apply by id, and the store keys modification records against them. Validating
 * the shape here is what catches a caller that minted an id by hand, or an
 * injected id factory in a test that produces something the store cannot key.
 *
 * The pattern is deliberately the *generic* id shape rather than an
 * `act_`-anchored one: {@link normalizePlan} accepts an injected factory so a
 * test can be deterministic, and pinning the prefix would make this module the
 * arbiter of a vocabulary that `@debuggen/shared` owns.
 */
export const ACTION_ID_PATTERN = /^[a-z]{3}_[0-9a-z]{16}$/;

// ---------------------------------------------------------------------------
// Vocabularies
// ---------------------------------------------------------------------------

/**
 * Every kind of instrumentation an action can ask for.
 *
 * Spelled in the order AAP §0.2.3 spells it, because the tuple is what a
 * rendered JSON Schema, a stored plan and a protocol message all carry: the
 * enumeration must not depend on how this file happens to be sorted. The eight
 * split cleanly along the axis that decides whether a developer's file is
 * touched at all (AAP §0.5.1):
 *
 * - `'function-timing'` — time a named function on either tier. The **only**
 *   signal no runtime hook can supply, and therefore the only reason this
 *   product writes into a working tree at all.
 * - `'server-span'` — a span around a named server-side entry point, installed
 *   the same way and for the same reason.
 * - `'react-render-tracking'` — renders and commits, observed through the React
 *   fiber hook the page agent installs before React loads.
 * - `'fetch-tracking'` — `fetch` and `XMLHttpRequest`, patched in the page by
 *   the agent, which is also what injects the trace-context header that makes
 *   browser and server spans one tree.
 * - `'db-query-tracking'` — database spans from the driver or ORM
 *   instrumentation inside the dev-server process.
 * - `'state-tracking'` — state transitions, from the same fiber hook as
 *   renders.
 * - `'interaction-tracking'` — the user interaction that starts a trace, from a
 *   capture-phase listener plus event-timing entries.
 * - `'perf-tracking'` — performance entries, long tasks and paints.
 *
 * Which adapter claims which type is **not** encoded here, and cannot be: ids
 * live in the registry (`../registry.ts`) and a third-party adapter may claim a
 * type at runtime through `registerAdapter()` (AAP §0.4.2). As shipped, the
 * React adapter claims render and state tracking, the browser-performance
 * adapter claims interaction and performance tracking, the fetch adapter claims
 * fetch tracking, the Next.js adapter claims server spans and function timing,
 * and the two database adapters claim query tracking — but every one of those
 * is a fact about the registry, which is why {@link InstrumentationAction}'s
 * `adapter` field is a bounded string rather than a union.
 */
export const INSTRUMENTATION_ACTION_TYPES = [
  'function-timing',
  'server-span',
  'react-render-tracking',
  'fetch-tracking',
  'db-query-tracking',
  'state-tracking',
  'interaction-tracking',
  'perf-tracking',
] as const;

/**
 * One member of the closed action-type vocabulary.
 *
 * Derived from {@link INSTRUMENTATION_ACTION_TYPES} rather than declared beside
 * it, so the runtime list and the static type cannot drift: adding a type
 * widens this union in the same edit, and every consumer that switches
 * exhaustively over it — an adapter's `canHandle`, the readiness module's
 * signal derivation — stops compiling until it says something about the new
 * case.
 */
export type InstrumentationActionType = (typeof INSTRUMENTATION_ACTION_TYPES)[number];

/**
 * Validator for a single action type, used by both schemas below.
 *
 * Built from the tuple directly, so the eight strings are never repeated. A
 * rejection reads `Invalid option: expected one of "function-timing"|…`, which
 * is exactly what a repair re-prompt needs: the whole accepted vocabulary, and
 * nothing about the value that was rejected.
 */
export const instrumentationActionTypeSchema = z.enum(INSTRUMENTATION_ACTION_TYPES);

/**
 * Widened view of {@link INSTRUMENTATION_ACTION_TYPES} used by
 * {@link isInstrumentationActionType}.
 *
 * The annotation is the point: it lets an arbitrary `string` be tested for
 * membership without the predicate asserting anything about the value under
 * test.
 */
const ACTION_TYPE_VALUES: readonly string[] = INSTRUMENTATION_ACTION_TYPES;

/**
 * Whether a value is one of the eight action types.
 *
 * The boolean form, for the paths that classify a value where no schema is in
 * play: an adapter deciding whether a type is one it claims, a stored plan row
 * being triaged before it is parsed. Where the answer has to explain itself,
 * parse instead — a rejection with no reason attached is a bug report nobody
 * can act on.
 *
 * @param value Any value.
 * @returns `true` when `value` is a member of
 * {@link INSTRUMENTATION_ACTION_TYPES}, narrowing it to
 * {@link InstrumentationActionType}.
 */
export function isInstrumentationActionType(value: unknown): value is InstrumentationActionType {
  return typeof value === 'string' && ACTION_TYPE_VALUES.includes(value);
}

/**
 * How an action is installed.
 *
 * - `'runtime'` — a hook the product already owns is switched on: a listener in
 *   the page agent, an instrumentation inside the dev-server preload. Nothing
 *   is written to disk, it is live immediately, and it survives a reload.
 * - `'patch'` — a recorded, hash-checked, reversible edit to the developer's
 *   file, which is what timing a named function requires (AAP §0.5.1).
 *
 * **The order of the tuple is the install order** the installer follows:
 * runtime-mode actions first, patch-mode actions second (AAP §0.4.2, §0.5.1).
 * That ordering is not cosmetic — runtime hooks cannot fail half-way and leave
 * bytes behind, so doing them first means a patch failure has strictly less to
 * unwind, and the hooks are already listening when a patched file is picked up
 * by the dev server's hot reload.
 */
export const INSTRUMENTATION_MODES = ['runtime', 'patch'] as const;

/** One member of the closed install-mode vocabulary. */
export type InstrumentationMode = (typeof INSTRUMENTATION_MODES)[number];

/** Validator for a single install mode, used by {@link instrumentationActionSchema}. */
export const instrumentationModeSchema = z.enum(INSTRUMENTATION_MODES);

/** Widened view of {@link INSTRUMENTATION_MODES} used by {@link isInstrumentationMode}. */
const MODE_VALUES: readonly string[] = INSTRUMENTATION_MODES;

/**
 * Whether a value is one of the two install modes.
 *
 * Used where a resolution arrives from outside this module —
 * {@link normalizePlan} takes the adapter and the mode from a caller-supplied
 * resolver, and a resolver is ordinary code that can be wrong.
 *
 * @param value Any value.
 * @returns `true` when `value` is a member of {@link INSTRUMENTATION_MODES},
 * narrowing it to {@link InstrumentationMode}.
 */
export function isInstrumentationMode(value: unknown): value is InstrumentationMode {
  return typeof value === 'string' && MODE_VALUES.includes(value);
}

// ---------------------------------------------------------------------------
// Targetless actions
//
// Most runtime signals are about the whole page or the whole server process
// rather than one declaration: the fiber hook observes every commit, the fetch
// patch sees every request, the event-timing observer sees every interaction.
// Such an action still carries `file` and `symbol` — the field set is AAP
// §0.2.3's and every consumer keys on it — so it names them with one explicit
// marker instead of an invented target. A marker is a fact the feasibility gate
// can recognise; a plausible-looking file and symbol are a claim it would have
// to check, and a hallucinated one would otherwise pass as validated.
// ---------------------------------------------------------------------------

/**
 * The `file` a targetless action names: the project root, spelled `'.'`.
 *
 * The root is the one path that is always inside the project and never an
 * indexed source file, so it cannot be mistaken for a target, and it satisfies
 * the path rule both schemas already apply. It is only ever meaningful together
 * with {@link TARGETLESS_SYMBOL}: the schemas refuse either half on its own.
 */
export const TARGETLESS_FILE = '.';

/**
 * The `symbol` a targetless action names: `'*'`, which no language this product
 * indexes accepts as a declaration name, so it can never collide with one.
 */
export const TARGETLESS_SYMBOL = '*';

/**
 * The action types that address one named declaration, and so may never be
 * targetless.
 *
 * Both are installed by wrapping that declaration's body (AAP §0.5.1): a
 * function-timing or server-span action without a file and a symbol has no
 * declaration to wrap, and accepting one would move the failure from the plan,
 * where a repair re-prompt can fix it, to the installer.
 */
export const TARGET_REQUIRED_ACTION_TYPES = [
  'function-timing',
  'server-span',
] as const satisfies readonly InstrumentationActionType[];

/** One member of {@link TARGET_REQUIRED_ACTION_TYPES}. */
export type TargetRequiredActionType = (typeof TARGET_REQUIRED_ACTION_TYPES)[number];

/**
 * Widened view of {@link TARGET_REQUIRED_ACTION_TYPES} used by
 * {@link isTargetRequiredActionType}.
 */
const TARGET_REQUIRED_VALUES: readonly string[] = TARGET_REQUIRED_ACTION_TYPES;

/**
 * Whether an action type addresses one named declaration and therefore needs a
 * real target.
 *
 * @param type An action type.
 * @returns `true` for a member of {@link TARGET_REQUIRED_ACTION_TYPES}.
 */
export function isTargetRequiredActionType(type: string): type is TargetRequiredActionType {
  return TARGET_REQUIRED_VALUES.includes(type);
}

/**
 * Whether an action names the targetless marker — `{ file: '.', symbol: '*' }`
 * — rather than one file and one symbol.
 *
 * Exact comparison, for a *normalised* action: the internal schema requires the
 * normal form, in which the project root is exactly {@link TARGETLESS_FILE}. The
 * feasibility gate uses this to decide which actions have a target to check;
 * every other action, runtime or patch, is checked against the project and the
 * code graph.
 *
 * @param target Anything carrying a `file` and a `symbol`.
 * @returns `true` when both halves of the marker are present.
 *
 * @example
 * ```ts
 * isTargetlessAction({ file: TARGETLESS_FILE, symbol: TARGETLESS_SYMBOL }); // true
 * isTargetlessAction({ file: 'src/checkout.tsx', symbol: 'Checkout' }); // false
 * ```
 */
export function isTargetlessAction(target: {
  readonly file: string;
  readonly symbol: string;
}): boolean {
  return target.file === TARGETLESS_FILE && target.symbol === TARGETLESS_SYMBOL;
}

/**
 * The version of the normalised plan shape, carried on every plan.
 *
 * `1`, and it is a *shape* version rather than a plan's own revision counter —
 * {@link InstrumentationPlan.planVersion} is that. The two exist for different
 * readers: this one tells a consumer which schema a stored or received plan was
 * written against, so a session recorded by an older build can be recognised
 * rather than misread; `planVersion` tells the installer which revision of
 * *this* session's plan it is looking at.
 */
export const INSTRUMENTATION_PLAN_VERSION = 1 as const;

// ---------------------------------------------------------------------------
// Text and path predicates
//
// Shared by both schemas so that a field means the same thing before and after
// normalisation. They are pure, total and allocation-light: every one of them
// runs on every field of every target of every plan, on a developer's machine,
// while they wait.
// ---------------------------------------------------------------------------

/** Highest code point of the C0 control block, `U+001F`, NUL included below it. */
const C0_CONTROL_MAX = 0x1f;

/** `U+007F` DELETE, the start of the DELETE + C1 control range. */
const C1_CONTROL_MIN = 0x7f;

/** `U+009F`, the last C1 control code point. */
const C1_CONTROL_MAX = 0x9f;

/** Tab, line feed and carriage return: the control characters prose may carry. */
const ALLOWED_WHITESPACE_CONTROLS: readonly number[] = [0x09, 0x0a, 0x0d];

/**
 * Whether `value` contains a control character, optionally tolerating tab, line
 * feed and carriage return.
 *
 * Control characters in a plan are not a style question. A plan is written to
 * the session store, printed into log lines, rendered in the editor view and
 * the DevTools panel, and — for the objective — quoted into a model prompt. A
 * NUL truncates a string at every C string boundary it later meets, and an ESC
 * begins a terminal escape sequence, which is how a "harmless" field becomes a
 * way to rewrite a developer's terminal. Neither has a legitimate use in a file
 * path, a symbol name or a sentence about why a function is being timed.
 *
 * @param value The string to inspect.
 * @param allowWhitespace When `true`, tab, line feed and carriage return are
 * permitted — the tolerance prose fields need and identifiers do not.
 * @returns `true` when a disallowed control character is present.
 */
function hasControlCharacter(value: string, allowWhitespace: boolean): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    const isControl = code <= C0_CONTROL_MAX || (code >= C1_CONTROL_MIN && code <= C1_CONTROL_MAX);

    if (!isControl) {
      continue;
    }

    if (allowWhitespace && ALLOWED_WHITESPACE_CONTROLS.includes(code)) {
      continue;
    }

    return true;
  }

  return false;
}

/**
 * Whether `value` is a usable single-line identifier: at least one
 * non-whitespace character and no control character at all.
 *
 * Applied to a symbol name and to an adapter id. Both are matched against
 * something real later — a declaration in the code graph, an entry in the
 * adapter registry — so a value that is only whitespace is a guaranteed
 * downstream failure reported far from its cause, and a value carrying a line
 * break is not a name in any language this product indexes.
 */
function isIdentifierText(value: string): boolean {
  return value.trim().length > 0 && !hasControlCharacter(value, false);
}

/**
 * Whether `value` is usable prose: at least one non-whitespace character and no
 * control character other than tab, line feed or carriage return.
 *
 * Applied to the objective, the capture phrases, the hypotheses and an action's
 * rationale. The whitespace tolerance is deliberate — a model may well wrap a
 * sentence — while the blank rejection is load-bearing rather than cosmetic:
 * {@link normalizePlan} falls back to the trimmed objective when a target
 * carries no rationale, and a whitespace-only objective would make that
 * fallback empty and fail the internal schema for a reason no repair prompt
 * could explain.
 */
function isProseText(value: string): boolean {
  return value.trim().length > 0 && !hasControlCharacter(value, true);
}

/**
 * Lexically normalise an authored path: separators converted, `'.'` segments
 * and duplicate separators dropped, interior `'..'` resolved.
 *
 * "Lexically" is the whole contract — no filesystem is touched, no symlink is
 * resolved and no current directory is consulted, so this is safe to run on a
 * value that has not been validated yet. `normalizePosix` already removes a
 * leading `'./'` along with every other `'.'` segment, so a model's cosmetic
 * `'./src/lib/thing.ts'` and a Windows-flavoured `'src\\lib\\thing.ts'` both
 * come out as `'src/lib/thing.ts'`.
 *
 * What it deliberately does **not** do is repair an unsafe path. A leading
 * `'..'` survives normalisation (there is no base to resolve it against), and
 * an absolute path stays absolute, which is exactly what lets
 * {@link isSafeRelativePath} refuse both afterwards.
 *
 * The function is idempotent, which the internal schema relies on: it requires
 * a path to equal its own normal form, so the identity key two plan versions
 * are matched on cannot differ by a `'./'`.
 */
function lexicallyNormalizePath(value: string): string {
  return normalizePosix(toPosix(value));
}

/**
 * Whether an *authored* path can be accepted for normalisation later.
 *
 * Lenient about form, strict about safety: the value is normalised lexically
 * first, so cosmetic output a model routinely produces is tolerated, and the
 * result must then satisfy {@link isSafeRelativePath} — which refuses an
 * absolute POSIX path, a drive-letter or UNC path, any surviving `'..'`
 * segment, a control character and a blank string.
 *
 * Being tolerant here and strict there is the point of having a repair loop at
 * all: a path this predicate rejects is one no amount of normalisation could
 * make safe, so the model is told about it while there is still a chance to fix
 * it, rather than having the plan fail after the authoring schema has passed.
 */
function isAuthoredProjectRelativePath(value: string): boolean {
  return isSafeRelativePath(lexicallyNormalizePath(value));
}

/**
 * Whether a *normalised* path is one the rest of the product can rely on:
 * project-relative, safe, and already in its own normal form.
 *
 * The second half is what the authoring schema cannot demand. Downstream code
 * compares these paths as strings — {@link actionIdentityKey} keys an action on
 * its file, and the installer matches a follow-up plan's actions against the
 * ones already applied — so `'src/./lib/thing.ts'` and `'src/lib/thing.ts'`
 * reaching the installer as two different actions for one function would be a
 * duplicate patch on a file the journal believes was touched once. Requiring
 * the normal form in the schema makes that unrepresentable instead of unlikely.
 */
function isNormalizedProjectRelativePath(value: string): boolean {
  return isSafeRelativePath(value) && value === lexicallyNormalizePath(value);
}

// ---------------------------------------------------------------------------
// Validation failures
// ---------------------------------------------------------------------------

/**
 * The part of a validation issue this module reads.
 *
 * Declared structurally rather than imported from `zod`'s internals so the
 * formatter below is not coupled to a library type that moves between minor
 * versions, and so it can be handed an issue list from anywhere.
 */
interface SchemaIssueLike {
  /** The property path of the offending field, outermost first. */
  readonly path: readonly PropertyKey[];
  /** The machine-readable issue kind, for example `'too_big'` or `'custom'`. */
  readonly code?: string | undefined;
  /** The schema's own description of the rule that was broken. */
  readonly message: string;
}

/** One reported issue: where the problem is, and which rule it broke. */
interface ReportedIssue {
  /** Dotted property path, or `'(root)'` for an issue on the object itself. */
  readonly path: string;
  /** The issue kind, or `'invalid'` when the source did not supply one. */
  readonly code: string;
  /** The schema's message for the broken rule. */
  readonly message: string;
}

/**
 * Turns a validation issue list into an error message and diagnostic details
 * that carry the *shape* of the failure and never the data that caused it.
 *
 * **Privacy, not brevity.** An error raised this deep in a call stack never
 * passes through the redaction layer or the outbound model guard (AAP §0.5.2),
 * and this object is logged, persisted with the session and rendered in two
 * user interfaces. So the rejected values stay out of it: what goes in is the
 * field path, the issue kind and the schema's own statement of the rule — which
 * is everything a producer needs in order to be fixed, and nothing a plan's
 * content could leak.
 *
 * Zod's messages are safe by the same test: they name expected types, bounds
 * and permitted options, and the one case that echoes the input at all is an
 * unrecognised *key*, which is part of the shape rather than the data.
 *
 * @param issues The issues reported by a schema.
 * @returns A `summary` of `path (code)` pairs for the error message, the first
 * {@link MAX_REPORTED_ISSUES} issues in full, and the total count so a
 * truncated list never looks complete.
 */
function summarizeIssues(issues: readonly SchemaIssueLike[]): {
  readonly summary: string;
  readonly issues: readonly ReportedIssue[];
  readonly issueCount: number;
} {
  const reported: ReportedIssue[] = issues.slice(0, MAX_REPORTED_ISSUES).map((issue) => ({
    path: issue.path.length > 0 ? issue.path.map((segment) => String(segment)).join('.') : '(root)',
    code: issue.code ?? 'invalid',
    message: issue.message,
  }));

  const summary = reported.map((issue) => `${issue.path} (${issue.code})`).join(', ');
  const truncated = issues.length > reported.length;

  return {
    summary: truncated
      ? `${summary}, and ${String(issues.length - reported.length)} more`
      : summary,
    issues: reported,
    issueCount: issues.length,
  };
}

/**
 * Builds the error a schema rejection is reported as.
 *
 * One function so that every rejection in this module has the same anatomy: a
 * code from the closed vocabulary, a sentence naming what failed and the
 * offending field paths, a hint saying what to do about it, and
 * `details.issues` for a log.
 *
 * @param code The failure being reported. Only the two schema-rejection codes
 * are accepted, so a caller cannot report a rejection as something a user
 * interface would render with the wrong recovery path.
 * @param subject What failed, as a sentence fragment that reads after "did not
 * match", for example `'the instrumentation plan input schema'`.
 * @param hint The developer's next step.
 * @param issues The issues reported by the schema.
 */
function schemaRejection(
  code: 'MODEL_OUTPUT_INVALID' | 'PLAN_INVALID',
  subject: string,
  hint: string,
  issues: readonly SchemaIssueLike[],
): DebuggenError {
  const described = summarizeIssues(issues);

  return new DebuggenError(code, `A value did not match ${subject}: ${described.summary}.`, {
    hint,
    details: {
      issueCount: described.issueCount,
      issues: described.issues,
    },
  });
}

// ---------------------------------------------------------------------------
// The authoring schema: what a model, or a human, writes
//
// This is the schema a repair re-prompt is run against, and the only one the
// model ever sees (AAP §0.5.3). Two consequences shape it: nothing is
// transformed, defaulted or coerced — the value that comes out is the value
// that went in, so a repair prompt can quote the field it is complaining about
// and normalisation stays in one place — and every rejection message states a
// rule rather than describing the input.
// ---------------------------------------------------------------------------

/**
 * The path rule stated once, because three schemas quote it and a rendered JSON
 * Schema cannot carry the refinement it belongs to.
 */
const PATH_RULE_MESSAGE =
  'file must be a project-relative POSIX path with forward slashes: no absolute or drive-letter path, no UNC prefix, no ".." segment and no control character.';

/**
 * The targetless-marker rule, stated once because both schemas enforce it and a
 * rendered JSON Schema cannot carry the refinement it belongs to.
 */
const TARGETLESS_PAIR_RULE = `a targetless action names file "${TARGETLESS_FILE}" and symbol "${TARGETLESS_SYMBOL}" together; any other action must name a project file and a symbol that file declares, never the project root or "${TARGETLESS_SYMBOL}" on its own.`;

/** The rule a target-required action type is held to. */
const TARGET_REQUIRED_RULE = `${TARGET_REQUIRED_ACTION_TYPES.join(' and ')} actions wrap one named declaration, so they must name a project file and a symbol, never the targetless marker (file "${TARGETLESS_FILE}" and symbol "${TARGETLESS_SYMBOL}").`;

/** The rule a resolved targetless action is held to. */
const TARGETLESS_RUNTIME_RULE =
  'a targetless action is installed by a runtime hook, so its mode must be "runtime".';

/**
 * Enforces the targetless marker on a target or an action: both halves or
 * neither, and never on a type that wraps one declaration.
 *
 * The file is compared in its lexical normal form, so the authoring schema's
 * cosmetic `'./'` is recognised as the project root exactly as
 * {@link normalizePlan} will later rewrite it — a target that normalisation
 * would turn into a half-marker is refused here, while a repair re-prompt can
 * still fix it, instead of failing the internal schema afterwards.
 *
 * An issue is reported on the field that has to change: the missing half of the
 * pair, or `type` when the marker itself is well-formed. Zod runs an object's
 * checks only once its fields have parsed, so every value here is already a
 * validated string, and — as everywhere in this module — the issue never
 * carries the value that caused it.
 *
 * @param payload The parse payload of a target or an action.
 */
function checkTargetMarker(
  payload: z.core.ParsePayload<{
    readonly file: string;
    readonly symbol: string;
    readonly type: string;
  }>,
): void {
  const namesProjectRoot = lexicallyNormalizePath(payload.value.file) === TARGETLESS_FILE;
  const namesWildcard = payload.value.symbol === TARGETLESS_SYMBOL;

  if (namesProjectRoot !== namesWildcard) {
    payload.issues.push({
      code: 'custom',
      path: [namesProjectRoot ? 'symbol' : 'file'],
      message: TARGETLESS_PAIR_RULE,
      input: undefined,
    });

    return;
  }

  if (namesProjectRoot && isTargetRequiredActionType(payload.value.type)) {
    payload.issues.push({
      code: 'custom',
      path: ['type'],
      message: TARGET_REQUIRED_RULE,
      input: undefined,
    });
  }
}

/**
 * Enforces the targetless marker on a resolved action, plus the one rule only a
 * resolved action can break: a targetless action is installed at runtime.
 *
 * A patch edits one declaration's body, so a patch-mode action with no target
 * has nothing to edit. The mode is supplied by a caller's resolver during
 * normalisation, and a resolver is ordinary code that can be wrong — this is
 * where that mistake is caught, before the installer sees it.
 *
 * @param payload The parse payload of an action.
 */
function checkActionTarget(
  payload: z.core.ParsePayload<{
    readonly file: string;
    readonly symbol: string;
    readonly type: string;
    readonly mode: InstrumentationMode;
  }>,
): void {
  checkTargetMarker(payload);

  if (isTargetlessAction(payload.value) && payload.value.mode !== 'runtime') {
    payload.issues.push({
      code: 'custom',
      path: ['mode'],
      message: TARGETLESS_RUNTIME_RULE,
      input: undefined,
    });
  }
}

/**
 * A single instrumentation target, as authored.
 *
 * `z.strictObject`, so an unrecognised key is a rejection rather than a silent
 * strip. At a process boundary the product prefers tolerance, but this is not a
 * process boundary — it is a model's structured output, and a key the model
 * invented is information: either it misunderstood the schema, in which case
 * the repair loop should tell it so, or the plan carries an instruction this
 * product would silently ignore. Both are worth failing for while there is
 * still a retry available.
 *
 * The four fields are exactly AAP §0.2.3's authoring field set. There is no
 * `adapter`, no `mode` and no `id`: an author does not choose which adapter
 * installs a signal, and an identity is assigned by {@link normalizePlan}.
 *
 * One rule spans fields: a signal that is not about one declaration names the
 * targetless marker — `file` {@link TARGETLESS_FILE} with `symbol`
 * {@link TARGETLESS_SYMBOL}, both or neither — and a
 * {@link TARGET_REQUIRED_ACTION_TYPES} member never does ({@link checkTargetMarker}).
 */
export const instrumentationTargetInputSchema = z
  .strictObject({
    /**
     * The file the target lives in: **project-relative, POSIX separators**.
     *
     * Validated leniently on form and strictly on safety by
     * {@link isAuthoredProjectRelativePath}, so `'./src/lib/thing.ts'` and
     * `'src\\lib\\thing.ts'` are accepted as the cosmetic variants they are,
     * while an absolute path, a drive-letter or UNC path and any `'..'` escape
     * are refused — the repair loop can fix a path that merely looks untidy, and
     * nothing should be able to fix its way out of the project.
     *
     * The value is **not** rewritten here. Parsing stays byte-faithful so that a
     * repair prompt can quote the field as written; {@link normalizePlan} is what
     * turns it into the normal form the internal schema requires.
     *
     * A runtime signal that is not about one declaration — the page-wide render
     * hook, the fetch patch, the interaction observer — names the **targetless
     * marker** instead: {@link TARGETLESS_FILE} here and {@link TARGETLESS_SYMBOL}
     * as the symbol, both together (see {@link checkTargetMarker}). Anything
     * else is a target, and the feasibility gate checks it against the project
     * and the code graph whatever mode it is installed in.
     */
    file: z.string().min(1).max(MAX_FILE_LENGTH).refine(isAuthoredProjectRelativePath, {
      error: PATH_RULE_MESSAGE,
    }),

    /**
     * The function, method, component or route-handler export the action applies
     * to.
     *
     * A name, not a signature and not a code excerpt: the feasibility gate looks
     * it up in the indexed code graph, and the patcher finds the declaration it
     * names. Whitespace-only and control-character values are refused because
     * both are guaranteed to fail that lookup later, far from the place that
     * could have explained them.
     */
    symbol: z.string().min(1).max(MAX_SYMBOL_LENGTH).refine(isIdentifierText, {
      error: 'symbol must be a single-line name with at least one non-whitespace character.',
    }),

    /**
     * Which kind of instrumentation this target asks for. See
     * {@link INSTRUMENTATION_ACTION_TYPES}.
     *
     * This — and only this — is what decides how the action is installed. The
     * adapter and the install mode are *derived* from it during normalisation, by
     * asking the registry which adapter claims the type, so an author never has
     * to know the registry's contents and a third-party adapter can claim a type
     * without a single schema change.
     */
    type: instrumentationActionTypeSchema,

    /**
     * Why this target is in the plan, in one sentence.
     *
     * Optional when authored and **required** after normalisation: an action a
     * developer can see in the editor view without being told why it exists is an
     * unexplained edit to their working tree. When an author omits it,
     * {@link normalizePlan} fills it from the plan's objective, which is a weaker
     * answer than a per-target reason and still better than none.
     */
    rationale: z
      .string()
      .min(1)
      .max(MAX_RATIONALE_LENGTH)
      .refine(isProseText, {
        error: 'rationale must contain at least one non-whitespace character.',
      })
      .optional(),
  })
  .check(checkTargetMarker);

/**
 * A single instrumentation target as authored — the input form, before an
 * adapter, a mode, an id and a rationale have been resolved.
 *
 * Inferred from {@link instrumentationTargetInputSchema} so the validator and
 * the type are one statement.
 */
export type InstrumentationTargetInput = z.infer<typeof instrumentationTargetInputSchema>;

/**
 * The authoring form of an instrumentation plan: what the planning stage's
 * model produces, and what a human writes when they write a plan by hand.
 *
 * This schema accepts AAP §0.1.2's authoring example **verbatim** — an
 * objective, a list of prose capture phrases and targets carrying only a file,
 * a symbol and a type — which is a hard requirement rather than a nicety: that
 * example is the shape the prompt shows the model, and a schema that needed one
 * field more than the example shows would fail every first attempt and spend a
 * repair round earning it back.
 *
 * Every field is bounded and nothing is optional-but-meaningful: a plan with no
 * targets is a legitimate artifact (an objective that the available runtime
 * hooks already cover needs no target at all), and so is a plan with no
 * hypotheses.
 */
export const instrumentationPlanInputSchema = z.strictObject({
  /**
   * What the plan is trying to find out, in one sentence.
   *
   * It is the plan's purpose in the developer's language, it is what the editor
   * view shows above the target list, and it is the fallback rationale for any
   * target that carries none — which is the reason it may not be
   * whitespace-only.
   */
  objective: z.string().min(1).max(MAX_OBJECTIVE_LENGTH).refine(isProseText, {
    error: 'objective must contain at least one non-whitespace character.',
  }),

  /**
   * The signals the plan intends to capture, as **prose for display**.
   *
   * These phrases are shown in the editor's plan and progress view so a
   * developer can read what is about to be collected before anything is
   * installed. They are free text on purpose, and they are deliberately *not*
   * machine-readable.
   *
   * **Nothing may derive behaviour from them.** Matching a phrase with
   * `includes`, a regular expression or an equality test — to decide which hook
   * to enable, which adapter to invoke, or what a panel should contain — is
   * precisely the hardcoded-behaviour pattern AAP §0.5.4 forbids, only wearing
   * a plan's clothes instead of a question's. The machine-readable signal set
   * comes from the typed actions, through `./readiness.ts`'s
   * `deriveAgentHookConfig` and `deriveServerAgentSignals`, and from nowhere
   * else. If a signal needs to be switchable, it needs an action type, not a
   * sentence.
   */
  capture: z
    .array(
      z.string().min(1).max(MAX_CAPTURE_LENGTH).refine(isProseText, {
        error: 'each capture entry must contain at least one non-whitespace character.',
      }),
    )
    .max(MAX_CAPTURE_ENTRIES),

  /**
   * The targets the plan asks to be instrumented, in the order they were
   * authored.
   *
   * **Order is contract, not presentation.** Normalisation preserves it, the
   * installer applies runtime-mode actions before patch-mode ones but keeps the
   * authored order within each mode, and the editor view lists them as
   * authored — so a plan that reads top-to-bottom as a story about one
   * interaction stays that way through every stage.
   *
   * Duplicates are *not* rejected here, and are not removed by normalisation
   * either: `../feasibility.ts` owns the duplicate-action rejection, and it can
   * only own it if the duplicates are still visible when it runs.
   */
  instrumentationTargets: z.array(instrumentationTargetInputSchema).max(MAX_TARGETS),

  /**
   * The explanations the plan is testing, as plain sentences.
   *
   * Optional, and carried through normalisation unchanged (an absent list
   * becomes an empty one) so the analysis stage can see what the plan set out
   * to distinguish between.
   *
   * These are **not** `@debuggen/panel-schema`'s `Hypothesis`. That type is a
   * structured object with a confidence and an optional suggested source
   * location, it is produced by the *analysis* stage from captured evidence,
   * and it is rendered under a panel's "Likely cause" heading. These are
   * strings written *before* any evidence exists, by the stage that decides
   * what to collect. Conflating the two would let a planning-time guess be
   * rendered as an evidenced conclusion, which is the exact separation AAP
   * §0.8.4 keeps structural — and it is why this module does not, and must not,
   * import the panel schema.
   */
  hypotheses: z
    .array(
      z.string().min(1).max(MAX_HYPOTHESIS_LENGTH).refine(isProseText, {
        error: 'each hypothesis must contain at least one non-whitespace character.',
      }),
    )
    .max(MAX_HYPOTHESES)
    .optional(),
});

/**
 * An instrumentation plan in its authoring form.
 *
 * This is the type the planning stage asks the model provider for, and the type
 * {@link normalizePlan} consumes. Inferred from
 * {@link instrumentationPlanInputSchema}, so a field added to the schema
 * appears here in the same edit.
 */
export type InstrumentationPlanInput = z.infer<typeof instrumentationPlanInputSchema>;

/**
 * Validates an unknown value as an {@link InstrumentationPlanInput}, without
 * throwing.
 *
 * This is the first gate of the planning stage: the model's structured output
 * arrives here, and a rejection is what a repair re-prompt is built from —
 * which is why the error names the offending field paths and the rules they
 * broke rather than the values that broke them. Two repairs are permitted, and
 * then the stage falls back to a runtime-only default plan built from the
 * adapters' capabilities (AAP §0.5.3); nothing in this module decides that, but
 * it is the reason a rejection has to be a value rather than an exception.
 *
 * The code is `'MODEL_OUTPUT_INVALID'` because the authoring schema's producer
 * is the model, and that code is what the graceful-failure contract keys the
 * repair path on. A caller validating a *human*-authored plan may `mapErr` it
 * to something that reads better in its own context; the field paths are the
 * part that matters either way.
 *
 * @param value Any value believed to be an authored plan.
 * @returns `ok(input)` with the parsed value, or `err(error)` describing every
 * issue found.
 *
 * @example
 * ```ts
 * const parsed = parseInstrumentationPlanInput(await provider.generateStructured(schema, request));
 * if (!parsed.ok) {
 *   return repairOrFallback(parsed.error);
 * }
 * ```
 */
export function parseInstrumentationPlanInput(value: unknown): Result<InstrumentationPlanInput> {
  const parsed = instrumentationPlanInputSchema.safeParse(value);

  if (parsed.success) {
    return ok(parsed.data);
  }

  return err(
    schemaRejection(
      'MODEL_OUTPUT_INVALID',
      'the instrumentation plan input schema',
      'Re-emit the plan with the reported fields fixed: an objective, prose capture phrases, and targets that each name a project-relative POSIX file, a symbol and one of the known action types.',
      parsed.error.issues,
    ),
  );
}

// ---------------------------------------------------------------------------
// The internal schema: what the rest of the product consumes
//
// Everything optional in the authoring form is resolved here, and every field
// is strict: the normaliser has run, so a value that still needs repairing is a
// defect in this product rather than a mistake by an author, and it is reported
// as one (AAP §0.5.3).
// ---------------------------------------------------------------------------

/**
 * One resolved instrumentation action: a target plus the identity, adapter,
 * install mode and rationale that normalisation supplied.
 *
 * The field order is AAP §0.2.3's, and it is the order a stored plan, a
 * protocol message and a rendered JSON Schema all carry.
 *
 * This is the unit the whole installation path addresses. The feasibility gate
 * checks it against the code graph, the installer applies it (runtime-mode
 * actions first), a `ModificationRecord` in the store references the action
 * that produced it, and a follow-up plan version re-states the actions it keeps
 * **with their original ids** so the installer can apply only the delta.
 *
 * The authoring form's targetless-marker rule holds here too, with one addition
 * only a resolved action can break: a targetless action is runtime-mode, because
 * a patch has no declaration to edit without a target ({@link checkActionTarget}).
 */
export const instrumentationActionSchema = z
  .strictObject({
    /**
     * The action's stable identity, as minted by `newActionId()`.
     *
     * Stable is the operative word: AAP §0.4.2's follow-up path builds
     * `planVersion n + 1` as the previous plan plus additive actions, and the
     * installer applies the delta by id. An action that survives into the next
     * plan version therefore **keeps** its id — {@link normalizePlan} reuses it
     * — and an action whose id changed would be installed a second time on a file
     * the journal already records as instrumented.
     *
     * Validated against {@link ACTION_ID_PATTERN} rather than accepted as any
     * non-empty string, because this value is a store key and a wire identifier;
     * a hand-built id that does not match is a defect worth finding here rather
     * than in a modification record.
     */
    id: z.string().min(1).max(MAX_ID_LENGTH).regex(ACTION_ID_PATTERN, {
      error:
        'id must be an opaque id: a three-letter prefix, "_", then 16 lowercase alphanumerics.',
    }),

    /**
     * The file this action applies to: project-relative POSIX, and already in its
     * own normal form.
     *
     * Stricter than the authoring field on purpose. See
     * {@link isNormalizedProjectRelativePath} for why the normal form is required
     * and not merely preferred: this string participates in the identity key two
     * plan versions are matched on, and in the path the patcher resolves against
     * the project root.
     */
    file: z
      .string()
      .min(1)
      .max(MAX_FILE_LENGTH)
      .refine(isNormalizedProjectRelativePath, {
        error: `${PATH_RULE_MESSAGE} It must also already be normalised (no "./" or "." segments, no duplicate separators).`,
      }),

    /** The symbol the action applies to, carried through from the target. */
    symbol: z.string().min(1).max(MAX_SYMBOL_LENGTH).refine(isIdentifierText, {
      error: 'symbol must be a single-line name with at least one non-whitespace character.',
    }),

    /** Which kind of instrumentation this action installs. */
    type: instrumentationActionTypeSchema,

    /**
     * The id of the adapter that claimed this action's type.
     *
     * A **bounded string, not an enumeration**, and that is a design decision
     * rather than a missing constraint: adapter identity belongs to
     * `../registry.ts`, and AAP §0.4.2 promises that adding an adapter means
     * implementing the interface and registering it, with no orchestrator change.
     * An enumeration here would break that promise for any adapter registered at
     * runtime, and would put this schema module in the position of knowing the
     * registry's contents — which is exactly the import this folder does not
     * make.
     *
     * The value is supplied by the caller's {@link PlanAdapterResolver} during
     * normalisation, and it is what the installer looks the adapter back up by.
     */
    adapter: z.string().min(1).max(MAX_ADAPTER_ID_LENGTH).refine(isIdentifierText, {
      error: 'adapter must be a single-line adapter id with at least one non-whitespace character.',
    }),

    /**
     * How this action is installed — and, because of it, whether a developer's
     * file is touched. See {@link INSTRUMENTATION_MODES}.
     *
     * Resolved from the action type by the registry, never chosen by an author:
     * the adapter that claims a type is the thing that knows whether it can be
     * satisfied by a runtime hook.
     */
    mode: instrumentationModeSchema,

    /**
     * Why this action is in the plan. **Required** here, unlike in the authoring
     * form.
     *
     * Every action is shown to the developer — in the editor's plan and
     * modification lists, and in the panel's session summary — and an
     * instrumentation step with no stated reason is an unexplained change to
     * their project. Normalisation guarantees a value by falling back to the
     * plan's objective, so this field can be required without costing the author
     * a repair round.
     */
    rationale: z.string().min(1).max(MAX_RATIONALE_LENGTH).refine(isProseText, {
      error: 'rationale must contain at least one non-whitespace character.',
    }),
  })
  .check(checkActionTarget);

/**
 * A resolved instrumentation action.
 *
 * The type `./readiness.ts` derives hook configuration from, `../adapter.ts`
 * accepts in `install`, `../feasibility.ts` checks against the code graph and
 * `@debuggen/protocol` embeds in `instrumentation.plan` and
 * `instrumentation.ready`.
 */
export type InstrumentationAction = z.infer<typeof instrumentationActionSchema>;

/**
 * A normalised instrumentation plan: the artifact the installer, the store, the
 * protocol and both user interfaces share.
 *
 * Field set and order are AAP §0.2.3's. Nothing here is optional, because
 * normalisation resolves every authoring-time absence: an omitted hypothesis
 * list becomes an empty array rather than a missing key, so a consumer never
 * has to distinguish "no hypotheses" from "a producer that did not know about
 * hypotheses".
 */
export const instrumentationPlanSchema = z.strictObject({
  /**
   * The version of *this shape*, always {@link INSTRUMENTATION_PLAN_VERSION}.
   *
   * A literal rather than a number, so a plan written against a future shape
   * fails to parse here instead of being read as though it were this one. It is
   * not the plan's revision counter — that is `planVersion`.
   */
  version: z.literal(INSTRUMENTATION_PLAN_VERSION),

  /**
   * Which revision of this session's plan this is: 1-based, and incremented
   * once per follow-up that needs new instrumentation.
   *
   * AAP §0.4.2's follow-up path makes `planVersion n + 1` the previous plan
   * **plus** additive actions, never removing an installed one, so that cleanup
   * can restore a file's modification chain in strict reverse order. Building
   * that union — deciding which previous actions carry over and which delta
   * actions are new — is the service's job in `stages/followup.ts`, not this
   * module's: {@link normalizePlan} is handed the version to stamp and the
   * previous actions whose ids it should reuse, and it stamps and reuses.
   *
   * The store keys plans and modification records on `(sessionId, planVersion)`,
   * which is why it is a required integer here rather than something a consumer
   * derives by counting.
   */
  planVersion: z.int().min(1),

  /**
   * The session this plan belongs to: the opaque `ses_`-prefixed id from
   * `@debuggen/shared`.
   *
   * A plain bounded string, deliberately not branded and deliberately not
   * pinned to the `ses_` shape. The id aliases in `@debuggen/shared` are
   * unbranded by design, and a plan is also parsed back out of the store and
   * off the wire by processes that only pass the value through; pinning the
   * prefix here would make this module an arbiter of a vocabulary it does not
   * own, with nothing gained — the session's existence is checked by the
   * service against the store, which is the only check that can actually
   * establish it.
   */
  sessionId: z.string().min(1).max(MAX_ID_LENGTH).refine(isIdentifierText, {
    error: 'sessionId must be a single-line id with at least one non-whitespace character.',
  }),

  /** What the plan is trying to find out. Carried through unchanged. */
  objective: z.string().min(1).max(MAX_OBJECTIVE_LENGTH).refine(isProseText, {
    error: 'objective must contain at least one non-whitespace character.',
  }),

  /**
   * The explanations the plan is testing, as plain sentences; empty when the
   * author offered none.
   *
   * Still not `@debuggen/panel-schema`'s `Hypothesis` — see the note on the
   * authoring schema's field.
   */
  hypotheses: z
    .array(
      z.string().min(1).max(MAX_HYPOTHESIS_LENGTH).refine(isProseText, {
        error: 'each hypothesis must contain at least one non-whitespace character.',
      }),
    )
    .max(MAX_HYPOTHESES),

  /**
   * The signals the plan intends to capture, as prose for display.
   *
   * Carried through normalisation verbatim, and still not a machine-readable
   * signal set: see the authoring schema's field for why nothing may read these
   * for meaning.
   */
  capture: z
    .array(
      z.string().min(1).max(MAX_CAPTURE_LENGTH).refine(isProseText, {
        error: 'each capture entry must contain at least one non-whitespace character.',
      }),
    )
    .max(MAX_CAPTURE_ENTRIES),

  /**
   * The resolved actions, in the order they were authored.
   *
   * Named `instrumentationTargets` rather than `actions` because AAP §0.2.3
   * names it so on both the authoring and the normalised shape: the authored
   * key survives normalisation, so a developer reading a plan in the editor and
   * a plan in the store is reading the same document.
   *
   * Duplicates are representable. `../feasibility.ts` rejects them with a
   * `duplicate-action` finding, which it can only do if normalisation left them
   * in place — and it does.
   */
  instrumentationTargets: z.array(instrumentationActionSchema).max(MAX_TARGETS),
});

/**
 * A normalised instrumentation plan.
 *
 * Stored on the session record's `plans` array (by `planVersion`), sent in the
 * `instrumentation.plan` message to both the editor and the DevTools panel, and
 * handed to the installer.
 */
export type InstrumentationPlan = z.infer<typeof instrumentationPlanSchema>;

/**
 * Validates an unknown value as an {@link InstrumentationPlan}, without
 * throwing.
 *
 * This is how a plan that arrived from somewhere else becomes a typed value: a
 * row read back out of the session store when a session is reopened, a
 * `instrumentation.plan` payload received by an extension, a plan handed to the
 * installer by a caller that did not build it here.
 *
 * The code is `'PLAN_INVALID'`, which the error vocabulary defines as a
 * normalised plan failing its internal schema — **a product defect, logged with
 * the input rather than retried against the model** (AAP §0.5.3). A caller must
 * not turn this into a repair re-prompt: the model never sees this shape, so
 * re-prompting could not fix it and would only spend a round trip proving so.
 *
 * @param value Any value believed to be a normalised plan.
 * @returns `ok(plan)` with the parsed value, or `err(error)` describing every
 * issue found.
 */
export function parseInstrumentationPlan(value: unknown): Result<InstrumentationPlan> {
  const parsed = instrumentationPlanSchema.safeParse(value);

  if (parsed.success) {
    return ok(parsed.data);
  }

  return err(
    schemaRejection(
      'PLAN_INVALID',
      'the normalised instrumentation plan schema',
      'This is a defect in whatever produced the plan, not in an authored one: the reported field paths identify it. Do not re-prompt the model.',
      parsed.error.issues,
    ),
  );
}

// ---------------------------------------------------------------------------
// The registry seam
//
// Normalisation needs one fact this module must not know: which adapter claims
// an action type, and whether that adapter installs it as a runtime hook or as
// a patch. Importing `../registry.ts` to find out would make `schema/` depend
// on a module that depends on `schema/` — the cycle this folder's layering
// exists to prevent, and one `tsc -b` and the package's lint layering block
// would both reject. So the requirement is declared here as a structural
// interface and satisfied by the caller: the registry object implements it
// as-is, `../feasibility.ts` accepts it, and a test can satisfy it with an
// object literal.
// ---------------------------------------------------------------------------

/**
 * What the registry answers when asked about an action type: which adapter
 * claims it, and how that adapter installs it.
 */
export interface AdapterActionResolution {
  /**
   * The claiming adapter's id, as registered.
   *
   * A string for the reason {@link instrumentationActionSchema}'s `adapter`
   * field is one: the registry owns adapter identity, and a third-party adapter
   * may register at runtime.
   */
  readonly adapter: string;

  /**
   * Whether the adapter installs this type as a runtime hook or as a reversible
   * patch to the developer's file.
   */
  readonly mode: InstrumentationMode;
}

/**
 * The one question {@link normalizePlan} asks its caller.
 *
 * Structural on purpose — any object with this method satisfies it, so nothing
 * has to be imported in either direction. The adapter registry is the
 * production implementation; a suite can pass a literal.
 *
 * An implementation returns `undefined` for a type no registered adapter
 * claims, which normalisation treats as a rejection of the whole plan rather
 * than as a reason to drop the action (AAP §0.2.3). It must be free of side
 * effects and stable within a call: normalisation asks once per target and
 * relies on the answer being the same for the same type.
 */
export interface PlanAdapterResolver {
  /**
   * Resolves the adapter and install mode for one action type.
   *
   * @param type The action type to resolve.
   * @returns The claiming adapter's id and install mode, or `undefined` when no
   * registered adapter claims the type.
   */
  resolveActionType(type: InstrumentationActionType): AdapterActionResolution | undefined;
}

/**
 * Encodes one component of an identity key so that it delimits itself: its
 * length in UTF-16 code units, a `':'`, then the value verbatim.
 *
 * Self-delimiting is the whole point. A length is a digit run and contains no
 * `':'`, so the first `':'` in an encoded component always ends the length, and
 * the component is then exactly that many code units regardless of what those
 * code units are — digits, colons, separators or anything else. A concatenation
 * of such components is therefore uniquely decodable, which is the property
 * {@link actionIdentityKey} needs and which no escaping scheme gets for free.
 *
 * @param value The component to encode. Any string, including an empty one.
 * @returns The length-prefixed component.
 */
function lengthPrefixed(value: string): string {
  return `${String(value.length)}:${value}`;
}

/**
 * The identity of an action: an unambiguous encoding of `(file, symbol, type)`.
 *
 * Three things use this key, and all three need the *same* definition of "the
 * same action", which is why it is a function here rather than an expression
 * repeated in each of them:
 *
 * - {@link normalizePlan}, to reuse the id of an action that survives from a
 *   previous plan version, so a follow-up delta can address by id.
 * - `../installer.ts`, to match a new plan version's actions against the ones
 *   already applied and install only the difference.
 * - `../feasibility.ts`, to report two targets that ask for the same
 *   instrumentation on the same symbol as a duplicate action.
 *
 * Identity is deliberately `(file, symbol, type)` and nothing else. The
 * rationale is prose that a follow-up may legitimately reword, the adapter and
 * the mode are derived from the type, and the id is the thing being looked up —
 * including any of them would make an action that was merely re-explained look
 * like a new one, and re-instrument a file that is already instrumented.
 *
 * **The encoding is injective, and that is load-bearing rather than tidy.**
 * Joining the three components with a separator does not work, because every
 * plausible separator is a legal character in two of them: the schemas above
 * refuse control characters and nothing else inside a path or a symbol, so
 * `'|'` — valid in a POSIX file name and in the text of a symbol — would give
 * `('src/a|b.ts', 'x')` and `('src/a', 'b.ts|x')` one key for two different
 * actions, and each consumer would then mis-associate. Normalisation would hand
 * one action's id to the other; the installer would read a new action as
 * already applied and skip it, or consume the surviving action's id and patch a
 * file the journal already records as instrumented; the feasibility gate would
 * report two unrelated targets as a duplicate. AAP §0.4.2's modification chain
 * — the one cleanup restores in strictly reverse order — hangs off those ids,
 * so a collision is a file that does not come back.
 *
 * Each component is therefore written length-prefixed by {@link lengthPrefixed}
 * and the three are concatenated, which makes distinct triples produce distinct
 * keys whatever the components contain, with no character excluded and no
 * escaping to get wrong.
 *
 * The result is still an **opaque** key: compare it, group by it, use it as a
 * `Map` key, but do not parse it back apart. Unique decodability is what makes
 * comparing it sound, not an interface this module offers. It carries no
 * control character whenever its inputs carry none — which both schemas above
 * already guarantee — so it is safe to name in a log line.
 *
 * @param target Anything carrying a normalised `file`, a `symbol` and a `type`
 * — an {@link InstrumentationAction} or a bare triple.
 * @returns The identity key.
 */
export function actionIdentityKey(target: {
  readonly file: string;
  readonly symbol: string;
  readonly type: InstrumentationActionType;
}): string {
  return lengthPrefixed(target.file) + lengthPrefixed(target.symbol) + lengthPrefixed(target.type);
}

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

/**
 * Everything {@link normalizePlan} needs that an authored plan does not carry.
 *
 * All four supplied fields come from the session, not from the model: an author
 * proposes what to instrument, and the service decides which session and which
 * plan version it belongs to. That division is what keeps a model's output from
 * being able to address a session other than the one it was asked about.
 */
export interface NormalizePlanContext {
  /**
   * The session this plan belongs to — the `ses_`-prefixed id from
   * `@debuggen/shared`.
   */
  readonly sessionId: string;

  /**
   * The revision number to stamp on the plan: `1` for a session's first plan,
   * `n + 1` for the plan a follow-up builds on version `n`.
   */
  readonly planVersion: number;

  /** How to resolve each action type to an adapter and an install mode. */
  readonly resolver: PlanAdapterResolver;

  /**
   * The actions of the previous plan version, when this is a follow-up.
   *
   * Their ids are reused for any action that appears again — matched by
   * {@link actionIdentityKey}, one previous action to one new action — so an
   * action that survives into `planVersion n + 1` keeps the id the installer,
   * the store and every modification record already know it by. Pass the
   * previous version's `instrumentationTargets` verbatim; anything not matched
   * is simply not reused.
   *
   * A malformed entry is a rejection rather than something to skip: losing an
   * id silently is how an already-instrumented file gets patched twice.
   */
  readonly previousActions?: readonly InstrumentationAction[] | undefined;

  /**
   * An id factory to mint new action ids with, defaulting to `newActionId()`
   * from `@debuggen/shared`.
   *
   * Injected so a suite can assert an exact expected plan object, which is the
   * only part of normalisation that is not otherwise deterministic. A factory
   * must mint a *distinct* id per call that matches
   * {@link ACTION_ID_PATTERN} — a constant factory will produce a plan whose
   * actions share an identity, which this module does not attempt to detect
   * because id uniqueness belongs to whoever mints ids.
   */
  readonly newActionId?: (() => string) | undefined;
}

/**
 * Checks the context {@link normalizePlan} was called with.
 *
 * The context comes from first-party code, so a failure here is a programming
 * error rather than anything an author or a model did — hence `'INTERNAL'`,
 * and hence checking at all despite the types: this module is published as
 * JavaScript with declarations, and the service, both extensions and a test can
 * all reach it without the compiler in the room.
 *
 * @returns The error describing the first problem found, or `undefined` when
 * the context is usable.
 */
function validateNormalizeContext(context: NormalizePlanContext): DebuggenError | undefined {
  const candidate: unknown = context;

  if (typeof candidate !== 'object' || candidate === null) {
    return new DebuggenError('INTERNAL', 'normalizePlan was called without a context object.', {
      hint: 'Pass { sessionId, planVersion, resolver } — the session the plan belongs to, the plan version to stamp, and the adapter registry.',
      details: { field: 'context' },
    });
  }

  if (typeof context.sessionId !== 'string' || !isIdentifierText(context.sessionId)) {
    return new DebuggenError('INTERNAL', 'normalizePlan was called with an empty sessionId.', {
      hint: "Pass the session's id; a plan cannot be stored or addressed without it.",
      details: { field: 'context.sessionId' },
    });
  }

  if (!Number.isSafeInteger(context.planVersion) || context.planVersion < 1) {
    return new DebuggenError(
      'INTERNAL',
      'normalizePlan was called with a planVersion that is not a positive integer.',
      {
        hint: "Pass 1 for a session's first plan, and the previous version plus one for a follow-up.",
        details: { field: 'context.planVersion' },
      },
    );
  }

  const resolver: unknown = context.resolver;
  if (
    typeof resolver !== 'object' ||
    resolver === null ||
    typeof context.resolver.resolveActionType !== 'function'
  ) {
    return new DebuggenError('INTERNAL', 'normalizePlan was called without an adapter resolver.', {
      hint: 'Pass the adapter registry, or any object with a resolveActionType(type) method, as context.resolver.',
      details: { field: 'context.resolver' },
    });
  }

  if (context.previousActions !== undefined && !Array.isArray(context.previousActions)) {
    return new DebuggenError(
      'INTERNAL',
      'normalizePlan was called with previousActions that is not an array.',
      {
        hint: "Pass the previous plan version's instrumentationTargets array, or omit the field.",
        details: { field: 'context.previousActions' },
      },
    );
  }

  if (context.newActionId !== undefined && typeof context.newActionId !== 'function') {
    return new DebuggenError(
      'INTERNAL',
      'normalizePlan was called with a newActionId that is not a function.',
      {
        hint: 'Omit the field to use the default id generator, or pass a function that mints a distinct opaque id per call.',
        details: { field: 'context.newActionId' },
      },
    );
  }

  return undefined;
}

/**
 * Trims a value to a maximum length without breaking a surrogate pair.
 *
 * Defensive rather than load-bearing: the only value normalisation composes is
 * a rationale, and both of its sources are already bounded by the authoring
 * schema at the same limit. It exists so that the invariant "the rationale fits
 * the internal schema" is stated by the code that produces it rather than
 * inferred from two other bounds staying equal, and so the internal schema can
 * never reject a plan over a length this module chose.
 */
function clampText(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  const clamped = value.slice(0, maxLength);
  const lastCode = clamped.charCodeAt(clamped.length - 1);
  const isLoneHighSurrogate = lastCode >= 0xd800 && lastCode <= 0xdbff;

  return isLoneHighSurrogate ? clamped.slice(0, -1) : clamped;
}

/**
 * Turns an authored plan into the normalised plan the rest of the product
 * consumes — deterministically, and **without ever throwing**.
 *
 * This is the deterministic half of AAP §0.5.3's pipeline. The model's output
 * has already been accepted by {@link instrumentationPlanInputSchema} (and
 * repaired up to twice if it was not) by the time this runs, so a failure here
 * is a product defect rather than a model mistake: it is logged with the input
 * and never retried against the model. A thrown exception would be that same
 * unretryable failure expressed as control flow, in a call the caller cannot
 * usefully wrap — so every failure is an `Err`, including an unexpected one,
 * and the caller has exactly one shape to handle.
 *
 * What it does, in order:
 *
 * 1. Checks the context (`'INTERNAL'` on failure).
 * 2. Parses the input through the authoring schema — defensively, so an
 *    already-validated object is simply re-accepted (`'MODEL_OUTPUT_INVALID'`).
 * 3. For each target, **in authored order**: normalises the path lexically and
 *    requires it to be project-relative (`'PATH_OUTSIDE_PROJECT'`); asks the
 *    resolver which adapter claims the type and refuses the **whole plan** when
 *    none does (`'INSTRUMENTATION_UNAVAILABLE'`); fills the rationale from the
 *    objective when the author omitted one; and reuses a previous action's id
 *    when the target is one that survived, minting a fresh id otherwise.
 * 4. Stamps `version`, `planVersion` and `sessionId`, defaults `hypotheses` to
 *    an empty array, and validates the result against
 *    {@link instrumentationPlanSchema} (`'PLAN_INVALID'`).
 *
 * What it deliberately does not do: deduplicate targets, reorder them, drop an
 * action it cannot resolve, merge a previous plan version's actions into this
 * one, consult a clock or a random source beyond the id factory, or read any
 * `capture` phrase for meaning.
 *
 * Determinism is a property callers rely on: the same input with the same
 * injected id factory produces an identical plan object, which is what lets a
 * suite assert an exact expected value and what makes a re-run of a stored plan
 * reproducible.
 *
 * @param input The authored plan — a model's structured output, a
 * hand-written plan, or an {@link InstrumentationPlanInput} already parsed.
 * @param context The session id, plan version, adapter resolver and optional
 * previous actions and id factory. See {@link NormalizePlanContext}.
 * @returns `ok(plan)` with the normalised plan, or `err(error)` explaining
 * which target and which field made it impossible.
 *
 * @example
 * ```ts
 * // A follow-up: version 2 keeps the ids of the actions it carries over.
 * const next = normalizePlan(authored, {
 *   sessionId: session.id,
 *   planVersion: previous.planVersion + 1,
 *   resolver: adapterRegistry,
 *   previousActions: previous.instrumentationTargets,
 * });
 * ```
 */
export function normalizePlan(
  input: unknown,
  context: NormalizePlanContext,
): Result<InstrumentationPlan, DebuggenError> {
  try {
    const contextError = validateNormalizeContext(context);
    if (contextError !== undefined) {
      return err(contextError);
    }

    const parsed = parseInstrumentationPlanInput(input);
    if (!parsed.ok) {
      return err(parsed.error);
    }

    const authored = parsed.value;
    const objectiveRationale = authored.objective.trim();

    // Previous ids, grouped by identity and consumed one at a time. A queue
    // rather than a single value per key so that two identical targets reuse
    // two distinct previous ids instead of collapsing onto one: duplicates are
    // legal here and are the feasibility gate's to report.
    const reusableIds = new Map<string, string[]>();
    for (const [index, previous] of (context.previousActions ?? []).entries()) {
      const candidate: unknown = previous;

      // A malformed previous action is refused rather than skipped, and the
      // difference matters: skipping it would cost a surviving action its id,
      // the installer would read that action as new, and it would patch a file
      // the journal already records as instrumented. Failing here keeps the
      // follow-up chain honest, and says which entry broke it.
      if (
        typeof candidate !== 'object' ||
        candidate === null ||
        typeof previous.id !== 'string' ||
        previous.id.length === 0 ||
        typeof previous.file !== 'string' ||
        typeof previous.symbol !== 'string' ||
        !isInstrumentationActionType(previous.type)
      ) {
        return err(
          new DebuggenError(
            'INTERNAL',
            `normalizePlan was called with a previousActions entry at index ${String(index)} that is not an instrumentation action.`,
            {
              hint: "Pass the previous plan version's instrumentationTargets verbatim, or omit the field when there is no previous version.",
              details: { field: `context.previousActions.${String(index)}` },
            },
          ),
        );
      }

      const key = actionIdentityKey(previous);
      const queue = reusableIds.get(key);
      if (queue === undefined) {
        reusableIds.set(key, [previous.id]);
      } else {
        queue.push(previous.id);
      }
    }

    const mintActionId = context.newActionId ?? newActionId;
    const actions: InstrumentationAction[] = [];

    for (const [index, target] of authored.instrumentationTargets.entries()) {
      const file = lexicallyNormalizePath(target.file);

      // The authoring schema ran the same check, so this only fires for an
      // input that bypassed it or a normalisation that produced something the
      // strict form rejects. PATH_OUTSIDE_PROJECT is the containment failure
      // the error vocabulary defines, and it is reported with the target's
      // index because a plan can name the same file more than once.
      if (!isNormalizedProjectRelativePath(file)) {
        return err(
          new DebuggenError(
            'PATH_OUTSIDE_PROJECT',
            `Target ${String(index)} names a file that is not project-relative.`,
            {
              hint: 'Name the file relative to the project root with forward slashes: no absolute or drive-letter path, no UNC prefix and no ".." segment.',
              details: {
                field: `instrumentationTargets.${String(index)}.file`,
                targetIndex: index,
                actionType: target.type,
              },
            },
          ),
        );
      }

      const resolution = context.resolver.resolveActionType(target.type);

      // AAP §0.2.3: an action no adapter claims rejects the plan. Dropping it
      // instead would be worse than failing — the plan shown to the developer
      // and the plan that was installed would differ, and the analysis would
      // be missing a signal nobody said was missing. The code is the closest
      // member of the instrumentation family: the planned signal cannot be
      // enabled on this machine, which is what INSTRUMENTATION_UNAVAILABLE
      // reports.
      if (resolution === undefined) {
        return err(
          new DebuggenError(
            'INSTRUMENTATION_UNAVAILABLE',
            `No registered adapter claims the action type "${target.type}" asked for by target ${String(index)}.`,
            {
              hint: 'Register an adapter that handles this action type, or re-plan using a type one of the registered adapters claims.',
              details: {
                field: `instrumentationTargets.${String(index)}.type`,
                targetIndex: index,
                actionType: target.type,
              },
            },
          ),
        );
      }

      const authoredRationale = target.rationale?.trim() ?? '';
      const rationale = clampText(
        authoredRationale.length > 0 ? authoredRationale : objectiveRationale,
        MAX_RATIONALE_LENGTH,
      );

      // One previous id per surviving target, so a follow-up delta can address
      // by id (AAP §0.4.2). `shift` is what makes the match one-to-one.
      const reusedId = reusableIds
        .get(actionIdentityKey({ file, symbol: target.symbol, type: target.type }))
        ?.shift();

      actions.push({
        id: reusedId ?? mintActionId(),
        file,
        symbol: target.symbol,
        type: target.type,
        adapter: resolution.adapter,
        mode: resolution.mode,
        rationale,
      });
    }

    // The resolver's answers are first-party but unvalidated until here: an
    // adapter id or a mode it got wrong surfaces as a PLAN_INVALID naming the
    // exact field, which is the §0.5.3 product-defect path rather than
    // anything to re-prompt.
    return parseInstrumentationPlan({
      version: INSTRUMENTATION_PLAN_VERSION,
      planVersion: context.planVersion,
      sessionId: context.sessionId,
      objective: authored.objective,
      hypotheses: authored.hypotheses ?? [],
      capture: authored.capture,
      instrumentationTargets: actions,
    });
  } catch (caught) {
    // Nothing above is expected to throw: every schema call is a `safeParse`,
    // the path helpers are total, and the only foreign code is the caller's
    // resolver and id factory. If one of those throws, §0.5.3 still forbids a
    // retry, so the failure becomes the same value-shaped rejection as the
    // rest — with the original attached as the cause for the log.
    //
    // The context is deliberately not read here. A field read is not free of
    // risk on an object this module did not build — an accessor can throw, and
    // one that threw during validation is exactly how this handler is reached
    // — and a throw from inside a catch block would escape the promise this
    // function makes.
    return err(
      new DebuggenError('INTERNAL', 'Instrumentation plan normalisation failed unexpectedly.', {
        hint: 'No instrumentation was applied. Report the logged cause; a repair re-prompt cannot fix a normalisation failure.',
        cause: caught,
      }),
    );
  }
}
