/**
 * The read-only resolution of a patch target: which one declaration a
 * `(file, symbol)` pair names, and whether it is a form a timing wrapper can
 * replace the body of.
 *
 * ## Why this is its own module
 *
 * Two parts of this package answer the question "which declaration does this
 * action mean?" — `../feasibility.ts`, before a plan is accepted, and
 * `./function-timing.ts`, immediately before a file is written. When each
 * carried its own resolver they disagreed: the gate classified the *earliest*
 * of two nested same-named declarations and accepted a bare name the patcher
 * then refused as ambiguous, and it computed a nested declaration's owner from a
 * different set of scopes, so it refused `enclosingFunction.inner` spellings
 * the patcher resolves and accepted object-literal spellings the patcher cannot
 * address. A plan the gate affirmed then failed at install, which is exactly
 * the failure the gate exists to prevent.
 *
 * One resolver, used by both, removes the disagreement by construction. Every
 * rule it applies — the qualified spellings it accepts, module scope before
 * nested scope, refusing rather than guessing between two declarations, the
 * nearest named function-like scope as a nested declaration's owner, and the
 * positions no wrapper can reach — is stated once, here.
 *
 * ## What it does not do
 *
 * It never edits a tree. The patcher parses a private copy of the file and
 * rewrites that; the feasibility gate hands in the code index's own parsed
 * source, which other readers share, so every function below only *reads* the
 * node it is given. The support checks that depend on the emitted wrapper — a
 * generator's `yield`, a React render function's hook calls, `super`,
 * `new.target`, a sloppy-mode `arguments` object — stay in
 * `./function-timing.ts`, beside the template they protect.
 *
 * ## Refusals
 *
 * Every expected failure is a {@link DebuggenError} carrying a stable
 * `details.reason` ({@link Refusal.reason}); details are paths, names, positions
 * and vocabulary, never a fragment of the developer's source.
 *
 * This module is internal to the package: it is imported directly by its two
 * callers and is not part of the package entry. The vocabularies a caller can
 * branch on — {@link PATCH_TARGET_SHAPES}, {@link PATCH_NON_ADDRESSABLE_POSITIONS}
 * and {@link QUALIFIED_SYMBOL_SEPARATORS} — are re-exported publicly by
 * `./function-timing.ts`.
 *
 * @example Resolving a target against an already-parsed file
 * ```ts
 * const resolved = resolvePatchTarget(sourceFile, 'Checkout.submit', 'src/checkout.ts');
 * if (resolved.ok) {
 *   console.log(resolved.value.shape, resolved.value.declaration.getStartLineNumber());
 * } else {
 *   console.log(resolved.error.details['reason']); // e.g. 'ambiguous-symbol'
 * }
 * ```
 *
 * @module
 */

import { Node } from 'ts-morph';
import type {
  ArrowFunction,
  ClassDeclaration,
  FunctionDeclaration,
  FunctionExpression,
  MethodDeclaration,
  SourceFile,
  Statement,
  VariableDeclaration,
} from 'ts-morph';

import { DebuggenError, err, ok } from '@debuggen/shared';
import type { Result } from '@debuggen/shared';

import type { InstrumentationActionType } from '../schema/plan.js';

/**
 * The declaration shapes this transform can wrap, which is the closed set of
 * forms a named, body-carrying function takes at module scope, on a class, or
 * inside another function's body.
 *
 * The **shape** is what the emitted wrapper is chosen by, and it does not
 * depend on where the declaration sits: a nested `function name() {}` is the
 * same `'function-declaration'` as a module-scope one and takes the same
 * template, and a nested `const name = () => …` is the same
 * `'arrow-function'`. See {@link collectNestedCandidates} for which nested
 * forms are addressable, and {@link PATCH_NON_ADDRESSABLE_POSITIONS} for the
 * positions that are not.
 *
 * - `'function-declaration'` — `function f() {}`, including `export function`,
 *   `export async function` and `export default function f`. An exported route
 *   handler is this shape and nothing more: it is recognised **structurally**,
 *   by being an exported function declaration in the module the plan named, and
 *   never by matching a route path (AAP §0.5.4).
 * - `'function-expression'` — `const f = function () {}`, and the same as a
 *   class property initialiser. Binds `arguments` and a dynamic `this`, so it
 *   takes the same template as a declaration.
 * - `'arrow-function'` — `const f = (a, b) => …`, expression- or block-bodied,
 *   and the same as a class property initialiser. Binds neither `arguments` nor
 *   its own `this`, so it takes the rest-parameter template.
 * - `'method'` — a class method. Its `this` is the instance, which the
 *   template's `'this'` receiver forwards.
 *
 * Frozen because it is vocabulary rather than state, and exported so a caller
 * or a test can enumerate the shapes instead of restating them.
 */
export const PATCH_TARGET_SHAPES = Object.freeze([
  'function-declaration',
  'function-expression',
  'arrow-function',
  'method',
] as const);

/** One member of {@link PATCH_TARGET_SHAPES}. */
export type PatchTargetShape = (typeof PATCH_TARGET_SHAPES)[number];

/**
 * Where a declaration this module *found* but cannot wrap was sitting, carried
 * as `details.position` on a `'symbol-not-addressable'` refusal.
 *
 * The distinction this vocabulary exists to make is the one that was missing:
 * "the file declares no such symbol" and "the file declares it, in a position
 * whose body a wrapper cannot replace" are different facts with different next
 * steps, and answering the second with the first tells a developer to re-index
 * a project whose index is perfectly correct.
 *
 * - `'parameter'` — a parameter binding, including a destructured prop such as
 *   `function Row({ onPick })`. It holds whatever the caller passed, so there
 *   is no declaration here whose body could move.
 * - `'binding-element'` — an element of a destructuring pattern in a variable
 *   declaration: `const { onClose } = props`, `const [q, setQ] = useState()`.
 *   The value is taken out of another object at run time.
 * - `'non-function-declarator'` — a **nested** `const`/`let`/`var` whose
 *   initialiser is not a function literal, `const cb = useCallback(…)` above
 *   all. A *module-scope* declarator of that shape resolves and is refused
 *   `'unsupported-declaration'` instead, which is unchanged.
 * - `'object-literal-member'` — a property, method or accessor of an object
 *   literal.
 * - `'class-member'` — a member of a class this transform does not address,
 *   which is any class not declared at module scope.
 * - `'class-declaration'` — the class itself, whose body runs field
 *   initialisers on construction rather than one timed call.
 * - `'type-declaration'` — a `type`, `interface`, `enum`, enum member or type
 *   parameter, every one of which erases before anything runs.
 * - `'namespace'` — a namespace or module declaration.
 * - `'import-binding'` — the name is bound by an import, so the declaration
 *   that has a body is in another module.
 * - `'function-expression-name'` — the name a function *expression* gives
 *   itself, which is bound only inside that expression.
 * - `'mismatched-container'` — the file does declare an addressable function of
 *   that name, but under a different qualification than the spelling named.
 * - `'unreachable-scope'` — a function-valued declaration in a scope this
 *   transform does not descend into: a namespace body, or nesting deeper than
 *   {@link MAX_NESTED_DECLARATION_DEPTH}.
 *
 * Frozen because it is vocabulary rather than state, and exported so a caller
 * or a test can enumerate the positions instead of restating them.
 */
export const PATCH_NON_ADDRESSABLE_POSITIONS = Object.freeze([
  'parameter',
  'binding-element',
  'non-function-declarator',
  'object-literal-member',
  'class-member',
  'class-declaration',
  'type-declaration',
  'namespace',
  'import-binding',
  'function-expression-name',
  'mismatched-container',
  'unreachable-scope',
] as const);

/** One member of {@link PATCH_NON_ADDRESSABLE_POSITIONS}. */
export type PatchNonAddressablePosition = (typeof PATCH_NON_ADDRESSABLE_POSITIONS)[number];

