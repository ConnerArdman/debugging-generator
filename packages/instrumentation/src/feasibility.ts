/**
 * The **pre-install feasibility gate**: the last thing that looks at an
 * instrumentation plan before anything is written into a developer's project.
 *
 * AAP §0.7.1 Group 1 states this module's job in one clause — "feasibility
 * rejects actions whose file/symbol is absent from the graph" — and AAP §0.5.3
 * states where it sits in the sequence a model's proposal travels through:
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
 *   (`../adapter.ts`) whose `reason` and `hint` are rendered verbatim into
 *   AAP §0.5.5's sentence — "Could not enable ‹signal›: ‹reason›. Continuing
 *   with: ‹enabled list›." — and the action is dropped rather than attempted.
 * - `apps/local-service/src/pipeline/stages/plan.ts` runs it immediately after
 *   normalisation, so a plan that would instrument nothing is caught while the
 *   session can still fall back to a runtime-only default plan. Its rejections
 *   become `session.progress` detail and, where nothing at all survives,
 *   `instrumentation.failed` detail (AAP §0.4.2).
 *
 * Both callers get **data, not exceptions**: a rejection is a finding on the
 * report, because "this target cannot be instrumented" is an ordinary answer
 * about an ordinary project and AAP §0.5.5 requires it to reach the developer
 * as an explanation rather than as a stack trace. A thrown
 * {@link DebuggenError} here means something else entirely — a context that is
 * missing the graph queries every check is made against, which is a
 * programming error in the caller and not a statement about the project.
 *
 * ## Necessary, deliberately not sufficient
 *
 * This gate is cheap on purpose. It answers four questions — is the path inside
 * the project, is the file indexed, does the file declare the symbol, and is
 * the declaration a shape a timing wrapper can replace the body of — and it
 * answers them from the code graph and one parsed file. It does **not**
 * re-implement `./patch/function-timing.ts`, which is the final authority on a
 * patch target and additionally refuses an already-instrumented target, a React
 * component or hook, a body that reaches for `super` or `new.target`, and a
 * sloppy-mode body whose `arguments` object is observable. Those refusals need
 * the whole transform; reaching for it here would make every planning round pay
 * for the patch layer, and would put two modules in the position of having to
 * agree about a judgement only one of them can make.
 *
 * What this module guarantees is the half the planner needs: a plan that passes
 * it names files and symbols that exist, so the patcher's remaining refusals are
 * about the *shape* of real code rather than about a target the model invented.
 * A rejection is therefore always actionable, and never "re-index and try
 * again" for a project whose index is perfectly correct.
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
import type {
  FunctionDeclaration,
  FunctionExpression,
  MethodDeclaration,
  SourceFile,
} from 'ts-morph';

import { DebuggenError, isErr, normalizePosix, resolveWithinProject } from '@debuggen/shared';
import type { CodeGraph, CodeQueries, LoadedProject } from '@debuggen/code-analysis';

import type { InstrumentationContext } from './adapter.js';
import { actionIdentityKey } from './schema/plan.js';
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
 * Most declarations of one name collected from one file before the walk stops.
 *
 * A file can legitimately declare a name several times — a module-scope
 * function and a nested one, a class member and a local — and only the first in
 * the resolution order is classified. The cap exists so that a pathological
 * file cannot turn a feasibility check into an unbounded traversal; it is far
 * above anything ordinary code produces, and the ordering below means raising
 * or lowering it cannot change which candidate is chosen in a realistic file.
 */
const MAX_DECLARATION_CANDIDATES = 32;

/**
 * The segment a qualified spelling may carry between a class and its member,
 * as `Class.prototype.member`.
 *
 * Recognised so that the three spellings the function-timing patcher accepts
 * for a class member — `member`, `Class.member`, `Class#member`,
 * `Class.prototype.member` — all resolve to the same declaration here. A gate
 * that rejected a spelling the patcher accepts would be worse than no gate: it
 * would refuse a target that could have been instrumented.
 */
