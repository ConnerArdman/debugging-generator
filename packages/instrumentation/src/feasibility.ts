/**
 * The **pre-install feasibility gate**: the last thing that looks at an
 * instrumentation plan before anything is written into a developer's project.
 *
 * Its job in one clause: reject the actions whose file or symbol is absent from
 * the code graph. It sits here in the sequence a model's proposal travels
 * through:
 *
 * ```text
 * model output
 *   → instrumentationPlanInputSchema   (authoring schema; ≤ 2 repair re-prompts)
 *   → normalizePlan(...)               (deterministic; adapter + mode resolved)
 *   → instrumentationPlanSchema        (internal schema)
 *   → checkPlanFeasibility(...)        ← this module
 *   → installPlan(...)                 (runtime hooks, then patches)
 * ```
 *
 * By the time a plan reaches here it is *well-formed*: every action names a
 * normalised project-relative file, a symbol, a known action type, a claiming
 * adapter and an install mode. None of that establishes that the action can
 * actually be carried out on **this** project, which is a different question
 * with a different authority — the code graph, the loaded syntax tree and the
 * adapter registry — and it is the question answered here.
 *
 * ## Who calls this, and what they do with the answer
 *
 * - `./installer.ts` runs it as its pre-install gate: every
 *   {@link InfeasibleAction} becomes an `UnavailableSignal`
 *   (`../adapter.ts`) whose `reason` and `hint` are rendered verbatim into the
 *   developer-facing sentence "Could not enable ‹signal›: ‹reason›. Continuing
 *   with: ‹enabled list›." — and the action is dropped rather than attempted.
 * - `apps/local-service/src/pipeline/stages/plan.ts` runs it immediately after
 *   normalisation, so a plan that would instrument nothing is caught while the
 *   session can still fall back to a runtime-only default plan. Its rejections
 *   become `session.progress` detail and, where nothing at all survives,
 *   `instrumentation.failed` detail.
 *
 * Both callers get **data, not exceptions**: a rejection is a finding on the
 * report, because "this target cannot be instrumented" is an ordinary answer
 * about an ordinary project, and it has to reach the developer as an
 * explanation rather than as a stack trace. A thrown
 * {@link DebuggenError} here means something else entirely — a context that is
 * missing the graph queries every check is made against, which is a
 * programming error in the caller and not a statement about the project.
 *
 * ## Every target is checked, whatever installs it
 *
 * An action either names a target — one file and one symbol — or names the
 * **targetless marker** (`TARGETLESS_FILE` with `TARGETLESS_SYMBOL`, from
 * `./schema/plan.ts`), which is how a page-wide or process-wide runtime signal
 * says it is about no single declaration. A target is checked against the
 * project and the code graph in **both** install modes: a runtime action that
 * names a component the project does not have would otherwise be reported as
 * validated while its hook armed over the whole document, and the plan the
 * developer reads would describe a subject that does not exist. The marker is
 * accepted without a lookup, because there is nothing to look up — and refused
 * for the action types that wrap one declaration, which have no meaning without
 * a target.
 *
 * ## One resolver, shared with the patcher
 *
 * For a patch-mode action, *which declaration* the spelling names is decided by
 * `./patch/target-resolver.ts` — the resolver `./patch/function-timing.ts` runs
 * immediately before it writes. The two therefore agree by construction on the
 * qualified spellings, on module scope before nested scope, on refusing a bare
 * name two nested declarations share, on a nested declaration's owner and on
 * the positions no wrapper can reach: a target this gate accepts resolves to
 * the declaration the patcher will rewrite, and one it refuses is one the
 * patcher would refuse.
 *
 * ## Necessary, deliberately not sufficient
 *
 * The gate stays cheap on purpose: the code graph, and at most one parsed file
 * per patch-mode action, read and never edited. It does **not** run the support
 * checks that depend on the emitted wrapper, which `./patch/function-timing.ts`
 * keeps beside its template: an already-instrumented target, a React component
 * or hook, a body that reaches for `super` or `new.target`, and a sloppy-mode
 * body whose `arguments` object is observable. Those need the whole transform;
 * reaching for it here would make every planning round pay for the patch layer.
 * The one wrapper constraint this gate owns outright — a generator cannot be
 * wrapped — is checked here, on the declaration the shared resolver returned.
 *
 * What this module guarantees is the half the planner needs: a plan that passes
 * it names files and symbols that exist, and patch targets that resolve to one
 * declaration, so the patcher's remaining refusals are about the *body* of real
 * code rather than about a target the model invented. A rejection is therefore
 * always actionable, and never "re-index and try again" for a project whose
 * index is perfectly correct.
 *
 * ## No side effects, and none available
 *
 * Nothing here writes a file, opens a socket, reads an environment variable,
 * touches a clock or mutates module state. Every fact arrives on the
 * {@link InstrumentationContext} the service built (`../adapter.ts` records why
 * that is an argument and not an import), and the only work done is reading the
 * graph, asking its bounded query surface, and walking the syntax tree of at
 * most one file per action.
 */

import { Node } from 'ts-morph';
import type { SourceFile } from 'ts-morph';

import { DebuggenError, isErr, normalizePosix, resolveWithinProject } from '@debuggen/shared';
import type {
  CodeGraph,
  CodeNode,
  CodeNodeKind,
  CodeQueries,
  LoadedProject,
  SymbolDeclarationKind,
} from '@debuggen/code-analysis';

import type { InstrumentationContext } from './adapter.js';
import {
  NON_ADDRESSABLE_CLAUSES,
  PATCH_NON_ADDRESSABLE_POSITIONS,
  parseSymbolSpelling,
  resolvePatchTarget,
} from './patch/target-resolver.js';
import type {
  PatchNonAddressablePosition,
  PatchableFunctionNode,
  ResolvedTarget,
  SymbolSpelling,
} from './patch/target-resolver.js';
import { reactComponentSite } from './patch/function-timing.js';
import {
  TARGETLESS_FILE,
  TARGETLESS_SYMBOL,
  actionIdentityKey,
  isTargetRequiredActionType,
  isTargetlessAction,
} from './schema/plan.js';
import type {
  InstrumentationAction,
  InstrumentationPlan,
  PlanAdapterResolver,
} from './schema/plan.js';

// ---------------------------------------------------------------------------
// Bounds
//
// Every string this module composes is shown in two user interfaces and
// written to a log line, and every collection it builds is derived from a
// model's output, so each one is bounded. A `reason` or a `hint` that wrapped a
// panel row or a progress line would be a worse answer than a shorter one.
// ---------------------------------------------------------------------------

/**
 * Longest file path, symbol name or adapter id echoed into a `reason` or a
 * `hint`, in Unicode code points.
 *
 * Long enough for a deeply nested project-relative path to be recognisable and
 * short enough to fit the single-line rows both user interfaces render into.
 * Anything longer is truncated with an ellipsis by {@link reportable}, which
 * never silently shortens a value.
 */
const MAX_REPORTED_TEXT_LENGTH = 120;

/**
 * Most near-miss candidates named in a `symbol-not-found` hint.
 *
 * Three is the number that turns "no such symbol" into an actionable sentence —
 * "the name is declared in ‹other file›" — without turning a rejection into a
 * search result. The candidates come from the bounded
 * {@link CodeQueries.findByName}, whose own ranking is deterministic, so the
 * three are the same three on every run.
 */
const MAX_NEAR_MISS_CANDIDATES = 3;

/**
 * Longest hint taken over from the shared target resolver, in Unicode code
 * points.
 *
 * The resolver's hints are built from vocabulary and declaration names only —
 * the spellings that would disambiguate a target, the enclosing declaration to
 * time instead — so they are safe to show, and they are the most specific next
 * step available. They are still bounded here, because each name in them came
 * from a developer's file and this module promises single-line rows of a
 * predictable length.
 */
const MAX_REPORTED_HINT_LENGTH = 360;