/**
 * Qualified spellings this module accepts for a class member, in addition to
 * the bare member name.
 *
 * `packages/code-analysis/src/extractors/symbols.ts` records a class member
 * under its **bare** name with the owning class in a separate `container`
 * field, so a plan's `symbol` is normally just `'settleSegments'`. The
 * qualified spellings exist for the case a bare name cannot address: two
 * classes in one module that declare a member of the same name, which is
 * otherwise an ambiguous target and therefore a refusal.
 *
 * Accepted: `'method'`, `'Class.method'`, `'Class#method'` and
 * `'Class.prototype.method'`. Anything else — a deeper path, an empty segment —
 * is refused rather than guessed at.
 */
export const QUALIFIED_SYMBOL_SEPARATORS = Object.freeze(['.', '#'] as const);

/**
 * The segment a `'Class.prototype.method'` spelling carries in the middle,
 * which is dropped when the spelling is parsed.
 */
const PROTOTYPE_SEGMENT = 'prototype';

/**
 * The function-like nodes this transform can rewrite.
 *
 * Deliberately not `FunctionLikeDeclaration`: that union also admits
 * constructors, accessors and function types, each of which this module
 * refuses for its own stated reason.
 */
export type PatchableFunctionNode =
  ArrowFunction | FunctionDeclaration | FunctionExpression | MethodDeclaration;

/** A resolved target: one declaration this module knows how to wrap. */
export interface ResolvedTarget {
  /** Which of the four shapes it is. */
  readonly shape: PatchTargetShape;

  /** The function-like node whose body moves. */
  readonly fn: PatchableFunctionNode;

  /**
   * That function's body: a block for the three `arguments`-style shapes, and
   * either a block or the single expression for an arrow.
   *
   * Captured at resolution time because a body is what makes a declaration a
   * target at all: an overload signature, an ambient declaration and an
   * abstract method have none and are refused before they become a resolved
   * target, so every consumer of this field has a body without re-checking for
   * one.
   */
  readonly body: Node;

  /**
   * The name identifier the recorded position points at — a declaration's or
   * method's name node, or the variable/property the function is assigned to.
   */
  readonly nameNode: Node;

  /**
   * The whole declaration, used for `endLine`, for the already-instrumented
   * check and for the indentation of the emitted wrapper. For an assigned
   * function this is the variable or property declaration, not the function.
   */
  readonly declaration: Node;

  /**
   * The declaration whose identifiers the collision scan reads, which is
   * {@link ResolvedTarget.declaration} itself for a module-scope target and the
   * enclosing top-level declaration for a nested one.
   *
   * The two differ because a nested target's moved body can reference a binding
   * declared in an **enclosing** scope, and shadowing it with the wrapper's own
   * `__orig` or `__dbg` would change what that body reads. Scanning the
   * enclosing declaration is a superset of the bindings that could collide,
   * which costs at most a disambiguating rename and never a wrong one. See
   * `allocateIdentifiers` in `./function-timing.ts`.
   */
  readonly identifierScope: Node;

  /** The bare declared name. */
  readonly declaredName: string;

  /** The owning class's name for a class member, `undefined` otherwise. */
  readonly container: string | undefined;

  /**
   * The nearest named declaration this one is nested inside, for a target
   * declared within another function's body; `undefined` at module scope and
   * for a class member.
   */
  readonly enclosing: string | undefined;
}

/** Why this module declines to wrap a declaration it did resolve. */
export interface Refusal {
  /**
   * A stable machine-readable reason, carried as `details.reason` on the
   * returned error. The spellings this module and `./function-timing.ts` use
   * are, in the order the checks run: `'file-not-found'`, `'symbol-not-found'`,
   * `'symbol-not-addressable'`, `'ambiguous-symbol'`,
   * `'unsupported-declaration'`, `'unsupported-accessor'`,
   * `'unsupported-constructor'`, `'unsupported-generator'`,
   * `'unsupported-async-generator'`, `'unsupported-react-component'`,
   * `'unsupported-super-reference'`,
   * `'unsupported-new-target'`, `'unsupported-mapped-arguments'`,
   * `'unsupported-arguments-callee'`, `'unsupported-direct-eval'`,
   * `'already-instrumented'`, `'identifier-unavailable'`,
   * `'malformed-symbol'`, `'unsupported-polymorphic-this'`,
   * `'unsupported-anonymous-class'`, `'overlapping-edits'`,
   * `'invalid-syntax'` and `'unsupported-introduced-diagnostic'`.
   *
   * Six of them are the ones a *semantics-preserving* wrapper cannot be
   * emitted for: the three `arguments` spellings come from
   * `detectArgumentsHazard` in `./wrap-template.ts` and cover a sloppy-mode body whose mapped
   * arguments object the move would rebind; the two `this` spellings come from
   * the receiver-typing rules and cover a receiver that cannot be named in the
   * inner function's signature; and `'unsupported-introduced-diagnostic'` is
   * the semantic pre-flight reporting that the emitted text would add a
   * compiler diagnostic the target file does not already have.
   *
   * Two of them say something about a declaration the transform declines on
   * *policy* rather than on semantics: `'symbol-not-addressable'` reports a
   * declaration the file really does hold, in a position no wrapper can replace
   * the body of (see {@link PATCH_NON_ADDRESSABLE_POSITIONS}), and
   * `'unsupported-react-component'` reports a render function, which AAP §0.5.1
   * tracks at run time instead of patching.
   *
   * `../feasibility.ts` resolves every patch-mode action through
   * {@link resolvePatchTarget} before a plan is accepted and maps the reasons it
   * meets onto its own rejection vocabulary; `./function-timing.ts` resolves
   * the same way again immediately before a file would be written, because it
   * is the last thing to look at the declaration, and adds the support checks
   * that depend on the emitted wrapper.
   */
  readonly reason: string;

  /** A complete sentence naming what cannot be wrapped. */
  readonly message: string;

  /** The developer-facing next step, where one applies. */
  readonly hint: string | undefined;
}

/** One candidate found while resolving a symbol to a declaration. */
interface Candidate {
  /** The bare declared name, which matched the requested symbol. */
  readonly declaredName: string;

  /** The owning class's name when the candidate is a class member. */
  readonly container: string | undefined;

  /**
   * The nearest named enclosing declaration when the candidate is nested inside
   * another function's body, `undefined` at module scope and on a class.
   *
   * Reported in an ambiguity refusal beside {@link Candidate.container}, because
   * it is the other half of the qualification that names one of several
   * same-named declarations.
   */
  readonly enclosing: string | undefined;

  /** The whole declaration, for diagnostics and for ordering. */
  readonly declaration: Node;

  /** Set when the candidate is a form this module can wrap. */
  readonly target: ResolvedTarget | undefined;

  /** Set when the candidate is a form this module refuses, with the reason. */
  readonly refusal: Refusal | undefined;
}

/** A parsed `symbol` spelling: a bare member name and an optional container. */
export interface SymbolSpelling {
  /** The bare declared name to match. */
  readonly name: string;

  /** The class name the spelling qualified the member with, if any. */
  readonly container: string | undefined;
}

/**
 * The name a class constructor is addressed by, matching the name
 * `packages/code-analysis/src/extractors/symbols.ts` records it under.
 *
 * Present so a plan that names a constructor gets the refusal that explains why
 * a constructor is not a function-timing target, rather than a misleading
 * "symbol not found".
 */
const CONSTRUCTOR_MEMBER_NAME = 'constructor';

/** How many wrapping expressions an initialiser may hide a function behind. */
const MAX_INITIALIZER_UNWRAP_DEPTH = 8;

/**
 * How many function-like scopes deep the nested-declaration descent goes,
 * counting the first body inside module scope as depth 1.
 *
 * A bound rather than an unbounded walk for the same reason
 * {@link MAX_INITIALIZER_UNWRAP_DEPTH} is one: resolution has to terminate on
 * hostile or generated input, and a declaration buried eight function bodies
 * deep is not a target a plan can describe to a developer anyway. Eight is
 * deliberately far past real code — the deepest named handler in a React
 * component tree is at depth 1 or 2 — so the bound is a guard rail rather than
 * a policy, and a declaration beyond it is reported as
 * `'symbol-not-addressable'` with the position `'unreachable-scope'` rather
 * than as a symbol the file does not declare.
 */