const PROTOTYPE_SEGMENT = 'prototype';

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
 * therefore never shown on its own — AAP §0.5.5 requires an explanation a
 * developer can act on, and an internal identifier is not one.
 *
 * - `'no-adapter'` — no registered adapter claims the action's type, so nothing
 *   would install it whatever its file says. Only reported when a resolver was
 *   supplied; see {@link FeasibilityOptions.resolver}.
 * - `'path-outside-project'` — the action's `file` is not a safe
 *   project-relative POSIX path, or resolves outside the project root. The one
 *   rejection that is a containment decision rather than a capability one.
 * - `'file-not-indexed'` — the code graph holds no entry for the file, so
 *   nothing is known about what it declares.
 * - `'symbol-not-found'` — the file is indexed and declares no addressable
 *   symbol of that name.
 * - `'unsupported-generator'` — the declaration is a generator function. A
 *   wrapper that calls the body as a function cannot preserve `yield`: the
 *   consumer would receive the wrapper's return value instead of an iterator
 *   (AAP §0.5.1).
 * - `'unsupported-async-generator'` — the same, for an `async function*`. Kept
 *   apart from the previous code because the two are different facts about the
 *   declaration and a caller may want to word them differently.
 * - `'unsupported-declaration'` — the file declares the name, but not as
 *   something a timing wrapper can replace the body of: a class, a type, an
 *   enum, a namespace, a constructor, an accessor, a variable holding a
 *   non-function, or a signature with no body.
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
  'path-outside-project',
  'file-not-indexed',
  'symbol-not-found',
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
 * The three fields beyond the action are the graceful-degradation channel of
 * AAP §0.5.5, in the wording `../adapter.ts` fixes for an `UnavailableSignal`:
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
 * into this repository, which is the AAP §0.5.4 line this module is scanned
 * against.
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

/**
 * A symbol spelling split into the name and the class that qualifies it.
 *
 * `container` is `undefined` for a bare name, which is also what a plan
 * normally carries.
 */
interface SymbolSpelling {
  readonly name: string;
  readonly container: string | undefined;
}

/**
 * One declaration of the requested name found in the parsed file, with the two
 * facts that order the candidates.
 */
interface DeclarationCandidate {
  /** The declaration node itself. */
  readonly node: Node;

  /**
   * Whether it sits at module scope — inside no function body and no namespace
   * — including as a member of a class declared at module scope.
   */
  readonly moduleScope: boolean;

  /** Its start offset in the file, which breaks ties in source order. */
  readonly start: number;
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
  let rendered = '';
  let counted = 0;