/**
 * The graph node kinds that *declare* a name, as opposed to mentioning it.
 *
 * The same three `hasSymbol` treats as declarations: a `handler` node is a
 * binding site and an `api-call` or `db-call` node is a call site, and neither
 * may corroborate the owner a qualified spelling names.
 */
const DECLARING_NODE_KINDS: readonly CodeNodeKind[] = Object.freeze([
  'symbol',
  'component',
  'server-function',
]);

/**
 * The `symbol` declaration kinds that declare nothing an action can address —
 * types vanish before anything runs, and `unknown` says nothing about a body —
 * so they cannot corroborate an owner either, exactly as they cannot satisfy
 * `hasSymbol`.
 */
const NON_ADDRESSABLE_DECLARATION_KINDS: readonly SymbolDeclarationKind[] = Object.freeze([
  'type',
  'interface',
  'enum',
  'unknown',
]);

// ---------------------------------------------------------------------------
// The rejection vocabulary
// ---------------------------------------------------------------------------

/**
 * Every reason this gate refuses an action, as stable machine-readable codes.
 *
 * Two audiences, and the split is why a code exists at all beside the prose:
 * `./installer.ts` and the service **branch** on the code (an
 * `ast-unavailable` is a project-configuration problem, a `symbol-not-found` is
 * a planning problem, a `duplicate-action` is neither and needs no developer
 * action at all), while the developer reads
 * {@link InfeasibleAction.reason} and {@link InfeasibleAction.hint}. A code is
 * therefore never shown on its own — a refusal reaches the developer as an
 * explanation they can act on, and an internal identifier is not one.
 *
 * - `'no-adapter'` — no registered adapter claims the action's type, so nothing
 *   would install it whatever its file says. Only reported when a resolver was
 *   supplied; see {@link FeasibilityOptions.resolver}.
 * - `'target-required'` — the action names the targetless marker, but it is a
 *   patch-mode action or of a type that wraps one named declaration
 *   (`TARGET_REQUIRED_ACTION_TYPES` in `./schema/plan.ts`), so there is nothing
 *   for it to install on.
 * - `'path-outside-project'` — the action's `file` is not a safe
 *   project-relative POSIX path, or resolves outside the project root. The one
 *   rejection that is a containment decision rather than a capability one.
 * - `'file-not-indexed'` — the code graph holds no entry for the file, so
 *   nothing is known about what it declares.
 * - `'symbol-not-found'` — the file is indexed and declares no addressable
 *   symbol of that name, or — for a qualified spelling — none under the class
 *   or enclosing declaration the spelling names.
 * - `'ambiguous-symbol'` — the file declares the name more than once where the
 *   spelling cannot tell the declarations apart (two nested functions of one
 *   name, say), so the patcher would refuse to guess which one to wrap. The
 *   hint names the qualified spellings that do address one of them.
 * - `'unsupported-generator'` — the declaration is a generator function. A
 *   wrapper that calls the body as a function cannot preserve `yield`: the
 *   consumer would receive the wrapper's return value instead of an iterator.
 * - `'unsupported-async-generator'` — the same, for an `async function*`. Kept
 *   apart from the previous code because the two are different facts about the
 *   declaration and a caller may want to word them differently.
 * - `'unsupported-declaration'` — the file declares the name, but not as
 *   something a timing wrapper can replace the body of: a class, a type, an
 *   enum, a namespace, a constructor, an accessor, a variable holding a
 *   non-function, a signature with no body, or a declaration in a position no
 *   wrapper can address — an object-literal member, a parameter, a binding
 *   pattern, or under a qualification that does not contain it.
 * - `'ast-unavailable'` — the declaration's shape could not be checked because
 *   no syntax tree was available: the context carries no loaded project, or the
 *   loaded program holds no parsed source for the file. Reported rather than
 *   guessed, because guessing here would send a generator to the patcher.
 * - `'duplicate-action'` — an earlier action in the same call already asks for
 *   this instrumentation, or already patches this symbol. `normalizePlan`
 *   deliberately leaves duplicates in place so that this gate can see them.
 *
 * Frozen, and ordered as above: the tuple is the order a distinct-code summary
 * is reported in, so a log line is comparable between runs.
 */
export const FEASIBILITY_REJECTION_CODES = Object.freeze([
  'no-adapter',
  'target-required',
  'path-outside-project',
  'file-not-indexed',
  'symbol-not-found',
  'ambiguous-symbol',
  'unsupported-generator',
  'unsupported-async-generator',
  'unsupported-declaration',
  'ast-unavailable',
  'duplicate-action',
] as const);

/**
 * One member of the closed rejection vocabulary.
 *
 * Derived from {@link FEASIBILITY_REJECTION_CODES} rather than declared beside
 * it, so the runtime list and the static type cannot drift: a code added to the
 * tuple widens this union in the same edit, and a consumer that switches
 * exhaustively over it stops compiling until it says something about the new
 * case.
 */
export type FeasibilityRejectionCode = (typeof FEASIBILITY_REJECTION_CODES)[number];

/**
 * Widened view of {@link FEASIBILITY_REJECTION_CODES}, used by
 * {@link isFeasibilityRejectionCode}.
 *
 * The annotation is the point: it lets an arbitrary `string` be tested for
 * membership without the predicate asserting anything about the value under
 * test.
 */
const REJECTION_CODE_VALUES: readonly string[] = FEASIBILITY_REJECTION_CODES;

/**
 * Whether a value is one of this module's rejection codes.
 *
 * For the paths where a code arrives from outside the process — a rejection
 * persisted with a session and read back when the session is reopened, a code
 * forwarded in an `instrumentation.failed` detail — and has to be triaged
 * before it is branched on.
 *
 * @param value Any value.
 * @returns `true` when `value` is a member of
 * {@link FEASIBILITY_REJECTION_CODES}, narrowing it to
 * {@link FeasibilityRejectionCode}.
 */
export function isFeasibilityRejectionCode(value: unknown): value is FeasibilityRejectionCode {
  return typeof value === 'string' && REJECTION_CODE_VALUES.includes(value);
}

// ---------------------------------------------------------------------------
// Result shapes
// ---------------------------------------------------------------------------

/**
 * One action that cannot be installed, and what the developer can do about it.
 *
 * The three fields beyond the action are the graceful-degradation channel —
 * how a signal that cannot be enabled is explained while capture continues
 * with the rest — in the wording `../adapter.ts` fixes for an
 * `UnavailableSignal`:
 *
 * - `reason` states **what was observed**, as a fragment that reads after a
 *   colon: "the code index holds no entry for 'src/server/x.ts'". Never a
 *   sentence about the product, never an exception message, never a stack
 *   trace.
 * - `hint` states **one concrete action** the developer can take.
 *
 * Both are single-line and composed entirely from the action and the injected
 * context — a project-relative path, a symbol, an action type, a candidate
 * location the code graph reported. No path, project name or symbol is written
 * into this repository: product source carries no knowledge of any particular
 * project, and `scripts/check-no-hardcoding.mjs` scans this module to hold it
 * to that.
 */
export interface InfeasibleAction {
  /** The action that was refused, unchanged and by reference. */
  readonly action: InstrumentationAction;

  /** Which check refused it. See {@link FEASIBILITY_REJECTION_CODES}. */
  readonly code: FeasibilityRejectionCode;

  /** What was observed. See this interface's note on wording. */
  readonly reason: string;

  /** The one thing the developer can do about it. */
  readonly hint: string;
}

/**
 * The verdict on a set of actions: what may be installed, and what may not.
 *
 * Both arrays are **deterministic**. `feasible` preserves the input order,
 * which is the order the plan was authored in and the order the installer
 * groups from; `rejected` is ordered by the index of the action it refers to,
 * so two runs over the same plan and the same project produce byte-identical
 * reports — the property that makes a rejection assertable in a test and
 * comparable between two sessions.
 *
 * The two arrays partition the input exactly: every action appears in one of
 * them, once. Nothing is silently dropped, because a dropped action is a signal
 * the developer was never told about.
 */
export interface FeasibilityReport {
  /** The actions that passed every check, in input order. */
  feasible: InstrumentationAction[];