const MAX_NESTED_DECLARATION_DEPTH = 8;

/**
 * How many qualified spellings an ambiguity hint lists.
 *
 * Bounded because the hint is one sentence a developer reads: the first few
 * spellings show how to name one declaration, and a file with a dozen
 * same-named nested handlers is ambiguous for the same reason whether they are
 * all listed or not.
 */
const MAX_REPORTED_SPELLINGS = 4;

/**
 * The plan action type a refused React target is redirected to.
 *
 * Typed against the plan's own action vocabulary rather than written as a bare
 * string, so a rename in `../schema/plan.js` is a compile error here instead of
 * a hint that names an action type the planner would reject. React renders are
 * runtime-tracked (AAP §0.5.1), which is why this redirection costs no file
 * edit at all.
 */
export const REACT_RENDER_ACTION_TYPE: InstrumentationActionType = 'react-render-tracking';

/**
 * Builds a coded refusal.
 *
 * Every expected failure of this module is one of these: a decision **not** to
 * produce text, carrying the code a caller branches on and the `reason` a log
 * or a test asserts against. Details are paths, names, positions and
 * vocabulary — never a fragment of the developer's source, which this module
 * reads in full and must not leak into a log line or a user interface.
 *
 * @param code The failure being reported, from the closed error vocabulary.
 * @param reason The machine-readable reason. See {@link Refusal.reason}.
 * @param message A complete sentence naming what cannot be patched.
 * @param details Diagnostic context, merged with `reason`.
 * @param hint The developer-facing next step, when one applies.
 * @returns The error, for the caller to wrap in `err`.
 */
export function refusal(
  code: 'INTERNAL' | 'PATCH_TARGET_NOT_FOUND' | 'PATCH_UNSUPPORTED',
  reason: string,
  message: string,
  details: Readonly<Record<string, unknown>>,
  hint?: string,
): DebuggenError {
  const options =
    hint === undefined
      ? { details: { reason, ...details } }
      : { details: { reason, ...details }, hint };

  return new DebuggenError(code, message, options);
}

/**
 * Parses a `symbol` spelling into a bare name and an optional container.
 *
 * Accepts `'member'`, `'Class.member'`, `'Class#member'` and
 * `'Class.prototype.member'` — see {@link QUALIFIED_SYMBOL_SEPARATORS} for why
 * the qualified forms exist — and refuses anything with an empty segment or
 * more than two meaningful ones rather than interpreting it.
 *
 * @param symbol The spelling as the request gave it.
 * @returns The parsed spelling, or a `PATCH_TARGET_NOT_FOUND` refusal.
 */