  for (const character of value) {
    if (counted === MAX_REPORTED_TEXT_LENGTH) {
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
 * no file at all (AAP §0.5.1). Saying so is what keeps a rejection from reading
 * like a dead end.
 */
const RUNTIME_ALTERNATIVE = 'A runtime signal needs no file edit at all.';

/**
 * The name a constructor is addressed by, for the one case where naming it
 * produces a better rejection than not recognising it.
 *
 * A constructor has no name node of its own, so it would otherwise be invisible
 * to {@link declaredNameOf} and a plan naming it would be told the file
 * declares no such symbol — while the code index, which records a constructor
 * as a method, says it does. Recognising the spelling here makes the two agree
 * and turns the answer into the accurate one: the declaration exists, and its
 * shape is what no wrapper fits.
 */
const CONSTRUCTOR_MEMBER_NAME = 'constructor';

// ---------------------------------------------------------------------------
// The checks
//
// One function per question, each returning `undefined` when the action passes
// and a `Rejection` when it does not, so the evaluation below reads as the
// ordered list AAP §0.7.1 describes.
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
 * Check 2 — does the path stay inside the project?
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
 * Check 3 — is the file one the product actually knows about?
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
 * Check 4 — does the file declare the symbol?
 *
 * `hasSymbol` is the code-analysis API written for exactly this: it resolves
 * `(file, symbol)` from the graph without loading references, so the gate stays
 * cheap, and it is documented to agree with the patcher — a symbol it affirms
 * is one the function-timing transform resolves to a declaration, and one it
 * denies is one the transform would refuse.
 *
 * The spelling is asked about twice when it is qualified. `hasSymbol` matches a
 * declaration's own name, so `Class.member` — a spelling the patcher accepts,
 * and the one a planner uses to disambiguate two declarations of one name —
 * would be denied on its qualified form alone. Asking again with the bare name
 * keeps this gate from refusing a target the patcher would have instrumented.
 *
 * @param file The normalised project-relative path.
 * @param action The action under test.
 * @param spelling The parsed spelling, whose `name` is the bare member name.
 * @param queries The bounded query surface over the graph.
 * @returns The rejection, or `undefined` when the file declares the symbol.
 */
function checkSymbolDeclared(
  file: string,
  action: InstrumentationAction,
  spelling: SymbolSpelling,
  queries: CodeQueries,
): Rejection | undefined {
  if (queries.hasSymbol(file, action.symbol)) {
    return undefined;
  }

  if (spelling.name !== action.symbol && queries.hasSymbol(file, spelling.name)) {
    return undefined;
  }

  return {
    code: 'symbol-not-found',
    reason: `'${reportable(file)}' declares no addressable symbol named '${reportable(action.symbol)}'`,
    hint: nearMissHint(spelling.name, file, queries),
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
 * @param name The bare symbol name that was not found.
 * @param file The file it was looked for in.
 * @param queries The bounded query surface over the graph.
 * @returns A single-line hint.
 */
function nearMissHint(name: string, file: string, queries: CodeQueries): string {
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
    return `Name a symbol '${reportable(file)}' declares, or plan a runtime signal instead. ${RUNTIME_ALTERNATIVE}`;
  }

  return `The code index declares ${rendered.join(', ')} — name the file that declares the symbol, or a symbol this file declares.`;
}

/**
 * Check 5 — is the declaration a shape a timing wrapper can replace the body
 * of?
 *
 * The one check that needs a syntax tree, and the one the AAP §0.5.1 template
 * constraint lives in: the wrapper moves the original body into an inner
 * function and calls it, which a generator's `yield` cannot survive — the
 * consumer would receive the wrapper's return value instead of an iterator —
 * and which a class, a type, an enum or a variable holding a plain value has no
 * body to participate in at all.
 *
 * **Absence of a tree is reported, never guessed.** A context with no loaded
 * project is a legitimate state — the service withholds it when no patch-mode
 * action is in play, because loading one is the most expensive thing this
 * package does — and answering "supported" for it would be this gate letting a
 * generator through to the patcher, where the wrapper builder throws rather
 * than refuses.
 *
 * @param file The normalised project-relative path.
 * @param absolutePath The same path, absolute, for the program lookup.
 * @param action The action under test.
 * @param spelling The parsed spelling.
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

  const candidate = resolveCandidate(sourceFile, spelling);

  if (candidate === undefined) {
    return {
      code: 'unsupported-declaration',
      reason: `'${reportable(file)}' holds '${reportable(action.symbol)}' in a position no timing wrapper can address`,
      hint: `Time a function declaration, a function-valued variable or a class method the file declares — or the function that contains this one. ${RUNTIME_ALTERNATIVE}`,
    };
  }

  return classifyDeclaration(candidate.node, action, file);
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
 * Splits a symbol spelling into the member name and the class qualifying it.
 *
 * The accepted forms are the function-timing patcher's: `member`,
 * `Class.member`, `Class#member` and `Class.prototype.member`. A spelling that
 * is none of them — empty, an empty segment, three or more meaningful segments
 * — yields the trimmed original as the name and no container, which then fails
 * the symbol check with a rejection that names what was asked for. That is the
 * honest answer: this module does not own the spelling vocabulary, and turning
 * an unparseable spelling into a different rejection code would report a
 * malformed plan as a missing declaration.
 *
 * @param symbol The `symbol` field of an action.
 * @returns The name, and the container when one was spelled.
 */
function parseSpelling(symbol: string): SymbolSpelling {
  const trimmed = symbol.trim();
  const segments = trimmed.split(/[.#]/u);
  const meaningful = segments.filter(
    (segment, index) => !(segments.length === 3 && index === 1 && segment === PROTOTYPE_SEGMENT),
  );
  const name = meaningful.at(-1);

  if (
    trimmed.length === 0 ||
    name === undefined ||
    meaningful.length > 2 ||
    meaningful.some((segment) => segment.length === 0)
  ) {
    return { name: trimmed, container: undefined };
  }

  return { name, container: meaningful.length === 2 ? meaningful[0] : undefined };
}

/**
 * The declaration a spelling resolves to, in the patcher's resolution order.
 *
 * Module scope first, then source order. Both tiers matter: the function-timing
 * transform resolves a bare name at module scope and descends into function
 * bodies only when module scope yields nothing, and the code graph's
 * `findSymbol` ranks its candidates the same way for the same reason — so a
 * file that declares one name twice is classified here on the declaration the
 * patch would actually rewrite, rather than on whichever one happens to be
 * written first.
 *
 * @param sourceFile The parsed target file.
 * @param spelling The parsed spelling.
 * @returns The chosen candidate, or `undefined` when the file declares nothing
 * of that name in a shape this module classifies.
 */
function resolveCandidate(
  sourceFile: SourceFile,
  spelling: SymbolSpelling,
): DeclarationCandidate | undefined {
  let best: DeclarationCandidate | undefined;

  for (const candidate of collectCandidates(sourceFile, spelling)) {
    if (best === undefined || precedes(candidate, best)) {
      best = candidate;
    }
  }

  return best;
}

/**
 * Whether one candidate resolves before another: module scope wins, then the
 * earlier position.
 *
 * @param left The candidate under consideration.
 * @param right The best candidate so far.
 * @returns `true` when `left` should replace `right`.
 */
function precedes(left: DeclarationCandidate, right: DeclarationCandidate): boolean {
  if (left.moduleScope !== right.moduleScope) {
    return left.moduleScope;
  }

  return left.start < right.start;
}

/**
 * Every declaration of the spelled name the file holds, capped at
 * {@link MAX_DECLARATION_CANDIDATES}.
 *
 * One depth-first walk of one file, which is the whole cost of check 5. A
 * qualified spelling additionally requires the candidate's nearest named owner
 * to be the spelled container, so `Class.member` does not match a module-scope
 * function of the same name and vice versa.
 *
 * @param sourceFile The parsed target file.
 * @param spelling The parsed spelling.
 * @returns The candidates, in source order.
 */
function collectCandidates(
  sourceFile: SourceFile,
  spelling: SymbolSpelling,
): readonly DeclarationCandidate[] {
  const candidates: DeclarationCandidate[] = [];

  sourceFile.forEachDescendant((node, traversal): undefined => {
    if (candidates.length >= MAX_DECLARATION_CANDIDATES) {
      traversal.stop();
      return undefined;
    }

    if (declaredNameOf(node) !== spelling.name) {
      return undefined;
    }

    if (spelling.container !== undefined && ownerName(node) !== spelling.container) {
      return undefined;
    }

    candidates.push({
      node,
      moduleScope: isModuleScope(node),
      start: node.getStart(),
    });

    return undefined;
  });

  return candidates;
}

/**
 * The name a node declares, when it is one of the declaration forms this module
 * classifies.
 *
 * Deliberately wider than the set of *supported* shapes: a class, a type, an
 * enum, a namespace, an accessor and a constructor all answer here, so that a
 * plan naming one of them is refused as `'unsupported-declaration'` — the
 * declaration exists and its shape is the problem — rather than as a missing
 * symbol, which would send the developer to re-index a correct index.
 *
 * The name is read through `Node.hasName`, so a form whose name is a binding
 * pattern rather than an identifier simply does not match a plain name.
 *
 * @param node The node under consideration.
 * @returns The declared name, or `undefined`.
 */
function declaredNameOf(node: Node): string | undefined {
  if (Node.isConstructorDeclaration(node)) {
    return CONSTRUCTOR_MEMBER_NAME;
  }

  if (!isClassifiedDeclaration(node)) {
    return undefined;
  }

  return Node.hasName(node) ? node.getName() : undefined;
}

/**
 * Whether a node is one of the declaration forms {@link classifyDeclaration}
 * has an answer for.
 *
 * @param node The node under consideration.
 * @returns `true` when the node is a classified declaration form.
 */
function isClassifiedDeclaration(node: Node): boolean {
  return (
    Node.isFunctionDeclaration(node) ||
    Node.isMethodDeclaration(node) ||
    Node.isVariableDeclaration(node) ||
    Node.isPropertyDeclaration(node) ||
    Node.isGetAccessorDeclaration(node) ||
    Node.isSetAccessorDeclaration(node) ||
    Node.isClassDeclaration(node) ||
    Node.isInterfaceDeclaration(node) ||
    Node.isTypeAliasDeclaration(node) ||
    Node.isEnumDeclaration(node) ||
    Node.isModuleDeclaration(node)
  );
}

/**
 * The qualifier a candidate would be spelled with: its class, or the nearest
 * named function or variable it is nested in.
 *
 * @param node The candidate declaration.
 * @returns The owner's name, or `undefined` at module scope.
 */
function ownerName(node: Node): string | undefined {
  let parent = node.getParent();

  while (parent !== undefined) {
    if (
      Node.isClassDeclaration(parent) ||
      Node.isFunctionDeclaration(parent) ||
      Node.isMethodDeclaration(parent) ||
      Node.isVariableDeclaration(parent)
    ) {
      const name = Node.hasName(parent) ? parent.getName() : undefined;

      if (name !== undefined) {
        return name;
      }
    }

    parent = parent.getParent();
  }

  return undefined;
}

/**
 * Whether a declaration sits at module scope.
 *
 * A member of a class declared at module scope counts as module scope, which is
 * what the patcher's first pass covers; anything inside a function body or a
 * namespace body does not.
 *
 * @param node The candidate declaration.
 * @returns `true` when no function or namespace body encloses it.
 */
function isModuleScope(node: Node): boolean {
  let parent = node.getParent();

  while (parent !== undefined) {
    if (Node.isSourceFile(parent)) {
      return true;
    }

    if (isFunctionLike(parent) || Node.isModuleDeclaration(parent)) {
      return false;
    }

    parent = parent.getParent();
  }

  return true;
}

/**
 * Whether a node introduces a function scope.
 *
 * @param node The node under consideration.
 * @returns `true` for every function form, including accessors and
 * constructors.
 */
function isFunctionLike(node: Node): boolean {
  return (
    Node.isFunctionDeclaration(node) ||
    Node.isFunctionExpression(node) ||
    Node.isArrowFunction(node) ||
    Node.isMethodDeclaration(node) ||
    Node.isConstructorDeclaration(node) ||
    Node.isGetAccessorDeclaration(node) ||
    Node.isSetAccessorDeclaration(node)
  );
}

/**
 * The verdict on one resolved declaration: `undefined` when a timing wrapper
 * can replace its body, a rejection otherwise.
 *
 * The supported set is exactly the one the function-timing template has a form
 * for — a function declaration, a function-valued variable or class property
 * (arrow or function expression), and a class method — and an exported route
 * handler is a function declaration like any other, recognised structurally
 * rather than by matching a route path (AAP §0.5.4).
 *
 * @param node The resolved declaration.
 * @param action The action under test.
 * @param file The normalised project-relative path.
 * @returns The rejection, or `undefined` when the declaration is supported.
 */
function classifyDeclaration(
  node: Node,
  action: InstrumentationAction,
  file: string,
): Rejection | undefined {
  if (Node.isFunctionDeclaration(node)) {
    return node.getBody() === undefined
      ? unsupportedShape(action, file, 'a function signature with no body')
      : generatorRejection(node, action, file);
  }

  if (Node.isMethodDeclaration(node)) {
    return node.getBody() === undefined
      ? unsupportedShape(action, file, 'a method signature with no body')
      : generatorRejection(node, action, file);
  }

  if (Node.isVariableDeclaration(node) || Node.isPropertyDeclaration(node)) {
    const initializer = node.getInitializer();

    if (initializer === undefined) {
      return unsupportedShape(
        action,
        file,
        'a declaration with no initialiser, so it holds no function',
      );
    }

    if (Node.isArrowFunction(initializer)) {
      return undefined;
    }

    if (Node.isFunctionExpression(initializer)) {
      return generatorRejection(initializer, action, file);
    }

    return unsupportedShape(action, file, 'a value that is not a function expression');
  }

  if (Node.isGetAccessorDeclaration(node) || Node.isSetAccessorDeclaration(node)) {
    return unsupportedShape(action, file, 'a property accessor');
  }

  if (Node.isConstructorDeclaration(node)) {
    return unsupportedShape(action, file, 'a constructor');
  }

  if (Node.isClassDeclaration(node)) {
    return unsupportedShape(action, file, 'a class');
  }

  if (Node.isInterfaceDeclaration(node) || Node.isTypeAliasDeclaration(node)) {
    return unsupportedShape(
      action,
      file,
      'a type declaration, which is gone by the time the code runs',
    );
  }

  if (Node.isEnumDeclaration(node)) {
    return unsupportedShape(action, file, 'an enum');
  }

  if (Node.isModuleDeclaration(node)) {
    return unsupportedShape(action, file, 'a namespace');
  }

  return unsupportedShape(action, file, 'a declaration that is not a function');
}

/**
 * The rejection for a generator, or `undefined` when the function is not one.
 *
 * Separate codes for the plain and the `async` form, because they are different
 * facts about the declaration and a caller may word them differently; the
 * consequence is the same, and it is the one AAP §0.5.1 states.
 *
 * @param fn The resolved function node.
 * @param action The action under test.
 * @param file The normalised project-relative path.
 * @returns The rejection, or `undefined`.
 */
function generatorRejection(
  fn: FunctionDeclaration | FunctionExpression | MethodDeclaration,
  action: InstrumentationAction,
  file: string,
): Rejection | undefined {
  if (!fn.isGenerator()) {
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
 * @param clause What was found, completing "declares ‹symbol› as …".
 * @returns The rejection.
 */
function unsupportedShape(action: InstrumentationAction, file: string, clause: string): Rejection {
  return {
    code: 'unsupported-declaration',
    reason: `'${reportable(file)}' declares '${reportable(action.symbol)}' as ${clause}, whose body no timing wrapper can replace`,
    hint: `Time a function declaration, a function-valued variable or a class method instead. ${RUNTIME_ALTERNATIVE}`,
  };
}

/**
 * Check 6 — has this call already accepted the same work?
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
 * The ordered gate of AAP §0.7.1 Group 1, run by `./installer.ts` before a
 * single byte is written and by `apps/local-service/src/pipeline/stages/plan.ts`
 * as soon as a plan has been normalised. Every action is judged
 * **independently**, and the first failing check is the one reported — a target
 * has one most-useful explanation, and stacking the rest of them onto it makes
 * a progress row unreadable:
 *
 * 1. An adapter claims the action's type, when a resolver was supplied.
 * 2. `patch`-mode only: the file is a safe project-relative path inside the
 *    project root.
 * 3. `patch`-mode only: the code index holds the file.
 * 4. `patch`-mode only: the file declares the symbol.
 * 5. `patch`-mode only: the declaration is a shape a timing wrapper fits —
 *    generators and anything without a wrappable body are refused here.
 * 6. No earlier action in this same call already asked for the work.
 *
 * `runtime`-mode actions skip checks 2 to 5, and that is not a shortcut: a
 * runtime action arms a hook the product already owns — a listener in the page
 * agent, an instrumentation inside the dev-server preload — so it writes
 * nothing to a file, and the file and symbol it carries are the *subject* of the
 * signal rather than an edit site. Refusing one for a symbol the index has not
 * got would withdraw a whole tier of telemetry over a stale index.
 *
 * **Nothing is thrown for a rejection.** Every refusal is an
 * {@link InfeasibleAction} on the report, carrying the two sentences a
 * developer reads (AAP §0.5.5). A {@link DebuggenError} with code `'INTERNAL'`
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
 * Runs checks 1 to 5 for one action, stopping at the first failure.
 *
 * Check 6 is the caller's, because it is the only check whose answer depends on
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

  if (action.mode !== 'patch') {
    return { feasible: true, file: normalizePosix(action.file) };
  }

  const contained = checkContainedPath(action, context.projectRoot);

  if (!('absolutePath' in contained)) {
    return { feasible: false, rejection: contained };
  }

  const file = normalizePosix(action.file);
  const spelling = parseSpelling(action.symbol);

  const unindexed = checkFileIndexed(file, contained.absolutePath, context.graph, context.loaded);

  if (unindexed !== undefined) {
    return { feasible: false, rejection: unindexed };
  }

  const undeclared = checkSymbolDeclared(file, action, spelling, context.queries);

  if (undeclared !== undefined) {
    return { feasible: false, rejection: undeclared };
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