  /** The actions that did not, ordered by their position in the input. */
  rejected: InfeasibleAction[];
}

/**
 * How to run {@link checkFeasibility}.
 *
 * One member today, and an object rather than a positional argument so that a
 * later check with its own input does not change the signature of a function
 * two callers already use.
 */
export interface FeasibilityOptions {
  /**
   * The adapter registry, or anything that answers its one question.
   *
   * Supplied by `./installer.ts` and by the planning stage, which both hold the
   * registry; omitted by a caller that only wants the project-side checks.
   * When it is present, an action whose type no registered adapter claims is
   * rejected as `'no-adapter'` before its file is looked at — the cheapest
   * check there is, and one whose answer no amount of re-indexing would change.
   *
   * Structural on purpose: `../registry.ts` satisfies it as-is, and a suite
   * satisfies it with an object literal. It must be free of side effects and
   * stable within a call.
   */
  readonly resolver?: PlanAdapterResolver | undefined;
}

/**
 * A rejection before it is paired with the action it refers to.
 *
 * Module-private: the checks below compose the code and the two sentences, and
 * the loop attaches the action, so no check has to carry the action through
 * every return just to put it back on the result.
 */
interface Rejection {
  readonly code: FeasibilityRejectionCode;
  readonly reason: string;
  readonly hint: string;
}

/**
 * What one action's evaluation produced: acceptance, with the normalised file
 * the duplicate registry is keyed on, or a rejection.
 *
 * The normalised path is carried out of the evaluation rather than recomputed
 * by the caller because the evaluation is where it was proven safe.
 */
type ActionVerdict =
  | { readonly feasible: true; readonly file: string }
  | { readonly feasible: false; readonly rejection: Rejection };

/**
 * What the current call has already accepted, so that a second action asking
 * for the same thing can be recognised.
 *
 * Two maps, because there are two ways one plan can ask for the same work
 * twice and they are not the same question:
 *
 * - `identities` is keyed by `actionIdentityKey` — `(file, symbol, type)`, the
 *   product's single definition of "the same action", shared with
 *   `normalizePlan` and the installer. Two actions with this key are literally
 *   the same instrumentation requested twice.
 * - `patchSites` is keyed by `(file, symbol)` and holds **patch-mode actions
 *   only**. Two patch actions of *different* types on one declaration are not
 *   the same action, but they are two wrappers around one body: the second
 *   would find the first's wrapper already in the file, and the patcher refuses
 *   it as already instrumented. Catching it here means the plan is corrected
 *   rather than half-applied. Runtime-mode actions never enter this map,
 *   because two runtime signals on one component — renders and state, say — are
 *   an ordinary and legitimate plan.
 */
interface DuplicateRegistry {
  readonly identities: Map<string, InstrumentationAction>;
  readonly patchSites: Map<string, InstrumentationAction>;
}

// ---------------------------------------------------------------------------
// Composing the two sentences
//
// Everything a rejection says about a developer's project passes through
// `reportable` first. Two obligations, and both have a failure mode: a value
// that arrived in a plan is not trusted to be printable — a path or a symbol
// from a hand-built plan can carry a control character, which would put an
// escape sequence into a terminal and a broken row into a panel — and a value
// that arrived in a plan is not trusted to be short.
// ---------------------------------------------------------------------------

/**
 * One value from a plan, made safe and short enough to name in a sentence.
 *
 * Control characters (C0, DELETE and C1) and the two Unicode line separators
 * are replaced with `'?'`, which keeps the value recognisable while making it
 * impossible for it to break the single line it is rendered into.
 * {@link MAX_REPORTED_TEXT_LENGTH} code points survive, and anything longer is
 * marked with an ellipsis rather than silently cut — a truncated path that
 * looked complete would send a developer looking for the wrong file.
 *
 * Iteration is by code point, so a value is never cut through the middle of a
 * surrogate pair.
 *
 * @param value The path, symbol, adapter id or type to render.
 * @returns The safe, bounded form.
 */
function reportable(value: string): string {
  return bounded(value, MAX_REPORTED_TEXT_LENGTH);
}

/**
 * A hint the shared target resolver composed, made safe and bounded exactly as
 * {@link reportable} makes a value, at {@link MAX_REPORTED_HINT_LENGTH}.
 *
 * @param hint The resolver's hint sentence.
 * @returns The safe, bounded form.
 */
function reportableHint(hint: string): string {
  return bounded(hint, MAX_REPORTED_HINT_LENGTH);
}

/**
 * Replaces every character that could break a single rendered line with `'?'`
 * and truncates to `limit` code points, marking a cut with an ellipsis.
 *
 * @param value The text to render.
 * @param limit The most code points to keep.
 * @returns The safe, bounded form.
 */
function bounded(value: string, limit: number): string {
  let rendered = '';
  let counted = 0;

  for (const character of value) {
    if (counted === limit) {
      return `${rendered}…`;
    }

    const code = character.codePointAt(0) ?? 0;
    const printable = !(
      code < 0x20 ||
      (code >= 0x7f && code <= 0x9f) ||
      code === 0x2028 ||
      code === 0x2029
    );

    rendered += printable ? character : '?';
    counted += 1;
  }

  return rendered;
}

/**
 * The sentence every shape-related hint ends with.
 *
 * Each rejection states something specific first, and this is the tail they
 * share: an action that cannot be installed as a patch is not the end of an
 * investigation, because runtime hooks are the product's default route and edit
 * no file at all. Saying so is what keeps a rejection from reading like a dead
 * end.
 */
const RUNTIME_ALTERNATIVE = 'A runtime signal needs no file edit at all.';

// ---------------------------------------------------------------------------
// The checks
//
// One function per question, each returning `undefined` when the action passes
// and a `Rejection` when it does not, so the evaluation below reads as the
// ordered list documented on `checkFeasibility`.
// ---------------------------------------------------------------------------

/**
 * Check 1 — is there an adapter that would install this at all?
 *
 * Asked first because it is the cheapest question and because its answer is
 * independent of the project: an action type no registered adapter claims
 * cannot be installed whatever the file says, and reporting a missing file for
 * it would send the developer to fix the wrong thing. Skipped entirely when no
 * resolver was supplied, which is a caller saying "I only want the project-side
 * checks" rather than "there is no registry".
 *
 * @param action The action under test.
 * @param resolver The registry's resolution surface.
 * @returns The rejection, or `undefined` when an adapter claims the type.
 */
function checkAdapterClaim(
  action: InstrumentationAction,
  resolver: PlanAdapterResolver,
): Rejection | undefined {
  if (resolver.resolveActionType(action.type) !== undefined) {
    return undefined;
  }

  return {
    code: 'no-adapter',
    reason: `no registered adapter claims the action type '${reportable(action.type)}'`,
    hint: `Register an adapter that claims '${reportable(action.type)}' actions, or plan a signal one of the installed adapters provides.`,
  };
}

/**
 * Check 2 — for a targetless action, can it be installed without a target?
 *
 * Only a runtime hook can: the marker says "this signal is about the whole page
 * or process", which is exactly what a listener in the page agent or an
 * instrumentation inside the dev-server preload observes. A patch edits one
 * declaration's body, and a function-timing or server-span action names the
 * declaration it wraps, so neither means anything with the marker in place of a
 * target. The internal plan schema already refuses both; this check holds for
 * an action built without it, which is the case the gate exists to catch.
 *
 * Called only for an action {@link isTargetlessAction} recognised; every other
 * action goes on to checks 3 to 6.
 *
 * @param action The targetless action under test.
 * @returns The rejection, or `undefined` when a runtime hook installs it.
 */
function checkTargetlessAction(action: InstrumentationAction): Rejection | undefined {
  if (action.mode !== 'patch' && !isTargetRequiredActionType(action.type)) {
    return undefined;
  }

  return {
    code: 'target-required',
    reason: `a '${reportable(action.type)}' action installed as a ${action.mode === 'patch' ? 'patch' : 'runtime hook'} wraps one named declaration, and this one names the targetless marker ('${TARGETLESS_FILE}', '${TARGETLESS_SYMBOL}') instead of a file and a symbol`,
    hint: 'Name the project file and the function to time, or plan a runtime signal, which is the one kind of action that can observe the whole page without a target.',
  };
}