export function parseSymbolSpelling(symbol: string): Result<SymbolSpelling> {
  const trimmed = symbol.trim();

  if (trimmed.length === 0) {
    return err(
      refusal(
        'PATCH_TARGET_NOT_FOUND',
        'malformed-symbol',
        'A patch target must name a symbol, and this one names none.',
        { symbol },
      ),
    );
  }

  const segments = trimmed.split(/[.#]/u);

  if (segments.some((segment) => segment.length === 0)) {
    return err(
      refusal(
        'PATCH_TARGET_NOT_FOUND',
        'malformed-symbol',
        'A patch target must not contain an empty name segment.',
        { symbol },
      ),
    );
  }

  const meaningful = segments.filter(
    (segment, index) => !(segments.length === 3 && index === 1 && segment === PROTOTYPE_SEGMENT),
  );
  const name = meaningful.at(-1);

  if (name === undefined || meaningful.length > 2) {
    return err(
      refusal(
        'PATCH_TARGET_NOT_FOUND',
        'malformed-symbol',
        'A patch target is a name, optionally qualified by the class that declares it.',
        { symbol, accepted: ['member', 'Class.member', 'Class#member', 'Class.prototype.member'] },
      ),
    );
  }

  return ok({ name, container: meaningful.length === 2 ? meaningful[0] : undefined });
}

/**
 * Resolves a spelling to exactly one declaration this module can wrap.
 *
 * Exact-name and unambiguous, in three refusal steps: nothing matched, more
 * than one matched, or the single match is a form this module declines. There
 * is no fuzzy fallback — a plan that named a symbol this file does not declare
 * is a plan built against a different file, and patching the nearest thing
 * would instrument the wrong function and report a source location that looked
 * authoritative.
 *
 * ## The two passes, and why module scope goes first
 *
 * The first pass is module scope and the members of the classes declared there
 * ({@link collectFromStatement}). The second descends into the file's function
 * bodies ({@link collectNestedCandidates}) and is reached **only when the first
 * found nothing at all** — which is what keeps every module-scope target
 * resolving exactly as it did before nested resolution existed. A module-scope
 * `handleThing` and a nested one in the same file would otherwise become an
 * ambiguity, turning a patch that worked into a refusal; with the passes
 * ordered, the outer declaration keeps the bare name and the nested one is
 * named `Enclosing.handleThing`.
 *
 * ## Why nested declarations are addressed at all
 *
 * A React event handler is a named function declared inside its component, and
 * timing one is exactly what the product's canonical plan asks for. The code
 * graph records those declarations, so refusing them here would mean the
 * feasibility gate affirming a target the installer then cannot install. The
 * agreement the two sides keep is: the graph affirms a `(file, symbol)` pair if
 * and only if this resolver answers with a declaration for it.
 *
 * @param sourceFile The parsed copy of the target file.
 * @param spelling The parsed symbol spelling.
 * @param file The project-relative path, for the refusal details.
 * @returns The single resolved target, or a refusal.
 */
export function resolveTarget(
  sourceFile: SourceFile,
  spelling: SymbolSpelling,
  file: string,
): Result<ResolvedTarget> {
  const candidates: Candidate[] = [];

  for (const statement of sourceFile.getStatements()) {
    collectFromStatement(statement, spelling, candidates);
  }

  if (candidates.length === 0) {
    collectNestedCandidates(sourceFile, undefined, 0, spelling, candidates);
  }

  const first = candidates[0];

  if (first === undefined) {
    // Only here — never on the happy path — is the file scanned for a
    // declaration in a position no wrapper can replace the body of, so the
    // precise answer costs nothing in the case that resolves.
    const finding = nonAddressableFinding(sourceFile, spelling);

    if (finding !== undefined) {
      return err(nonAddressableRefusal(finding, spelling, file));
    }

    return err(
      refusal(
        'PATCH_TARGET_NOT_FOUND',
        'symbol-not-found',
        'The target file declares no such symbol at module scope or on a class it declares.',
        { file, symbol: spelling.name, container: spelling.container },
        'Re-index the project: the plan names a symbol this file does not declare.',
      ),
    );
  }

  // A refusal every candidate shares is reported as that refusal rather than as
  // an ambiguity, and the case is not hypothetical: a get/set pair is two
  // declarations of one name, so "qualify it" would be advice that cannot help.
  // The developer needs to hear that an accessor is not a timing target.
  const sharedRefusal =
    first.refusal !== undefined &&
    candidates.every((candidate) => candidate.refusal?.reason === first.refusal?.reason)
      ? first.refusal
      : undefined;

  if (sharedRefusal !== undefined) {
    return err(
      refusal(
        'PATCH_UNSUPPORTED',
        sharedRefusal.reason,
        sharedRefusal.message,
        {
          file,
          symbol: spelling.name,
          container: first.container,
          declarations: candidates.length,
        },
        sharedRefusal.hint,
      ),
    );
  }

  if (candidates.length > 1) {
    return err(
      refusal(
        'PATCH_TARGET_NOT_FOUND',
        'ambiguous-symbol',
        'The target symbol resolves to more than one declaration, so it is not addressable.',
        {
          file,
          symbol: spelling.name,
          candidates: candidates.map((candidate) => ({
            container: candidate.container,
            enclosing: candidate.enclosing,
            line: candidate.declaration.getStartLineNumber(),
          })),
        },
        ambiguityHint(candidates),
      ),
    );
  }

  if (first.target === undefined) {
    return err(
      refusal(
        'INTERNAL',
        'unresolved-candidate',
        'A patch candidate was neither wrappable nor refused, which is a defect in the resolver.',
        { file, symbol: spelling.name },
      ),
    );
  }

  return ok(first.target);
}

/**
 * The hint an ambiguity refusal carries: how to name one of the declarations
 * that matched.
 *
 * Built from the candidates rather than stated as a constant, because the
 * spelling that disambiguates depends on what they are. A class member is named
 * `Class.member`; a declaration nested in another function is named
 * `Enclosing.name`, which is the same syntax
 * {@link parseSymbolSpelling} already parses. Listing the concrete spellings is
 * what turns "qualify it" into something a plan can be edited to say, and a
 * candidate with neither a container nor an enclosing declaration — two
 * same-named declarations inside unnamed closures — contributes none, which is
 * why the generic sentence is still the fallback.
 *
 * @param candidates The candidates that matched, in source order.
 * @returns The hint sentence.
 */
function ambiguityHint(candidates: readonly Candidate[]): string {
  const spellings: string[] = [];

  for (const candidate of candidates) {
    const qualifier = candidate.container ?? candidate.enclosing;

    if (qualifier === undefined || spellings.length >= MAX_REPORTED_SPELLINGS) {
      continue;
    }

    const spelling = `${qualifier}.${candidate.declaredName}`;

    if (!spellings.includes(spelling)) {
      spellings.push(spelling);
    }
  }

  if (spellings.length === 0) {
    return 'Qualify the symbol as Class.member to name one of them.';
  }

  return `Qualify the symbol to name one of them: ${spellings.join(', ')} — Class.member for a class member, Enclosing.name for a declaration nested inside another.`;
}

/**
 * Collects the candidates one top-level statement contributes.
 *
 * Module scope, and class members of classes declared at module scope: the
 * surface `packages/code-analysis`'s symbol extractor records under a bare name
 * or a `container`. A declaration inside another function's body is collected
 * by {@link collectNestedCandidates} instead, and only when this pass found
 * nothing, so a module-scope declaration always wins a bare name.
 *
 * @param statement The statement to inspect.
 * @param spelling The name and optional container being resolved.
 * @param into The accumulator, appended to in source order.
 */
function collectFromStatement(
  statement: Statement,
  spelling: SymbolSpelling,
  into: Candidate[],
): void {
  if (Node.isFunctionDeclaration(statement)) {
    if (spelling.container !== undefined) {
      return;
    }

    const nameNode = statement.getNameNode();

    if (nameNode === undefined || nameNode.getText() !== spelling.name) {
      return;
    }

    // An overload signature is not the target; its implementation is. Skipping
    // it here is what keeps an overloaded function from looking ambiguous.
    if (statement.isOverload() && statement.getImplementation() !== undefined) {
      return;
    }

    const body = statement.getBody();

    into.push({
      declaredName: spelling.name,
      container: undefined,
      enclosing: undefined,
      declaration: statement,
      target:
        body === undefined
          ? undefined
          : {
              shape: 'function-declaration',
              fn: statement,
              body,
              nameNode,
              declaration: statement,
              identifierScope: statement,
              declaredName: spelling.name,
              container: undefined,
              enclosing: undefined,
            },
      refusal: body === undefined ? BODYLESS_DECLARATION_REFUSAL : undefined,
    });

    return;
  }

  if (Node.isVariableStatement(statement)) {
    if (spelling.container !== undefined) {
      return;
    }

    for (const declaration of statement.getDeclarations()) {
      const nameNode = declaration.getNameNode();

      if (!Node.isIdentifier(nameNode) || nameNode.getText() !== spelling.name) {
        continue;
      }

      into.push(
        assignedFunctionCandidate(
          unwrapInitializer(declaration.getInitializer()),
          declaration,
          nameNode,
          spelling.name,
          { container: undefined, enclosing: undefined, identifierScope: declaration },
        ),
      );
    }

    return;
  }

  if (Node.isClassDeclaration(statement)) {
    collectFromClass(statement, spelling, into);
  }
}

/**
 * Collects the candidates one class declaration contributes.
 *
 * @param classDeclaration The class to inspect.
 * @param spelling The name and optional container being resolved.
 * @param into The accumulator, appended to in source order.
 */
function collectFromClass(
  classDeclaration: ClassDeclaration,
  spelling: SymbolSpelling,
  into: Candidate[],
): void {
  const container = classDeclaration.getName();

  if (spelling.container !== undefined && container !== spelling.container) {
    return;
  }

  for (const member of classDeclaration.getMembers()) {
    if (Node.isConstructorDeclaration(member)) {
      if (spelling.name === CONSTRUCTOR_MEMBER_NAME) {
        into.push({
          declaredName: spelling.name,
          container,
          enclosing: undefined,
          declaration: member,
          target: undefined,
          refusal: {
            reason: 'unsupported-constructor',
            message:
              'A constructor is not a function-timing target: its body runs field initialisers and may call super, neither of which survives being moved into an inner function.',
            hint: 'Instrument a method the constructor calls instead.',
          },
        });
      }

      continue;
    }

    if (Node.isGetAccessorDeclaration(member) || Node.isSetAccessorDeclaration(member)) {
      if (declaredNameOf(member.getNameNode()) === spelling.name) {
        into.push({
          declaredName: spelling.name,
          container,
          enclosing: undefined,
          declaration: member,
          target: undefined,
          refusal: {
            reason: 'unsupported-accessor',
            message:
              'A property accessor is not a function-timing target: a get/set pair shares one name, so a plan could not say which half to time.',
            hint: 'Instrument a method the accessor delegates to instead.',
          },
        });
      }

      continue;
    }

    if (Node.isMethodDeclaration(member)) {
      if (declaredNameOf(member.getNameNode()) !== spelling.name) {
        continue;
      }

      if (member.isOverload() && member.getImplementation() !== undefined) {
        continue;
      }

      const body = member.getBody();

      into.push({
        declaredName: spelling.name,
        container,
        enclosing: undefined,
        declaration: member,
        target:
          body === undefined
            ? undefined
            : {
                shape: 'method',
                fn: member,
                body,
                nameNode: member.getNameNode(),
                declaration: member,
                identifierScope: member,
                declaredName: spelling.name,
                container,
                enclosing: undefined,
              },
        refusal: body === undefined ? BODYLESS_DECLARATION_REFUSAL : undefined,
      });

      continue;
    }

    if (Node.isPropertyDeclaration(member)) {
      if (declaredNameOf(member.getNameNode()) !== spelling.name) {
        continue;
      }

      into.push(
        assignedFunctionCandidate(
          unwrapInitializer(member.getInitializer()),
          member,
          member.getNameNode(),
          spelling.name,
          { container, enclosing: undefined, identifierScope: member },
        ),
      );
    }

    // A static initialisation block and an index signature carry no name a plan
    // could address, so neither contributes a candidate.
  }
}

/**
 * Collects the candidates the file's **nested** scopes contribute: a named,
 * function-valued declaration inside another function's body.
 *
 * Two forms, and only two — the same two module scope offers, which is what
 * lets the emitted wrapper stay byte-for-byte the template
 * `./wrap-template.js` owns:
 *
 * - `function name() {}`, wrapped exactly as a module-scope declaration is,
 *   shape `'function-declaration'`.
 * - `const|let|var name = <function expression | arrow>`, with the initialiser
 *   unwrapped through the same transparent expressions
 *   {@link unwrapInitializer} looks through, shape `'function-expression'` or
 *   `'arrow-function'`.
 *
 * A nested declarator whose initialiser is **not** function-valued —
 * `const cb = useCallback(…)` is the one that turns up — is deliberately not
 * collected: there is no body to move, and the not-found path reports it as
 * `'symbol-not-addressable'` with the position `'non-function-declarator'`
 * rather than as a declaration that holds no function. (A *module-scope*
 * declarator of that shape keeps its own `'unsupported-declaration'` refusal,
 * because a plan naming it is naming a real module export.)
 *
 * ## The walk
 *
 * Depth-first in source order, descending through every node — blocks,
 * conditions, loops, classes, object literals — so a handler declared inside an
 * `if` is found, and counting depth only when it crosses into a function-like
 * scope. `depth` is 0 at module scope, which is why nothing is collected there:
 * that surface belongs to {@link collectFromStatement}, which has already run.
 * The descent stops at {@link MAX_NESTED_DECLARATION_DEPTH}.
 *
 * Because the walk is over the syntax tree in source order and appends, two
 * calls on the same text produce the same candidates in the same order, which
 * is what keeps the patched bytes a function of the input alone.
 *
 * @param scope The node whose children are being walked.
 * @param enclosing The nearest named enclosing declaration, which is the
 * qualifier a `Enclosing.name` spelling must match.
 * @param depth How many function-like scopes deep the walk already is.
 * @param spelling The name and optional container being resolved.
 * @param into The accumulator, appended to in source order.
 */
function collectNestedCandidates(
  scope: Node,
  enclosing: string | undefined,
  depth: number,
  spelling: SymbolSpelling,
  into: Candidate[],
): void {
  for (const child of scope.forEachChildAsArray()) {
    if (isFunctionLikeScope(child)) {
      if (depth >= 1) {
        collectNestedFunction(child, enclosing, spelling, into);
      }

      if (depth < MAX_NESTED_DECLARATION_DEPTH) {
        collectNestedCandidates(child, scopeName(child) ?? enclosing, depth + 1, spelling, into);
      }

      continue;
    }

    if (depth >= 1 && Node.isVariableDeclaration(child)) {
      collectNestedDeclarator(child, enclosing, spelling, into);
    }

    collectNestedCandidates(child, enclosing, depth, spelling, into);
  }
}

/**
 * Collects a nested `function name() {}` when it is the one being resolved.
 *
 * Mirrors {@link collectFromStatement}'s function-declaration branch exactly,
 * including the overload rule — an overload signature is not the target, its
 * implementation is — so a nested overloaded function does not look ambiguous
 * and a nested signature with no implementation earns the same
 * "nothing to time" refusal a module-scope one does.
 *
 * @param node The function-like node the walk reached.
 * @param enclosing The nearest named enclosing declaration.
 * @param spelling The name and optional container being resolved.
 * @param into The accumulator, appended to in source order.
 */
function collectNestedFunction(
  node: Node,
  enclosing: string | undefined,
  spelling: SymbolSpelling,
  into: Candidate[],
): void {
  if (!Node.isFunctionDeclaration(node)) {
    return;
  }

  if (spelling.container !== undefined && spelling.container !== enclosing) {
    return;
  }

  const nameNode = node.getNameNode();

  if (nameNode === undefined || nameNode.getText() !== spelling.name) {
    return;
  }

  if (node.isOverload() && node.getImplementation() !== undefined) {
    return;
  }

  const body = node.getBody();

  into.push({
    declaredName: spelling.name,
    container: undefined,
    enclosing,
    declaration: node,
    target:
      body === undefined
        ? undefined
        : {
            shape: 'function-declaration',
            fn: node,
            body,
            nameNode,
            declaration: node,
            identifierScope: topLevelDeclarationOf(node),
            declaredName: spelling.name,
            container: undefined,
            enclosing,
          },
    refusal: body === undefined ? BODYLESS_DECLARATION_REFUSAL : undefined,
  });
}

/**
 * Collects a nested `const name = <function>` declarator when it is the one
 * being resolved.
 *
 * @param declaration The variable declaration the walk reached.
 * @param enclosing The nearest named enclosing declaration.
 * @param spelling The name and optional container being resolved.
 * @param into The accumulator, appended to in source order.
 */
function collectNestedDeclarator(
  declaration: VariableDeclaration,
  enclosing: string | undefined,
  spelling: SymbolSpelling,
  into: Candidate[],
): void {
  if (spelling.container !== undefined && spelling.container !== enclosing) {
    return;
  }

  const nameNode = declaration.getNameNode();

  if (!Node.isIdentifier(nameNode) || nameNode.getText() !== spelling.name) {
    return;
  }

  const initializer = unwrapInitializer(declaration.getInitializer());

  if (initializer === undefined) {
    return;
  }

  into.push(
    assignedFunctionCandidate(initializer, declaration, nameNode, spelling.name, {
      container: undefined,
      enclosing,
      identifierScope: topLevelDeclarationOf(declaration),
    }),
  );
}

/**
 * Whether a node opens a scope of its own for the purposes of the nested walk.
 *
 * The list is the function-like kinds plus the class static block, every one of
 * which carries a body whose declarations are nested rather than module-scope.
 * It is deliberately **not** `RECEIVER_REBINDING_KINDS` in `./function-timing.ts`: that set answers
 * a different question (which subtrees rebind `this` and `arguments`) and
 * excludes the arrow function, which for nesting counts like any other body — a
 * handler declared inside an arrow-bodied component is exactly the case this
 * resolver exists for.
 *
 * @param node The node to test.
 * @returns `true` when the node's children are one level further nested.
 */
export function isFunctionLikeScope(node: Node): boolean {
  return (
    Node.isFunctionDeclaration(node) ||
    Node.isFunctionExpression(node) ||
    Node.isArrowFunction(node) ||
    Node.isMethodDeclaration(node) ||
    Node.isConstructorDeclaration(node) ||
    Node.isGetAccessorDeclaration(node) ||
    Node.isSetAccessorDeclaration(node) ||
    Node.isClassStaticBlockDeclaration(node)
  );
}

/**
 * The name a function-like scope is known by, or `undefined` when it has none.
 *
 * "Known by" rather than "declares": an arrow function and an anonymous
 * function expression have no name of their own, so the name of the declaration
 * they initialise is theirs — which is why a handler inside
 * `const Panel = (props) => { … }` is addressable as `Panel.handleThing`
 * exactly as one inside `function Panel(props) { … }` is. A scope with no name
 * at all (an immediately-invoked function expression, a callback passed inline)
 * contributes nothing, and the walk keeps the nearest *named* scope above it.
 *
 * @param scope The function-like node.
 * @returns The name, or `undefined`.
 */
function scopeName(scope: Node): string | undefined {
  if (Node.isFunctionDeclaration(scope) || Node.isFunctionExpression(scope)) {
    const nameNode = scope.getNameNode();

    if (nameNode !== undefined) {
      return nameNode.getText();
    }
  }

  if (
    Node.isMethodDeclaration(scope) ||
    Node.isGetAccessorDeclaration(scope) ||
    Node.isSetAccessorDeclaration(scope)
  ) {
    return declaredNameOf(scope.getNameNode());
  }

  if (Node.isConstructorDeclaration(scope)) {
    return CONSTRUCTOR_MEMBER_NAME;
  }

  return initializedDeclarationName(scope);
}

/**
 * The name of the declaration a function expression or arrow initialises, or
 * `undefined` when it initialises none.
 *
 * Walks out through the same transparent expressions {@link unwrapInitializer}
 * walks in through — parentheses, `as`, `satisfies`, `!`, `<T>` — so
 * `const Panel = (((props) => …) as Component)` is still `Panel`, and stops at
 * anything else rather than guessing.
 *
 * @param fn The function expression or arrow.
 * @returns The declared name it is assigned to, or `undefined`.
 */
function initializedDeclarationName(fn: Node): string | undefined {
  let current = fn.getParent();

  for (let depth = 0; depth < MAX_INITIALIZER_UNWRAP_DEPTH; depth += 1) {
    if (current === undefined) {
      return undefined;
    }

    if (
      Node.isParenthesizedExpression(current) ||
      Node.isAsExpression(current) ||
      Node.isSatisfiesExpression(current) ||
      Node.isNonNullExpression(current) ||
      Node.isTypeAssertion(current)
    ) {
      current = current.getParent();
      continue;
    }

    if (Node.isVariableDeclaration(current)) {
      const nameNode = current.getNameNode();

      return Node.isIdentifier(nameNode) ? nameNode.getText() : undefined;
    }

    if (Node.isPropertyDeclaration(current) || Node.isPropertyAssignment(current)) {
      return declaredNameOf(current.getNameNode());
    }

    return undefined;
  }

  return undefined;
}

/**
 * The top-level statement a declaration sits inside, which is the range the
 * identifier-collision scan reads for a nested target.
 *
 * Deliberately the **statement** and not the immediately enclosing function: a
 * moved body may reference a binding declared anywhere in the enclosing
 * declaration, and shadowing one of those with the wrapper's `__orig` or
 * `__dbg` would change what the body reads. A superset of the bindings that
 * could collide costs at most one disambiguating rename, while a subset costs
 * correctness. See {@link ResolvedTarget.identifierScope}.
 *
 * @param declaration The declaration to walk out from.
 * @returns The outermost ancestor below the source file, or the declaration
 * itself when it is already a top-level statement.
 */
function topLevelDeclarationOf(declaration: Node): Node {
  let outermost = declaration;

  for (
    let ancestor = declaration.getParent();
    ancestor !== undefined && !Node.isSourceFile(ancestor);
    ancestor = ancestor.getParent()
  ) {
    outermost = ancestor;
  }

  return outermost;
}

/**
 * The refusal every bodyless form shares: an overload signature with no
 * implementation, an ambient `declare function`, an abstract method.
 *
 * One object rather than three identical ones, because the distinction a
 * developer needs is "there is no body to time", not which syntax withheld it.
 * `../feasibility.ts` meets the same refusal through {@link resolvePatchTarget},
 * before a plan ever reaches the patcher.
 */
const BODYLESS_DECLARATION_REFUSAL: Refusal = Object.freeze({
  reason: 'unsupported-declaration',
  message:
    'The target declaration has no body, so there is nothing to time: an overload signature, an ambient declaration and an abstract member all declare a shape rather than an implementation.',
  hint: 'Name the implementation rather than the signature that declares it.',
});

/**
 * Where a candidate sits: what qualifies its name, and what the wrapper's
 * identifier-collision scan must read.
 *
 * One record rather than three parallel parameters, because the three answers
 * always travel together and are decided by the collecting pass — module scope,
 * a class, or a nested function body — rather than by the declaration itself.
 */
interface CandidateScope {
  /** The owning class's name for a class member, `undefined` otherwise. */
  readonly container: string | undefined;

  /**
   * The nearest named enclosing declaration for a nested candidate,
   * `undefined` at module scope and on a class.
   */
  readonly enclosing: string | undefined;

  /** See {@link ResolvedTarget.identifierScope}. */
  readonly identifierScope: Node;
}

/**
 * Builds the candidate for a function assigned to a variable or a class
 * property.
 *
 * The declaration that carries the name — the variable or the property — is
 * what `endLine` and the indentation are taken from, while the function itself
 * is what gets rewritten. Keeping them apart is what lets `const f = (a) => a;`
 * report the position of `f` and rewrite the arrow.
 *
 * @param initializer The unwrapped function-valued initialiser, or `undefined`
 * when the declaration holds something else.
 * @param declaration The variable or property declaration.
 * @param nameNode The declaration's name node.
 * @param declaredName The bare declared name.
 * @param scope Where the declaration sits. See {@link CandidateScope}.
 * @returns A wrappable candidate, or one carrying the refusal.
 */
function assignedFunctionCandidate(
  initializer: ArrowFunction | FunctionExpression | undefined,
  declaration: Node,
  nameNode: Node,
  declaredName: string,
  scope: CandidateScope,
): Candidate {
  if (initializer === undefined) {
    return {
      declaredName,
      container: scope.container,
      enclosing: scope.enclosing,
      declaration,
      target: undefined,
      refusal: {
        reason: 'unsupported-declaration',
        message:
          'The target names a declaration that does not hold a function, so there is no body to time.',
        hint: 'Name a function, a method, or a declaration initialised with one.',
      },
    };
  }

  return {
    declaredName,
    container: scope.container,
    enclosing: scope.enclosing,
    declaration,
    target: {
      shape: Node.isArrowFunction(initializer) ? 'arrow-function' : 'function-expression',
      fn: initializer,
      body: initializer.getBody(),
      nameNode,
      declaration,
      identifierScope: scope.identifierScope,
      declaredName,
      container: scope.container,
      enclosing: scope.enclosing,
    },
    refusal: undefined,
  };
}

/**
 * The name a declaration's name node spells, or `undefined` when it has none
 * a plan could address.
 *
 * Mirrors `declaredNameOf` in `packages/code-analysis/src/extractors/symbols.ts`
 * deliberately, so a symbol the code graph recorded is a symbol this module can
 * find: a string-literal member name is unquoted, a numeric or private name is
 * kept as written, and a computed name yields `undefined` because it is not
 * statically known.
 *
 * @param nameNode The name node, or `undefined`.
 * @returns The declared name, or `undefined`.
 */
function declaredNameOf(nameNode: Node | undefined): string | undefined {
  if (nameNode === undefined) {
    return undefined;
  }

  if (Node.isIdentifier(nameNode) || Node.isPrivateIdentifier(nameNode)) {
    const text = nameNode.getText();

    return text.length === 0 ? undefined : text;
  }

  if (Node.isStringLiteral(nameNode) || Node.isNoSubstitutionTemplateLiteral(nameNode)) {
    const text = nameNode.getLiteralText();

    return text.length === 0 ? undefined : text;
  }

  if (Node.isNumericLiteral(nameNode)) {
    return nameNode.getText();
  }

  return undefined;
}

/**
 * The function an initialiser holds, looking through the expressions that can
 * wrap one without changing it.
 *
 * `(f)`, `f as Fn`, `f satisfies Fn`, `f!` and `<Fn>f` all leave the function
 * itself as the node to rewrite, and the wrapper stays exactly where it was:
 * only the function's own range is replaced, so `const f = ((a) => a) as Fn;`
 * keeps both its parentheses and its assertion.
 *
 * @param expression The initialiser, or `undefined`.
 * @returns The arrow or function expression, or `undefined` when the
 * initialiser holds something else.
 */
function unwrapInitializer(
  expression: Node | undefined,
): ArrowFunction | FunctionExpression | undefined {
  let current = expression;

  for (let depth = 0; depth < MAX_INITIALIZER_UNWRAP_DEPTH; depth += 1) {
    if (current === undefined) {
      return undefined;
    }

    if (Node.isArrowFunction(current) || Node.isFunctionExpression(current)) {
      return current;
    }

    if (
      Node.isParenthesizedExpression(current) ||
      Node.isAsExpression(current) ||
      Node.isSatisfiesExpression(current) ||
      Node.isNonNullExpression(current) ||
      Node.isTypeAssertion(current)
    ) {
      current = current.getExpression();
      continue;
    }

    return undefined;
  }

  return undefined;
}

/**
 * A declaration the file holds under the requested name, in a position no
 * wrapper can replace the body of.
 *
 * Positions and names only. The declaration's own text never appears here, and
 * must not: this module reads the developer's whole file and everything it
 * reports travels into a log line and a user interface — see {@link refusal}.
 */
interface NonAddressableFinding {
  /** Which position it was found in. */
  readonly position: PatchNonAddressablePosition;

  /**
   * The nearest named declaration it sits inside, which is what a hint points
   * the planner at — the function whose timing would cover this code.
   */
  readonly enclosing: string | undefined;

  /** The 1-based line the declaration starts on. */
  readonly line: number;
}

/**
 * The first declaration of the requested name the file holds in a
 * non-addressable position, or `undefined` when the file declares the name
 * nowhere at all.
 *
 * Runs **only** on the not-found path, which is what keeps it free: a request
 * that resolves never walks the file a second time. What it buys is the
 * distinction a "symbol not found" answer cannot make — `ZZZ`, which no
 * re-index will ever produce, versus a destructured prop or a nested
 * `useCallback` result the file plainly declares and no re-index will ever
 * change into something wrappable.
 *
 * Depth-first in source order, stopping at the first classified declaration, so
 * the answer is deterministic and the walk is bounded by the file.
 *
 * @param sourceFile The parsed copy of the target file.
 * @param spelling The name and optional container being resolved.
 * @returns The finding, or `undefined`.
 */
function nonAddressableFinding(
  sourceFile: SourceFile,
  spelling: SymbolSpelling,
): NonAddressableFinding | undefined {
  return sourceFile.forEachDescendant((node) => {
    const position = nonAddressablePositionOf(node, spelling.name);

    if (position === undefined) {
      return undefined;
    }

    return {
      position,
      // The qualifier that would address this declaration: its class for a
      // member of a module-scope class, the nearest named function otherwise.
      // Both are spellings `parseSymbolSpelling` accepts, so a hint built from
      // one names a target that really resolves.
      enclosing: addressableClassName(node) ?? nearestEnclosingName(node),
      line: node.getStartLineNumber(),
    };
  });
}

/**
 * The name of the module-scope class a node is a member of, or `undefined` when
 * it is not one.
 *
 * Narrow on purpose: only a member of a **named class declared at module
 * scope** is addressable as `Class.member`, so only that case contributes a
 * qualifier. A member of a class expression or of a class nested in a function
 * is not addressable under any spelling, and naming its class in a hint would
 * send the planner to a target that refuses again.
 *
 * @param node The node the scan classified.
 * @returns The class's name, or `undefined`.
 */
function addressableClassName(node: Node): string | undefined {
  if (
    !Node.isMethodDeclaration(node) &&
    !Node.isPropertyDeclaration(node) &&
    !Node.isGetAccessorDeclaration(node) &&
    !Node.isSetAccessorDeclaration(node) &&
    !Node.isConstructorDeclaration(node)
  ) {
    return undefined;
  }

  const owner = node.getParent();

  return Node.isClassDeclaration(owner) && Node.isSourceFile(owner.getParent())
    ? owner.getName()
    : undefined;
}

/**
 * Which non-addressable position a node declares the name in, or `undefined`
 * when it does not declare it.
 *
 * The order of the checks is the order of the kinds, not a precedence: a node is
 * of exactly one kind, so at most one branch can answer for it. What the walk's
 * own order decides is only which of *several* findings is reported, and that is
 * source order.
 *
 * Two branches answer for a declaration that **is** addressable — a
 * function-valued declarator or `function` declaration, and a member of a
 * module-scope class — because reaching this scan means the *spelling* did not
 * match one of them: a qualified spelling naming the wrong container. Those are
 * reported as `'mismatched-container'`, with the qualification that does match,
 * rather than as a scope this transform cannot reach.
 *
 * @param node The node the walk reached.
 * @param name The bare name being resolved.
 * @returns The position, or `undefined`.
 */
function nonAddressablePositionOf(
  node: Node,
  name: string,
): PatchNonAddressablePosition | undefined {
  if (Node.isParameterDeclaration(node)) {
    return declaredNameOf(node.getNameNode()) === name ? 'parameter' : undefined;
  }

  if (Node.isBindingElement(node)) {
    if (declaredNameOf(node.getNameNode()) !== name) {
      return undefined;
    }

    // The same syntax binds a destructured prop and a destructured local, and
    // the developer needs to hear which one this is, so the pattern's owner is
    // what decides the position.
    return node.getFirstAncestor((ancestor) => Node.isParameterDeclaration(ancestor)) === undefined
      ? 'binding-element'
      : 'parameter';
  }

  if (Node.isVariableDeclaration(node)) {
    const nameNode = node.getNameNode();

    if (!Node.isIdentifier(nameNode) || nameNode.getText() !== name) {
      return undefined;
    }

    return unwrapInitializer(node.getInitializer()) === undefined
      ? 'non-function-declarator'
      : scopeReachability(node);
  }

  if (Node.isFunctionDeclaration(node)) {
    const nameNode = node.getNameNode();

    return nameNode !== undefined && nameNode.getText() === name
      ? scopeReachability(node)
      : undefined;
  }

  if (Node.isFunctionExpression(node)) {
    const nameNode = node.getNameNode();

    return nameNode !== undefined && nameNode.getText() === name
      ? 'function-expression-name'
      : undefined;
  }

  if (
    Node.isMethodDeclaration(node) ||
    Node.isPropertyDeclaration(node) ||
    Node.isGetAccessorDeclaration(node) ||
    Node.isSetAccessorDeclaration(node)
  ) {
    if (declaredNameOf(node.getNameNode()) !== name) {
      return undefined;
    }

    const owner = node.getParent();

    if (Node.isObjectLiteralExpression(owner)) {
      return 'object-literal-member';
    }

    return Node.isClassDeclaration(owner) && Node.isSourceFile(owner.getParent())
      ? 'mismatched-container'
      : 'class-member';
  }

  if (Node.isPropertyAssignment(node) || Node.isShorthandPropertyAssignment(node)) {
    return declaredNameOf(node.getNameNode()) === name ? 'object-literal-member' : undefined;
  }

  if (Node.isClassDeclaration(node) || Node.isClassExpression(node)) {
    return node.getName() === name ? 'class-declaration' : undefined;
  }

  if (
    Node.isTypeAliasDeclaration(node) ||
    Node.isInterfaceDeclaration(node) ||
    Node.isEnumDeclaration(node) ||
    Node.isEnumMember(node) ||
    Node.isTypeParameterDeclaration(node)
  ) {
    return declaredNameOf(node.getNameNode()) === name ? 'type-declaration' : undefined;
  }

  if (Node.isModuleDeclaration(node)) {
    return node.getName() === name ? 'namespace' : undefined;
  }

  return importBindingPosition(node, name);
}

/**
 * `'import-binding'` when a node binds the name through an import,
 * `undefined` otherwise.
 *
 * Every import form that introduces a local binding is covered, and the
 * **local** spelling is what is compared: `import { load as fetchRows }` binds
 * `fetchRows`, and a plan naming `load` is naming the other module's symbol
 * rather than anything this file declares. An `export { … } from` specifier
 * binds nothing locally and is deliberately not reported.
 *
 * @param node The node the walk reached.
 * @param name The bare name being resolved.
 * @returns The position, or `undefined`.
 */
function importBindingPosition(node: Node, name: string): 'import-binding' | undefined {
  if (Node.isImportSpecifier(node)) {
    const alias = node.getAliasNode();

    return (alias === undefined ? node.getName() : alias.getText()) === name
      ? 'import-binding'
      : undefined;
  }

  if (Node.isNamespaceImport(node) || Node.isImportEqualsDeclaration(node)) {
    return node.getName() === name ? 'import-binding' : undefined;
  }

  if (Node.isImportClause(node)) {
    return node.getDefaultImport()?.getText() === name ? 'import-binding' : undefined;
  }

  return undefined;
}

/**
 * Whether an addressable *form* sits somewhere this resolver reaches.
 *
 * A function-valued declaration is addressable when it is a module-scope
 * statement or nested within {@link MAX_NESTED_DECLARATION_DEPTH} function-like
 * scopes — exactly what the two collecting passes walk. Anything else is a
 * scope neither pass descends into: a namespace body, or nesting past the
 * bound.
 *
 * Reaching this function at all means the spelling did not match, so an
 * addressable form here is a qualification mismatch rather than a missing
 * symbol, and is reported as such.
 *
 * @param declaration The function or function-valued declarator that was found.
 * @returns `'mismatched-container'` when some spelling would address it,
 * `'unreachable-scope'` when none would.
 */
function scopeReachability(declaration: Node): 'mismatched-container' | 'unreachable-scope' {
  let scopes = 0;

  for (
    let ancestor = declaration.getParent();
    ancestor !== undefined && !Node.isSourceFile(ancestor);
    ancestor = ancestor.getParent()
  ) {
    if (isFunctionLikeScope(ancestor)) {
      scopes += 1;
    }
  }

  if (scopes > MAX_NESTED_DECLARATION_DEPTH) {
    return 'unreachable-scope';
  }

  if (scopes > 0) {
    return 'mismatched-container';
  }

  // At module scope the statement itself is what the first pass walks, so a
  // declaration reached through anything else — a namespace body — is one
  // neither pass sees.
  return isModuleScopeDeclaration(declaration) ? 'mismatched-container' : 'unreachable-scope';
}

/**
 * Whether a declaration is one of the module-scope forms
 * {@link collectFromStatement} walks: a top-level `function`, or a declarator
 * of a top-level variable statement.
 *
 * @param declaration The declaration to test.
 * @returns `true` when the first resolution pass reaches it.
 */
function isModuleScopeDeclaration(declaration: Node): boolean {
  const parent = declaration.getParent();

  if (parent === undefined) {
    return false;
  }

  if (Node.isSourceFile(parent)) {
    return true;
  }

  if (!Node.isVariableDeclarationList(parent)) {
    return false;
  }

  const statement = parent.getParent();

  return (
    statement !== undefined &&
    Node.isVariableStatement(statement) &&
    Node.isSourceFile(statement.getParent())
  );
}

/**
 * The name of the nearest named function-like scope above a node, or
 * `undefined` when it sits at module scope or inside only unnamed ones.
 *
 * The value a hint points the planner at: the declaration whose own timing
 * *does* cover the code they named, and the qualifier a `Enclosing.name`
 * spelling carries.
 *
 * @param node The node to walk out from.
 * @returns The enclosing declaration's name, or `undefined`.
 */
function nearestEnclosingName(node: Node): string | undefined {
  for (
    let ancestor = node.getParent();
    ancestor !== undefined && !Node.isSourceFile(ancestor);
    ancestor = ancestor.getParent()
  ) {
    if (!isFunctionLikeScope(ancestor)) {
      continue;
    }

    const name = scopeName(ancestor);

    if (name !== undefined) {
      return name;
    }
  }

  return undefined;
}

/**
 * What each non-addressable position is, as the clause its refusal message
 * carries.
 *
 * Stated as data keyed by {@link PATCH_NON_ADDRESSABLE_POSITIONS}, exactly as
 * `ARGUMENTS_HAZARD_REFUSALS` in `./function-timing.ts` is, so a new position is a compile error
 * here rather than a message with a gap in it. Each clause says what the
 * declaration *is*, because that is the fact the developer cannot see from the
 * plan: they named something real, and it is not a function whose body a
 * wrapper can replace.
 *
 * Exported for `../feasibility.ts`, which reports the same position in its own
 * rejection sentence, so the two modules describe one declaration in one set of
 * words.
 */
export const NON_ADDRESSABLE_CLAUSES: Readonly<Record<PatchNonAddressablePosition, string>> =
  Object.freeze({
    parameter:
      'a parameter binding, which holds whatever the caller passed rather than a declaration with a body of its own',
    'binding-element':
      'an element of a destructuring pattern, which takes a value out of another object rather than declaring a function',
    'non-function-declarator':
      'a nested declaration whose initialiser is not a function literal, so there is no body to move',
    'object-literal-member': 'a member of an object literal, which this transform does not address',
    'class-member':
      'a member of a class that is not declared at module scope, and only a module-scope class is addressable',
    'class-declaration':
      'the class itself, whose body runs field initialisers on construction rather than one timed call',
    'type-declaration':
      'a type-level declaration, which erases completely before anything runs and therefore has nothing to time',
    namespace: 'a namespace declaration rather than a function',
    'import-binding': 'bound by an import, so the declaration that has a body is in another module',
    'function-expression-name':
      "a function expression's own name, which is bound only inside that expression",
    'mismatched-container':
      'declared under a different qualification than the one the plan spelled',
    'unreachable-scope':
      'declared in a scope this transform does not descend into — a namespace body, or nesting deeper than it supports',
  });

/**
 * The refusal for a declaration the file holds in a non-addressable position.
 *
 * `PATCH_TARGET_NOT_FOUND` for the same reason `'symbol-not-found'` carries it:
 * nothing may be written, and a caller branching on the code must treat the two
 * identically. What differs is the `reason`, the sentence and above all the next
 * step — re-indexing cannot turn a destructured prop into a timing target,
 * whereas timing the function that *owns* it, naming the module an import comes
 * from, or planning a runtime signal each can.
 *
 * @param finding What was found, and where.
 * @param spelling The name and optional container that were requested.
 * @param file The project-relative path, for the refusal details.
 * @returns The coded refusal.
 */
function nonAddressableRefusal(
  finding: NonAddressableFinding,
  spelling: SymbolSpelling,
  file: string,
): DebuggenError {
  return refusal(
    'PATCH_TARGET_NOT_FOUND',
    'symbol-not-addressable',
    `The target file does declare that name, but not as a function this transform can wrap: it is ${NON_ADDRESSABLE_CLAUSES[finding.position]}.`,
    {
      file,
      symbol: spelling.name,
      container: spelling.container,
      position: finding.position,
      enclosing: finding.enclosing,
      line: finding.line,
      shapes: PATCH_TARGET_SHAPES,
    },
    nonAddressableHint(finding, spelling),
  );
}

/**
 * The next step a non-addressable refusal offers.
 *
 * Three of them, chosen by what was found, and every one is something the
 * planner can actually emit:
 *
 * - **A mismatched qualification** gets the spelling that does address the
 *   declaration, because the target exists and one edit to the plan reaches it.
 * - **An imported binding** gets sent to the module that declares it: the body
 *   is there, and this file holds only the name.
 * - **Everything else** gets the enclosing declaration — timing it covers the
 *   code the plan pointed at, one frame out — or, when there is none, the
 *   shapes this transform does wrap and the runtime route. A
 *   `react-render-tracking` action needs no file edit at all (AAP §0.5.1), so
 *   it is always available where a patch is not.
 *
 * @param finding What was found, and where.
 * @param spelling The name and optional container that were requested.
 * @returns The hint sentence.
 */
function nonAddressableHint(finding: NonAddressableFinding, spelling: SymbolSpelling): string {
  const { enclosing, position } = finding;

  if (position === 'mismatched-container') {
    return enclosing === undefined
      ? `Spell the target as the bare name ${spelling.name}: the declaration it names is not nested inside a named declaration.`
      : `Spell the target ${enclosing}.${spelling.name} — or, where the file declares the name only once, as the bare name.`;
  }

  if (position === 'import-binding') {
    return `Name the module that declares ${spelling.name} and time it there, or plan a ${REACT_RENDER_ACTION_TYPE} or another runtime signal, which needs no file edit.`;
  }

  const shapes = PATCH_TARGET_SHAPES.join(', ');

  return enclosing === undefined
    ? `Time a declaration of one of the supported shapes instead (${shapes}), or plan a runtime signal, which needs no file edit.`
    : `Time ${enclosing} instead — or the function it delegates to — since a patch target must be one of ${shapes}; a runtime signal needs no file edit at all.`;
}

/**
 * Resolves a `(file, symbol)` pair to the one declaration a timing wrapper would
 * replace the body of — the single entry point both of this module's callers
 * share.
 *
 * Exactly {@link parseSymbolSpelling} followed by {@link resolveTarget}, so the
 * spelling vocabulary, the scope order, the ambiguity refusal and the
 * non-addressable positions are the patcher's own by construction rather than
 * by imitation. The call only reads `sourceFile`: it is safe to hand in a tree
 * the code index shares with other readers.
 *
 * @param sourceFile The parsed copy of the target file.
 * @param symbol The `symbol` field of an action, as the plan spelled it.
 * @param file The project-relative POSIX path, for the refusal details.
 * @returns The resolved target, or a refusal whose `details.reason` is one of
 * `'malformed-symbol'`, `'symbol-not-found'`, `'symbol-not-addressable'`,
 * `'ambiguous-symbol'`, `'unsupported-declaration'`, `'unsupported-accessor'`
 * or `'unsupported-constructor'`.
 */
export function resolvePatchTarget(
  sourceFile: SourceFile,
  symbol: string,
  file: string,
): Result<ResolvedTarget> {
  const spelling = parseSymbolSpelling(symbol);

  if (!spelling.ok) {
    return spelling;
  }

  return resolveTarget(sourceFile, spelling.value, file);
}