/**
 * Check 3 — does the path stay inside the project?
 *
 * `resolveWithinProject` is the product's containment gate: it requires a safe
 * project-relative POSIX path (no absolute path, no drive letter, no
 * backslash, no surviving `'..'`, no control character), joins it onto the
 * normalised root, and proves the result is still inside. A path that fails is
 * refused here rather than deeper, and the refusal discloses nothing about the
 * filesystem — the error it produced is not forwarded, because its message
 * names the absolute project root and this sentence is shown in two user
 * interfaces.
 *
 * @param action The action under test.
 * @param projectRoot The absolute project root from the context.
 * @returns The absolute path when it is contained, or the rejection.
 */
function checkContainedPath(
  action: InstrumentationAction,
  projectRoot: string,
): { readonly absolutePath: string } | Rejection {
  const resolved = resolveWithinProject(projectRoot, action.file);

  if (isErr(resolved)) {
    return {
      code: 'path-outside-project',
      reason: `'${reportable(action.file)}' is not a project-relative path inside this project`,
      hint: "Name the target with a project-relative POSIX path, such as a path under the project's source directory.",
    };
  }

  return { absolutePath: resolved.value };
}

/**
 * Check 4 — is the file one the product actually knows about?
 *
 * The code graph is the authority, because it is the record of what was
 * indexed: `nodesByFile` is an O(1) read keyed by the exact project-relative
 * POSIX path, and every indexed file contributes at least its own `file` node.
 * `CodeGraph.files` is consulted only when that read is empty — a file that was
 * fingerprinted but produced no node is still a file the index covers, and
 * treating it as unknown would be wrong.
 *
 * When the graph does not know the file but the loaded program does, the
 * rejection says so. The code is the same, because the next step is the same —
 * nothing can be planned against a file the index has no symbols for — but the
 * distinction is the difference between "check the path" and "index the project
 * again", and a developer should not have to guess which.
 *
 * @param file The normalised project-relative path.
 * @param absolutePath The same path, absolute, for the program lookup.
 * @param graph The indexed code graph.
 * @param loaded The loaded project, when the context carries one.
 * @returns The rejection, or `undefined` when the file is known.
 */
function checkFileIndexed(
  file: string,
  absolutePath: string,
  graph: CodeGraph,
  loaded: LoadedProject | undefined,
): Rejection | undefined {
  if (graph.nodesByFile(file).length > 0) {
    return undefined;
  }

  if (graph.files.some((fingerprint) => fingerprint.file === file)) {
    return undefined;
  }

  const inProgram =
    loaded !== undefined && findSourceFile(loaded, file, absolutePath) !== undefined;

  return {
    code: 'file-not-indexed',
    reason: inProgram
      ? `the code index holds no entry for '${reportable(file)}', although the project's TypeScript program does`
      : `the code index holds no entry for '${reportable(file)}'`,
    hint: inProgram
      ? "Index the project again so the file's declarations are known, then plan against it."
      : "Confirm the file belongs to the project's TypeScript program — inside its configuration's file set, and not under a dependency, build-output or hidden directory — and index the project again.",
  };
}

/**
 * Check 5 — does the file declare the symbol?
 *
 * `hasSymbol` is the code-analysis API written for exactly this: it resolves
 * `(file, symbol)` from the graph without loading references, so the gate stays
 * cheap. It establishes that the file declares the name at all — which is the
 * whole question for a runtime-mode action, whose symbol is the *subject* of
 * the signal (the component whose renders are counted, the handler whose
 * requests are traced) rather than an edit site, and must still be real for
 * the plan to describe the project truthfully. *Which* declaration a patch
 * would rewrite, and whether a wrapper can reach it, is check 6's question.
 *
 * The spelling is asked about twice when it is qualified. `hasSymbol` matches a
 * declaration's own name, so `Class.member` — a spelling the patcher accepts,
 * and the one a planner uses to disambiguate two declarations of one name —
 * would be denied on its qualified form alone. Asking again with the bare name
 * keeps this gate from refusing a target the patcher would have instrumented.
 *
 * **The qualifier is corroborated too.** A bare name that exists says nothing
 * about the owner a qualified spelling claims, and accepting
 * `Invented.member` because some `member` exists would present an invented
 * target as validated — for a runtime action, whose shape is never checked,
 * this is the last check its subject meets. So a qualified spelling is
 * accepted only when the graph records a declaration of that name *under*
 * that owner ({@link checkQualifiedOwner}), which needs no syntax tree.
 *
 * @param file The normalised project-relative path.
 * @param action The action under test.
 * @param spelling The parsed spelling, whose `name` is the bare member name.
 * @param graph The indexed code graph, for the owner of a qualified spelling.
 * @param queries The bounded query surface over the graph.
 * @returns The rejection, or `undefined` when the file declares the symbol.
 */
function checkSymbolDeclared(
  file: string,
  action: InstrumentationAction,
  spelling: SymbolSpelling,
  graph: CodeGraph,
  queries: CodeQueries,
): Rejection | undefined {
  if (queries.hasSymbol(file, action.symbol)) {
    return undefined;
  }

  if (spelling.name !== action.symbol && queries.hasSymbol(file, spelling.name)) {
    return spelling.container === undefined
      ? undefined
      : checkQualifiedOwner(file, spelling.name, spelling.container, graph);
  }

  return {
    code: 'symbol-not-found',
    reason: `'${reportable(file)}' declares no addressable symbol named '${reportable(action.symbol)}'`,
    hint: nearMissHint(spelling.name, file, action, queries),
  };
}

/**
 * The hint for a symbol the file does not declare, naming where the name *is*
 * declared when the graph knows.
 *
 * `findByName` is the bounded, ranked lookup — exact, then case-insensitive
 * exact, then prefix, then substring, ties broken by node id — so the
 * candidates are deterministic and the list is capped at
 * {@link MAX_NEAR_MISS_CANDIDATES} before it is rendered. Candidates in the
 * target file itself are kept: a name that occurs there as a binding rather
 * than a declaration is precisely the confusion that produced the plan, and
 * naming its line is what resolves it.
 *
 * With no candidate to name, the hint offers the alternative that fits the
 * action: a patch can become a runtime signal, and a runtime signal that is
 * about the whole page rather than one declaration can name the targetless
 * marker instead of inventing a subject.
 *
 * @param name The bare symbol name that was not found.
 * @param file The file it was looked for in.
 * @param action The action under test, whose mode picks the alternative.
 * @param queries The bounded query surface over the graph.
 * @returns A single-line hint.
 */
function nearMissHint(
  name: string,
  file: string,
  action: InstrumentationAction,
  queries: CodeQueries,
): string {
  const rendered: string[] = [];
  const seen = new Set<string>();

  for (const match of queries.findByName(name, { limit: MAX_NEAR_MISS_CANDIDATES })) {
    const position = `${match.file}:${String(match.location.line)}`;

    if (seen.has(position)) {
      continue;
    }

    seen.add(position);
    rendered.push(`'${reportable(match.name)}' at ${reportable(position)}`);

    if (rendered.length === MAX_NEAR_MISS_CANDIDATES) {
      break;
    }
  }

  if (rendered.length === 0) {
    return action.mode === 'patch'
      ? `Name a symbol '${reportable(file)}' declares, or plan a runtime signal instead. ${RUNTIME_ALTERNATIVE}`
      : `Name a symbol '${reportable(file)}' declares or, for a signal about the whole page rather than one declaration, the targetless marker ('${TARGETLESS_FILE}', '${TARGETLESS_SYMBOL}').`;
  }

  return `The code index declares ${rendered.join(', ')} — name the file that declares the symbol, or a symbol this file declares.`;
}

/**
 * Whether the graph records a declaration of `name` in `file` under `owner`,
 * and the rejection naming the owners it does record when it does not.
 *
 * A declaration's owner, in the graph's own terms, is the class a member
 * belongs to (`CodeNodeBase.symbol`) or, for a nested declaration, the
 * innermost named declaration around it — the last entry of
 * `SymbolNodeData.enclosing`. That is the qualifier the function-timing patcher
 * accepts for the same declaration: `Class.member` for a class member and
 * `Enclosing.name` for a declaration nested in a named function, so a
 * spelling corroborated here is one the patcher would resolve by the same
 * owner, and one refused here names an owner the patcher would refuse too.
 *
 * `symbol-not-found`, because that is the fact: the file declares nothing
 * under the spelled qualification. The hint names the owners it does record,
 * bounded, because re-spelling the target is the one-edit fix.
 *
 * @param file The normalised project-relative path.
 * @param name The bare declared name, which `hasSymbol` already affirmed.
 * @param owner The qualifier the spelling claims.
 * @param graph The indexed code graph.
 * @returns The rejection, or `undefined` when the owner is corroborated.
 */
function checkQualifiedOwner(
  file: string,
  name: string,
  owner: string,
  graph: CodeGraph,
): Rejection | undefined {
  const owners = declaredOwnersOf(graph.nodesByFile(file), name);

  if (owners.includes(owner)) {
    return undefined;
  }

  const named = [...new Set(owners.filter((candidate) => candidate !== undefined))].slice(
    0,
    MAX_NEAR_MISS_CANDIDATES,
  );
  const [first] = named;

  return {
    code: 'symbol-not-found',
    reason: `'${reportable(file)}' declares '${reportable(name)}', but not on or inside '${reportable(owner)}'`,
    hint:
      first === undefined
        ? `Name it by its bare name '${reportable(name)}', which is how '${reportable(file)}' declares it.`
        : `'${reportable(file)}' declares it under ${named.map((candidate) => `'${reportable(candidate)}'`).join(', ')} — spell it '${reportable(first)}.${reportable(name)}', or by its bare name where the file declares it once.`,
  };
}

/**
 * The owner of every declaration of `name` among one file's graph nodes:
 * the class for a member, the innermost named enclosing declaration for a
 * nested one, and `undefined` for a module-scope declaration or one nested
 * only in anonymous scopes.
 *
 * @param nodes The file's graph nodes.
 * @param name The bare declared name.
 * @returns One owner per declaring node, in graph order.
 */
function declaredOwnersOf(nodes: readonly CodeNode[], name: string): (string | undefined)[] {
  const owners: (string | undefined)[] = [];

  for (const node of nodes) {
    if (node.name !== name || !DECLARING_NODE_KINDS.includes(node.kind)) {
      continue;
    }

    if (node.kind === 'symbol') {
      if (
        node.data !== undefined &&
        NON_ADDRESSABLE_DECLARATION_KINDS.includes(node.data.declaration)
      ) {
        continue;
      }

      const chain = node.data?.enclosing;

      if (chain !== undefined) {
        owners.push(chain.at(-1));
        continue;
      }
    }

    owners.push(node.symbol);
  }

  return owners;
}

/**
 * Check 6 — `patch`-mode only: is the declaration one a timing wrapper can
 * replace the body of?
 *
 * The one check that needs a syntax tree. *Which* declaration the spelling
 * names is decided by `resolvePatchTarget` from `./patch/target-resolver.ts` —
 * the resolver the function-timing patcher runs immediately before it writes —
 * so the declaration classified here is the one the patch would rewrite: a bare
 * name two nested declarations share is refused as ambiguous rather than
 * silently resolved to the first, a nested declaration's owner is its nearest
 * named function-like scope exactly as the patcher computes it, and a
 * declaration in a position no wrapper can address is refused here rather than
 * at install time.
 *
 * On the declaration the resolver returns, the wrapper template's constraint
 * is applied: the wrapper moves the original body into an inner function and
 * calls it, which a generator's `yield` cannot survive — the consumer would
 * receive the wrapper's return value instead of an iterator.
 *
 * **Absence of a tree is reported, never guessed.** A context with no loaded
 * project is a legitimate state — the service withholds it when no patch-mode
 * action is in play, because loading one is the most expensive thing this
 * package does — and answering "supported" for it would be this gate letting a
 * generator through to the patcher, where the wrapper builder throws rather
 * than refuses.
 *
 * The tree is the code index's own, shared with every other reader of the
 * loaded project; the resolver only reads it.
 *
 * @param file The normalised project-relative path.
 * @param absolutePath The same path, absolute, for the program lookup.
 * @param action The action under test.
 * @param spelling The parsed spelling, for the wording of a refusal.
 * @param loaded The loaded project, when the context carries one.
 * @returns The rejection, or `undefined` when the declaration can be wrapped.
 */
function checkDeclarationShape(
  file: string,
  absolutePath: string,
  action: InstrumentationAction,
  spelling: SymbolSpelling,
  loaded: LoadedProject | undefined,
): Rejection | undefined {
  if (loaded === undefined) {
    return {
      code: 'ast-unavailable',
      reason: `no TypeScript program is loaded for this project, so the shape of '${reportable(action.symbol)}' cannot be checked`,
      hint: 'Give the session a project whose TypeScript configuration loads, so the syntax tree is available, and plan again.',
    };
  }

  const sourceFile = findSourceFile(loaded, file, absolutePath);

  if (sourceFile === undefined) {
    return {
      code: 'ast-unavailable',
      reason: `the project's TypeScript program holds no parsed source for '${reportable(file)}'`,
      hint: "Confirm the file is part of the project's TypeScript configuration, then plan against it again.",
    };
  }

  const resolved = resolvePatchTarget(sourceFile, action.symbol, file);

  if (!resolved.ok) {
    return resolutionRejection(resolved.error, action, file, spelling);
  }

  return (
    generatorRejection(resolved.value.fn, action, file) ??
    reactComponentRejection(resolved.value, action, file)
  );
}

/**
 * The rejection for a React component or hook, or `undefined` when the target
 * is neither.
 *
 * The recognition is the patcher's own (`reactComponentSite` in
 * `./patch/function-timing.ts`), so this gate refuses exactly the targets the
 * patcher would refuse — before an install begins, where a refusal becomes an
 * unavailable signal, instead of mid-install, where it would roll back every
 * other modification of the same install. Coded `'unsupported-declaration'`:
 * the declaration exists and is a function, but not one whose body a timing
 * wrapper may move.
 *
 * @param target The resolved target.
 * @param action The action under test.
 * @param file The normalised project-relative path.
 * @returns The rejection, or `undefined`.
 */
function reactComponentRejection(
  target: ResolvedTarget,
  action: InstrumentationAction,
  file: string,
): Rejection | undefined {
  const site = reactComponentSite(target);

  if (site === undefined) {
    return undefined;
  }

  const subject = `'${reportable(action.symbol)}' in '${reportable(file)}'`;

  return {
    code: 'unsupported-declaration',
    reason:
      site.site === 'jsx-return'
        ? `${subject} returns JSX, so it is a React render function, and a timing wrapper would move its render and any hook it calls out of the component React analyses`
        : `${subject} calls a React hook in its own scope, so it is a component or a hook, and a timing wrapper would move that hook call into a function that is neither`,
    hint: `Plan a react-render-tracking action for this component instead: it observes renders and commits at run time. ${RUNTIME_ALTERNATIVE}`,
  };
}

/**
 * The parsed source of one project file, or `undefined` when the program does
 * not hold it.
 *
 * Two steps, because a path is not an identity. `getSourceFile` with a path is
 * a *search* in ts-morph — it also matches by file-name ending — so its answer
 * is verified by reducing it back to a project-relative path and comparing,
 * which is the only comparison that establishes it is the right file. The scan
 * that follows is the fallback for a program whose stored path form differs
 * from the one composed here; it runs over the frozen, deterministic file set
 * and only when the direct lookup did not answer.
 *
 * @param loaded The loaded project.
 * @param file The normalised project-relative path.
 * @param absolutePath The same path, absolute POSIX.
 * @returns The source file, or `undefined`.
 */
function findSourceFile(
  loaded: LoadedProject,
  file: string,
  absolutePath: string,
): SourceFile | undefined {
  const direct = loaded.project.getSourceFile(absolutePath);

  if (direct !== undefined && loaded.projectRelative(direct.getFilePath()) === file) {
    return direct;
  }

  return loaded
    .sourceFiles()
    .find((candidate) => loaded.projectRelative(candidate.getFilePath()) === file);
}

/**
 * Splits a symbol spelling into the member name and the class or enclosing
 * declaration qualifying it, for the graph lookup of check 5.
 *
 * The accepted forms are the shared resolver's own — `member`, `Class.member`,
 * `Class#member` and `Class.prototype.member` — parsed by the same
 * `parseSymbolSpelling` the patcher uses, so the bare name asked about here is
 * the name the patcher would resolve. A spelling the resolver refuses as
 * malformed yields the trimmed original as the name and no container, which
 * then fails check 5 with a rejection that names what was asked for: the graph
 * declares nothing of that spelling, and saying so is more useful to a planner
 * than a report about the spelling rules.
 *
 * @param symbol The `symbol` field of an action.
 * @returns The name, and the container when one was spelled.
 */
function spellingOf(symbol: string): SymbolSpelling {
  const parsed = parseSymbolSpelling(symbol);

  return parsed.ok ? parsed.value : { name: symbol.trim(), container: undefined };
}

/**
 * The rejection for a target the shared resolver declined to resolve.
 *
 * The resolver speaks the patcher's `details.reason` vocabulary; this maps it
 * onto this gate's codes, keeping the finding the developer has to act on:
 *
 * - `'ambiguous-symbol'` stays itself, with the resolver's hint — the qualified
 *   spellings that name one of the declarations.
 * - `'malformed-symbol'` is `'symbol-not-found'`: nothing is declared under a
 *   spelling no resolver can parse.
 * - `'symbol-not-addressable'` is `'unsupported-declaration'`, worded from the
 *   position the resolver reported and carrying its next step.
 * - `'symbol-not-found'` is `'unsupported-declaration'` too, because check 5
 *   has already established that the file declares the name: what the resolver
 *   found none of is a *function* of that name under that qualification.
 * - Every other reason — an accessor, a constructor, a signature with no body,
 *   a variable holding a non-function — is `'unsupported-declaration'` for the
 *   declaration's shape.
 *
 * The resolver's message is never forwarded: it is a sentence about the patch
 * transform, and this rejection is shown to a developer as a fragment after a
 * colon. Its hint is forwarded, bounded, because it is built from vocabulary
 * and declaration names only and is the most specific next step available.
 *
 * @param error The resolver's refusal.
 * @param action The action under test.
 * @param file The normalised project-relative path.
 * @param spelling The parsed spelling, for the wording of a qualified refusal.
 * @returns The rejection.
 */
function resolutionRejection(
  error: DebuggenError,
  action: InstrumentationAction,
  file: string,
  spelling: SymbolSpelling,
): Rejection {
  const details = error.details ?? {};
  const reason = details['reason'];
  const resolverHint = error.hint === undefined ? undefined : reportableHint(error.hint);

  switch (reason) {
    case 'ambiguous-symbol':
      return {
        code: 'ambiguous-symbol',
        reason: `'${reportable(file)}' declares '${reportable(action.symbol)}' more than once, and the spelling does not say which declaration to time`,
        hint:
          resolverHint ??
          'Qualify the symbol as Class.member or Enclosing.name to name one of them.',
      };
    case 'malformed-symbol':
      return {
        code: 'symbol-not-found',
        reason: `'${reportable(action.symbol)}' is not a spelling that names a declaration in '${reportable(file)}'`,
        hint: 'Name the declaration as member, Class.member, Class#member or Class.prototype.member.',
      };
    case 'symbol-not-addressable':
      return {
        code: 'unsupported-declaration',
        reason: notWrappableReason(file, action.symbol, nonAddressableClause(details['position'])),
        hint:
          resolverHint ??
          `Time the function that contains this declaration instead. ${RUNTIME_ALTERNATIVE}`,
      };
    case 'symbol-not-found':
      return spelling.container === undefined
        ? unsupportedShape(action, file, 'something other than a function this project can time')
        : {
            code: 'unsupported-declaration',
            reason: `'${reportable(file)}' declares '${reportable(spelling.name)}', but not as a function on or inside '${reportable(spelling.container)}' whose body a timing wrapper can replace`,
            hint: `Name the declaration by the class or the function that contains it, or by its bare name where the file declares it once. ${RUNTIME_ALTERNATIVE}`,
          };
    case 'unsupported-accessor':
      return unsupportedShape(action, file, 'a property accessor');
    case 'unsupported-constructor':
      return unsupportedShape(action, file, 'a constructor');
    default:
      return unsupportedShape(action, file, 'a declaration with no function body to wrap');
  }
}

/**
 * The clause that says what a non-addressable declaration *is*, in the words
 * the patcher's own refusal uses.
 *
 * The position arrives in a refusal's details, so it is checked against the
 * vocabulary before it is used as a key; an unrecognised one — a resolver newer
 * than this gate — still produces a truthful sentence.
 *
 * @param position The `details.position` of a `'symbol-not-addressable'` refusal.
 * @returns The clause.
 */
function nonAddressableClause(position: unknown): string {
  return isNonAddressablePosition(position)
    ? NON_ADDRESSABLE_CLAUSES[position]
    : 'a declaration in a position no timing wrapper can address';
}

/**
 * Whether a value is one of the resolver's non-addressable positions.
 *
 * @param value Any value.
 * @returns `true` for a member of `PATCH_NON_ADDRESSABLE_POSITIONS`.
 */
function isNonAddressablePosition(value: unknown): value is PatchNonAddressablePosition {
  const positions: readonly string[] = PATCH_NON_ADDRESSABLE_POSITIONS;

  return typeof value === 'string' && positions.includes(value);
}

/**
 * The rejection for a generator, or `undefined` when the function is not one.
 *
 * Separate codes for the plain and the `async` form, because they are different
 * facts about the declaration and a caller may word them differently; the
 * consequence is the same: the wrapper cannot preserve `yield`, so neither form
 * is patched. An arrow function is never a generator.
 *
 * @param fn The function-like node the shared resolver returned.
 * @param action The action under test.
 * @param file The normalised project-relative path.
 * @returns The rejection, or `undefined`.
 */
function generatorRejection(
  fn: PatchableFunctionNode,
  action: InstrumentationAction,
  file: string,
): Rejection | undefined {
  if (Node.isArrowFunction(fn) || !fn.isGenerator()) {
    return undefined;
  }

  const asynchronous = fn.isAsync();

  return {
    code: asynchronous ? 'unsupported-async-generator' : 'unsupported-generator',
    reason: `'${reportable(action.symbol)}' in '${reportable(file)}' is ${asynchronous ? 'an async generator' : 'a generator'} function, and a wrapper that calls the body as a function cannot preserve yield`,
    hint: `Time a function the generator delegates to, or plan a runtime signal for this flow. ${RUNTIME_ALTERNATIVE}`,
  };
}

/**
 * The rejection for a declaration whose shape no wrapper fits.
 *
 * @param action The action under test.
 * @param file The normalised project-relative path.
 * @param clause What was found, completing "…: it is …".
 * @returns The rejection.
 */
function unsupportedShape(action: InstrumentationAction, file: string, clause: string): Rejection {
  return {
    code: 'unsupported-declaration',
    reason: notWrappableReason(file, action.symbol, clause),
    hint: `Time a function declaration, a function-valued variable or a class method instead. ${RUNTIME_ALTERNATIVE}`,
  };
}

/**
 * The `reason` of a declaration the file holds but no timing wrapper can
 * replace, in the words the patcher's own refusal uses ("…but not as a function
 * this transform can wrap: it is ‹clause›").
 *
 * The clause says what the declaration *is* and stands on its own after the
 * colon, so it is never followed by a verdict about "its body": several
 * clauses — a class, whose body runs field initialisers; a constructor; a
 * declaration with no function body at all — already describe the body, or its
 * absence, and a second clause about it would repeat or contradict the first.
 * One fragment on one line, which is how it reads after "Could not enable
 * ‹signal›: " in the message the developer sees.
 *
 * @param file The normalised project-relative path.
 * @param symbol The symbol as the plan spelled it.
 * @param clause What the declaration is: a `NON_ADDRESSABLE_CLAUSES` value or a
 * shape such as "a constructor".
 * @returns The reason fragment.
 */
function notWrappableReason(file: string, symbol: string, clause: string): string {
  return `'${reportable(file)}' declares '${reportable(symbol)}', but not as a function a timing wrapper can replace: it is ${clause}`;
}

/**
 * Check 7 — has this call already accepted the same work?
 *
 * Last, and deliberately so: an action that is both a duplicate and impossible
 * is reported as impossible, because that is the finding the developer has to
 * act on. Only accepted actions are registered, so a duplicate of a rejected
 * action earns the rejected action's own reason rather than a report that its
 * twin came first.
 *
 * @param action The action under test.
 * @param file The normalised project-relative path.
 * @param registry What this call has accepted so far.
 * @returns The rejection, or `undefined` when nothing matches.
 */
function checkDuplicate(
  action: InstrumentationAction,
  file: string,
  registry: DuplicateRegistry,
): Rejection | undefined {
  if (registry.identities.has(actionIdentityKey(action))) {
    return {
      code: 'duplicate-action',
      reason: `an earlier action in this plan already requests '${reportable(action.type)}' on '${reportable(action.symbol)}' in '${reportable(file)}'`,
      hint: 'Keep one action per symbol and signal, and remove the repeated target from the plan.',
    };
  }

  if (action.mode !== 'patch') {
    return undefined;
  }

  const site = registry.patchSites.get(patchSiteKey(file, action.symbol));

  if (site === undefined) {
    return undefined;
  }

  return {
    code: 'duplicate-action',
    reason: `an earlier '${reportable(site.type)}' action in this plan already patches '${reportable(action.symbol)}' in '${reportable(file)}'`,
    hint: 'One symbol carries one patch: keep the action whose signal you need, and plan a runtime signal for the other.',
  };
}

/**
 * Records an accepted action so a later one asking for the same work is seen.
 *
 * @param action The accepted action.
 * @param file The normalised project-relative path.
 * @param registry What this call has accepted so far.
 */
function registerAction(
  action: InstrumentationAction,
  file: string,
  registry: DuplicateRegistry,
): void {
  registry.identities.set(actionIdentityKey(action), action);

  if (action.mode === 'patch') {
    registry.patchSites.set(patchSiteKey(file, action.symbol), action);
  }
}

/**
 * The key one patch site is recognised by: `(file, symbol)`, encoded so that
 * distinct pairs cannot collide.
 *
 * Each component is prefixed with its length in UTF-16 code units and a `':'`,
 * exactly as `actionIdentityKey` in `./schema/plan.ts` does and for the reason
 * recorded there: a length is a digit run containing no `':'`, so the first
 * `':'` ends it and the component is then exactly that many code units whatever
 * those code units are. Joining with a separator would not do — every plausible
 * separator is legal inside a POSIX file name and inside the text of a symbol,
 * and a collision here would report two unrelated targets as one patch site and
 * drop an action the developer asked for.
 *
 * The key is opaque: compare it, use it as a `Map` key, never parse it apart.
 *
 * @param file The normalised project-relative path.
 * @param symbol The symbol as the action spelled it.
 * @returns The key.
 */
function patchSiteKey(file: string, symbol: string): string {
  return `${String(file.length)}:${file}${String(symbol.length)}:${symbol}`;
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

/**
 * Decides which of a plan's actions can actually be installed on this project.
 *
 * The ordered pre-install gate, run by `./installer.ts` before a
 * single byte is written and by `apps/local-service/src/pipeline/stages/plan.ts`
 * as soon as a plan has been normalised. Every action is judged
 * **independently**, and the first failing check is the one reported — a target
 * has one most-useful explanation, and stacking the rest of them onto it makes
 * a progress row unreadable:
 *
 * 1. An adapter claims the action's type, when a resolver was supplied.
 * 2. A targetless action — the marker `{ file: '.', symbol: '*' }` from
 *    `./schema/plan.ts` — is installable only as a runtime hook of a type that
 *    needs no declaration; it is accepted here, with nothing to look up.
 * 3. The file is a safe project-relative path inside the project root.
 * 4. The code index holds the file.
 * 5. The file declares the symbol — under the class or enclosing declaration
 *    a qualified spelling names, corroborated from the graph.
 * 6. `patch`-mode only: the shared target resolver resolves the spelling to
 *    exactly one declaration a timing wrapper can reach, and it is not a
 *    generator.
 * 7. No earlier action in this same call already asked for the work.
 *
 * Checks 3 to 5 apply to **every** action that names a target, runtime or
 * patch. A runtime action writes nothing to a file, but the file and symbol it
 * carries are the *subject* of its signal — the component whose renders are
 * counted, the handler whose requests are attributed — and they are what the
 * editor and the panel show the developer as validated. A subject the project
 * does not have would present a hallucinated target as checked while the hook
 * armed over the whole document; a signal that genuinely has no subject says so
 * with the targetless marker instead.
 *
 * **Nothing is thrown for a rejection.** Every refusal is an
 * {@link InfeasibleAction} on the report, carrying the two sentences a
 * developer reads. A {@link DebuggenError} with code `'INTERNAL'`
 * is thrown only for a context that cannot be used at all — no graph, no
 * queries, no project root, no logger — which is a defect in the caller and
 * says nothing about the project.
 *
 * The project is untouched: nothing here writes, spawns, connects or reads an
 * environment variable, and the only work is reading the graph, asking its
 * bounded query surface, and walking the syntax tree of at most one file per
 * `patch`-mode action.
 *
 * @param actions The actions to judge, normally a plan's
 * `instrumentationTargets` or a follow-up delta drawn from it.
 * @param context The session's instrumentation context, supplying the project
 * root, the code graph and its queries, the loaded project when one exists, and
 * the logger.
 * @param options The adapter resolver, when the caller holds one.
 * @returns The partition of the input into installable and refused actions,
 * deterministically ordered.
 * @throws {DebuggenError} `'INTERNAL'` when the context is missing the graph,
 * the queries, the project root or the logger.
 *
 * @example
 * ```ts
 * const report = checkFeasibility(plan.instrumentationTargets, context, {
 *   resolver: registry,
 * });
 *
 * for (const refusal of report.rejected) {
 *   unavailable.push({
 *     signal: signalForActionType(refusal.action.type),
 *     reason: refusal.reason,
 *     hint: refusal.hint,
 *   });
 * }
 *
 * await installActions(report.feasible, context);
 * ```
 */
export function checkFeasibility(
  actions: readonly InstrumentationAction[],
  context: InstrumentationContext,
  options?: FeasibilityOptions,
): FeasibilityReport {
  requireUsableContext(context);
  requireActionList(actions);

  const resolver = options?.resolver;
  const registry: DuplicateRegistry = { identities: new Map(), patchSites: new Map() };
  const feasible: InstrumentationAction[] = [];
  const rejected: InfeasibleAction[] = [];

  for (const action of actions) {
    const verdict = evaluateAction(action, context, resolver);

    if (verdict.feasible) {
      const duplicate = checkDuplicate(action, verdict.file, registry);

      if (duplicate === undefined) {
        registerAction(action, verdict.file, registry);
        feasible.push(action);
        continue;
      }

      rejected.push({ action, ...duplicate });
      continue;
    }

    rejected.push({ action, ...verdict.rejection });
  }

  context.logger.debug('checked instrumentation plan feasibility', {
    sessionId: context.sessionId,
    planVersion: context.planVersion,
    actions: actions.length,
    feasible: feasible.length,
    rejected: rejected.length,
    codes: reportedCodes(rejected),
  });

  return { feasible, rejected };
}

/**
 * The same gate, over a whole normalised plan.
 *
 * The form both callers actually use, because a plan is what they hold: it runs
 * over `plan.instrumentationTargets` and adds nothing of its own, so the report
 * and its ordering are exactly {@link checkFeasibility}'s. The plan's own
 * `planVersion` is not consulted — which revision is being installed is the
 * context's statement (`InstrumentationContext.planVersion`), and every record
 * of this round is stamped from there.
 *
 * @param plan The normalised plan to judge.
 * @param context The session's instrumentation context.
 * @param options The adapter resolver, when the caller holds one.
 * @returns The partition of the plan's actions into installable and refused.
 * @throws {DebuggenError} `'INTERNAL'` when the context is unusable or the plan
 * carries no action list.
 *
 * @example
 * ```ts
 * const report = checkPlanFeasibility(normalized.value, context, {
 *   resolver: registry,
 * });
 *
 * if (report.feasible.length === 0) {
 *   return usePlanFallback(report.rejected);
 * }
 * ```
 */
export function checkPlanFeasibility(
  plan: InstrumentationPlan,
  context: InstrumentationContext,
  options?: FeasibilityOptions,
): FeasibilityReport {
  const targets: unknown = plan.instrumentationTargets;

  if (!Array.isArray(targets)) {
    throw new DebuggenError(
      'INTERNAL',
      'A feasibility check was given a plan whose instrumentationTargets is not an array.',
      {
        hint: 'Parse the plan with parseInstrumentationPlan before checking it, so a malformed plan is reported as PLAN_INVALID rather than here.',
      },
    );
  }

  return checkFeasibility(plan.instrumentationTargets, context, options);
}

/**
 * Runs checks 1 to 6 for one action, stopping at the first failure.
 *
 * A targetless action stops after check 2, because checks 3 to 6 are questions
 * about a target it deliberately does not have. Every other action — runtime
 * or patch — takes checks 3 to 5, and a patch-mode action also takes check 6.
 *
 * Check 7 is the caller's, because it is the only check whose answer depends on
 * what has already been *accepted* — and an action that fails an earlier check
 * must not occupy a duplicate slot that would then explain away its twin.
 *
 * @param action The action to judge.
 * @param context The session's instrumentation context.
 * @param resolver The adapter resolver, when one was supplied.
 * @returns Acceptance with the normalised file, or the rejection.
 */
function evaluateAction(
  action: InstrumentationAction,
  context: InstrumentationContext,
  resolver: PlanAdapterResolver | undefined,
): ActionVerdict {
  if (resolver !== undefined) {
    const unclaimed = checkAdapterClaim(action, resolver);

    if (unclaimed !== undefined) {
      return { feasible: false, rejection: unclaimed };
    }
  }

  if (isTargetlessAction(action)) {
    const targetRequired = checkTargetlessAction(action);

    return targetRequired === undefined
      ? { feasible: true, file: TARGETLESS_FILE }
      : { feasible: false, rejection: targetRequired };
  }

  const contained = checkContainedPath(action, context.projectRoot);

  if (!('absolutePath' in contained)) {
    return { feasible: false, rejection: contained };
  }

  const file = normalizePosix(action.file);
  const spelling = spellingOf(action.symbol);

  const unindexed = checkFileIndexed(file, contained.absolutePath, context.graph, context.loaded);

  if (unindexed !== undefined) {
    return { feasible: false, rejection: unindexed };
  }

  const undeclared = checkSymbolDeclared(file, action, spelling, context.graph, context.queries);

  if (undeclared !== undefined) {
    return { feasible: false, rejection: undeclared };
  }

  if (action.mode !== 'patch') {
    return { feasible: true, file };
  }

  const unsupported = checkDeclarationShape(
    file,
    contained.absolutePath,
    action,
    spelling,
    context.loaded,
  );

  if (unsupported !== undefined) {
    return { feasible: false, rejection: unsupported };
  }

  return { feasible: true, file };
}

/**
 * The distinct rejection codes of one report, in vocabulary order.
 *
 * Bounded by the vocabulary itself — at most {@link FEASIBILITY_REJECTION_CODES}
 * entries, however many actions were refused — and ordered by it rather than by
 * first occurrence, so one run's summary line is comparable with another's.
 *
 * @param rejected The refusals of one call.
 * @returns The distinct codes, in vocabulary order.
 */
function reportedCodes(rejected: readonly InfeasibleAction[]): FeasibilityRejectionCode[] {
  return FEASIBILITY_REJECTION_CODES.filter((code) =>
    rejected.some((refusal) => refusal.code === code),
  );
}

/**
 * Checks the context a feasibility run was given.
 *
 * Every check below is made *against* this object, so a context missing one of
 * these members would produce a report that looked like a verdict and was
 * nothing of the kind — every action refused for a reason that has no bearing
 * on the project, or a thrown `TypeError` from inside a check with no code on
 * it. The types already say these members are present; this module is published
 * as JavaScript with declarations and is reachable from the service, both
 * extensions and a test without the compiler in the room, which is exactly when
 * a missing member shows up.
 *
 * `'INTERNAL'` is the honest code: the context is built by first-party code
 * (`apps/local-service/src/instrumentation/service.ts`), so a failure here is a
 * defect in this product rather than anything a model, an author or a developer
 * did.
 *
 * @param context The context to check.
 * @throws {DebuggenError} `'INTERNAL'` when a required member is missing.
 */
function requireUsableContext(context: InstrumentationContext): void {
  const logger: unknown = context.logger;

  if (!hasMethod(logger, 'debug')) {
    throw new DebuggenError('INTERNAL', 'A feasibility check was given a context with no logger.', {
      hint: 'Pass the session logger, or noopLogger from @debuggen/shared when no output is wanted.',
    });
  }

  const queries: unknown = context.queries;

  if (!hasMethod(queries, 'hasSymbol') || !hasMethod(queries, 'findByName')) {
    throw new DebuggenError(
      'INTERNAL',
      'A feasibility check was given a context with no code queries.',
      {
        hint: "Build the context with createCodeQueries from @debuggen/code-analysis over the session's indexed graph.",
      },
    );
  }

  const graph: unknown = context.graph;

  if (!hasMethod(graph, 'nodesByFile')) {
    throw new DebuggenError(
      'INTERNAL',
      'A feasibility check was given a context with no code graph.',
      { hint: 'Build the context with the CodeGraph the project indexer produced.' },
    );
  }

  if (typeof context.projectRoot !== 'string' || context.projectRoot.length === 0) {
    throw new DebuggenError(
      'INTERNAL',
      'A feasibility check was given a context with no project root.',
      {
        hint: 'Pass the absolute POSIX project root the service resolved from the workspace folder.',
      },
    );
  }
}

/**
 * Checks that the actions argument is a list that can be iterated twice — once
 * to judge it, once to count it for the summary line.
 *
 * @param actions The argument to check.
 * @throws {DebuggenError} `'INTERNAL'` when it is not an array.
 */
function requireActionList(actions: readonly InstrumentationAction[]): void {
  const list: unknown = actions;

  if (!Array.isArray(list)) {
    throw new DebuggenError(
      'INTERNAL',
      'A feasibility check was given actions that are not an array.',
      { hint: "Pass a plan's instrumentationTargets, or an array drawn from it." },
    );
  }
}

/**
 * Whether a value carries a callable property of that name.
 *
 * The one structural probe {@link requireUsableContext} needs, kept in one
 * place so that each check reads as the invariant it states rather than as a
 * cast.
 *
 * @param value The value to probe.
 * @param method The property name.
 * @returns `true` when the value is an object with a function at that key.
 */
function hasMethod(value: unknown, method: string): boolean {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  return typeof (value as Record<string, unknown>)[method] === 'function';
}
